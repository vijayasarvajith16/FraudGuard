import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import {
  ADMIN,
  ALICE,
  callsTo,
  dashboardRoutes,
  json,
  makeToken,
  makeTx,
  mockApi,
  renderApp,
  signIn,
} from './helpers.jsx';

describe('authentication', () => {
  it('redirects to sign-in, then back to the requested page after login', async () => {
    const user = userEvent.setup();
    mockApi([
      ['POST', /\/api\/auth\/login$/, () => ({ accessToken: makeToken(), tokenType: 'Bearer', user: ALICE })],
      ['GET', /\/api\/alerts\?/, () => ({ items: [], nextCursor: null })],
    ]);
    renderApp('/alerts');
    await user.type(await screen.findByLabelText('Email'), ALICE.email);
    await user.type(screen.getByLabelText('Password'), 'demo-pass-123');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('heading', { name: 'Alerts' })).toBeInTheDocument();
  });

  it('shows a clear message for wrong credentials', async () => {
    const user = userEvent.setup();
    mockApi([
      ['POST', /\/api\/auth\/login$/, () => json(401, { error: { code: 'INVALID_CREDENTIALS', message: 'x' } })],
    ]);
    renderApp('/login');
    await user.type(screen.getByLabelText('Email'), 'a@b.co');
    await user.type(screen.getByLabelText('Password'), 'nope1234');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText('Wrong email or password.')).toBeInTheDocument();
  });

  it('registers and signs straight in', async () => {
    const user = userEvent.setup();
    const fetchMock = mockApi([
      ['POST', /\/api\/auth\/register$/, () => json(201, { user: ALICE })],
      ['POST', /\/api\/auth\/login$/, () => ({ accessToken: makeToken(), user: ALICE })],
      ...dashboardRoutes(),
    ]);
    renderApp('/register');
    await user.type(screen.getByLabelText('Name'), 'Alice');
    await user.type(screen.getByLabelText('Email'), ALICE.email);
    await user.type(screen.getByLabelText('Password'), 'demo-pass-123');
    await user.click(screen.getByRole('button', { name: 'Create account' }));
    expect(await screen.findByRole('heading', { name: 'Hello, Alice' })).toBeInTheDocument();
    expect(JSON.parse(callsTo(fetchMock, 'POST', /register$/)[0][1].body)).toEqual({
      name: 'Alice',
      email: ALICE.email,
      password: 'demo-pass-123',
    });
  });

  it('ends the session when an authenticated call returns 401', async () => {
    signIn(ALICE);
    mockApi([
      ['GET', /\/api\/wallet$/, () => json(401, { error: { code: 'UNAUTHORIZED', message: 'Token expired' } })],
      ['GET', /\/api\/transactions\?/, () => ({ items: [], nextCursor: null })],
    ]);
    renderApp('/');
    expect(await screen.findByText('Your session expired. Please sign in again.')).toBeInTheDocument();
    expect(sessionStorage.getItem('fraudguard.session')).toBeNull();
  });

  it('ignores a stored session whose token already expired', async () => {
    signIn(ALICE, { expiresInSec: -1 });
    mockApi([]);
    renderApp('/');
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
  });
});

