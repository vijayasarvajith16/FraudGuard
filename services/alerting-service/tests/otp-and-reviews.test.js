'use strict';

const request = require('supertest');
const { startTestApp, scoredEvent, respond } = require('./helpers');

describe('OTP step-up verification', () => {
  let ctx;
  let user;
  let event;
  beforeAll(async () => {
    ctx = await startTestApp();
  });
  afterAll(async () => ctx.stop());
  beforeEach(async () => {
    await ctx.reset();
    user = ctx.user();
    event = scoredEvent({ tier: 'HIGH', userId: user.id });
    await ctx.service.processScoredEvent(event);
    ctx.txService.reset();
  });

  const txId = () => event.payload.transactionId;
  const verify = (code, who = user) =>
    request(ctx.app)
      .post('/alerts/otp/verify')
      .set('Authorization', `Bearer ${ctx.tokenFor(who)}`)
      .send({ transactionId: txId(), code });
  const challenge = () => ctx.db.collection('otp_challenges').findOne({ _id: txId() });
  const wrongCode = () => (ctx.service.otpCodeFor(txId()) === '000000' ? '111111' : '000000');

  it('approves the transfer for the correct code, once', async () => {
    const res = await verify(ctx.service.otpCodeFor(txId()));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ transactionId: txId(), status: 'APPROVED' });
    expect(ctx.txService.patches()[0].body).toMatchObject({ status: 'APPROVED', source: 'otp' });
    expect((await challenge()).status).toBe('VERIFIED');

    const again = await verify(ctx.service.otpCodeFor(txId()));
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('OTP_ALREADY_RESOLVED');
  });

  it('counts down attempts and blocks the transfer when they run out', async () => {
    for (const remaining of [2, 1]) {
      const res = await verify(wrongCode());
      expect(res.status).toBe(400);
      expect(res.body.error).toMatchObject({ code: 'INVALID_OTP', details: [{ attemptsRemaining: remaining }] });
    }
    expect(ctx.txService.patches()).toHaveLength(0);

    const last = await verify(wrongCode());
    expect(last.body.error.details).toEqual([{ attemptsRemaining: 0 }]);
    expect(ctx.txService.patches()[0].body).toMatchObject({ status: 'BLOCKED', source: 'otp' });
    expect((await challenge()).status).toBe('FAILED');

    const alerts = await ctx.db.collection('alerts').find({ transactionId: txId() }).toArray();
    expect(alerts.map((a) => a.kind).sort()).toEqual(['otp-blocked', 'tier']);
    expect((await verify(ctx.service.otpCodeFor(txId()))).status).toBe(409);
  });

  it('blocks the transfer when the code has expired', async () => {
    await ctx.db.collection('otp_challenges').updateOne({ _id: txId() }, { $set: { expiresAt: new Date(0) } });
    const res = await verify(ctx.service.otpCodeFor(txId()));
    expect(res.status).toBe(410);
    expect(res.body.error.code).toBe('OTP_EXPIRED');
    expect(ctx.txService.patches()[0].body).toMatchObject({ status: 'BLOCKED', reason: 'otp expired' });
    expect((await challenge()).status).toBe('EXPIRED');
  });

  it("does not reveal another user's challenge", async () => {
    expect((await verify(ctx.service.otpCodeFor(txId()), ctx.user())).status).toBe(404);
  });

  it('keeps the challenge open if transaction-service is down, so the user can retry', async () => {
    ctx.txService.respond = respond.status(503, 'SERVICE_UNAVAILABLE');
    expect((await verify(ctx.service.otpCodeFor(txId()))).status).toBe(503);
    expect((await challenge()).status).toBe('OPEN');

    ctx.txService.respond = null;
    expect((await verify(ctx.service.otpCodeFor(txId()))).status).toBe(200);
  });

  it('the sweeper blocks expired challenges and ones whose block call failed earlier', async () => {
    ctx.txService.respond = respond.status(503, 'SERVICE_UNAVAILABLE');
    for (let i = 0; i < 3; i += 1) await verify(wrongCode());
    expect((await challenge()).status).toBe('OPEN'); // block deferred
    expect((await challenge()).attemptsRemaining).toBe(0);

    ctx.txService.respond = null;
    expect(await ctx.service.sweepOtps()).toBe(1);
    expect((await challenge()).status).toBe('FAILED');
    expect(await ctx.service.sweepOtps()).toBe(0);
  });

  it.each([['12345'], ['abcdef'], ['1234567']])('rejects malformed code %p', async (code) => {
    expect((await verify(code)).status).toBe(400);
    expect((await challenge()).attemptsRemaining).toBe(3);
  });

  it('derives stable, distinct 6-digit codes per transaction', () => {
    const a = ctx.service.otpCodeFor('11111111-1111-4111-8111-111111111111');
    expect(a).toBe(ctx.service.otpCodeFor('11111111-1111-4111-8111-111111111111'));
    expect(a).toMatch(/^\d{6}$/);
    expect(ctx.service.otpCodeFor('22222222-2222-4222-8222-222222222222')).not.toBe(a);
  });
});

