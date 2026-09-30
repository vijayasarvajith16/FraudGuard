'use strict';

const request = require('supertest');
const { parsePolicy, InvalidPolicyError } = require('../src/policy/tierActions');
const { handleDelivery } = require('../src/queue/consumer');
const { PermanentProcessingError } = require('../src/services/alertingService');
const { TransactionServiceError } = require('../src/clients/transactionClient');
const { createMetrics } = require('../src/metrics');
const { createLogger } = require('../src/logger');
const { loadConfig } = require('../src/config');
const { DEFAULT_POLICY, scoredEvent, startTestApp, testEnv } = require('./helpers');

describe('tier-action policy validation', () => {
  const base = () => JSON.parse(DEFAULT_POLICY);
  const withTier = (tier, value) => {
    const p = base();
    p.tiers[tier] = value;
    return JSON.stringify(p);
  };

  it('accepts the shipped default policy', () => {
    expect(parsePolicy(DEFAULT_POLICY).tiers.HIGH.action).toBe('OTP_STEP_UP');
  });

  it.each([
    ['invalid JSON', '{nope', /not valid JSON/],
    ['missing tier', JSON.stringify({ version: 1, tiers: { LOW: base().tiers.LOW } }), /MEDIUM/],
    ['wrong version', JSON.stringify({ ...base(), version: 2 }), /version/],
    [
      'status that contradicts the action',
      withTier('LOW', { action: 'LOG', resultingStatus: 'AWAITING_OTP', notifyUser: false }),
      /LOG must result in APPROVED/,
    ],
    [
      'OTP without notifying the user',
      withTier('HIGH', { action: 'OTP_STEP_UP', resultingStatus: 'AWAITING_OTP', notifyUser: false }),
      /requires notifyUser/,
    ],
    [
      'block without a review case',
      withTier('CRITICAL', { action: 'BLOCK_AND_FREEZE', resultingStatus: 'ACCOUNT_FROZEN', notifyUser: true }),
      /openReviewCase/,
    ],
    [
      'review case on a non-block action',
      withTier('MEDIUM', { action: 'NOTIFY', resultingStatus: 'APPROVED', notifyUser: true, openReviewCase: true }),
      /openReviewCase/,
    ],
    ['unknown field', withTier('LOW', { ...base().tiers.LOW, severity: 'x' }), /severity|Unrecognized/],
  ])('rejects %s', (_label, text, message) => {
    expect(() => parsePolicy(text)).toThrow(InvalidPolicyError);
    expect(() => parsePolicy(text)).toThrow(message);
  });
});

describe('policy reloading', () => {
  let ctx;
  beforeAll(async () => {
    ctx = await startTestApp({ TIER_ACTIONS_POLL_SECONDS: '1' });
  });
  afterAll(async () => ctx.stop());

  it('reports unchanged content, loads a valid change and keeps the last good policy on an invalid one', async () => {
    expect((await ctx.policy.reload()).result).toBe('unchanged');

    const changed = JSON.parse(DEFAULT_POLICY);
    changed.tiers.MEDIUM = { action: 'LOG', resultingStatus: 'APPROVED', notifyUser: false };
    ctx.writePolicy(JSON.stringify(changed));
    expect((await ctx.policy.reload()).result).toBe('loaded');
    expect(ctx.policy.forTier('MEDIUM').action).toBe('LOG');

    ctx.writePolicy('not json');
    expect((await ctx.policy.reload()).result).toBe('invalid');
    expect(ctx.policy.forTier('MEDIUM').action).toBe('LOG');

    const text = (await request(ctx.app).get('/metrics')).text;
    expect(text).toMatch(/tier_actions_config_reloads_total\{result="invalid",service="alerting-service"\} 1/);
  });

  it('picks up a file change by polling', async () => {
    ctx.writePolicy(DEFAULT_POLICY);
    await ctx.policy.reload();
    ctx.policy.startPolling();
    const changed = JSON.parse(DEFAULT_POLICY);
    changed.tiers.HIGH = { action: 'NOTIFY', resultingStatus: 'APPROVED', notifyUser: true };
    ctx.writePolicy(JSON.stringify(changed));

    await new Promise((r) => setTimeout(r, 1500));
    ctx.policy.stopPolling();
    expect(ctx.policy.forTier('HIGH').action).toBe('NOTIFY');
  });

  it('refuses to start with an invalid policy', async () => {
    ctx.writePolicy('{}');
    ctx.policy.sha256 = null;
    ctx.policy.policy = null;
    await expect(ctx.policy.load()).rejects.toThrow(/cannot start/);
  });
});