describe('transactions page', () => {
  it('lists transactions with badges, filters by status, and pages with the cursor', async () => {
    const user = userEvent.setup();
    signIn(ALICE);
    const approved = makeTx({ amount: 12.5, description: 'Lunch' });
    const frozen = makeTx({
      amount: 99.99,
      status: 'ACCOUNT_FROZEN',
      riskTier: 'CRITICAL',
      riskScore: 0.998,
      action: 'BLOCK_AND_FREEZE',
      deepScan: { probability: 0.998, riskTier: 'CRITICAL', modelVersion: '2', scoredAt: '' },
    });
    const fetchMock = mockApi([
      [
        'GET',
        /\/api\/transactions\?/,
        ({ path }) =>
          path.includes('cursor=c2')
            ? { items: [frozen], nextCursor: null }
            : path.includes('status=ACCOUNT_FROZEN')
              ? { items: [frozen], nextCursor: null }
              : { items: [approved], nextCursor: 'c2' },
      ],
    ]);
    renderApp('/transactions');
    expect(await screen.findByText('Lunch')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Load more' }));
    expect(await screen.findByText('risk 99.8%')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();

    await user.click(screen.getByText('risk 99.8%').closest('button'));
    const details = within(screen.getByText('risk 99.8%').closest('li'));
    expect(details.getByText('Fraud probability')).toBeInTheDocument();
    expect(details.getByText('Tier CRITICAL · model v2')).toBeInTheDocument();
    expect(details.getByRole('meter', { name: 'Fraud probability' })).toHaveAttribute('aria-valuenow', '0.998');

    await user.click(screen.getByRole('radio', { name: 'Account frozen' }));
    await waitFor(() => expect(screen.queryByText('Lunch')).not.toBeInTheDocument());
    expect(callsTo(fetchMock, 'GET', /status=ACCOUNT_FROZEN/)).toHaveLength(1);
  });
});

describe('alerts and OTP', () => {
  it('verifies a step-up OTP: wrong code shows attempts left, the right code approves', async () => {
    const user = userEvent.setup();
    signIn(ALICE);
    const tx = makeTx({ status: 'AWAITING_OTP', riskTier: 'HIGH', action: 'OTP_STEP_UP', amount: 20 });
    const alert = {
      id: 'a1',
      userId: ALICE.id,
      transactionId: tx.id,
      riskTier: 'HIGH',
      action: 'OTP_STEP_UP',
      channel: 'SIMULATED',
      message: 'Confirm your $20.00 transfer with the code sent to you.',
      simulatedOtp: '482913',
      read: false,
      createdAt: '2026-09-30T10:00:00.000Z',
    };
    let current = tx;
    const fetchMock = mockApi([
      ['GET', /\/api\/alerts\?/, () => ({ items: [alert], nextCursor: null })],
      ['GET', new RegExp(`/api/transactions/${tx.id}$`), () => ({ transaction: current })],
      [
        'POST',
        /\/api\/alerts\/otp\/verify$/,
        ({ body }) => {
          if (body.code !== '482913') {
            return json(400, {
              error: { code: 'INVALID_OTP', message: 'Invalid code', details: [{ attemptsRemaining: 2 }] },
            });
          }
          current = { ...tx, status: 'APPROVED' };
          return { transactionId: tx.id, status: 'APPROVED' };
        },
      ],
    ]);
    renderApp('/alerts');

    const card = within((await screen.findByText(alert.message)).closest('li'));
    const input = await card.findByLabelText('One-time code for $20.00');
    await user.type(input, '000000');
    await user.click(card.getByRole('button', { name: 'Confirm transfer' }));
    expect(await card.findByText('Wrong code. 2 attempts left.')).toBeInTheDocument();

    await user.click(card.getByRole('button', { name: 'Fill it in' }));
    expect(input).toHaveValue('482913');
    await user.click(card.getByRole('button', { name: 'Confirm transfer' }));
    expect(await card.findByText('Approved')).toBeInTheDocument();
    expect(callsTo(fetchMock, 'POST', /otp\/verify$/).map(([, i]) => JSON.parse(i.body).code)).toEqual([
      '000000',
      '482913',
    ]);
  });
});

describe('admin', () => {
  it('hides the review queue from customers', async () => {
    signIn(ALICE);
    mockApi([]);
    renderApp('/admin');
    expect(await screen.findByRole('heading', { name: 'Admins only' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Review queue' })).not.toBeInTheDocument();
  });

  it('approves an open case with a note and reloads the queue; shows the active policy', async () => {
    const user = userEvent.setup();
    signIn(ADMIN);
    const review = {
      id: '33333333-3333-4333-8333-333333333333',
      transactionId: '44444444-4444-4444-8444-444444444444',
      userId: ALICE.id,
      riskScore: 0.998,
      riskTier: 'CRITICAL',
      amount: 99.99,
      status: 'OPEN',
      decision: null,
      decidedBy: null,
      note: null,
      createdAt: '2026-09-30T10:00:00.000Z',
      resolvedAt: null,
    };
    let open = [review];
    const fetchMock = mockApi([
      ['GET', /\/api\/alerts\/admin\/reviews\?status=OPEN$/, () => ({ items: open })],
      [
        'GET',
        new RegExp(`/api/transactions/${review.transactionId}$`),
        () => ({ transaction: makeTx({ id: review.transactionId, status: 'ACCOUNT_FROZEN', riskTier: 'CRITICAL' }) }),
      ],
      [
        'POST',
        /\/api\/alerts\/admin\/reviews\/.+\/decision$/,
        () => {
          open = [];
          return { review: { ...review, status: 'RESOLVED', decision: 'APPROVE' }, transaction: {} };
        },
      ],
      [
        'GET',
        /\/api\/alerts\/admin\/config\/tier-actions$/,
        () => ({
          sha256: 'abc123def4567890',
          loadedAt: '2026-09-30T10:00:00.000Z',
          path: '/app/policy/tierActions.json',
          policy: {
            version: 1,
            tiers: {
              LOW: { action: 'LOG', resultingStatus: 'APPROVED', notifyUser: false },
              CRITICAL: { action: 'BLOCK_AND_FREEZE', resultingStatus: 'ACCOUNT_FROZEN', notifyUser: true },
            },
          },
        }),
      ],
    ]);
    renderApp('/admin');

    expect(await screen.findByText('Blocked and account frozen')).toBeInTheDocument(); // policy table
    const card = within((await screen.findByText('$99.99')).closest('li'));
    expect(card.getByText('fraud probability 99.8%')).toBeInTheDocument();
    expect(card.queryByLabelText('Note (optional)')).not.toBeInTheDocument(); // compact until opened
    await user.click(card.getByRole('button', { name: 'Review' }));
    expect(await card.findByText('Status history')).toBeInTheDocument();
    await user.type(card.getByLabelText('Note (optional)'), 'customer confirmed by phone');
    await user.click(card.getByRole('button', { name: 'Approve and unfreeze' }));

    expect(await screen.findByText('No cases waiting for a decision.')).toBeInTheDocument();
    const [[url, init]] = callsTo(fetchMock, 'POST', /decision$/);
    expect(url).toBe(`/api/alerts/admin/reviews/${review.id}/decision`);
    expect(JSON.parse(init.body)).toEqual({ decision: 'APPROVE', note: 'customer confirmed by phone' });
  });
});

describe('page titles', () => {
  it('names each page in the browser tab', async () => {
    mockApi([['GET', /\/api\/alerts\?/, () => ({ items: [], nextCursor: null })]]);
    const { unmount } = renderApp('/login');
    await waitFor(() => expect(document.title).toBe('Sign in · FraudGuard'));
    unmount();

    signIn(ALICE);
    renderApp('/alerts');
    await waitFor(() => expect(document.title).toBe('Alerts · FraudGuard'));
  });
});
