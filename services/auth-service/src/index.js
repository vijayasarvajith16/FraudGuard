'use strict';

const { MongoClient } = require('mongodb');
const { loadConfig } = require('./config');
const { createLogger } = require('./logger');
const { createApp } = require('./app');
const { bootstrapAdmin } = require('./bootstrapAdmin');

const SHUTDOWN_TIMEOUT_MS = 10_000;

async function main() {
  const config = loadConfig();
  const logger = createLogger({ level: config.logLevel, serviceName: config.serviceName });

  const mongo = new MongoClient(config.mongo.uri, {
    appName: config.serviceName,
    serverSelectionTimeoutMS: 5_000,
    maxPoolSize: 20,
  });
  await mongo.connect();
  const db = mongo.db(config.mongo.dbName);
  logger.info({ db: config.mongo.dbName }, 'connected to MongoDB');

  const { app, users } = createApp({ db, config, logger });
  await users.ensureIndexes();
  await bootstrapAdmin({ users, admin: config.admin, bcryptRounds: config.bcryptRounds, logger });

  const server = app.listen(config.port, () => {
    logger.info({ port: config.port, version: config.version }, 'auth-service listening');
  });

  let shuttingDown = false;
  async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');
    const forceExit = setTimeout(() => {
      logger.error('graceful shutdown timed out, forcing exit');
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    forceExit.unref();

    server.close(async () => {
      await mongo.close().catch((err) => logger.error({ err }, 'error closing MongoDB'));
      logger.info('shutdown complete');
      process.exit(0);
    });
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  // The logger may not exist yet (e.g. invalid config), so write a JSON line directly.
  process.stderr.write(
    `${JSON.stringify({ level: 'fatal', service: 'auth-service', msg: 'startup failed', err: err.message })}\n`,
  );
  process.exit(1);
});
