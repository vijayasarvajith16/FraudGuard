'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { MongoClient } = require('mongodb');
const { loadConfig } = require('../src/config');
const { createLogger } = require('../src/logger');
const { createApp } = require('../src/app');
const { signAccessToken } = require('../src/middleware/jwtAuth');

const JWT_SECRET = 'test-jwt-secret-that-is-at-least-32-characters-long';
const SERVICE_TOKEN = 'test-internal-service-token-at-least-32-chars';
const DEFAULT_POLICY = fs.readFileSync(path.join(__dirname, '..', 'src', 'config', 'tierActions.json'), 'utf8');

function testEnv(overrides = {}) {
  return {
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    MONGO_URI: 'mongodb://placeholder',
    MONGO_DB: 'fraudguard_alerts_test',
    RABBITMQ_URL: 'amqp://localhost',
    CONSUMER_ENABLED: 'false',
    JWT_SECRET,
    INTERNAL_SERVICE_TOKEN: SERVICE_TOKEN,
    TRANSACTION_SERVICE_URL: 'http://transactions.test',
    TRANSACTION_SERVICE_TIMEOUT_MS: '200',
    TIER_ACTIONS_POLL_SECONDS: '0',
    OTP_SECRET: 'test-otp-secret-that-is-at-least-32-characters',
    EXPOSE_SIMULATED_OTP: 'true',
    ...overrides,
  };
}

const json = (status, body) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/**
 * Fake transaction-service internal API. Records calls; `respond` decides each answer
 * (default: 200 echoing the requested status).
 */
class FakeTransactionService {
  constructor() {
    this.calls = [];
    this.respond = null;
  }
  reset() {
    this.calls = [];
    this.respond = null;
  }
  fetch = async (url, init = {}) => {
    const call = { url: String(url), method: init.method, body: init.body ? JSON.parse(init.body) : undefined };
    this.calls.push(call);
    if (this.respond) {
      const res = await this.respond(call, init);
      if (res) return res;
    }
    if (call.url.includes('/unfreeze')) return json(200, { wallet: { userId: 'u', frozen: false } });
    const id = call.url.split('/transactions/')[1].split('/')[0];
    return json(200, { transaction: { id, status: call.body.status } });
  };
  patches() {
    return this.calls.filter((c) => c.method === 'PATCH');
  }
}

const respond = {
  status: (status, code) => () => json(status, { error: { code, message: code } }),
  hang: () => (_call, init) =>
    new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason))),
};

function scoredEvent({ tier = 'HIGH', probability = 0.81, transactionId = randomUUID(), userId = randomUUID() } = {}) {
  const now = new Date().toISOString();
  return {
    eventId: randomUUID(),
    eventType: 'transaction.scored',
    version: 1,
    idempotencyKey: `${transactionId}:scored`,
    occurredAt: now,
    producer: 'deep-scan-service',
    payload: {
      transactionId,
      userId,
      recipientId: randomUUID(),
      amount: 42.5,
      currency: 'USD',
      probability,
      riskTier: tier,
      thresholds: { medium: 0.3, high: 0.7, critical: 0.9 },
      modelVersion: '2',
      quickScan: { score: 0.45, threshold: 0.39, flagged: true, reason: 'ANOMALY', modelVersion: '2' },
      scoredAt: now,
    },
  };
}

async function startTestApp(envOverrides = {}) {
  const mongod = await MongoMemoryServer.create();
  const client = new MongoClient(mongod.getUri());
  await client.connect();
  const policyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fraudguard-policy-'));
  const policyPath = path.join(policyDir, 'tierActions.json');
  fs.writeFileSync(policyPath, DEFAULT_POLICY);

  const config = loadConfig(testEnv({ MONGO_URI: mongod.getUri(), TIER_ACTIONS_PATH: policyPath, ...envOverrides }));
  const db = client.db(config.mongo.dbName);
  const logger = createLogger({ level: 'silent' });
  const txService = new FakeTransactionService();
  const ctx = { db, config, logger, txService, policyPath };

  ctx.rebuild = async () => {
    Object.assign(ctx, createApp({ db, config, logger, fetchImpl: txService.fetch }));
    await ctx.ensureIndexes();
    await ctx.policy.load();
  };
  await ctx.rebuild();

  ctx.tokenFor = (user) => signAccessToken(user, { secret: JWT_SECRET, expiresIn: '5m' });
  ctx.user = (role = 'user') => ({ id: randomUUID(), email: `${randomUUID().slice(0, 8)}@example.com`, role });
  ctx.writePolicy = (text) => fs.writeFileSync(policyPath, text);
  ctx.reset = async () => {
    const names = ['alerts', 'otp_challenges', 'review_cases', 'processed_events'];
    await Promise.all(names.map((c) => db.collection(c).deleteMany({})));
    txService.reset();
    ctx.writePolicy(DEFAULT_POLICY);
    await ctx.rebuild();
  };
  ctx.stop = async () => {
    await client.close();
    await mongod.stop();
    fs.rmSync(policyDir, { recursive: true, force: true });
  };
  return ctx;
}

module.exports = { startTestApp, testEnv, scoredEvent, respond, json, DEFAULT_POLICY, SERVICE_TOKEN };