describe('manual review and admin endpoints', () => {
  let ctx;
  let admin;
  let customer;
  let review;
  beforeAll(async () => {
    ctx = await startTestApp();
  });
  afterAll(async () => ctx.stop());
  beforeEach(async () => {
    await ctx.reset();
    admin = ctx.user('admin');
    customer = ctx.user();
    await ctx.service.processScoredEvent(scoredEvent({ tier: 'CRITICAL', userId: customer.id }));
    ctx.txService.reset();
    review = (await asAdmin().get('/alerts/admin/reviews?status=OPEN')).body.items[0];
  });

  const as = (who) => ({
    get: (url) =>
      request(ctx.app)
        .get(url)
        .set('Authorization', `Bearer ${ctx.tokenFor(who)}`),
    post: (url) =>
      request(ctx.app)
        .post(url)
        .set('Authorization', `Bearer ${ctx.tokenFor(who)}`),
  });
  const asAdmin = () => as(admin);
  const decide = (decision, note) =>
    asAdmin().post(`/alerts/admin/reviews/${review.id}/decision`).send({ decision, note });

  it('lists open cases for admins only', async () => {
    expect(review).toMatchObject({ userId: customer.id, status: 'OPEN', riskTier: 'CRITICAL', decision: null });
    expect((await as(customer).get('/alerts/admin/reviews')).status).toBe(403);
    expect((await request(ctx.app).get('/alerts/admin/reviews')).status).toBe(401);
  });

  it('APPROVE settles via transaction-service, resolves the case and tells the customer', async () => {
    const res = await decide('APPROVE', 'verified with customer');
    expect(res.status).toBe(200);
    expect(res.body.review).toMatchObject({ status: 'RESOLVED', decision: 'APPROVE', decidedBy: admin.id });
    expect(res.body.transaction.status).toBe('APPROVED');
    expect(ctx.txService.patches()[0].body).toMatchObject({
      status: 'APPROVED',
      source: 'admin',
      reason: 'manual review approved: verified with customer',
    });
    const messages = (await as(customer).get('/alerts')).body.items.map((a) => a.message);
    expect(messages.some((m) => m.includes('approved after review'))).toBe(true);

    const again = await decide('REJECT');
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('REVIEW_ALREADY_RESOLVED');
  });

  it('REJECT blocks the transfer', async () => {
    await decide('REJECT');
    expect(ctx.txService.patches()[0].body).toMatchObject({ status: 'BLOCKED', source: 'admin' });
  });

  it('maps a finalized transaction to 409 and leaves the case open', async () => {
    ctx.txService.respond = respond.status(409, 'INVALID_TRANSITION');
    expect((await decide('APPROVE')).status).toBe(409);
    expect((await asAdmin().get('/alerts/admin/reviews?status=OPEN')).body.items).toHaveLength(1);
  });

  it('proxies account unfreeze to transaction-service', async () => {
    const res = await asAdmin().post(`/alerts/admin/accounts/${customer.id}/unfreeze`);
    expect(res.status).toBe(200);
    expect(ctx.txService.calls[0]).toMatchObject({
      method: 'POST',
      url: `http://transactions.test/internal/accounts/${customer.id}/unfreeze`,
    });
  });

  it('shows the active policy and rejects an invalid reload, keeping the old policy', async () => {
    const before = (await asAdmin().get('/alerts/admin/config/tier-actions')).body;
    expect(before.policy.tiers.CRITICAL.action).toBe('BLOCK_AND_FREEZE');

    ctx.writePolicy('{"version": 1, "tiers": {}}');
    const res = await asAdmin().post('/alerts/admin/config/reload');
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('INVALID_POLICY');
    expect((await asAdmin().get('/alerts/admin/config/tier-actions')).body.sha256).toBe(before.sha256);
    expect((await as(customer).post('/alerts/admin/config/reload')).status).toBe(403);
  });
});
