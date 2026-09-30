'use strict';

const request = require('supertest');
const { randomUUID } = require('node:crypto');
const { startTestApp, quickScan, SERVICE_TOKEN } = require('./helpers');

describe('internal status transitions and money effects', () => {
  let ctx;
  let alice;
  let bob;

  beforeAll(async () => {
    ctx = await startTestApp();
  });
  afterAll(async () => ctx.stop());

  beforeEach(async () => {
    await ctx.reset();
    alice = ctx.addUser('alice@example.com');
    bob = ctx.addUser('bob@example.com');
    await request(ctx.app).post('/wallet/deposit').set(auth(alice)).send({ amount: 100 });
  });

  const auth = (user) => ({ Authorization: `Bearer ${ctx.tokenFor(user)}` });
  const wallet = async (user) => (await request(ctx.app).get('/wallet').set(auth(user))).body.wallet;
  const patch = (id, body, token = SERVICE_TOKEN) =>
    request(ctx.app)
      .patch(`/internal/transactions/${id}/status`)
      .set('X-Service-Token', token)
      .send({ source: 'alerting-service', ...body });

  async function flaggedTransfer(amount = 40) {
    ctx.quickScanBehaviour = quickScan.flagged;
    const res = await request(ctx.app)
      .post('/transactions')
      .set(auth(alice))
      .set('Idempotency-Key', randomUUID())
      .send({ recipientEmail: 'bob@example.com', amount });
    return res.body.transaction.id;
  }

  const deepScan = { probability: 0.81, riskTier: 'HIGH', modelVersion: '2', scoredAt: '2026-09-30T10:00:00.000Z' };

  it('requires the service token', async () => {
    const id = await flaggedTransfer();
    expect((await patch(id, { status: 'APPROVED' }, 'wrong')).status).toBe(401);
    expect((await patch(id, { status: 'APPROVED' }, '')).status).toBe(401);
  });

  it('LOW/MEDIUM path: UNDER_REVIEW -> APPROVED settles and records the deep-scan result', async () => {
    const id = await flaggedTransfer();
    const res = await patch(id, {
      status: 'APPROVED',
      riskScore: 0.12,
      riskTier: 'LOW',
      deepScan: { ...deepScan, probability: 0.12, riskTier: 'LOW' },
      action: 'LOG',
      reason: 'tier LOW',
    });

    expect(res.status).toBe(200);
    expect(res.body.transaction).toMatchObject({ status: 'APPROVED', riskScore: 0.12, riskTier: 'LOW', action: 'LOG' });
    expect(res.body.transaction.deepScan).toMatchObject({ probability: 0.12, modelVersion: '2' });
    expect(res.body.transaction.finalizedAt).not.toBeNull();
    expect(await wallet(alice)).toMatchObject({ balance: 60, held: 0 });
    expect(await wallet(bob)).toMatchObject({ balance: 40 });
  });

  it('HIGH path: AWAITING_OTP keeps funds held, then OTP success settles', async () => {
    const id = await flaggedTransfer();
    await patch(id, { status: 'AWAITING_OTP', riskScore: 0.81, riskTier: 'HIGH', deepScan, action: 'OTP_STEP_UP' });
    expect(await wallet(alice)).toMatchObject({ balance: 60, held: 40 });

    const res = await patch(id, { status: 'APPROVED', source: 'otp', reason: 'otp verified' });
    expect(res.body.transaction.status).toBe('APPROVED');
    expect(res.body.transaction.riskTier).toBe('HIGH'); // unchanged when not supplied
    expect(res.body.transaction.statusHistory.map((h) => [h.status, h.source])).toEqual([
      ['PENDING', 'transaction-service'],
      ['UNDER_REVIEW', 'transaction-service'],
      ['AWAITING_OTP', 'alerting-service'],
      ['APPROVED', 'otp'],
    ]);
    expect(await wallet(bob)).toMatchObject({ balance: 40 });
  });

  it('OTP failure: AWAITING_OTP -> BLOCKED releases the hold back to the sender', async () => {
    const id = await flaggedTransfer();
    await patch(id, { status: 'AWAITING_OTP' });
    const res = await patch(id, { status: 'BLOCKED', source: 'otp', reason: 'otp expired' });

    expect(res.body.transaction.status).toBe('BLOCKED');
    expect(await wallet(alice)).toMatchObject({ balance: 100, held: 0 });
    expect(await wallet(bob)).toMatchObject({ balance: 0 });
  });

  it('CRITICAL path: ACCOUNT_FROZEN freezes the sender; admin approval settles and unfreezes', async () => {
    const id = await flaggedTransfer();
    await patch(id, { status: 'ACCOUNT_FROZEN', riskTier: 'CRITICAL', action: 'BLOCK_AND_FREEZE' });

    expect(await wallet(alice)).toMatchObject({ frozen: true, held: 40 });
    const blocked = await request(ctx.app)
      .post('/transactions')
      .set(auth(alice))
      .set('Idempotency-Key', randomUUID())
      .send({ recipientEmail: 'bob@example.com', amount: 1 });
    expect(blocked.status).toBe(423);
    expect((await request(ctx.app).post('/wallet/deposit').set(auth(alice)).send({ amount: 1 })).status).toBe(423);

    await patch(id, { status: 'APPROVED', source: 'admin', reason: 'manual review approved' });
    expect(await wallet(alice)).toMatchObject({ frozen: false, balance: 60, held: 0 });
    expect(await wallet(bob)).toMatchObject({ balance: 40 });
  });

  it('CRITICAL rejected: ACCOUNT_FROZEN -> BLOCKED releases funds but keeps the account frozen', async () => {
    const id = await flaggedTransfer();
    await patch(id, { status: 'ACCOUNT_FROZEN' });
    await patch(id, { status: 'BLOCKED', source: 'admin' });
    expect(await wallet(alice)).toMatchObject({ frozen: true, balance: 100, held: 0 });

    const res = await request(ctx.app)
      .post(`/internal/accounts/${alice.id}/unfreeze`)
      .set('X-Service-Token', SERVICE_TOKEN);
    expect(res.status).toBe(200);
    expect(res.body.wallet.frozen).toBe(false);
  });

  it('is idempotent for a repeated status and rejects invalid transitions', async () => {
    const id = await flaggedTransfer();
    await patch(id, { status: 'APPROVED' });

    const again = await patch(id, { status: 'APPROVED' });
    expect(again.status).toBe(200);
    expect(await wallet(bob)).toMatchObject({ balance: 40 }); // settled once

    const invalid = await patch(id, { status: 'BLOCKED' });
    expect(invalid.status).toBe(409);
    expect(invalid.body.error.code).toBe('INVALID_TRANSITION');
  });

  it('applies concurrent identical updates exactly once', async () => {
    const id = await flaggedTransfer();
    const results = await Promise.all(Array.from({ length: 5 }, () => patch(id, { status: 'APPROVED' })));
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(await wallet(bob)).toMatchObject({ balance: 40 });
    expect(await wallet(alice)).toMatchObject({ balance: 60, held: 0 });
  });

  it('rolls back the status change if the money movement fails', async () => {
    const id = await flaggedTransfer();
    // Corrupt the hold: settlement must refuse rather than create money.
    await ctx.db.collection('wallets').updateOne({ _id: alice.id }, { $set: { heldCents: 0 } });

    const res = await patch(id, { status: 'APPROVED' });
    expect(res.status).toBe(500);
    expect((await ctx.db.collection('transactions').findOne({ _id: id })).status).toBe('UNDER_REVIEW');
    expect(await wallet(bob)).toMatchObject({ balance: 0 });
  });

  it.each([
    ['unknown status', { status: 'PENDING' }],
    ['bad risk score', { status: 'APPROVED', riskScore: 1.5 }],
    ['unknown source', { status: 'APPROVED', source: 'someone' }],
    ['unknown field', { status: 'APPROVED', extra: 1 }],
  ])('validates the body: %s', async (_label, body) => {
    const id = await flaggedTransfer();
    expect((await patch(id, body)).status).toBe(400);
  });

  it('returns 404 for an unknown transaction or wallet', async () => {
    expect((await patch(randomUUID(), { status: 'APPROVED' })).status).toBe(404);
    const res = await request(ctx.app)
      .post(`/internal/accounts/${randomUUID()}/unfreeze`)
      .set('X-Service-Token', SERVICE_TOKEN);
    expect(res.status).toBe(404);
  });
});

