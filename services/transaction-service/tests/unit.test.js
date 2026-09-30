'use strict';

const request = require('supertest');
const { toCents } = require('../src/money');
const { effectsFor, TRANSITIONS, STATUSES } = require('../src/domain/stateMachine');
const { loadConfig } = require('../src/config');
const { requestHash } = require('../src/models/idempotencyRepository');
const { neutralFeatures } = require('../src/services/transferService');
const { eventQueues } = require('../src/queue/topology');
const { testEnv, startTestApp } = require('./helpers');

describe('money', () => {
  it.each([
    [0.01, 1],
    [0.1, 10],
    [0.29, 29],
    [25.5, 2550],
    [1_000_000, 100_000_000],
  ])('converts %p to %p cents', (amount, cents) => expect(toCents(amount)).toBe(cents));

  it.each([0, -1, 1.001, 1_000_000.01, Number.NaN, Infinity, '5'])('rejects %p', (amount) => {
    expect(toCents(amount)).toBeNull();
  });
});

describe('state machine', () => {
  it('matches the contract transition table', () => {
    expect(effectsFor('PENDING', 'APPROVED')).toEqual(['settle']);
    expect(effectsFor('UNDER_REVIEW', 'ACCOUNT_FROZEN')).toEqual(['freeze']);
    expect(effectsFor('ACCOUNT_FROZEN', 'APPROVED')).toEqual(['settle', 'unfreeze']);
    expect(effectsFor('ACCOUNT_FROZEN', 'BLOCKED')).toEqual(['release']);
    expect(effectsFor('AWAITING_OTP', 'UNDER_REVIEW')).toBeNull();
  });

  it('has no transitions out of terminal states and covers every status', () => {
    expect(TRANSITIONS.APPROVED).toEqual({});
    expect(TRANSITIONS.BLOCKED).toEqual({});
    expect(Object.keys(TRANSITIONS).sort()).toEqual([...STATUSES].sort());
  });
});

describe('helpers', () => {
  it('hashes request bodies independently of key order', () => {
    expect(requestHash({ a: 1, b: { c: 2, d: 3 } })).toBe(requestHash({ b: { d: 3, c: 2 }, a: 1 }));
    expect(requestHash({ a: 1 })).not.toBe(requestHash({ a: 2 }));
  });

  it('builds the neutral feature vector from the time of day', () => {
    const f = neutralFeatures(new Date('2026-09-30T01:02:03Z'), 12.5);
    expect(f).toMatchObject({ Time: 3723, V1: 0, V28: 0, Amount: 12.5 });
    expect(Object.keys(f)).toHaveLength(30);
  });

  it('defines queues exactly as the contract', () => {
    const { routingKey, queues } = eventQueues('flagged');
    expect(routingKey).toBe('transaction.flagged');
    expect(queues.map((q) => [q.name, q.exchange])).toEqual([
      ['transactions.flagged', 'fraudguard.events'],
      ['transactions.flagged.retry', 'fraudguard.retry'],
      ['transactions.flagged.dlq', 'fraudguard.dlx'],
    ]);
    expect(queues[0].options.arguments).toEqual({
      'x-queue-type': 'quorum',
      'x-dead-letter-exchange': 'fraudguard.dlx',
      'x-dead-letter-routing-key': 'transaction.flagged',
      'x-delivery-limit': 10,
    });
    expect(queues[1].options.arguments['x-message-ttl']).toBe(5000);
  });

  it('rejects invalid configuration with every problem listed', () => {
    expect(() => loadConfig(testEnv({ RABBITMQ_URL: 'http://x', QUICK_SCAN_URL: 'nope' }))).toThrow(
      /RABBITMQ_URL[\s\S]*QUICK_SCAN_URL|QUICK_SCAN_URL[\s\S]*RABBITMQ_URL/,
    );
  });
});

describe('wallet, health and metrics endpoints', () => {
  let ctx;
  beforeAll(async () => {
    ctx = await startTestApp();
  });
  afterAll(async () => ctx.stop());

  it('returns an empty wallet for a new user and accepts deposits', async () => {
    const user = ctx.addUser('new@example.com');
    const auth = { Authorization: `Bearer ${ctx.tokenFor(user)}` };

    expect((await request(ctx.app).get('/wallet').set(auth)).body.wallet).toMatchObject({
      userId: user.id,
      balance: 0,
      held: 0,
      frozen: false,
    });
    const res = await request(ctx.app).post('/wallet/deposit').set(auth).send({ amount: 10.1 });
    expect(res.body.wallet.balance).toBe(10.1);
    await request(ctx.app).post('/wallet/deposit').set(auth).send({ amount: 0.2 });
    expect((await request(ctx.app).get('/wallet').set(auth)).body.wallet.balance).toBe(10.3);
  });

  it('reports mongo in readiness and rabbitmq as information only', async () => {
    ctx.publisher.connected = false;
    const res = await request(ctx.app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'ok', checks: { mongo: 'ok', rabbitmq: 'fail' } });
    ctx.publisher.connected = true;
  });

  it('exposes Prometheus metrics labelled by route template', async () => {
    await request(ctx.app).get('/transactions/not-a-uuid');
    const text = (await request(ctx.app).get('/metrics')).text;
    expect(text).toContain('transactions_created_total');
    expect(text).toMatch(/http_requests_total\{[^}]*route="\/transactions\/:id"[^}]*status="401"/);
  });
});
