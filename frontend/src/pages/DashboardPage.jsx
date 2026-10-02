import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useLocation } from 'react-router';
import { useAuth } from '../auth/context.js';
import { StatusIcon, TierBadge } from '../components/Badges.jsx';
import { AmountArea, Meter, ScoreBars, Skeleton } from '../components/Charts.jsx';
import { DepositForm } from '../components/DepositForm.jsx';
import { ErrorNotice } from '../components/ErrorNotice.jsx';
import { TransferForm } from '../components/TransferForm.jsx';
import { PipelineIntro, TransferTracker } from '../components/TransferTracker.jsx';
import { WalletCard } from '../components/WalletCard.jsx';
import {
  IconArrowDownLeft,
  IconArrowUpRight,
  IconCheck,
  IconClock,
  IconDots,
  IconKey,
  IconLock,
} from '../components/icons.jsx';
import { useCountUp } from '../hooks/useMotion.js';
import { usePageTitle } from '../hooks/usePageTitle.js';
import { useResource } from '../hooks/useResource.js';
import { formatDateTime, formatMoney, formatScore } from '../lib/format.js';
import { amountSeries, scoreSeries, summarize } from '../lib/stats.js';
import { STATUS_TONE } from '../lib/transactions.js';

/** How many of the newest transfers the dashboard figures are computed from. */
const HISTORY = 50;

const TILE_ICONS = { approved: IconCheck, review: IconClock, otp: IconKey, stopped: IconLock };

function focusSend() {
  document.getElementById('send')?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
  document.querySelector('#send input[name=recipient]')?.focus({ preventScroll: true });
}

function focusDeposit() {
  document.getElementById('add-funds')?.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
  document.getElementById('deposit-amount')?.focus({ preventScroll: true });
}

const percent = (share) => `${Math.round(share * 100)}%`;

function Tile({ group, total }) {
  const count = Math.round(useCountUp(group.count, 700));
  const Glyph = TILE_ICONS[group.id];
  return (
    <div className={`tile tone-${group.tone}`}>
      <span className="tile-icon" aria-hidden="true">
        <Glyph size={20} />
      </span>
      <p className="tile-label">{group.label}</p>
      <p className="tile-figure">{count}</p>
      <p className="tile-sub small">
        <span className="dot" aria-hidden="true" />
        {total ? `${percent(group.share)} of transfers` : 'No transfers yet'}
      </p>
    </div>
  );
}

function ScreeningCard({ stats }) {
  const share = stats.clearedShare ?? 0;
  return (
    <section className="card screening">
      <div className="chips">
        <span className="chip chip-mint">Quick scan</span>
        <span className="chip chip-pink">Deep scan</span>
      </div>
      <h2>Cleared by the quick scan</h2>
      <p className="muted small">
        {stats.scanned
          ? `${stats.cleared} of your last ${stats.scanned} scored transfers were not flagged, so they settled instantly.`
          : 'No transfers scored yet.'}
      </p>
      <div className="progress-row">
        <Meter value={share} tone="ok" label="Share cleared by the quick scan" />
        <strong>{stats.scanned ? percent(share) : '-'}</strong>
      </div>
    </section>
  );
}

