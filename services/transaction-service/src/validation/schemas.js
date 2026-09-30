'use strict';

const { z } = require('zod');
const { toCents } = require('../money');

const FEATURE_COLUMNS = Object.freeze(['Time', ...Array.from({ length: 28 }, (_, i) => `V${i + 1}`), 'Amount']);
const RISK_TIERS = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];
const ACTIONS = ['NONE', 'LOG', 'NOTIFY', 'OTP_STEP_UP', 'BLOCK_AND_FREEZE'];

const finite = z.number().refine(Number.isFinite, 'must be a finite number');

// docs/contracts.md §0.8: exactly these 30 keys, finite numbers, Time and Amount >= 0.
const featuresSchema = z.strictObject(
  Object.fromEntries(
    FEATURE_COLUMNS.map((name) => [name, name === 'Time' || name === 'Amount' ? finite.min(0) : finite]),
  ),
);

const amountSchema = z
  .number()
  .refine((v) => toCents(v) !== null, 'must be > 0, at most 1,000,000.00, with at most 2 decimal places');

const email = z.string().trim().toLowerCase().max(254).pipe(z.email('must be a valid email address'));

const transferSchema = z.strictObject({
  recipientEmail: email,
  amount: amountSchema,
  currency: z.literal('USD').default('USD'),
  description: z.string().trim().max(140).nullish(),
  features: featuresSchema.optional(),
});

const depositSchema = z.strictObject({ amount: amountSchema });

const idempotencyKeySchema = z
  .string({ error: 'Idempotency-Key header is required' })
  .regex(/^[A-Za-z0-9_-]{8,128}$/, 'Idempotency-Key must be 8-128 characters of [A-Za-z0-9_-]');

const uuidParamSchema = z.strictObject({ id: z.uuid('must be a UUID') });
const userIdParamSchema = z.strictObject({ userId: z.uuid('must be a UUID') });

const listQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().max(200).optional(),
  status: z.enum(['PENDING', 'APPROVED', 'UNDER_REVIEW', 'BLOCKED', 'ACCOUNT_FROZEN', 'AWAITING_OTP']).optional(),
});

const statusUpdateSchema = z.strictObject({
  status: z.enum(['APPROVED', 'UNDER_REVIEW', 'BLOCKED', 'ACCOUNT_FROZEN', 'AWAITING_OTP']),
  riskScore: z.number().min(0).max(1).nullish(),
  riskTier: z.enum(RISK_TIERS).nullish(),
  deepScan: z
    .strictObject({
      probability: z.number().min(0).max(1),
      riskTier: z.enum(RISK_TIERS),
      modelVersion: z.string().max(64),
      scoredAt: z.iso.datetime(),
    })
    .nullish(),
  action: z.enum(ACTIONS).nullish(),
  source: z.enum(['alerting-service', 'admin', 'otp']),
  reason: z.string().max(200).nullish(),
});

module.exports = {
  FEATURE_COLUMNS,
  RISK_TIERS,
  ACTIONS,
  featuresSchema,
  transferSchema,
  depositSchema,
  idempotencyKeySchema,
  uuidParamSchema,
  userIdParamSchema,
  listQuerySchema,
  statusUpdateSchema,
};
