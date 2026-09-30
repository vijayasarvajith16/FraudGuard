'use strict';

const { MongoClient } = require('mongodb');
const { loadConfig } = require('./config');
const { createLogger } = require('./logger');
const { createApp } = require('./app');
const { RabbitPublisher } = require('./queue/rabbit');
const { OutboxRelay } = require('./queue/outboxRelay');

const SHUTDOWN_TIMEOUT_MS = 10_000;

async function main() {
  const config = loadConfig();
  const logger = createLogger({ level: config.logLevel, serviceName: config.serviceName });

  const mongoClient = new MongoClient(config.mongo.uri, {
    appName: config.serviceName,
    serverSelectionTimeoutMS: 5_000,
    maxPoolSize: 20,
  });
  await mongoClient.connect();
  const db = mongoClient.db(config.mongo.dbName);
  logger.info({ db: config.mongo.dbName }, 'connected to MongoDB');

  // Connects in the background with automatic recovery; the service starts even if RabbitMQ is down.
  const publisher = new RabbitPublisher({
    url: config.rabbitmqUrl,
    logger,
    confirmTimeoutMs: config.publishConfirmTimeoutMs,
  });
  await publisher.start();

  const { app, transactions, idempotency, transferService, metrics } = createApp({
    mongoClient,
    db,
    config,
    logger,
    publisher,
  });
  await transactions.ensureIndexes();
  await idempotency.ensureIndexes();

  const relay = new OutboxRelay({
    transferService,
    transactions,
    metrics,
    logger,
    intervalMs: config.outboxRelayIntervalMs,
    pendingRecoverySeconds: config.pendingRecoverySeconds,
  });
  relay.start();

  const server = app.listen(config.port, () => {
    logger.info({ port: config.port, version: config.version }, 'transaction-service listening');
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
      await relay.stop();
      await publisher.close();
      await mongoClient.close().catch((err) => logger.error({ err }, 'error closing MongoDB'));
      logger.info('shutdown complete');
      process.exit(0);
    });
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  process.stderr.write(
    `${JSON.stringify({ level: 'fatal', service: 'transaction-service', msg: 'startup failed', err: err.message })}\n`,
  );
  process.exit(1);
});