function RecentActivity({ items }) {
  return (
    <section className="card">
      <div className="card-head">
        <h2>Recent activity</h2>
        <Link to="/transactions" className="link-sm">
          View all
        </Link>
      </div>
      {items.length === 0 ? (
        <p className="muted small">No transfers yet.</p>
      ) : (
        <ul className="activity">
          {items.map((tx) => (
            <li key={tx.id} className="activity-row">
              <StatusIcon status={tx.status} />
              <div className="activity-main">
                <strong>{tx.description || 'Transfer'}</strong>
                <span className="muted small">{formatDateTime(tx.createdAt)}</span>
              </div>
              <div className="activity-side">
                <span className={`amount text-${STATUS_TONE[tx.status] ?? 'neutral'}`}>−{formatMoney(tx.amount)}</span>
                <TierBadge tier={tx.riskTier} />
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function ScoreCard({ transactions }) {
  const series = scoreSeries(transactions);
  const latest = series[series.length - 1];
  return (
    <section className="card chart-card">
      <p className="eyebrow">Quick-scan score</p>
      <p className="chart-figure">{latest ? formatScore(latest.score) : '-'}</p>
      <p className="chart-sub small">
        {latest ? (
          <>
            <span className={latest.flagged ? 'dot dot-flagged' : 'dot'} aria-hidden="true" />
            Latest transfer {latest.flagged ? 'flagged' : 'normal'} · threshold {formatScore(latest.threshold)}
          </>
        ) : (
          'No scores yet'
        )}
      </p>
      <ScoreBars series={series} />
      {series.length > 0 && (
        <p className="legend small" aria-hidden="true">
          <span>
            <i className="swatch swatch-ok" /> below threshold
          </span>
          <span>
            <i className="swatch swatch-flagged" /> flagged for the deep scan
          </span>
        </p>
      )}
    </section>
  );
}

function AmountCard({ transactions, settled }) {
  const shown = useCountUp(settled);
  const series = amountSeries(transactions);
  return (
    <section className="card chart-card">
      <p className="eyebrow">Settled</p>
      <p className="chart-figure">{formatMoney(shown)}</p>
      <p className="chart-sub small">
        {transactions.length ? `Approved, from your last ${transactions.length} transfers` : 'Nothing sent yet'}
      </p>
      <AmountArea series={series} />
      {series.length > 0 && <p className="legend small">Amounts of your last {series.length} transfers</p>}
    </section>
  );
}

export function DashboardPage() {
  usePageTitle('Wallet');
  const { api, user } = useAuth();
  const location = useLocation();
  const [tracked, setTracked] = useState(null);
  const load = useCallback(async () => {
    const [w, list] = await Promise.all([api.wallet(), api.listTransactions({ limit: HISTORY })]);
    return { wallet: w.wallet, transactions: list.items };
  }, [api]);
  const { data, error, reload, setData } = useResource(load);
  const wallet = data?.wallet;
  const transactions = useMemo(() => data?.transactions ?? [], [data]);
  const stats = useMemo(() => summarize(transactions), [transactions]);

  // The "+" button in the top bar links here with { focusSend: true }.
  useEffect(() => {
    if (location.state?.focusSend) focusSend();
  }, [location.key, location.state]);

  function onCreated(tx) {
    setTracked(tx);
    reload();
  }

  return (
    <div className="page dashboard">
      <div className="page-head rise">
        <div>
          <h1>Hello, {user.name}</h1>
          <p className="muted">Your wallet, and how the fraud screening treated your transfers.</p>
        </div>
      </div>
      <ErrorNotice error={error} />

      <div className="dash-grid">
        <div className="dash-left stagger">
          {wallet ? <WalletCard wallet={wallet} /> : <Skeleton className="sk-balance" />}
          <div className="quick-actions">
            <button type="button" className="action" onClick={focusSend}>
              <IconArrowUpRight size={18} />
              New transfer
            </button>
            <button type="button" className="action" onClick={focusDeposit}>
              <IconArrowDownLeft size={18} />
              Add funds
            </button>
            <Link
              to="/transactions"
              className="action action-icon"
              aria-label="All transactions"
              title="All transactions"
            >
              <IconDots />
            </Link>
          </div>
          <DepositForm
            disabled={!wallet || wallet.frozen}
            onDeposited={(next) => setData((d) => ({ ...d, wallet: next }))}
          />
          {data ? <ScreeningCard stats={stats} /> : <Skeleton className="sk-card" />}
          {data ? <RecentActivity items={transactions.slice(0, 5)} /> : <Skeleton className="sk-card" />}
        </div>

        <div className="dash-right">
          <div className="tiles stagger">
            {data
              ? stats.groups.map((g) => <Tile key={g.id} group={g} total={stats.total} />)
              : [0, 1, 2, 3].map((i) => <Skeleton key={i} className="sk-tile" />)}
          </div>
          <div className="charts stagger">
            {data ? (
              <>
                <ScoreCard transactions={transactions} />
                <AmountCard transactions={transactions} settled={stats.settled} />
              </>
            ) : (
              <>
                <Skeleton className="sk-chart" />
                <Skeleton className="sk-chart" />
              </>
            )}
          </div>
          <div className="rise rise-late">
            <TransferForm
              disabled={!wallet || wallet.frozen}
              onCreated={onCreated}
              aside={
                tracked ? (
                  <TransferTracker
                    key={tracked.id}
                    initial={tracked}
                    latest={transactions.find((t) => t.id === tracked.id)}
                    onSettled={reload}
                  />
                ) : (
                  <PipelineIntro />
                )
              }
            />
          </div>
        </div>
      </div>
    </div>
  );
}
