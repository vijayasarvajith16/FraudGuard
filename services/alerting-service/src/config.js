'use strict';

const path = require('node:path');
const { z } = require('zod');

// Env booleans. (Zod 4's .default() after .transform() would skip the transform and yield the
// raw string 'false', which is truthy, so the default is applied explicitly instead.)
const bool = (defaultValue) =>
  z
    .enum(['true', 'false', '1', '0'])
    .optional()
    .transform((v) => (v === undefined ? defaultValue : v === 'true' || v === '1'));

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  SERVICE_NAME: z.string().default('alerting-service'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3003),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  TRUST_PROXY: z.coerce.number().int().min(0).default(0),

  MONGO_URI: z.string().min(1, 'MONGO_URI is required'),
  MONGO_DB: z.string().min(1).default('fraudguard_alerts'),
  RABBITMQ_URL: z.string().regex(/^amqps?:\/\//, 'must be an amqp(s):// URL'),
  CONSUMER_ENABLED: bool(true),
  PREFETCH: z.coerce.number().int().min(1).max(500).default(10),
  MAX_RETRIES: z.coerce.number().int().min(0).max(20).default(3),

  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  INTERNAL_SERVICE_TOKEN: z.string().min(32, 'INTERNAL_SERVICE_TOKEN must be at least 32 characters'),
  TRANSACTION_SERVICE_URL: z.url().refine((u) => /^https?:\/\//.test(u), 'must be an http(s) URL'),
  TRANSACTION_SERVICE_TIMEOUT_MS: z.coerce.number().int().min(100).max(30_000).default(3000),

  TIER_ACTIONS_PATH: z.string().default(path.join(__dirname, 'config', 'tierActions.json')),
  TIER_ACTIONS_POLL_SECONDS: z.coerce.number().int().min(0).default(30),

  OTP_SECRET: z.string().min(32, 'OTP_SECRET must be at least 32 characters'),
  OTP_TTL_SECONDS: z.coerce.number().int().min(30).max(3600).default(300),
  OTP_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(3),
  OTP_SWEEP_INTERVAL_SECONDS: z.coerce.number().int().min(1).default(60),
  EXPOSE_SIMULATED_OTP: bool(false),
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
    rabbitmq: { url: c.RABBITMQ_URL, consumerEnabled: c.CONSUMER_ENABLED, prefetch: c.PREFETCH },
    maxRetries: c.MAX_RETRIES,
    jwtSecret: c.JWT_SECRET,
    internalServiceToken: c.INTERNAL_SERVICE_TOKEN,
    transactionServiceUrl: c.TRANSACTION_SERVICE_URL.replace(/\/$/, ''),
    transactionServiceTimeoutMs: c.TRANSACTION_SERVICE_TIMEOUT_MS,
    tierActions: { path: c.TIER_ACTIONS_PATH, pollSeconds: c.TIER_ACTIONS_POLL_SECONDS },
    otp: {
      secret: c.OTP_SECRET,
      ttlSeconds: c.OTP_TTL_SECONDS,
      maxAttempts: c.OTP_MAX_ATTEMPTS,
      sweepIntervalSeconds: c.OTP_SWEEP_INTERVAL_SECONDS,
      exposeSimulated: c.EXPOSE_SIMULATED_OTP,
    },
  });
}

module.exports = { loadConfig };
