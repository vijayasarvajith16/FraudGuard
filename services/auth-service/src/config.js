'use strict';

const { z } = require('zod');

const emptyToUndefined = (value) => (value === '' ? undefined : value);

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    SERVICE_NAME: z.string().default('auth-service'),
    PORT: z.coerce.number().int().min(1).max(65535).default(3001),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
    TRUST_PROXY: z.coerce.number().int().min(0).default(0),

    MONGO_URI: z.string().min(1, 'MONGO_URI is required'),
    MONGO_DB: z.string().min(1).default('fraudguard_auth'),

    JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
    JWT_EXPIRES_IN: z
      .string()
      .regex(/^\d+[smhd]$/, 'JWT_EXPIRES_IN must look like 15m, 2h, 1d')
      .default('15m'),
    BCRYPT_ROUNDS: z.coerce.number().int().min(4).max(15).default(12),
    LOGIN_RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(5),
    LOGIN_RATE_LIMIT_WINDOW_MS: z.coerce
      .number()
      .int()
      .min(1000)
      .default(15 * 60 * 1000),

    INTERNAL_SERVICE_TOKEN: z.string().min(32, 'INTERNAL_SERVICE_TOKEN must be at least 32 characters'),

    ADMIN_EMAIL: z.preprocess(emptyToUndefined, z.email().optional()),
    ADMIN_PASSWORD: z.preprocess(emptyToUndefined, z.string().min(12).optional()),
  })
  .refine((env) => Boolean(env.ADMIN_EMAIL) === Boolean(env.ADMIN_PASSWORD), {
    message: 'ADMIN_EMAIL and ADMIN_PASSWORD must be set together',
    path: ['ADMIN_EMAIL'],
  });

const DURATION_UNITS = { s: 1, m: 60, h: 3600, d: 86400 };

function durationToSeconds(value) {
  const unit = value.slice(-1);
  return Number(value.slice(0, -1)) * DURATION_UNITS[unit];
}

/**
 * Parse and validate configuration from environment variables.
 * Throws with every problem listed, so a misconfigured container fails fast at startup.
 */
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
    jwt: {
      secret: c.JWT_SECRET,
      expiresIn: c.JWT_EXPIRES_IN,
      expiresInSeconds: durationToSeconds(c.JWT_EXPIRES_IN),
      issuer: 'fraudguard-auth',
      audience: 'fraudguard',
    },
    bcryptRounds: c.BCRYPT_ROUNDS,
    loginRateLimit: { max: c.LOGIN_RATE_LIMIT_MAX, windowMs: c.LOGIN_RATE_LIMIT_WINDOW_MS },
    internalServiceToken: c.INTERNAL_SERVICE_TOKEN,
    admin: c.ADMIN_EMAIL ? { email: c.ADMIN_EMAIL.toLowerCase(), password: c.ADMIN_PASSWORD } : null,
  });
}

module.exports = { loadConfig, durationToSeconds };
