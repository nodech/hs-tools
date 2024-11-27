/*!
 * commands/genseeds.js - Generate hsd seeds.
 * Copyright (c) 2021, Nodari Chkuaselidze (MIT License).
 * https://github.com/nodech/hs-tools
 */

'use strict';

const {resolve} = require('node:dns').promises;
const {Command} = require('./command');
const {Semaphore} = require('../utils/semaphore');
const util = require('../utils/util');
const colors = require('../utils/colors');
const {fetchSem, fetchCached} = require('../utils/fetch');
const {NullCache, T_MINUTE} = require('../cache');

const CACHE_NAME = 'hs-genseeds';

const EASY_HANDSHAKE_DNS = 'seed.easyhandshake.com';
const HSD_NODES_SEEDS_URL = 'https://hnsnodes.htools.work/api/v1/snapshots/latest/reachable';

const NETHEALTH_URL = 'https://hsdnethealth.nodech.dev/data/nodes';
const NETHEALTH_GENERAL = `${NETHEALTH_URL}/general.json`;
const NETHEALTH_ONLINE = `${NETHEALTH_URL}/online-now.json`;
const NETHEALTH_NODE = addr => `${NETHEALTH_URL}/hosts/${addr}/general.json`;
const NETHEALTH_5MONTHS = (ip, port) => {
  return `${NETHEALTH_URL}/hosts/${ip}/${port}-history-day-5month.json`;
};

const PORT_CLEAR = 12038;

const TASK_GET_SEEDS = 'Gather seeds';
const TASK_GET_NODE_DETAILS = 'Gather node details';
const STEP_GET_NODE_DETAILS = seed => `Get ${seed} info`;

/**
 * @typedef {Object} Months5Data
 * @property {Number} countSync
 * @property {Number} countSPV
 * @property {Number} countFullNode
 * @property {Number} countFullTree
 * @property {Number} total
 */

/**
 * @typedef {Object} SeedData
 * @property {string} addr
 * @property {boolean} isMainSeed
 * @property {boolean} isGeneratedSeed
 * @property {boolean} isOnline
 * @property {Boolean} isFullNode
 * @property {Boolean} isFullTree
 * @property {Number} lastSeen
 * @property {Number} lastHeight
 * @property {Number} lastVersion
 * @property {Months5Data} uptime5months
 * @property {Boolean} easyHandshake
 * @property {Boolean} hsdnodesTools
 */

class GenerateSeeds extends Command {
  constructor(options) {
    super(options);

    this.current = '';

    this.cache = options.cache || new NullCache();
    this.fetchSem = new Semaphore(options.parallel || 3);
    this.outputFormat = options.format || 'ui';
    this.outputSort = options.sort || 'uptime';
    this.includePruned = options.includePruned || false;

    /** @type {Set<string>} */
    this.easyhandshakeSeeds = new Set();

    /** @type {Set<string>} */
    this.hsdnodesToolsSeeds = new Set();

    /** @type {Set<string>} */
    this.nethealthSeeds = new Set();

    /** @type {Set<string>} */
    this.mainSeeds = new Set();

    /** @type {Set<string>} */
    this.generatedSeeds = new Set();

    /** @type {Set<string>} */
    this.allSeeds = new Set();

    /** @type {Map<string, SeedData>} */
    this.seedData = new Map();

    /** @type {Set<string>} */
    this.failedToGet = new Set();
  }

  async get(url) {
    return fetchSem(this.fetchSem, {
      method: 'GET',
      url: url,
      Error: this.Error
    });
  }

  async getCachedNethealth(url) {
    const fileName = url.substring(NETHEALTH_URL.length + 1)
      .replaceAll('/', '_');

    const [response] = await fetchCached(this.cache, {
      Error: this.Error,

      cacheName: CACHE_NAME,
      fileName: fileName,
      expire: 5 * T_MINUTE,

      sema: this.fetchSem,

      method: 'GET',
      url: url
    });

    return response;
  };

  async getEasyHandshakeSeeds() {
    const seeds = await resolve(EASY_HANDSHAKE_DNS);

    for (const seed of seeds) {
      const addr = `${seed}:${PORT_CLEAR}`;
      this.easyhandshakeSeeds.add(addr);
      this.allSeeds.add(addr);
    }
  }

