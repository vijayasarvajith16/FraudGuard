'use strict';

const express = require('express');
const helmet = require('helmet');
const pinoHttp = require('pino-http');

const { requestId } = require('./middleware/requestId');
const { createJwtAuth } = require('./middleware/jwtAuth');
const { errorHandler, notFoundHandler } = require('./middleware/errorHandler');
const { AlertRepository, OtpRepository, ReviewRepository, ProcessedEventRepository } = require('./models/repositories');
const { AlertingService } = require('./services/alertingService');
const { createTransactionClient } = require('./clients/transactionClient');
const { TierActionPolicy } = require('./policy/tierActions');
const { createAlertsRouter, createHealthRouter } = require('./routes');
const { createMetrics } = require('./metrics');

/**
 * Build the app from injected dependencies. The caller loads the policy and starts the
 * consumer, poller and sweeper (src/index.js), so tests control each piece.
 */
function createApp({ db, config, logger, fetchImpl = fetch, getConsumer = () => null }) {
  const app = express();
  const metrics = createMetrics({ serviceName: config.serviceName });
  const alerts = new AlertRepository(db);
  const otps = new OtpRepository(db);
  const reviews = new ReviewRepository(db);
  const processed = new ProcessedEventRepository(db);
  const policy = new TierActionPolicy({ ...config.tierActions, logger, metrics });
  const transactions = createTransactionClient({
    baseUrl: config.transactionServiceUrl,
    serviceToken: config.internalServiceToken,
    timeoutMs: config.transactionServiceTimeoutMs,
    fetchImpl,
  });
  const service = new AlertingService({
    policy,
    alerts,
    otps,
    reviews,
    processed,
    transactions,
    metrics,
    logger,
    otpConfig: config.otp,
  });
  const { requireAuth, requireRole } = createJwtAuth({ secret: config.jwtSecret });

  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);
  app.use(requestId);
  app.use(
    pinoHttp({
      logger,
      genReqId: (req) => req.id,
      customLogLevel: (_req, res, err) =>
        err || res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info',
      autoLogging: { ignore: (req) => req.url.startsWith('/health') || req.url === '/metrics' },
    }),
  );
  app.use(helmet());
  app.use(metrics.httpMetricsMiddleware);
  app.use(express.json({ limit: '100kb' }));

  const consumerProxy = { isConnected: () => Boolean(getConsumer()?.isConnected()) };
  app.use(createHealthRouter({ db, consumer: consumerProxy, policy, config, metrics }));
  app.use('/alerts', createAlertsRouter({ service, alerts, reviews, policy, requireAuth, requireRole }));
  app.use(notFoundHandler);
  app.use(errorHandler);

  async function ensureIndexes() {
    await Promise.all([alerts, otps, reviews, processed].map((r) => r.ensureIndexes()));
  }

  return { app, metrics, service, policy, alerts, otps, reviews, processed, ensureIndexes };
}

module.exports = { createApp };
