'use strict';

const { loadConfig, durationToSeconds } = require('../src/config');
const { createJwtAuth, signAccessToken } = require('../src/middleware/jwtAuth');
const { testEnv, TEST_JWT_SECRET } = require('./helpers');

describe('config', () => {
  it('applies contract defaults', () => {
    const config = loadConfig(testEnv({ BCRYPT_ROUNDS: undefined }));
    expect(config).toMatchObject({
      port: 3001,
      bcryptRounds: 12,
      jwt: { expiresIn: '15m', expiresInSeconds: 900, issuer: 'fraudguard-auth', audience: 'fraudguard' },
      loginRateLimit: { max: 5, windowMs: 900000 },
      admin: null,
    });
  });

  it('reports every invalid variable at once', () => {
    expect(() => loadConfig(testEnv({ JWT_SECRET: 'short', MONGO_URI: '', PORT: 'abc' }))).toThrow(
      /JWT_SECRET[\s\S]*MONGO_URI|MONGO_URI[\s\S]*JWT_SECRET/,
    );
  });

  it('requires ADMIN_EMAIL and ADMIN_PASSWORD together', () => {
    expect(() => loadConfig(testEnv({ ADMIN_EMAIL: 'admin@example.com' }))).toThrow(/ADMIN_EMAIL/);
    const config = loadConfig(testEnv({ ADMIN_EMAIL: 'Admin@Example.com', ADMIN_PASSWORD: 'long-enough-pass' }));
    expect(config.admin).toEqual({ email: 'admin@example.com', password: 'long-enough-pass' });
  });

  it.each([
    ['30s', 30],
    ['15m', 900],
    ['2h', 7200],
    ['1d', 86400],
  ])('converts %s to %i seconds', (value, seconds) => {
    expect(durationToSeconds(value)).toBe(seconds);
  });
});

describe('jwtAuth middleware', () => {
  const { requireAuth, requireRole } = createJwtAuth({ secret: TEST_JWT_SECRET });
  const run = (middleware, req) =>
    new Promise((resolve) => {
      middleware(req, {}, (err) => resolve({ err, req }));
    });
  const reqWith = (token) => ({ get: (name) => (name === 'authorization' && token ? `Bearer ${token}` : undefined) });

  it('refuses to start with a weak secret', () => {
    expect(() => createJwtAuth({ secret: 'short' })).toThrow(/at least 32/);
  });

  it('populates req.user from a valid token', async () => {
    const token = signAccessToken(
      { id: 'user-1', email: 'a@b.co', role: 'admin' },
      { secret: TEST_JWT_SECRET, expiresIn: '5m' },
    );
    const { err, req } = await run(requireAuth, reqWith(token));
    expect(err).toBeUndefined();
    expect(req.user).toEqual({ id: 'user-1', email: 'a@b.co', role: 'admin' });
  });

  it('reports an expired token distinctly', async () => {
    const token = signAccessToken(
      { id: 'u', email: 'a@b.co', role: 'user' },
      { secret: TEST_JWT_SECRET, expiresIn: '-1m' },
    );
    const { err } = await run(requireAuth, reqWith(token));
    expect(err).toMatchObject({ status: 401, code: 'UNAUTHORIZED', message: 'Token expired' });
  });

  it('requireRole returns 403 for the wrong role and 401 without a user', async () => {
    const adminOnly = requireRole('admin');
    expect((await run(adminOnly, { user: { role: 'user' } })).err).toMatchObject({ status: 403, code: 'FORBIDDEN' });
    expect((await run(adminOnly, {})).err).toMatchObject({ status: 401 });
    expect((await run(adminOnly, { user: { role: 'admin' } })).err).toBeUndefined();
  });
});