  async getHsdnodesSeeds() {
    const seeds = await this.get(HSD_NODES_SEEDS_URL);

    if (seeds.status !== 'success')
      return;

    for (const seed of seeds.data) {
      const addr = `${seed[0]}:${seed[1]}`;
      this.hsdnodesToolsSeeds.add(addr);
      this.allSeeds.add(addr);
    }
  }

  /**
   * @param {Object} nethealthEntry
   * @returns {SeedData}
   */

  seedDataFromEntry(entry) {
    const lastUp = entry.lastUp;
    const lastStatus = entry.lastStatus;
    const addr = lastStatus.info.host + ':' + lastStatus.info.port;

    /** @type {SeedData} */
    const seedData = {
      addr,
      isMainSeed: this.mainSeeds.has(addr),
      isGeneratedSeed: this.generatedSeeds.has(addr),
      isOnline: entry.isUp,

      easyHandshake: this.easyhandshakeSeeds.has(addr),
      hsdnodesTools: this.hsdnodesToolsSeeds.has(addr),

      uptime5months: null,

      lastSeen: 0,
      isFullNode: false,
      isFullTree: false,
      lastHeight: 0,
      lastVersion: ''
    };

    if (!lastUp)
      return seedData;

    const lastDetails = lastUp.info.result;

    seedData.lastSeen = lastUp.info.time;
    seedData.isFullNode = !lastDetails.chain.pruned;
    seedData.isFullTree = !lastDetails.chain.treeCompacted;
    seedData.lastHeight = lastDetails.peer.height;
    seedData.lastVersion = extractVersion(lastDetails.peer.agent);

    return seedData;
  }

  async getNethealthSeeds() {
    const [
      online,
      general
    ] = await Promise.all([
      this.get(NETHEALTH_ONLINE),
      this.get(NETHEALTH_GENERAL)
    ]);

    for (const [ip, data] of Object.entries(online.data)) {
      for (const port of Object.keys(data)) {
        const addr = `${ip}:${port}`;
        this.nethealthSeeds.add(addr);
        this.allSeeds.add(addr);
      }
    }

    for (const [ip, data] of Object.entries(general.mainSeeds.statuses)) {
      for (const port of Object.keys(data)) {
        const addr = `${ip}:${port}`;

        this.mainSeeds.add(addr);
        this.allSeeds.add(addr);
      }
    }

    for (const [ip, data] of Object.entries(general.generatedSeeds.statuses)) {
      for (const port of Object.keys(data)) {
        const addr = `${ip}:${port}`;

        this.generatedSeeds.add(addr);
        this.allSeeds.add(addr);
      }
    }
  }

  async getSeeds() {
    const steps = new Map();

    const listSteps = {
      'seeds.easyhandshake.com': () => this.getEasyHandshakeSeeds(),
      'hnsnodes.htools.work': () => this.getHsdnodesSeeds(),
      'hsdnethealth.nodech.dev': () => this.getNethealthSeeds()
    };

    for (const [name, step] of Object.entries(listSteps)) {
      this.step(name);

      steps.set(name, async () => {
        await step();
      });
    }

    const sem = new Semaphore(Infinity);
    await this.runParallelSteps(steps, sem);
  }

  async getNodeDetails(seed) {
    const ip = seed.split(':')[0];
    const port = seed.split(':')[1];

    let general, months5;

    try {
      const results = await Promise.all([
        this.getCachedNethealth(NETHEALTH_NODE(ip)),
        this.getCachedNethealth(NETHEALTH_5MONTHS(ip, port))
      ]);

      general = results[0];
      months5 = results[1];
    } catch (e) {
      this.failedToGet.add(seed);
      throw e;
    }

    if (general == null || months5 == null) {
      this.failedToGet.add(seed);
      throw new Error('Failed to get node details');
    }

    if (general.general[port] == null) {
      this.failedToGet.add(seed);
      throw new Error(`Port ${port} not found in general.json`);
    }

    const data = this.seedDataFromEntry(general.general[port]);
    data.uptime5months = Months5Data.fromEntries(months5.data);

    this.seedData.set(seed, data);
  }

