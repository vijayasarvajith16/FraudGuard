'use strict';

const { z } = require('zod');

const url = z.url().refine((u) => /^https?:\/\//.test(u), 'must be an http(s) URL');

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  SERVICE_NAME: z.string().default('transaction-service'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3002),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  TRUST_PROXY: z.coerce.number().int().min(0).default(0),

  MONGO_URI: z.string().min(1, 'MONGO_URI is required'),
  MONGO_DB: z.string().min(1).default('fraudguard_transactions'),
  RABBITMQ_URL: z.string().regex(/^amqps?:\/\//, 'must be an amqp(s):// URL'),

  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  INTERNAL_SERVICE_TOKEN: z.string().min(32, 'INTERNAL_SERVICE_TOKEN must be at least 32 characters'),

  AUTH_SERVICE_URL: url,
  QUICK_SCAN_URL: url,
  QUICK_SCAN_TIMEOUT_MS: z.coerce.number().int().min(10).max(10_000).default(300),
  AUTH_LOOKUP_TIMEOUT_MS: z.coerce.number().int().min(10).max(10_000).default(2000),

  OUTBOX_RELAY_INTERVAL_MS: z.coerce.number().int().min(100).default(5000),
  PENDING_RECOVERY_SECONDS: z.coerce.number().int().min(1).default(30),
  PUBLISH_CONFIRM_TIMEOUT_MS: z.coerce.number().int().min(100).default(5000),
});

/** Parse and validate configuration from environment variables; throws listing every problem. */
function loadConfig(env = process.env) {
  const result = envSchema.safeParse(env);
  if (!result.success) {
    const problems = result.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid configuration:\n${problems}`);
  }
  const c = result.data;
  return Object.freeze({
    nodeEnv: c.NODE_ENV,
    serviceName: c.SERVICE_NAME,
    version: require('../package.json').version,
    port: c.PORT,
    logLevel: c.LOG_LEVEL,
    trustProxy: c.TRUST_PROXY,
    mongo: { uri: c.MONGO_URI, dbName: c.MONGO_DB },
    rabbitmqUrl: c.RABBITMQ_URL,
    jwtSecret: c.JWT_SECRET,
    internalServiceToken: c.INTERNAL_SERVICE_TOKEN,
    authServiceUrl: c.AUTH_SERVICE_URL.replace(/\/$/, ''),
    authLookupTimeoutMs: c.AUTH_LOOKUP_TIMEOUT_MS,
    quickScanUrl: c.QUICK_SCAN_URL.replace(/\/$/, ''),
    quickScanTimeoutMs: c.QUICK_SCAN_TIMEOUT_MS,
    outboxRelayIntervalMs: c.OUTBOX_RELAY_INTERVAL_MS,
    pendingRecoverySeconds: c.PENDING_RECOVERY_SECONDS,
    publishConfirmTimeoutMs: c.PUBLISH_CONFIRM_TIMEOUT_MS,
  });
}

module.exports = { loadConfig };
