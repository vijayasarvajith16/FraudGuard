import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { vi } from 'vitest';
import { App } from '../src/App.jsx';
import { AuthProvider } from '../src/auth/AuthProvider.jsx';
import { saveSession } from '../src/auth/session.js';

const b64url = (obj) => btoa(JSON.stringify(obj)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');

/** An unsigned JWT-shaped token; the UI only reads exp and role (the services verify signatures). */
export function makeToken({ role = 'user', expiresInSec = 3600 } = {}) {
  const exp = Math.floor(Date.now() / 1000) + expiresInSec;
  return `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url({ sub: 'u1', role, exp })}.sig`;
}

export const ALICE = {
  id: '11111111-1111-4111-8111-111111111111',
  email: 'alice@demo.test',
  name: 'Alice',
  role: 'user',
};
export const ADMIN = {
  id: '99999999-9999-4999-8999-999999999999',
  email: 'admin@demo.test',
  name: 'Ops',
  role: 'admin',
};

export function signIn(user = ALICE, tokenOptions = {}) {
  saveSession({ token: makeToken({ role: user.role, ...tokenOptions }), user });
}

export function json(status, body, headers = {}) {
  return new Response(body === undefined ? '' : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

/**
 * Stub global fetch with a route table: [[method, pathRegex, handler(request)], ...].
 * A handler returns a Response (or a value for json(200, value)). Unmatched calls fail the test.
 * Returns the vi.fn so tests can inspect calls: [url, init].
 */
export function mockApi(routes) {
  const fn = vi.fn(async (url, init = {}) => {
    const method = init.method ?? 'GET';
    const path = String(url);
    for (const [m, pattern, handler] of routes) {
      if (m === method && pattern.test(path)) {
        const body = init.body ? JSON.parse(init.body) : undefined;
        const result = await handler({ path, body, headers: init.headers ?? {}, init });
        return result instanceof Response ? result : json(200, result);
      }
    }
    throw new Error(`unexpected request ${method} ${path}`);
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

export const callsTo = (fetchMock, method, pattern) =>
  fetchMock.mock.calls.filter(([url, init = {}]) => (init.method ?? 'GET') === method && pattern.test(String(url)));

export function renderApp(route = '/') {
  return render(
    <MemoryRouter initialEntries={[route]}>
      <AuthProvider>
        <App />
      </AuthProvider>
    </MemoryRouter>,
  );
}

let seq = 0;
export function makeTx(overrides = {}) {
  seq += 1;
  return {
    id: `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
    userId: ALICE.id,
    recipientId: '22222222-2222-4222-8222-222222222222',
    amount: 20,
    currency: 'USD',
    description: null,
    status: 'APPROVED',
    riskScore: null,
    riskTier: 'LOW',
    quickScan: { score: 0.3, threshold: 0.39, flagged: false, reason: 'NORMAL', modelVersion: '2' },
    deepScan: null,
    action: 'NONE',
    statusHistory: [{ status: 'PENDING', at: '2026-09-30T10:00:00.000Z', source: 'transaction-service', reason: null }],
    createdAt: '2026-09-30T10:00:00.000Z',
    updatedAt: '2026-09-30T10:00:00.000Z',
    finalizedAt: null,
    ...overrides,
  };
}

export const WALLET = { userId: ALICE.id, balance: 1000, held: 0, currency: 'USD', frozen: false, updatedAt: '' };

/** Routes every signed-in page needs, merged in front of test-specific ones. */
export function dashboardRoutes({ wallet = WALLET, transactions = [] } = {}) {
  return [
    ['GET', /\/api\/wallet$/, () => ({ wallet })],
    ['GET', /\/api\/transactions\?/, () => ({ items: transactions, nextCursor: null })],
  ];
}