describe('outbox relay: interrupted PENDING recovery', () => {
  let ctx;
  beforeAll(async () => {
    ctx = await startTestApp();
  });
  afterAll(async () => ctx.stop());

  it('moves a stale PENDING transfer to UNDER_REVIEW and publishes it', async () => {
    const alice = ctx.addUser('alice@example.com');
    const bob = ctx.addUser('bob@example.com');
    await ctx.wallets.deposit(alice.id, 5000);

    // Simulate a crash after the create transaction committed but before the quick-scan decision.
    const created = new Date(Date.now() - 120_000);
    const doc = {
      _id: randomUUID(),
      userId: alice.id,
      recipientId: bob.id,
      amountCents: 1000,
      currency: 'USD',
      description: null,
      features: { Time: 1, ...Object.fromEntries(Array.from({ length: 28 }, (_, i) => [`V${i + 1}`, 0])), Amount: 10 },
      status: 'PENDING',
      riskScore: null,
      riskTier: null,
      quickScan: null,
      deepScan: null,
      action: null,
      statusHistory: [{ status: 'PENDING', at: created, source: 'transaction-service', reason: null }],
      idempotencyKey: 'crashed-request',
      outbox: null,
      createdAt: created,
      updatedAt: created,
      finalizedAt: null,
    };
    await ctx.wallets.hold(alice.id, 1000);
    await ctx.transactions.insert(doc);

    await ctx.relay.tick();

    const stored = await ctx.transactions.findById(doc._id);
    expect(stored.status).toBe('UNDER_REVIEW');
    expect(stored.quickScan.reason).toBe('QUICK_SCAN_UNAVAILABLE');
    expect(stored.statusHistory.at(-1).reason).toBe('recovered after interruption');
    expect(ctx.publisher.published).toHaveLength(1);
    expect((await ctx.wallets.findById(alice.id)).heldCents).toBe(1000);
  });
});