  async getAllNodeDetails() {
    const steps = new Map();

    for (const seed of this.allSeeds) {
      const stepName = STEP_GET_NODE_DETAILS(seed);

      this.step(stepName);

      steps.set(stepName, async () => {
        await this.getNodeDetails(seed);
      });
    }

    const sem = new Semaphore(3);
    await this.runParallelSteps(steps, sem);
  }

  async run() {
    const tasks = {
      [TASK_GET_SEEDS]: () => this.getSeeds(),
      [TASK_GET_NODE_DETAILS]: () => this.getAllNodeDetails()
    };

    this.registerTasks(Object.keys(tasks));
    await this.runTasks(Object.entries(tasks));

    this.outputUI();
  }

  /**
   * @param {SeedData} entry
   * @returns {Object}
   */

  formatSeedData(entry) {
    const tableEntry = {};

    tableEntry.seed = entry.addr;
    tableEntry.on = formatYN(entry.isOnline);
    tableEntry.height = String(entry.lastHeight);
    tableEntry.rawHeight = String(entry.lastHeight);
    tableEntry.uptime = entry.uptime5months.onlinePerc.toFixed(2) + '%';
    tableEntry.rawUptime = entry.uptime5months.onlinePerc;
    tableEntry.full = entry.uptime5months.fullPerc.toFixed(2) + '%';

    tableEntry.easy = formatYN(entry.easyHandshake);
    tableEntry.htools = formatYN(entry.hsdnodesTools);
    tableEntry.nethealth = formatYN(this.nethealthSeeds.has(entry.addr));

    return tableEntry;
  }

  prepareData() {
    const mains = [];
    const gens = [];
    const others = [];

    for (const seed of this.seedData.values()) {
      const formatted = this.formatSeedData(seed);

      if (seed.isMainSeed) {
        mains.push(formatted);
        continue;
      }

      if (seed.isGeneratedSeed) {
        gens.push(formatted);
        continue;
      }

      if (!this.includePruned && !seed.isFullNode)
        continue;

      others.push(formatted);
    }

    const sortRawUptime = (a, b) => b.rawUptime - a.rawUptime;
    const sortByHeight = (a, b) => b.rawHeight - a.rawHeight;

    let chosenSort = sortRawUptime;

    if (this.outputSort === 'height')
      chosenSort = sortByHeight;

    mains.sort(chosenSort);
    gens.sort(chosenSort);
    others.sort(chosenSort);

    return {
      mains,
      gens,
      others
    };
  }

  outputUI() {
    const headers = [
      'seed',
      'on',
      'height',
      'uptime',
      'full',
      'easy',
      'htools',
      'nethealth'
    ];

    const {
      mains,
      gens,
      others
    } = this.prepareData();

    this.log(`Total: ${mains.length + gens.length + others.length}`);
    this.log(`Main seeds (${mains.length}):`);
    this.log(util.printTable(headers, mains));
    this.log(`Generated Seeds (${gens.length}):`);
    this.log(util.printTable(headers, gens));
    this.log(`New possible seeds (${others.length}):`);
    this.log(util.printTable(headers, others));

    if (this.failedToGet.size) {
      this.log('Failed to get:');
      this.log(Array.from(this.failedToGet).join(', '));
    }
  }
}

function extractVersion(version) {
  return version.split('/')[1];
}

class Months5Data {
  constructor() {
    this.countSync = 0;
    this.countSPV = 0;
    this.countPruned = 0;
    this.countCompacted = 0;
    this.total = 0;
  }

  get onlinePerc() {
    if (this.total === 0)
      return 0;

    return percent(this.countSync, this.total);
  }

  get fullPerc() {
    if (this.countSync === 0)
      return 0;

    const full = this.countSync - this.countPruned;
    return percent(full, this.countSync);
  }

  fromEntries(entries) {
    for (const entry of Object.values(entries)) {
      this.countSync += entry.canSync;
      this.countSPV += entry.spv;
      this.countPruned += entry.pruned;
      this.countCompacted += entry.compacted;
      this.total += entry.total;
    }

    return this;
  }

  static fromEntries(entries) {
    return new this().fromEntries(entries);
  }
}

function percent(num, total) {
  return ((num / total) * 100);
}

function formatYN(bool) {
  return bool
    ? colors.greenText('y')
    : colors.redText('n');
}

exports.GenerateSeeds = GenerateSeeds;