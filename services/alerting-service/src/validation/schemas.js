'use strict';

const { z } = require('zod');

const TIERS = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];
const probability = z.number().min(0).max(1);

/** transaction.scored, version 1 (docs/contracts.md §3.4). Anything else is a poison message. */
const scoredEventSchema = z.strictObject({
  eventId: z.uuid(),
  eventType: z.literal('transaction.scored'),
  version: z.literal(1),
  idempotencyKey: z.string().min(1).max(200),
  occurredAt: z.iso.datetime(),
  producer: z.string(),
  payload: z.strictObject({
    transactionId: z.uuid(),
    userId: z.uuid(),
    recipientId: z.uuid(),
    amount: z.number().positive(),
    currency: z.literal('USD'),
    probability,
    riskTier: z.enum(TIERS),
    thresholds: z.strictObject({ medium: probability, high: probability, critical: probability }),
    modelVersion: z.string().max(64),
    quickScan: z.record(z.string(), z.unknown()),
    scoredAt: z.iso.datetime(),
  }),
});

const otpVerifySchema = z.strictObject({
  transactionId: z.uuid(),
  code: z.string().regex(/^\d{6}$/, 'must be 6 digits'),
});

const reviewDecisionSchema = z.strictObject({
  decision: z.enum(['APPROVE', 'REJECT']),
  note: z.string().trim().max(500).optional(),
});

const reviewListQuerySchema = z.strictObject({ status: z.enum(['OPEN', 'RESOLVED']).optional() });
const alertListQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().max(200).optional(),
});
const idParamSchema = z.strictObject({ id: z.uuid() });
const userIdParamSchema = z.strictObject({ userId: z.uuid() });

module.exports = {
  scoredEventSchema,
  otpVerifySchema,
  reviewDecisionSchema,
  reviewListQuerySchema,
  alertListQuerySchema,
  idParamSchema,
  userIdParamSchema,
};
