'use strict';

const { MongoClient } = require('mongodb');
const { loadConfig } = require('./config');
const { createLogger } = require('./logger');
const { createApp } = require('./app');
const { ScoredConsumer } = require('./queue/consumer');

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

  let consumer = null;
  const { app, service, policy, metrics, reviews, ensureIndexes } = createApp({
    db,
    config,
    logger,
    getConsumer: () => consumer,
  });
  await ensureIndexes();
  await policy.load(); // an invalid policy at startup is fatal: there is no last good one
  policy.startPolling();
  metrics.reviewCasesOpen.set(await reviews.countOpen());

  if (config.rabbitmq.consumerEnabled) {
    consumer = new ScoredConsumer({
      url: config.rabbitmq.url,
      prefetch: config.rabbitmq.prefetch,
      maxRetries: config.maxRetries,
      service,
      metrics,
      logger,
    });
    await consumer.start();
  }

  let sweeping = null;
  const sweeper = setInterval(() => {
    if (sweeping) return;
    sweeping = service
      .sweepOtps()
      .then((n) => n && logger.info({ blocked: n }, 'otp sweeper blocked stale challenges'))
      .catch((err) => logger.error({ err: err.message }, 'otp sweep failed'))
      .finally(() => (sweeping = null));
  }, config.otp.sweepIntervalSeconds * 1000);
  sweeper.unref();

  const server = app.listen(config.port, () => {
    logger.info({ port: config.port, version: config.version }, 'alerting-service listening');
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
      clearInterval(sweeper);
      policy.stopPolling();
      await sweeping;
      await consumer?.close();
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
    `${JSON.stringify({ level: 'fatal', service: 'alerting-service', msg: 'startup failed', err: err.message })}\n`,
  );
  process.exit(1);
});
