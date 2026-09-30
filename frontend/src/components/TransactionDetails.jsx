import { formatDateTime, formatPercent, formatScore } from '../lib/format.js';
import { ACTION_LABELS, STATUS_LABELS } from '../lib/transactions.js';

const REASONS = {
  NORMAL: 'normal',
  ANOMALY: 'anomaly (flagged)',
  QUICK_SCAN_UNAVAILABLE: 'unavailable, sent to review as a precaution',
};

/** Scan results and status history of one transaction. */
export function TransactionDetails({ tx }) {
  const q = tx.quickScan;
  const d = tx.deepScan;
  return (
    <div className="details">
      <dl className="grid-dl">
        <dt>Transaction</dt>
        <dd className="mono">{tx.id}</dd>
        <dt>Recipient</dt>
        <dd className="mono">{tx.recipientId}</dd>
        {tx.description && (
          <>
            <dt>Description</dt>
            <dd>{tx.description}</dd>
          </>
        )}
        <dt>Quick scan</dt>
        <dd>
          {!q
            ? 'not run'
            : q.reason === 'QUICK_SCAN_UNAVAILABLE'
              ? REASONS[q.reason]
              : `${REASONS[q.reason] ?? q.reason}; score ${formatScore(q.score)} vs threshold ${formatScore(q.threshold)}${
                  q.modelVersion ? `; model v${q.modelVersion}` : ''
                }`}
        </dd>
        <dt>Deep scan</dt>
        <dd>
          {d
            ? `fraud probability ${formatPercent(d.probability)}; tier ${d.riskTier}; model v${d.modelVersion}`
            : tx.status === 'UNDER_REVIEW' || tx.status === 'PENDING'
              ? 'in progress'
              : 'not needed'}
        </dd>
        <dt>Action</dt>
        <dd>{tx.action ? (ACTION_LABELS[tx.action] ?? tx.action) : 'pending'}</dd>
      </dl>
      <h4>Status history</h4>
      <ol className="timeline">
        {tx.statusHistory.map((h, i) => (
          <li key={i}>
            <span className="timeline-status">{STATUS_LABELS[h.status] ?? h.status}</span>
            <span className="muted small">
              {formatDateTime(h.at)} · {h.source}
              {h.reason ? ` · ${h.reason}` : ''}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}
