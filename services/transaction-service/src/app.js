'use strict';

const express = require('express');
const helmet = require('helmet');
const pinoHttp = require('pino-http');

const { requestId } = require('./middleware/requestId');
const { createJwtAuth } = require('./middleware/jwtAuth');
const { errorHandler, notFoundHandler } = require('./middleware/errorHandler');
const { WalletRepository } = require('./models/walletRepository');
const { TransactionRepository } = require('./models/transactionRepository');
const { IdempotencyRepository } = require('./models/idempotencyRepository');
const { TransferService } = require('./services/transferService');
const { createAuthClient } = require('./clients/authClient');
const { createQuickScanClient } = require('./clients/quickScanClient');
const { createControllers } = require('./controllers/transactionController');
const { createWalletRouter, createTransactionRouter, createInternalRouter, createHealthRouter } = require('./routes');
const { createMetrics } = require('./metrics');

/**
 * Build the app from injected dependencies so tests can use an in-memory MongoDB replica set,
 * a fake publisher and stub HTTP dependencies without starting a server.
 */
function createApp({ mongoClient, db, config, logger, publisher, fetchImpl = fetch }) {
  const app = express();
  const metrics = createMetrics({ serviceName: config.serviceName });
  const wallets = new WalletRepository(db);
  const transactions = new TransactionRepository(db);
  const idempotency = new IdempotencyRepository(db);

  const transferService = new TransferService({
    mongoClient,
    wallets,
    transactions,
    idempotency,
    lookupUser: createAuthClient({
      baseUrl: config.authServiceUrl,
      serviceToken: config.internalServiceToken,
      timeoutMs: config.authLookupTimeoutMs,
      fetchImpl,
    }),
    quickScan: createQuickScanClient({
      baseUrl: config.quickScanUrl,
      timeoutMs: config.quickScanTimeoutMs,
      metrics,
      fetchImpl,
    }),
    publisher,
    metrics,
    logger,
  });
  const controllers = createControllers({ transferService, wallets, transactions });
  const { requireAuth } = createJwtAuth({ secret: config.jwtSecret });

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

  app.use(createHealthRouter({ db, publisher, config, metrics }));
  app.use('/wallet', createWalletRouter({ controllers, requireAuth }));
  app.use('/transactions', createTransactionRouter({ controllers, requireAuth }));
  app.use('/internal', createInternalRouter({ controllers, internalServiceToken: config.internalServiceToken }));
  app.use(notFoundHandler);
  app.use(errorHandler);

  return { app, metrics, wallets, transactions, idempotency, transferService };
}

module.exports = { createApp };
