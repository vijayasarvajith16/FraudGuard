'use strict';

const request = require('supertest');
const { startTestApp, TEST_SERVICE_TOKEN } = require('./helpers');
const { bootstrapAdmin } = require('../src/bootstrapAdmin');

describe('internal, health, metrics and error handling', () => {
  let ctx;

  beforeAll(async () => {
    ctx = await startTestApp();
    await request(ctx.app)
      .post('/auth/register')
      .send({ email: 'bob@example.com', password: 'password-123', name: 'Bob' });
  });

  afterAll(async () => {
    await ctx.stop();
  });

  describe('GET /internal/users/lookup', () => {
    const lookup = (email, token = TEST_SERVICE_TOKEN) => {
      const req = request(ctx.app).get('/internal/users/lookup').query({ email });
      if (token) req.set('X-Service-Token', token);
      return req;
    };

    it('resolves an email to a user for a valid service token', async () => {
      const res = await lookup('BOB@example.com');
      expect(res.status).toBe(200);
      expect(res.body.user).toEqual({ id: expect.any(String), email: 'bob@example.com', name: 'Bob', role: 'user' });
    });

    it('returns 404 for an unknown email', async () => {
      const res = await lookup('nobody@example.com');
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
    });

    it.each([
      ['missing token', null],
      ['wrong token', 'wrong-token'],
    ])('returns 401 for a %s', async (_label, token) => {
      const res = await lookup('bob@example.com', token);
      expect(res.status).toBe(401);
    });

    it('returns 400 for an invalid email query', async () => {
      const res = await lookup('nope');
      expect(res.status).toBe(400);
    });
  });

  describe('health and metrics', () => {
    it('GET /health reports ok with a mongo check', async () => {
      const res = await request(ctx.app).get('/health');
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        status: 'ok',
        service: 'auth-service',
        version: expect.any(String),
        checks: { mongo: 'ok' },
      });
    });

    it('GET /health/live is always ok', async () => {
      const res = await request(ctx.app).get('/health/live');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ status: 'ok' });
    });

    it('GET /metrics exposes Prometheus metrics with route templates', async () => {
      await request(ctx.app).get('/auth/me');
      const res = await request(ctx.app).get('/metrics');

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/text\/plain/);
      expect(res.text).toContain('http_requests_total');
      expect(res.text).toContain('route="/auth/me"');
      expect(res.text).toContain('auth_registrations_total');
      expect(res.text).toContain('auth_logins_total');
    });

    it('labels failed requests with their route template, not "unmatched"', async () => {
      await request(ctx.app).get('/internal/users/lookup').query({ email: 'bob@example.com' });
      const res = await request(ctx.app).get('/metrics');

      expect(res.text).toMatch(/http_requests_total\{[^}]*route="\/internal\/users\/lookup"[^}]*status="401"/);
    });
  });

  describe('error envelope and request IDs', () => {
    it('echoes a valid incoming X-Request-Id and puts it in error bodies', async () => {
      const res = await request(ctx.app).get('/nope').set('X-Request-Id', 'req-123');
      expect(res.status).toBe(404);
      expect(res.headers['x-request-id']).toBe('req-123');
      expect(res.body).toEqual({ error: { code: 'NOT_FOUND', message: expect.any(String), requestId: 'req-123' } });
    });

    it('generates a request id when the incoming one is unsafe', async () => {
      const res = await request(ctx.app).get('/health/live').set('X-Request-Id', 'bad id with spaces');
      expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('returns 400 VALIDATION_ERROR for malformed JSON', async () => {
      const res = await request(ctx.app)
        .post('/auth/register')
        .set('Content-Type', 'application/json')
        .send('{"email":');
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('returns 413 for a body over 100 kB', async () => {
      const res = await request(ctx.app)
        .post('/auth/register')
        .send({ email: 'a@b.co', password: 'x1'.repeat(10), name: 'x'.repeat(110_000) });
      expect(res.status).toBe(413);
      expect(res.body.error.code).toBe('PAYLOAD_TOO_LARGE');
    });

    it('sets security headers and hides the framework', async () => {
      const res = await request(ctx.app).get('/health/live');
      expect(res.headers['x-powered-by']).toBeUndefined();
      expect(res.headers['x-content-type-options']).toBe('nosniff');
    });
  });

  describe('admin bootstrap', () => {
    it('creates the admin once and never modifies it afterwards', async () => {
      const admin = { email: 'admin@example.com', password: 'admin-password-123' };
      await bootstrapAdmin({ users: ctx.users, admin, bcryptRounds: 4, logger: ctx.logger });
      await bootstrapAdmin({
        users: ctx.users,
        admin: { ...admin, password: 'rotated-password-456' },
        bcryptRounds: 4,
        logger: ctx.logger,
      });

      const admins = await ctx.db.collection('users').find({ email: admin.email }).toArray();
      expect(admins).toHaveLength(1);
      expect(admins[0].role).toBe('admin');

      const login = await request(ctx.app).post('/auth/login').send(admin);
      expect(login.status).toBe(200);
      expect(login.body.user.role).toBe('admin');
    });
  });
});