describe('consumer delivery handling', () => {
  class FakeChannel {
    constructor({ failPublish = false } = {}) {
      this.acked = 0;
      this.nacks = [];
      this.published = [];
      this.failPublish = failPublish;
    }
    ack() {
      this.acked += 1;
    }
    nack(_msg, allUpTo, requeue) {
      this.nacks.push({ allUpTo, requeue });
    }
    publish(exchange, routingKey, content, options, cb) {
      if (this.failPublish) return cb(new Error('channel closed'));
      this.published.push({ exchange, routingKey, options });
      return cb(null);
    }
  }

  const msg = (body, headers = {}) => ({
    content: Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)),
    properties: { messageId: 'm1', headers },
  });
  const run = async (channel, service, message, maxRetries = 3) => {
    const metrics = createMetrics({ serviceName: 'alerting-service' });
    const outcome = await handleDelivery({
      channel,
      msg: message,
      service,
      metrics,
      logger: createLogger({ level: 'silent' }),
      maxRetries,
    });
    return { outcome, metrics };
  };
  const serviceReturning = (value) => ({ processScoredEvent: async () => value });
  const serviceThrowing = (err) => ({
    processScoredEvent: async () => {
      throw err;
    },
  });

  it('acks a processed event and a duplicate', async () => {
    const ch = new FakeChannel();
    expect((await run(ch, serviceReturning('applied'), msg(scoredEvent()))).outcome).toBe('ok');
    expect((await run(ch, serviceReturning('duplicate'), msg(scoredEvent()))).outcome).toBe('duplicate');
    expect(ch.acked).toBe(2);
  });

  it.each([
    ['not JSON', 'nope'],
    ['wrong event type', { ...scoredEvent(), eventType: 'transaction.flagged' }],
    ['bad tier', (() => {
      const e = scoredEvent();
      e.payload.riskTier = 'SEVERE';
      return e;
    })()], // prettier-ignore
  ])('dead-letters a poison message (%s) without calling the service', async (_label, body) => {
    const ch = new FakeChannel();
    const service = { processScoredEvent: jest.fn() };
    expect((await run(ch, service, msg(body))).outcome).toBe('dead_lettered');
    expect(ch.nacks).toEqual([{ allUpTo: false, requeue: false }]);
    expect(service.processScoredEvent).not.toHaveBeenCalled();
  });

  it('dead-letters a permanent failure immediately', async () => {
    const ch = new FakeChannel();
    const { outcome } = await run(ch, serviceThrowing(new PermanentProcessingError('404')), msg(scoredEvent()));
    expect(outcome).toBe('dead_lettered');
    expect(ch.published).toHaveLength(0);
  });

  it('schedules a retry with an incremented count for a transient failure', async () => {
    const ch = new FakeChannel();
    const err = new TransactionServiceError('transient', 'down');
    const { outcome } = await run(
      ch,
      serviceThrowing(err),
      msg(scoredEvent(), { 'x-retry-count': 1, 'x-request-id': 'r' }),
    );
    expect(outcome).toBe('retry');
    expect(ch.published[0]).toMatchObject({
      exchange: 'fraudguard.retry',
      routingKey: 'transaction.scored',
      options: { headers: { 'x-retry-count': 2, 'x-request-id': 'r' }, persistent: true },
    });
    expect(ch.acked).toBe(1);
  });

  it('dead-letters when retries are exhausted, and requeues if the retry cannot be published', async () => {
    const err = new TransactionServiceError('transient', 'down');
    const exhausted = new FakeChannel();
    expect((await run(exhausted, serviceThrowing(err), msg(scoredEvent(), { 'x-retry-count': 3 }))).outcome).toBe(
      'dead_lettered',
    );
    const broken = new FakeChannel({ failPublish: true });
    expect((await run(broken, serviceThrowing(err), msg(scoredEvent()))).outcome).toBe('requeued');
    expect(broken.nacks).toEqual([{ allUpTo: false, requeue: true }]);
  });
});

describe('configuration', () => {
  it('keeps the simulated OTP off unless explicitly enabled', () => {
    const env = testEnv({ MONGO_URI: 'mongodb://x' });
    delete env.EXPOSE_SIMULATED_OTP;
    expect(loadConfig(env).otp.exposeSimulated).toBe(false);
    expect(loadConfig({ ...env, EXPOSE_SIMULATED_OTP: 'false' }).otp.exposeSimulated).toBe(false);
    expect(loadConfig({ ...env, EXPOSE_SIMULATED_OTP: 'true' }).otp.exposeSimulated).toBe(true);
  });

  it('requires a strong OTP secret', () => {
    expect(() => loadConfig(testEnv({ OTP_SECRET: 'short' }))).toThrow(/OTP_SECRET/);
  });
});

describe('health', () => {
  let ctx;
  beforeAll(async () => {
    ctx = await startTestApp();
  });
  afterAll(async () => ctx.stop());

  it('reports mongo and policy readiness', async () => {
    const res = await request(ctx.app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.checks).toEqual({ mongo: 'ok', policy: 'ok' });
  });
});
