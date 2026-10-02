import { Link } from 'react-router';
import { useTransactionPolling } from '../hooks/useTransactionPolling.js';
import { formatMoney, formatPercent, formatScore } from '../lib/format.js';
import { ACTION_LABELS, statusExplanation } from '../lib/transactions.js';
import { StatusBadge, TierBadge } from './Badges.jsx';
import { IconCheck, IconKey, IconLayers, IconScan, IconSliders } from './icons.jsx';

function steps(tx) {
  const q = tx.quickScan;
  const d = tx.deepScan;
  const quick = !q
    ? { state: 'active', text: 'Running...' }
    : q.reason === 'QUICK_SCAN_UNAVAILABLE'
      ? { state: 'warn', text: 'Unavailable: sent to the deep scan as a precaution' }
      : q.flagged
        ? { state: 'warn', text: `Flagged: anomaly score ${formatScore(q.score)} ≥ ${formatScore(q.threshold)}` }
        : { state: 'done', text: `Normal: anomaly score ${formatScore(q.score)} < ${formatScore(q.threshold)}` };
  const deep = d
    ? { state: 'done', text: `Fraud probability ${formatPercent(d.probability)}, tier ${d.riskTier}` }
    : q && !q.flagged
      ? { state: 'skipped', text: 'Not needed' }
      : { state: 'active', text: 'Scoring...' };
  const action = tx.action
    ? { state: 'done', text: ACTION_LABELS[tx.action] ?? tx.action }
    : { state: q && !q.flagged ? 'done' : 'pending', text: 'Waiting for the deep scan' };
  return [
    { name: 'Quick scan', icon: IconScan, ...quick },
    { name: 'Deep scan', icon: IconLayers, ...deep },
    { name: 'Mitigation', icon: IconSliders, ...action },
  ];
}

function Pipeline({ items }) {
  return (
    <ol className="pipeline">
      {items.map(({ name, text, state, icon: Glyph }) => (
        <li key={name} className={`pipe-step step-${state}`}>
          <span className="pipe-node" aria-hidden="true">
            {state === 'done' ? <IconCheck size={16} /> : <Glyph size={16} />}
          </span>
          <span className="pipe-copy">
            <span className="step-name">{name}</span>
            <span className="step-text">{text}</span>
          </span>
        </li>
      ))}
    </ol>
  );
}

/**
 * Live view of the transfer just sent. Remount with a new `key` for each transfer. `latest` is the
 * page's own copy from its last reload, which can be newer than the last poll.
 */
export function TransferTracker({ initial, latest, onSettled }) {
  const { transaction: tx, polling } = useTransactionPolling(initial, { onSettled, latest });
  return (
    <section className="tracker" aria-live="polite" aria-label="Latest transfer">
      <div className="tracker-head">
        <div>
          <h3 className="eyebrow">Latest transfer</h3>
          <p className="tracker-amount">{formatMoney(tx.amount)}</p>
        </div>
        <div className="badges">
          <StatusBadge status={tx.status} />
          <TierBadge tier={tx.riskTier} />
          {polling && <span className="live">live</span>}
        </div>
      </div>
      <p className="tracker-text">{statusExplanation(tx)}</p>
      {tx.status === 'AWAITING_OTP' && (
        <Link className="btn btn-primary" to="/alerts">
          <IconKey size={18} />
          Enter the code
        </Link>
      )}
      <Pipeline items={steps(tx)} />
    </section>
  );
}

const IDLE = [
  { name: 'Quick scan', icon: IconScan, text: 'An Isolation Forest scores every transfer in milliseconds.' },
  { name: 'Deep scan', icon: IconLayers, text: 'XGBoost scores only the transfers the quick scan flags.' },
  {
    name: 'Mitigation',
    icon: IconSliders,
    text: 'The risk tier decides the action: log, notify, a one-time code, or a freeze.',
  },
].map((s) => ({ ...s, state: 'idle' }));

/** Shown before the first transfer of the session: how a transfer is screened. */
export function PipelineIntro() {
  return (
    <section className="tracker tracker-idle" aria-label="How transfers are screened">
      <h3 className="eyebrow">How your transfer is screened</h3>
      <Pipeline items={IDLE} />
    </section>
  );
}
