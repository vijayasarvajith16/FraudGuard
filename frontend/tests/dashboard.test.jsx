import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { amountSeries, chartTop, initials, scoreSeries, smoothPath, summarize } from '../src/lib/stats.js';
import { ALICE, dashboardRoutes, json, makeTx, mockApi, renderApp, signIn } from './helpers.jsx';

const quick = (score, flagged) => ({ score, threshold: 0.389, flagged, reason: flagged ? 'ANOMALY' : 'NORMAL' });

describe('dashboard figures', () => {
  const txs = [
    makeTx({ amount: 10.1, status: 'APPROVED', quickScan: quick(0.31, false) }),
    makeTx({ amount: 20.2, status: 'AWAITING_OTP', quickScan: quick(0.5, true) }),
    makeTx({ amount: 30, status: 'ACCOUNT_FROZEN', quickScan: quick(0.6, true) }),
    makeTx({
      amount: 40,
      status: 'UNDER_REVIEW',
      quickScan: { score: null, threshold: null, flagged: true, reason: 'QUICK_SCAN_UNAVAILABLE' },
    }),
    makeTx({ amount: 0.2, status: 'APPROVED', quickScan: quick(0.2, false) }),
  ];

  it('groups outcomes and counts what the quick scan cleared', () => {
    const s = summarize(txs);
    expect(s.total).toBe(5);
    expect(Object.fromEntries(s.groups.map((g) => [g.id, g.count]))).toEqual({
      approved: 2,
      review: 1,
      otp: 1,
      stopped: 1,
    });
    expect(s.groups[0].share).toBeCloseTo(0.4);
    expect(s.scanned).toBe(5);
    expect(s.cleared).toBe(2);
    expect(s.clearedShare).toBeCloseTo(0.4);
    expect(s.settled).toBe(10.3); // summed in cents: no floating-point drift
  });

  it('handles an empty history', () => {
    const s = summarize([]);
    expect(s.total).toBe(0);
    expect(s.clearedShare).toBeNull();
    expect(s.groups.every((g) => g.share === 0)).toBe(true);
  });

  it('builds chart series oldest first and skips missing scores', () => {
    const scores = scoreSeries(txs);
    expect(scores.map((p) => p.score)).toEqual([0.2, 0.6, 0.5, 0.31]);
    expect(scoreSeries(txs, 2).map((p) => p.score)).toEqual([0.5, 0.31]);
    expect(amountSeries(txs, 3).map((p) => p.amount)).toEqual([30, 20.2, 10.1]);
  });

  it('draws a smooth path inside the box', () => {
    expect(chartTop([])).toBe(1);
    expect(chartTop([2], 1.5)).toBe(3);
    expect(smoothPath([], 100, 50)).toEqual({ line: '', area: '' });
    expect(smoothPath([5], 100, 50, 10).line).toBe('M0,25 L100,25');
    const { line, area } = smoothPath([0, 10, 5], 100, 50, 10);
    expect(line.startsWith('M0,50 C')).toBe(true);
    expect(line.endsWith(' 100,25')).toBe(true);
    expect(area.endsWith('L100,50 L0,50 Z')).toBe(true);
  });

  it('makes avatar initials', () => {
    expect(initials('Ada Lovelace King')).toBe('AL');
    expect(initials('  ops ')).toBe('O');
    expect(initials('')).toBe('?');
  });
});

describe('dashboard page', () => {
  it('shows outcome tiles, the quick-scan chart and recent activity from the history', async () => {
    signIn(ALICE);
    mockApi(
      dashboardRoutes({
        transactions: [
          makeTx({ amount: 12.5, description: 'Lunch', quickScan: quick(0.31, false) }),
          makeTx({ amount: 99, status: 'AWAITING_OTP', riskTier: 'HIGH', quickScan: quick(0.52, true) }),
        ],
      }),
    );
    renderApp('/');
    await screen.findByText('$1,000.00');

    const tile = (label) => screen.getByText(label, { selector: '.tile-label' }).closest('.tile');
    expect(within(tile('Approved')).getByText('1')).toBeInTheDocument();
    expect(within(tile('Awaiting OTP')).getByText('50% of transfers')).toBeInTheDocument();
    expect(within(tile('Blocked or frozen')).getByText('0')).toBeInTheDocument();

    expect(screen.getByRole('img', { name: /2 transfers: 1 at or above the threshold/ })).toBeInTheDocument();
    expect(
      screen.getByText('1 of your last 2 scored transfers were not flagged, so they settled instantly.'),
    ).toBeInTheDocument();
    expect(screen.getByText('Lunch')).toBeInTheDocument();
    expect(screen.getByText('−$99.00')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'How transfers are screened' })).toBeInTheDocument();
  });

  it('shows empty states before the first transfer, and quick amounts fill the deposit', async () => {
    const user = userEvent.setup();
    signIn(ALICE);
    mockApi([
      [
        'POST',
        /\/api\/wallet\/deposit$/,
        ({ body }) => json(200, { wallet: { balance: 1000 + body.amount, held: 0 } }),
      ],
      ...dashboardRoutes(),
    ]);
    renderApp('/');
    await screen.findByText('$1,000.00');
    expect(screen.getByText('Send a transfer to see its quick-scan score here.')).toBeInTheDocument();
    expect(screen.getByText('No transfers scored yet.')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Fill in $500' }));
    expect(screen.getByLabelText('Amount (USD)', { selector: '#deposit-amount' })).toHaveValue('500');
    await user.click(screen.getByRole('button', { name: 'Deposit' }));
    expect(await screen.findByText('$1,500.00')).toBeInTheDocument();
    expect(screen.getByText('Funds added.')).toBeInTheDocument();
  });
});
