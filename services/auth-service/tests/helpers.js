'use strict';

const { MongoMemoryServer } = require('mongodb-memory-server');
const { MongoClient } = require('mongodb');
const { loadConfig } = require('../src/config');
const { createLogger } = require('../src/logger');
const { createApp } = require('../src/app');

const TEST_JWT_SECRET = 'test-jwt-secret-that-is-at-least-32-characters-long';
const TEST_SERVICE_TOKEN = 'test-internal-service-token-at-least-32-chars';

function testEnv(overrides = {}) {
  return {
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    MONGO_URI: 'mongodb://placeholder',
    MONGO_DB: 'fraudguard_auth_test',
    JWT_SECRET: TEST_JWT_SECRET,
    INTERNAL_SERVICE_TOKEN: TEST_SERVICE_TOKEN,
    BCRYPT_ROUNDS: '4',
    ...overrides,
  };
}

/** Start an in-memory MongoDB and build the app against it. */
async function startTestApp(envOverrides = {}) {
  const mongod = await MongoMemoryServer.create();
  const client = new MongoClient(mongod.getUri());
  await client.connect();

  const config = loadConfig(testEnv({ MONGO_URI: mongod.getUri(), ...envOverrides }));
  const db = client.db(config.mongo.dbName);
  const logger = createLogger({ level: 'silent' });
  const ctx = { db, config, logger };
  // A fresh app per test isolates in-memory state such as the login rate limiter and metrics.
  const rebuild = () => Object.assign(ctx, createApp({ db, config, logger }));
  rebuild();
  await ctx.users.ensureIndexes();

  return Object.assign(ctx, {
    async reset() {
      await db.collection('users').deleteMany({});
      rebuild();
    },
    async stop() {
      await client.close();
      await mongod.stop();
    },
  });
}

module.exports = { startTestApp, testEnv, TEST_JWT_SECRET, TEST_SERVICE_TOKEN };
