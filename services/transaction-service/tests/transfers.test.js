'use strict';

const request = require('supertest');
const { randomUUID } = require('node:crypto');
const { startTestApp, quickScan, features } = require('./helpers');

describe('transfers', () => {
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
    await deposit(alice, 100);
  });

  const auth = (user) => ({ Authorization: `Bearer ${ctx.tokenFor(user)}` });
  function deposit(user, amount) {
    return request(ctx.app).post('/wallet/deposit').set(auth(user)).send({ amount });
  }
  function transfer(user, body, key = randomUUID()) {
    return request(ctx.app).post('/transactions').set(auth(user)).set('Idempotency-Key', key).send(body);
  }
  async function wallet(user) {
    return (await request(ctx.app).get('/wallet').set(auth(user))).body.wallet;
  }
  const toBob = (overrides = {}) => ({ recipientEmail: 'bob@example.com', amount: 25.5, ...overrides });

  describe('normal transaction (quick-scan clean)', () => {
    it('is APPROVED with tier LOW and settles immediately', async () => {
      const res = await transfer(alice, toBob({ description: 'rent' }));

      expect(res.status).toBe(201);
      expect(res.body.transaction).toMatchObject({
        userId: alice.id,
        recipientId: bob.id,
        amount: 25.5,
        currency: 'USD',
        description: 'rent',
        status: 'APPROVED',
        riskTier: 'LOW',
        riskScore: null,
        action: 'NONE',
        quickScan: { flagged: false, reason: 'NORMAL', score: 0.3, threshold: 0.39, modelVersion: '2' },
        deepScan: null,
      });
      expect(res.body.transaction.finalizedAt).not.toBeNull();
      expect(res.body.transaction.statusHistory.map((h) => h.status)).toEqual(['PENDING', 'APPROVED']);
      expect(await wallet(alice)).toMatchObject({ balance: 74.5, held: 0 });
      expect(await wallet(bob)).toMatchObject({ balance: 25.5, held: 0 });
      expect(ctx.publisher.published).toHaveLength(0);
    });

    it('builds a neutral feature vector when none is supplied, with Amount = amount', async () => {
      const res = await transfer(alice, toBob());
      const f = res.body.transaction.features;

      expect(Object.keys(f)).toHaveLength(30);
      expect(f.Amount).toBe(25.5);
      expect(f.V1).toBe(0);
      expect(f.Time).toBeGreaterThanOrEqual(0);
      expect(f.Time).toBeLessThan(86400);
    });

    it('overwrites a client-supplied Amount feature with the transfer amount', async () => {
      const res = await transfer(alice, toBob({ features: features({ Amount: 99999, V14: -5 }) }));
      expect(res.body.transaction.features).toMatchObject({ Amount: 25.5, V14: -5 });

      const sent = JSON.parse(ctx.requests.find((r) => r.url.endsWith('/score')).init.body);
      expect(sent.features.Amount).toBe(25.5);
      expect(sent.transactionId).toBe(res.body.transaction.id);
    });
  });

  describe('flagged transaction', () => {
    it('goes UNDER_REVIEW, keeps funds held, and publishes transaction.flagged', async () => {
      ctx.quickScanBehaviour = quickScan.flagged;
      const res = await transfer(alice, toBob(), 'key-flagged-1');

      expect(res.status).toBe(201);
      const tx = res.body.transaction;
      expect(tx).toMatchObject({ status: 'UNDER_REVIEW', riskTier: null, finalizedAt: null });
      expect(tx.quickScan).toMatchObject({ flagged: true, reason: 'ANOMALY', score: 0.45 });
      expect(await wallet(alice)).toMatchObject({ balance: 74.5, held: 25.5 });
      expect(await wallet(bob)).toMatchObject({ balance: 0 });

      expect(ctx.publisher.published).toHaveLength(1);
      const { exchange, routingKey, envelope, options } = ctx.publisher.published[0];
      expect([exchange, routingKey]).toEqual(['fraudguard.events', 'transaction.flagged']);
      expect(envelope).toMatchObject({
        eventType: 'transaction.flagged',
        version: 1,
        idempotencyKey: `${tx.id}:flagged`,
        producer: 'transaction-service',
        payload: {
          transactionId: tx.id,
          userId: alice.id,
          recipientId: bob.id,
          amount: 25.5,
          currency: 'USD',
          quickScan: { score: 0.45, threshold: 0.39, flagged: true, reason: 'ANOMALY', modelVersion: '2' },
        },
      });
      expect(Object.keys(envelope.payload.features)).toHaveLength(30);
      expect(options.correlationId).toBe(tx.id);

      const stored = await ctx.db.collection('transactions').findOne({ _id: tx.id });
      expect(stored.outbox).toMatchObject({ eventId: envelope.eventId, publishedAt: expect.any(Date) });
      expect(res.body.transaction.outbox).toBeUndefined();
    });

    it.each([
      ['timeout', quickScan.hang, 'timeout'],
      ['HTTP 500', quickScan.error500, 'error'],
      ['malformed response', quickScan.malformed, 'error'],
      ['network error', quickScan.networkError, 'error'],
    ])('fails toward review when quick-scan has a %s', async (_label, behaviour, metricResult) => {
      ctx.quickScanBehaviour = behaviour;
      const res = await transfer(alice, toBob());

      expect(res.status).toBe(201);
      expect(res.body.transaction.status).toBe('UNDER_REVIEW');
      expect(res.body.transaction.quickScan).toMatchObject({
        flagged: true,
        reason: 'QUICK_SCAN_UNAVAILABLE',
        score: null,
      });
      expect(ctx.publisher.published).toHaveLength(1);

      const text = (await request(ctx.app).get('/metrics')).text;
      expect(text).toContain(`quick_scan_calls_total{result="${metricResult}",service="transaction-service"} 1`);
    });

    it('still accepts the transfer when RabbitMQ is down; the relay publishes it later', async () => {
      ctx.quickScanBehaviour = quickScan.flagged;
      ctx.publisher.fail = true;
      const res = await transfer(alice, toBob());
      expect(res.status).toBe(201);
      expect(res.body.transaction.status).toBe('UNDER_REVIEW');

      const id = res.body.transaction.id;
      let stored = await ctx.db.collection('transactions').findOne({ _id: id });
      expect(stored.outbox).toMatchObject({ publishedAt: null, attempts: 1 });

      // Broker back; the event is past the inline-publish grace period.
      ctx.publisher.fail = false;
      await ctx.db
        .collection('transactions')
        .updateOne({ _id: id }, { $set: { 'outbox.createdAt': new Date(Date.now() - 60_000) } });
      await ctx.relay.tick();

      stored = await ctx.db.collection('transactions').findOne({ _id: id });
      expect(stored.outbox.publishedAt).toBeInstanceOf(Date);
      expect(ctx.publisher.published).toHaveLength(1);
      expect(ctx.publisher.published[0].envelope.eventId).toBe(stored.outbox.eventId);
      expect((await request(ctx.app).get('/metrics')).text).toMatch(
        /outbox_pending\{service="transaction-service"\} 0/,
      );
    });
  });

  describe('idempotency', () => {
    it('replays the original transfer for the same key and body, without charging twice', async () => {
      const first = await transfer(alice, toBob(), 'same-key-123');
      const second = await transfer(alice, toBob(), 'same-key-123');

      expect(first.status).toBe(201);
      expect(second.status).toBe(200);
      expect(second.headers['idempotent-replayed']).toBe('true');
      expect(second.body.transaction.id).toBe(first.body.transaction.id);
      expect(await wallet(alice)).toMatchObject({ balance: 74.5 });
    });

    it('rejects the same key with a different body', async () => {
      await transfer(alice, toBob(), 'same-key-456');
      const res = await transfer(alice, toBob({ amount: 1 }), 'same-key-456');
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    });

    it('scopes keys per user', async () => {
      await deposit(bob, 10);
      ctx.addUser('carol@example.com');
      const a = await transfer(alice, toBob(), 'shared-key-789');
      const b = await transfer(bob, { recipientEmail: 'carol@example.com', amount: 1 }, 'shared-key-789');
      expect([a.status, b.status]).toEqual([201, 201]);
    });

    it('creates exactly one transfer for concurrent requests with the same key', async () => {
      const results = await Promise.all(Array.from({ length: 6 }, () => transfer(alice, toBob(), 'race-key-001')));

      expect(results.filter((r) => r.status === 201)).toHaveLength(1);
      expect(results.filter((r) => r.status === 200)).toHaveLength(5);
      expect(new Set(results.map((r) => r.body.transaction.id)).size).toBe(1);
      expect(await ctx.db.collection('transactions').countDocuments()).toBe(1);
      expect(await wallet(alice)).toMatchObject({ balance: 74.5 });
    });

    it.each([
      ['missing', undefined],
      ['too short', 'short'],
      ['bad characters', 'has spaces in it'],
    ])('rejects a %s Idempotency-Key', async (_label, key) => {
      const req = request(ctx.app).post('/transactions').set(auth(alice)).send(toBob());
      if (key) req.set('Idempotency-Key', key);
      const res = await req;
      expect(res.status).toBe(400);
      expect(await ctx.db.collection('transactions').countDocuments()).toBe(0);
    });
  });

  describe('rejections', () => {
    it('returns 422 INSUFFICIENT_FUNDS and changes nothing', async () => {
      const res = await transfer(alice, toBob({ amount: 100.01 }));
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('INSUFFICIENT_FUNDS');
      expect(await wallet(alice)).toMatchObject({ balance: 100, held: 0 });
      expect(await ctx.db.collection('transactions').countDocuments()).toBe(0);
      expect(await ctx.db.collection('idempotency_keys').countDocuments()).toBe(0);
    });

    it('returns 404 for an unknown recipient and 400 for a transfer to yourself', async () => {
      expect((await transfer(alice, toBob({ recipientEmail: 'nobody@example.com' }))).body.error.code).toBe(
        'RECIPIENT_NOT_FOUND',
      );
      expect((await transfer(alice, toBob({ recipientEmail: 'alice@example.com' }))).status).toBe(400);
    });

    it('returns 503 when the user directory is down', async () => {
      ctx.authDown = true;
      const res = await transfer(alice, toBob());
      expect(res.status).toBe(503);
      expect(res.body.error.code).toBe('SERVICE_UNAVAILABLE');
    });

    it.each([
      ['zero amount', { amount: 0 }],
      ['negative amount', { amount: -5 }],
      ['three decimals', { amount: 1.234 }],
      ['over the limit', { amount: 1_000_000.01 }],
      ['string amount', { amount: '10' }],
      ['other currency', { currency: 'EUR' }],
      ['long description', { description: 'x'.repeat(141) }],
      ['unknown field', { memo: 'hi' }],
      ['feature missing', { features: (({ V14: _omit, ...rest }) => rest)(features()) }],
      ['extra feature', { features: { ...features(), V29: 1 } }],
      ['negative Amount feature', { features: features({ Amount: -1 }) }],
    ])('rejects %s with 400', async (_label, overrides) => {
      const res = await transfer(alice, toBob(overrides));
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('requires authentication', async () => {
      const res = await request(ctx.app).post('/transactions').set('Idempotency-Key', 'abcdefgh').send(toBob());
      expect(res.status).toBe(401);
    });
  });

  describe('reads', () => {
    it('lists own transactions newest first with cursor pagination and a status filter', async () => {
      const ids = [];
      for (let i = 0; i < 3; i += 1) ids.push((await transfer(alice, toBob({ amount: 1 + i }))).body.transaction.id);
      ctx.quickScanBehaviour = quickScan.flagged;
      const flaggedId = (await transfer(alice, toBob({ amount: 5 }))).body.transaction.id;

      const page1 = await request(ctx.app).get('/transactions?limit=2').set(auth(alice));
      expect(page1.body.items.map((t) => t.id)).toEqual([flaggedId, ids[2]]);
      const page2 = await request(ctx.app)
        .get(`/transactions?limit=2&cursor=${page1.body.nextCursor}`)
        .set(auth(alice));
      expect(page2.body.items.map((t) => t.id)).toEqual([ids[1], ids[0]]);
      expect(page2.body.nextCursor).toBeNull();

      const review = await request(ctx.app).get('/transactions?status=UNDER_REVIEW').set(auth(alice));
      expect(review.body.items.map((t) => t.id)).toEqual([flaggedId]);
      expect((await request(ctx.app).get('/transactions').set(auth(bob))).body.items).toEqual([]);
      expect((await request(ctx.app).get('/transactions?cursor=garbage').set(auth(alice))).status).toBe(400);
    });

    it("hides another user's transaction as 404, but shows it to an admin", async () => {
      const id = (await transfer(alice, toBob())).body.transaction.id;
      const admin = ctx.addUser('admin@example.com', 'admin');

      expect((await request(ctx.app).get(`/transactions/${id}`).set(auth(alice))).status).toBe(200);
      expect((await request(ctx.app).get(`/transactions/${id}`).set(auth(bob))).status).toBe(404);
      expect((await request(ctx.app).get(`/transactions/${id}`).set(auth(admin))).status).toBe(200);
      expect((await request(ctx.app).get('/transactions/not-a-uuid').set(auth(alice))).status).toBe(400);
    });
  });
});
