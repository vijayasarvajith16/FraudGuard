'use strict';

const request = require('supertest');
const { startTestApp, scoredEvent, respond, DEFAULT_POLICY } = require('./helpers');
const { PermanentProcessingError } = require('../src/services/alertingService');
const { TransactionServiceError } = require('../src/clients/transactionClient');

describe('processing transaction.scored events', () => {
  let ctx;
  beforeAll(async () => {
    ctx = await startTestApp();
  });
  afterAll(async () => ctx.stop());
  beforeEach(async () => ctx.reset());

  const process = (event) => ctx.service.processScoredEvent(event, { requestId: 'req-1' });
  const alertsOf = (userId) => ctx.db.collection('alerts').find({ userId }).toArray();
  const feed = async (userId) =>
    (
      await request(ctx.app)
        .get('/alerts')
        .set('Authorization', `Bearer ${ctx.tokenFor({ id: userId, role: 'user' })}`)
    ).body.items;

  it('LOW: approves, logs an audit-only alert and records the event', async () => {
    const event = scoredEvent({ tier: 'LOW', probability: 0.12 });
    expect(await process(event)).toBe('applied');

    const [patch] = ctx.txService.patches();
    expect(patch.url).toBe(`http://transactions.test/internal/transactions/${event.payload.transactionId}/status`);
    expect(patch.body).toEqual({
      status: 'APPROVED',
      riskScore: 0.12,
      riskTier: 'LOW',
      deepScan: { probability: 0.12, riskTier: 'LOW', modelVersion: '2', scoredAt: event.payload.scoredAt },
      action: 'LOG',
      source: 'alerting-service',
      reason: 'tier LOW -> LOG',
    });
    const [alert] = await alertsOf(event.payload.userId);
    expect(alert).toMatchObject({ visible: false, channel: 'LOG', action: 'LOG' });
    expect(await feed(event.payload.userId)).toEqual([]);
    expect(await ctx.processed.has(event.idempotencyKey)).toBe(true);
  });

  it('MEDIUM: approves and notifies the user', async () => {
    const event = scoredEvent({ tier: 'MEDIUM', probability: 0.5 });
    await process(event);

    expect(ctx.txService.patches()[0].body).toMatchObject({ status: 'APPROVED', action: 'NOTIFY' });
    const items = await feed(event.payload.userId);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ riskTier: 'MEDIUM', action: 'NOTIFY', channel: 'SIMULATED', read: false });
    expect(items[0].message).toContain('$42.50');
    expect(items[0].simulatedOtp).toBeUndefined();
  });

  it('HIGH: creates an OTP challenge, shows the simulated code and holds the transfer', async () => {
    const event = scoredEvent({ tier: 'HIGH' });
    await process(event);

    expect(ctx.txService.patches()[0].body).toMatchObject({ status: 'AWAITING_OTP', action: 'OTP_STEP_UP' });
    const [alert] = await feed(event.payload.userId);
    expect(alert.simulatedOtp).toMatch(/^\d{6}$/);
    expect(alert.simulatedOtp).toBe(ctx.service.otpCodeFor(event.payload.transactionId));
    const challenge = await ctx.db.collection('otp_challenges').findOne({ _id: event.payload.transactionId });
    expect(challenge).toMatchObject({ status: 'OPEN', attemptsRemaining: 3, userId: event.payload.userId });
    expect(challenge.codeHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(challenge)).not.toContain(alert.simulatedOtp);
  });

  it('CRITICAL: opens a manual review case and freezes the account', async () => {
    const event = scoredEvent({ tier: 'CRITICAL', probability: 0.97 });
    await process(event);

    expect(ctx.txService.patches()[0].body).toMatchObject({ status: 'ACCOUNT_FROZEN', action: 'BLOCK_AND_FREEZE' });
    const review = await ctx.db.collection('review_cases').findOne({ transactionId: event.payload.transactionId });
    expect(review).toMatchObject({ status: 'OPEN', riskScore: 0.97, riskTier: 'CRITICAL', amount: 42.5 });
    expect((await request(ctx.app).get('/metrics')).text).toMatch(/review_cases_open\{service="alerting-service"\} 1/);
  });

  it('acks a duplicate event without acting again', async () => {
    const event = scoredEvent({ tier: 'CRITICAL' });
    await process(event);
    expect(await process({ ...event, eventId: event.eventId })).toBe('duplicate');
    expect(ctx.txService.patches()).toHaveLength(1);
  });

  it('reprocessing after a transient failure never duplicates side effects or changes the OTP', async () => {
    const event = scoredEvent({ tier: 'HIGH' });
    ctx.txService.respond = respond.status(503, 'SERVICE_UNAVAILABLE');
    await expect(process(event)).rejects.toMatchObject({ name: 'TransactionServiceError', kind: 'transient' });
    const firstCode = (await alertsOf(event.payload.userId))[0].simulatedOtp;

    ctx.txService.respond = null;
    expect(await process(event)).toBe('applied');

    const alerts = await alertsOf(event.payload.userId);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].simulatedOtp).toBe(firstCode);
    expect(await ctx.db.collection('otp_challenges').countDocuments()).toBe(1);
  });

  it('treats 409 from transaction-service as already finalized', async () => {
    ctx.txService.respond = respond.status(409, 'INVALID_TRANSITION');
    const event = scoredEvent({ tier: 'LOW' });
    expect(await process(event)).toBe('already_final');
    expect(await ctx.processed.has(event.idempotencyKey)).toBe(true);
  });

  it.each([
    [404, 'NOT_FOUND', PermanentProcessingError],
    [400, 'VALIDATION_ERROR', PermanentProcessingError],
    [500, 'INTERNAL_ERROR', TransactionServiceError],
  ])('classifies HTTP %i from transaction-service', async (status, code, errorType) => {
    ctx.txService.respond = respond.status(status, code);
    const event = scoredEvent({ tier: 'LOW' });
    await expect(process(event)).rejects.toBeInstanceOf(errorType);
    expect(await ctx.processed.has(event.idempotencyKey)).toBe(false);
  });

  it('treats a transaction-service timeout as transient', async () => {
    ctx.txService.respond = respond.hang();
    await expect(process(scoredEvent({ tier: 'LOW' }))).rejects.toMatchObject({ kind: 'transient' });
  });

  it('applies a changed policy without a restart', async () => {
    const policy = JSON.parse(DEFAULT_POLICY);
    policy.tiers.MEDIUM = { action: 'OTP_STEP_UP', resultingStatus: 'AWAITING_OTP', notifyUser: true };
    ctx.writePolicy(JSON.stringify(policy));
    expect((await ctx.policy.reload()).result).toBe('loaded');

    await process(scoredEvent({ tier: 'MEDIUM', probability: 0.5 }));
    expect(ctx.txService.patches()[0].body).toMatchObject({ status: 'AWAITING_OTP', action: 'OTP_STEP_UP' });
  });
});
