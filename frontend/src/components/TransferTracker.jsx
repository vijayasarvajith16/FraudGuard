import { Link } from 'react-router';
import { useTransactionPolling } from '../hooks/useTransactionPolling.js';
import { formatMoney, formatPercent, formatScore } from '../lib/format.js';
import { ACTION_LABELS, statusExplanation } from '../lib/transactions.js';
import { StatusBadge, TierBadge } from './Badges.jsx';

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
    { name: 'Quick scan', ...quick },
    { name: 'Deep scan', ...deep },
    { name: 'Mitigation', ...action },
  ];
}

/**
 * Live view of the transfer just sent. Remount with a new `key` for each transfer. `latest` is the
 * page's own copy from its last reload, which can be newer than the last poll.
 */
export function TransferTracker({ initial, latest, onSettled }) {
  const { transaction: tx, polling } = useTransactionPolling(initial, { onSettled, latest });
  return (
    <section className="card tracker" aria-live="polite" aria-label="Latest transfer">
      <div className="tracker-head">
        <h2>
          Latest transfer <span className="muted">{formatMoney(tx.amount)}</span>
        </h2>
        <div className="badges">
          <StatusBadge status={tx.status} />
          <TierBadge tier={tx.riskTier} />
          {polling && <span className="live">live</span>}
        </div>
      </div>
      <p>{statusExplanation(tx)}</p>
      {tx.status === 'AWAITING_OTP' && (
        <Link className="btn btn-primary" to="/alerts">
          Enter the code
        </Link>
      )}
      <ol className="steps">
        {steps(tx).map((s) => (
          <li key={s.name} className={`step step-${s.state}`}>
            <span className="step-name">{s.name}</span>
            <span className="step-text">{s.text}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}
