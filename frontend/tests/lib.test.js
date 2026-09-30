import { describe, expect, it, vi } from 'vitest';
import { ApiError, createApiClient, createEndpoints } from '../src/api/client.js';
import { decodeJwt, loadSession, saveSession } from '../src/auth/session.js';
import { parseAmount } from '../src/lib/format.js';
import { newIdempotencyKey } from '../src/lib/ids.js';
import { isResting, pollDelay, statusExplanation } from '../src/lib/transactions.js';
import { json, makeToken, mockApi } from './helpers.jsx';

describe('api client', () => {
  it('turns the error envelope into an ApiError', async () => {
    mockApi([
      [
        'POST',
        /\/api\/transactions$/,
        () =>
          json(400, {
            error: {
              code: 'VALIDATION_ERROR',
              message: 'Request validation failed',
              details: [{ field: 'amount', issue: 'must be > 0' }],
              requestId: 'req-1',
            },
          }),
      ],
    ]);
    const api = createApiClient();
    const err = await api.post('/transactions', { amount: 0 }).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 400, code: 'VALIDATION_ERROR', requestId: 'req-1', retryable: false });
    expect(err.details).toEqual([{ field: 'amount', issue: 'must be > 0' }]);
  });

  it('falls back to the X-Request-Id header and marks 5xx and network errors retryable', async () => {
    mockApi([
      [
        'GET',
        /\/api\/wallet$/,
        () => new Response('<html>bad gateway</html>', { status: 502, headers: { 'X-Request-Id': 'gw-9' } }),
      ],
    ]);
    const api = createApiClient();
    const err = await api.get('/wallet').catch((e) => e);
    expect(err).toMatchObject({ status: 502, code: 'HTTP_502', requestId: 'gw-9', retryable: true });

    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    const offline = await api.get('/wallet').catch((e) => e);
    expect(offline).toMatchObject({ status: 0, code: 'NETWORK_ERROR', retryable: true });
  });

  it('signs out on a 401 only for authenticated calls', async () => {
    mockApi([['POST', /./, () => json(401, { error: { code: 'UNAUTHORIZED', message: 'expired' } })]]);
    const onUnauthorized = vi.fn();
    await createApiClient({ getToken: () => null, onUnauthorized })
      .post('/auth/login', {})
      .catch(() => {});
    expect(onUnauthorized).not.toHaveBeenCalled(); // wrong password is not a session problem
    await createApiClient({ getToken: () => 'tok', onUnauthorized })
      .post('/wallet/deposit', {})
      .catch(() => {});
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it('sends the bearer token, JSON body and Idempotency-Key, and builds query strings without empty values', async () => {
    const fetchMock = mockApi([
      ['POST', /\/api\/transactions$/, () => json(201, { transaction: {} })],
      ['GET', /\/api\/transactions\?/, () => ({ items: [], nextCursor: null })],
    ]);
    const api = createEndpoints(createApiClient({ getToken: () => 'tok-1' }));
    await api.createTransfer({ amount: 5 }, 'key-12345678');
    await api.listTransactions({ status: '', cursor: null });
    const [[, postInit], [getUrl]] = fetchMock.mock.calls;
    expect(postInit.headers).toMatchObject({
      Authorization: 'Bearer tok-1',
      'Content-Type': 'application/json',
      'Idempotency-Key': 'key-12345678',
    });
    expect(JSON.parse(postInit.body)).toEqual({ amount: 5 });
    expect(getUrl).toBe('/api/transactions?limit=20');
  });

  it('never targets a scan service or an /internal route', () => {
    const paths = [];
    const api = createEndpoints({
      get: (p) => paths.push(p),
      post: (p) => paths.push(p),
    });
    for (const [name, fn] of Object.entries(api)) fn(name === 'register' ? {} : 'x', 'y', 'z');
    expect(paths.length).toBeGreaterThan(10);
    for (const p of paths) expect(p).not.toMatch(/internal|score|scan|metrics/);
  });
});

describe('transaction helpers', () => {
  it('polls every 2 s, then backs off to 10 s', () => {
    expect([0, 1, 2, 3, 4, 5, 9].map(pollDelay)).toEqual([2000, 2000, 2000, 4000, 8000, 10000, 10000]);
  });

  it('rests at terminal, OTP and frozen statuses only', () => {
    expect(['APPROVED', 'BLOCKED', 'AWAITING_OTP', 'ACCOUNT_FROZEN'].every(isResting)).toBe(true);
    expect(['PENDING', 'UNDER_REVIEW'].some(isResting)).toBe(false);
  });

  it('explains fail-toward-review distinctly', () => {
    expect(statusExplanation({ status: 'UNDER_REVIEW', quickScan: { reason: 'QUICK_SCAN_UNAVAILABLE' } })).toMatch(
      /unavailable/,
    );
    expect(statusExplanation({ status: 'APPROVED', deepScan: null })).toMatch(/instantly/);
  });
});

describe('session and inputs', () => {
  it('decodes JWT payloads and drops expired sessions', () => {
    expect(decodeJwt(makeToken({ role: 'admin' })).role).toBe('admin');
    expect(decodeJwt('garbage')).toBeNull();
    saveSession({ token: makeToken({ expiresInSec: -5 }), user: { id: 'u' } });
    expect(loadSession()).toBeNull();
    saveSession({ token: makeToken(), user: { id: 'u' } });
    expect(loadSession().user.id).toBe('u');
  });

  it('parses amounts with the contract limits', () => {
    expect(parseAmount('42.50')).toEqual({ value: 42.5 });
    expect(parseAmount(' 7 ')).toEqual({ value: 7 });
    expect(parseAmount('0').error).toMatch(/greater than 0/);
    expect(parseAmount('1.234').error).toBeDefined();
    expect(parseAmount('1000000.01').error).toMatch(/maximum/);
  });

  it('generates UUID v4 idempotency keys, also without crypto.randomUUID', () => {
    const v4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    expect(newIdempotencyKey()).toMatch(v4);
    const original = crypto.randomUUID;
    try {
      Object.defineProperty(crypto, 'randomUUID', { value: undefined, configurable: true });
      expect(newIdempotencyKey()).toMatch(v4);
    } finally {
      Object.defineProperty(crypto, 'randomUUID', { value: original, configurable: true });
    }
  });
});
