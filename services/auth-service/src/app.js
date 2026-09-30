'use strict';

const express = require('express');
const helmet = require('helmet');
const pinoHttp = require('pino-http');

const { requestId } = require('./middleware/requestId');
const { createJwtAuth } = require('./middleware/jwtAuth');
const { errorHandler, notFoundHandler } = require('./middleware/errorHandler');
const { UserRepository } = require('./models/userRepository');
const { createAuthController } = require('./controllers/authController');
const { createAuthRouter } = require('./routes/authRoutes');
const { createInternalRouter } = require('./routes/internalRoutes');
const { createHealthRouter } = require('./routes/healthRoutes');
const { createMetrics } = require('./metrics');

/**
 * Build the Express app from injected dependencies (db, config, logger), so tests
 * can run it against an in-memory MongoDB without starting a server.
 */
function createApp({ db, config, logger }) {
  const app = express();
  const metrics = createMetrics({ serviceName: config.serviceName });
  const users = new UserRepository(db);
  const controller = createAuthController({ users, config, metrics });
  const { requireAuth } = createJwtAuth({
    secret: config.jwt.secret,
    issuer: config.jwt.issuer,
    audience: config.jwt.audience,
  });

  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);

  app.use(requestId);
  app.use(
    pinoHttp({
      logger,
      genReqId: (req) => req.id,
      customLogLevel: (_req, res, err) =>
        err || res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info',
      // Probes and scrapes are high-frequency noise.
      autoLogging: { ignore: (req) => req.url.startsWith('/health') || req.url === '/metrics' },
    }),
  );
  app.use(helmet());
  app.use(metrics.httpMetricsMiddleware);
  app.use(express.json({ limit: '100kb' }));

  app.use(createHealthRouter({ db, config, metrics }));
  app.use('/auth', createAuthRouter({ controller, requireAuth, loginRateLimit: config.loginRateLimit }));
  app.use('/internal', createInternalRouter({ controller, internalServiceToken: config.internalServiceToken }));

  app.use(notFoundHandler);
  app.use(errorHandler);

  return { app, users, metrics };
}

module.exports = { createApp };
