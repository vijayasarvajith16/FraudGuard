import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import samples from '../src/demo/sampleFeatures.json';
import { ALICE, callsTo, dashboardRoutes, json, makeTx, mockApi, renderApp, signIn } from './helpers.jsx';

async function openDashboard(routes = []) {
  signIn(ALICE);
  const fetchMock = mockApi([...routes, ...dashboardRoutes()]);
  renderApp('/');
  await screen.findByText('$1,000.00');
  return fetchMock;
}

const form = () => within(screen.getByRole('heading', { name: 'Send money' }).closest('section'));

describe('transfer form', () => {
  afterEach(() => vi.useRealTimers());

  it('sends no feature vector for the Default profile', async () => {
    const user = userEvent.setup();
    const fetchMock = await openDashboard([
      ['POST', /\/api\/transactions$/, () => json(201, { transaction: makeTx({ amount: 12.5 }) })],
    ]);
    await user.type(form().getByLabelText('Recipient email'), 'bob@demo.test');
    await user.type(form().getByLabelText('Amount (USD)'), '12.50');
    await user.click(form().getByRole('button', { name: 'Send' }));

    await screen.findByText(/Approved instantly/);
    const [[, init]] = callsTo(fetchMock, 'POST', /\/api\/transactions$/);
    expect(JSON.parse(init.body)).toEqual({ recipientEmail: 'bob@demo.test', amount: 12.5, currency: 'USD' });
  });

  it('a dataset sample pre-fills its amount, sends its features, and warns when the amount changes', async () => {
    const user = userEvent.setup();
    const fetchMock = await openDashboard([
      ['POST', /\/api\/transactions$/, () => json(201, { transaction: makeTx({ status: 'ACCOUNT_FROZEN' }) })],
    ]);
    await user.selectOptions(form().getByLabelText('Risk profile'), 'fraud');

    const amountInput = form().getByLabelText('Amount (USD)');
    const prefilled = amountInput.value;
    expect(samples.categories.fraud.map((f) => f.Amount.toFixed(2))).toContain(prefilled);
    expect(form().getByText(/Using dataset sample \d+ of 12/)).toBeInTheDocument();
    expect(form().queryByText(/can change the outcome/)).not.toBeInTheDocument();

    await user.clear(amountInput);
    await user.type(amountInput, '999');
    expect(form().getByText(/can change the outcome/)).toBeInTheDocument();
    await user.clear(amountInput);
    await user.type(amountInput, prefilled);

    await user.type(form().getByLabelText('Recipient email'), 'bob@demo.test');
    await user.click(form().getByRole('button', { name: 'Send' }));
    await screen.findByText(/account is frozen until a reviewer decides/);

    const body = JSON.parse(callsTo(fetchMock, 'POST', /\/api\/transactions$/)[0][1].body);
    expect(samples.categories.fraud).toContainEqual(body.features);
    expect(body.amount).toBe(Number(prefilled));
    expect(Object.keys(body.features)).toHaveLength(30); // Time, V1..V28, Amount: no label
  });

  it('retries after a 5xx with the same Idempotency-Key, and starts a new key once answered', async () => {
    const user = userEvent.setup();
    let attempts = 0;
    const fetchMock = await openDashboard([
      [
        'POST',
        /\/api\/transactions$/,
        () =>
          ++attempts === 1
            ? json(503, { error: { code: 'SERVICE_UNAVAILABLE', message: 'Service unavailable', requestId: 'r1' } })
            : json(201, { transaction: makeTx() }),
      ],
    ]);
    await user.type(form().getByLabelText('Recipient email'), 'bob@demo.test');
    await user.type(form().getByLabelText('Amount (USD)'), '5');
    await user.click(form().getByRole('button', { name: 'Send' }));
    expect(await screen.findByText(/Retrying is safe/)).toBeInTheDocument();
    await user.click(form().getByRole('button', { name: 'Retry send' }));
    await screen.findByText(/Approved instantly/);

    await user.type(form().getByLabelText('Amount (USD)'), '6');
    await user.click(form().getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(attempts).toBe(3));

    const keys = callsTo(fetchMock, 'POST', /\/api\/transactions$/).map(([, init]) => init.headers['Idempotency-Key']);
    expect(keys[0]).toBe(keys[1]);
    expect(keys[2]).not.toBe(keys[1]);
  });

  it('validates on the client before calling the API', async () => {
    const user = userEvent.setup();
    const fetchMock = await openDashboard();
    await user.type(form().getByLabelText('Recipient email'), ALICE.email);
    await user.type(form().getByLabelText('Amount (USD)'), '1.234');
    await user.click(form().getByRole('button', { name: 'Send' }));
    expect(form().getByText('You cannot send money to yourself')).toBeInTheDocument();
    expect(form().getByText(/Enter an amount like/)).toBeInTheDocument();
    expect(callsTo(fetchMock, 'POST', /\/api\/transactions$/)).toHaveLength(0);
  });

  it('disables sending and depositing while the account is frozen', async () => {
    signIn(ALICE);
    mockApi(dashboardRoutes({ wallet: { balance: 900, held: 20, currency: 'USD', frozen: true } }));
    renderApp('/');
    expect(await screen.findByText(/Your account is frozen/)).toBeInTheDocument();
    expect(form().getByRole('button', { name: 'Send' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Deposit' })).toBeDisabled();
  });
});

describe('live tracker', () => {
  afterEach(() => vi.useRealTimers());

  it('shows a newer copy from the page reload at once instead of waiting for the first poll', async () => {
    const user = userEvent.setup();
    const flagged = makeTx({ status: 'UNDER_REVIEW', riskTier: null, action: null });
    const scored = {
      ...flagged,
      status: 'ACCOUNT_FROZEN',
      riskTier: 'CRITICAL',
      action: 'BLOCK_AND_FREEZE',
      statusHistory: [...flagged.statusHistory, { status: 'ACCOUNT_FROZEN', at: '', source: 'alerting-service' }],
    };
    let sent = false;
    signIn(ALICE);
    const fetchMock = mockApi([
      [
        'POST',
        /\/api\/transactions$/,
        () => {
          sent = true;
          return json(201, { transaction: flagged });
        },
      ],
      ['GET', /\/api\/transactions\?/, () => ({ items: sent ? [scored] : [], nextCursor: null })],
      ['GET', /\/api\/wallet$/, () => ({ wallet: { balance: 1000, held: 0, frozen: false } })],
      ['GET', new RegExp(`/api/transactions/${flagged.id}$`), () => ({ transaction: scored })],
    ]);
    renderApp('/');
    await screen.findByText('$1,000.00');
    await user.type(form().getByLabelText('Recipient email'), 'bob@demo.test');
    await user.type(form().getByLabelText('Amount (USD)'), '20');
    await user.click(form().getByRole('button', { name: 'Send' }));

    const tracker = within(await screen.findByRole('region', { name: 'Latest transfer' }));
    expect(await tracker.findByText(/account is frozen until a reviewer decides/)).toBeInTheDocument();
    expect(tracker.queryByText('live')).not.toBeInTheDocument();
    expect(callsTo(fetchMock, 'GET', new RegExp(`/api/transactions/${flagged.id}$`))).toHaveLength(0);
  });

  it('polls a flagged transfer until it rests, then refreshes the wallet and stops', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const flagged = makeTx({
      status: 'UNDER_REVIEW',
      riskTier: null,
      action: null,
      quickScan: { score: 0.43, threshold: 0.39, flagged: true, reason: 'ANOMALY', modelVersion: '2' },
    });
    const polls = [
      flagged,
      {
        ...flagged,
        status: 'AWAITING_OTP',
        riskTier: 'HIGH',
        riskScore: 0.85,
        action: 'OTP_STEP_UP',
        deepScan: { probability: 0.85, riskTier: 'HIGH', modelVersion: '2', scoredAt: '' },
      },
    ];
    const fetchMock = await openDashboard([
      ['POST', /\/api\/transactions$/, () => json(201, { transaction: flagged })],
      ['GET', new RegExp(`/api/transactions/${flagged.id}$`), () => ({ transaction: polls.shift() ?? polls[0] })],
    ]);

    await user.type(form().getByLabelText('Recipient email'), 'bob@demo.test');
    await user.type(form().getByLabelText('Amount (USD)'), '20');
    await user.click(form().getByRole('button', { name: 'Send' }));
    const tracker = within(await screen.findByRole('region', { name: 'Latest transfer' }));
    expect(tracker.getByText(/deep scan is scoring it now/)).toBeInTheDocument();
    expect(tracker.getByText('live')).toBeInTheDocument();

    const walletCallsBefore = callsTo(fetchMock, 'GET', /\/api\/wallet$/).length;
    await act(() => vi.advanceTimersByTimeAsync(2000)); // poll 1: still under review
    await act(() => vi.advanceTimersByTimeAsync(2000)); // poll 2: AWAITING_OTP
    expect(tracker.getByText(/confirm this transfer with the one-time code/)).toBeInTheDocument();
    expect(tracker.getByRole('link', { name: 'Enter the code' })).toHaveAttribute('href', '/alerts');
    expect(tracker.getByText('Fraud probability 85.0%, tier HIGH')).toBeInTheDocument();
    expect(tracker.queryByText('live')).not.toBeInTheDocument();
    await waitFor(() => expect(callsTo(fetchMock, 'GET', /\/api\/wallet$/).length).toBe(walletCallsBefore + 1));

    await act(() => vi.advanceTimersByTimeAsync(30_000));
    expect(callsTo(fetchMock, 'GET', new RegExp(`/api/transactions/${flagged.id}$`))).toHaveLength(2);
  });
});
