'use strict';

const { randomUUID } = require('node:crypto');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const { MongoClient } = require('mongodb');
const { loadConfig } = require('../src/config');
const { createLogger } = require('../src/logger');
const { createApp } = require('../src/app');
const { signAccessToken } = require('../src/middleware/jwtAuth');
const { OutboxRelay } = require('../src/queue/outboxRelay');
const { FEATURE_COLUMNS } = require('../src/validation/schemas');

const JWT_SECRET = 'test-jwt-secret-that-is-at-least-32-characters-long';
const SERVICE_TOKEN = 'test-internal-service-token-at-least-32-chars';

function testEnv(overrides = {}) {
  return {
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    MONGO_URI: 'mongodb://placeholder',
    MONGO_DB: 'fraudguard_transactions_test',
    RABBITMQ_URL: 'amqp://localhost',
    JWT_SECRET,
    INTERNAL_SERVICE_TOKEN: SERVICE_TOKEN,
    AUTH_SERVICE_URL: 'http://auth.test',
    QUICK_SCAN_URL: 'http://quick-scan.test',
    QUICK_SCAN_TIMEOUT_MS: '100',
    ...overrides,
  };
}

const jsonResponse = (status, body) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/** Quick-scan behaviours a test can select. */
const quickScan = {
  normal: () => jsonResponse(200, { score: 0.3, threshold: 0.39, flagged: false, modelVersion: '2' }),
  flagged: () => jsonResponse(200, { score: 0.45, threshold: 0.39, flagged: true, modelVersion: '2' }),
  error500: () => jsonResponse(500, { error: { code: 'INTERNAL_ERROR' } }),
  malformed: () => jsonResponse(200, { verdict: 'ok' }),
  networkError: () => {
    throw new TypeError('fetch failed');
  },
  hang: (_url, init) =>
    new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason))),
};

class FakePublisher {
  constructor() {
    this.published = [];
    this.fail = false;
    this.connected = true;
  }
  isConnected() {
    return this.connected;
  }
  async publish(exchange, routingKey, envelope, options) {
    if (this.fail) throw new Error('rabbitmq not connected');
    this.published.push({ exchange, routingKey, envelope, options });
  }
}

function makeUser(email, role = 'user') {
  return { id: randomUUID(), email, name: email.split('@')[0], role };
}

function features(overrides = {}) {
  return { ...Object.fromEntries(FEATURE_COLUMNS.map((n) => [n, 0])), Time: 100, Amount: 1, ...overrides };
}

/** In-memory replica set (multi-document transactions work) + app with stubbed dependencies. */
async function startTestApp(envOverrides = {}) {
  const replSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
  const mongoClient = new MongoClient(replSet.getUri());
  await mongoClient.connect();
  const config = loadConfig(testEnv({ MONGO_URI: replSet.getUri(), ...envOverrides }));
  const db = mongoClient.db(config.mongo.dbName);
  const logger = createLogger({ level: 'silent' });

  const ctx = {
    db,
    config,
    logger,
    users: new Map(),
    quickScanBehaviour: quickScan.normal,
    authDown: false,
    publisher: new FakePublisher(),
    requests: [],
  };

  const fetchImpl = async (url, init = {}) => {
    ctx.requests.push({ url: String(url), init });
    if (String(url).startsWith(config.authServiceUrl)) {
      if (ctx.authDown) throw new TypeError('fetch failed');
      const email = new URL(url).searchParams.get('email');
      const user = ctx.users.get(email);
      return user ? jsonResponse(200, { user }) : jsonResponse(404, { error: { code: 'NOT_FOUND' } });
    }
    return ctx.quickScanBehaviour(url, init);
  };

  ctx.rebuild = () => {
    Object.assign(ctx, createApp({ mongoClient, db, config, logger, publisher: ctx.publisher, fetchImpl }));
    ctx.relay = new OutboxRelay({
      transferService: ctx.transferService,
      transactions: ctx.transactions,
      metrics: ctx.metrics,
      logger,
      intervalMs: 1000,
      pendingRecoverySeconds: 30,
    });
  };
  ctx.rebuild();
  await ctx.transactions.ensureIndexes();
  await ctx.idempotency.ensureIndexes();

  ctx.addUser = (email, role) => {
    const user = makeUser(email, role);
    ctx.users.set(email, user);
    return user;
  };
  ctx.tokenFor = (user) => signAccessToken(user, { secret: JWT_SECRET, expiresIn: '5m' });
  ctx.reset = async () => {
    await Promise.all(['wallets', 'transactions', 'idempotency_keys'].map((c) => db.collection(c).deleteMany({})));
    ctx.users.clear();
    ctx.quickScanBehaviour = quickScan.normal;
    ctx.authDown = false;
    ctx.publisher = new FakePublisher();
    ctx.requests = [];
    ctx.rebuild();
  };
  ctx.stop = async () => {
    await mongoClient.close();
    await replSet.stop();
  };
  return ctx;
}

module.exports = { startTestApp, testEnv, quickScan, features, SERVICE_TOKEN, JWT_SECRET };
