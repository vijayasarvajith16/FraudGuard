'use strict';

const request = require('supertest');
const jwt = require('jsonwebtoken');
const { startTestApp, TEST_JWT_SECRET } = require('./helpers');

const validUser = { email: 'Ana@Example.com', password: 'correct-horse-1', name: 'Ana' };

describe('auth routes', () => {
  let ctx;

  beforeAll(async () => {
    ctx = await startTestApp();
  });

  afterEach(async () => {
    await ctx.reset();
  });

  afterAll(async () => {
    await ctx.stop();
  });

  const register = (body = validUser) => request(ctx.app).post('/auth/register').send(body);
  const login = (body) => request(ctx.app).post('/auth/login').send(body);

  describe('POST /auth/register', () => {
    it('creates a user, normalizes the email and never returns the hash', async () => {
      const res = await register();

      expect(res.status).toBe(201);
      expect(res.body.user).toEqual({
        id: expect.stringMatching(/^[0-9a-f-]{36}$/),
        email: 'ana@example.com',
        name: 'Ana',
        role: 'user',
        createdAt: expect.any(String),
      });
      expect(JSON.stringify(res.body)).not.toMatch(/passwordHash|\$2[aby]\$/);

      const stored = await ctx.db.collection('users').findOne({ email: 'ana@example.com' });
      expect(stored.passwordHash).toMatch(/^\$2b\$04\$/);
      expect(stored.passwordHash).not.toContain(validUser.password);
    });

    it('rejects a duplicate email case-insensitively with 409 EMAIL_TAKEN', async () => {
      await register();
      const res = await register({ ...validUser, email: 'ANA@example.com' });

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('EMAIL_TAKEN');
    });

    it.each([
      ['invalid email', { ...validUser, email: 'not-an-email' }, 'email'],
      ['short password', { ...validUser, password: 'a1' }, 'password'],
      ['password without digit', { ...validUser, password: 'onlyletters' }, 'password'],
      ['password without letter', { ...validUser, password: '1234567890' }, 'password'],
      ['missing name', { email: validUser.email, password: validUser.password }, 'name'],
      ['unknown field', { ...validUser, role: 'admin' }, '(root)'],
    ])('rejects %s with 400 and field details', async (_label, body, field) => {
      const res = await register(body);

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(res.body.error.details).toEqual(expect.arrayContaining([expect.objectContaining({ field })]));
    });

    it('cannot self-register as admin', async () => {
      const res = await register({ ...validUser, role: 'admin' });
      expect(res.status).toBe(400);
      expect(await ctx.db.collection('users').countDocuments()).toBe(0);
    });
  });

  describe('POST /auth/login', () => {
    beforeEach(async () => {
      await register();
    });

    it('returns a JWT with the contract claims', async () => {
      const res = await login({ email: 'ana@example.com', password: validUser.password });

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ tokenType: 'Bearer', expiresIn: 900, user: { email: 'ana@example.com' } });

      const claims = jwt.verify(res.body.accessToken, TEST_JWT_SECRET, {
        algorithms: ['HS256'],
        issuer: 'fraudguard-auth',
        audience: 'fraudguard',
      });
      expect(claims).toMatchObject({ sub: res.body.user.id, email: 'ana@example.com', role: 'user' });
      expect(claims.exp - claims.iat).toBe(900);
    });

    it('returns the same 401 for a wrong password and an unknown email', async () => {
      const wrongPassword = await login({ email: 'ana@example.com', password: 'wrong-password-1' });
      const unknownEmail = await login({ email: 'nobody@example.com', password: 'whatever-1' });

      for (const res of [wrongPassword, unknownEmail]) {
        expect(res.status).toBe(401);
        expect(res.body.error).toMatchObject({ code: 'INVALID_CREDENTIALS', message: 'Invalid email or password' });
      }
    });

    it('rate-limits repeated failures per IP and email with 429', async () => {
      const bad = { email: 'ana@example.com', password: 'wrong-password-1' };
      for (let i = 0; i < ctx.config.loginRateLimit.max; i += 1) {
        expect((await login(bad)).status).toBe(401);
      }
      const limited = await login(bad);
      expect(limited.status).toBe(429);
      expect(limited.body.error.code).toBe('RATE_LIMITED');

      // A different email from the same IP has its own budget.
      expect((await login({ email: 'other@example.com', password: 'x1x1x1x1' })).status).toBe(401);
    });
  });

  describe('GET /auth/me', () => {
    it('returns the current user for a valid token', async () => {
      await register();
      const { body } = await login({ email: validUser.email, password: validUser.password });

      const res = await request(ctx.app).get('/auth/me').set('Authorization', `Bearer ${body.accessToken}`);

      expect(res.status).toBe(200);
      expect(res.body.user).toMatchObject({ email: 'ana@example.com', role: 'user' });
    });

    it.each([
      ['no header', undefined],
      ['wrong scheme', 'Basic abc'],
      ['garbage token', 'Bearer not.a.jwt'],
      [
        'token signed with another secret',
        `Bearer ${jwt.sign({ role: 'user' }, 'x'.repeat(40), { subject: 'u', issuer: 'fraudguard-auth', audience: 'fraudguard' })}`,
      ],
      [
        'token with the wrong issuer',
        `Bearer ${jwt.sign({ role: 'user' }, TEST_JWT_SECRET, { subject: 'u', issuer: 'evil', audience: 'fraudguard' })}`,
      ],
      [
        'expired token',
        `Bearer ${jwt.sign({ role: 'user', exp: Math.floor(Date.now() / 1000) - 120 }, TEST_JWT_SECRET, { subject: 'u', issuer: 'fraudguard-auth', audience: 'fraudguard' })}`,
      ],
    ])('rejects %s with 401', async (_label, header) => {
      const req = request(ctx.app).get('/auth/me');
      if (header) req.set('Authorization', header);
      const res = await req;

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('UNAUTHORIZED');
    });

    it('rejects an unsigned (alg=none) token', async () => {
      const unsigned = jwt.sign({ role: 'admin' }, null, {
        algorithm: 'none',
        subject: 'u',
        issuer: 'fraudguard-auth',
        audience: 'fraudguard',
      });
      const res = await request(ctx.app).get('/auth/me').set('Authorization', `Bearer ${unsigned}`);
      expect(res.status).toBe(401);
    });

    it('rejects a valid token whose user was deleted', async () => {
      const { body: reg } = await register();
      const { body } = await login({ email: validUser.email, password: validUser.password });
      await ctx.db.collection('users').deleteOne({ _id: reg.user.id });

      const res = await request(ctx.app).get('/auth/me').set('Authorization', `Bearer ${body.accessToken}`);
      expect(res.status).toBe(401);
    });
  });
});
