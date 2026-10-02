import { formatDateTime, formatPercent, formatScore } from '../lib/format.js';
import { ACTION_LABELS, STATUS_LABELS, STATUS_TONE, TIER_TONE } from '../lib/transactions.js';
import { Meter } from './Charts.jsx';

const REASONS = {
  NORMAL: 'Normal',
  ANOMALY: 'Anomaly (flagged)',
  QUICK_SCAN_UNAVAILABLE: 'Unavailable, sent to review as a precaution',
};

function QuickScanCard({ q }) {
  if (!q) {
    return (
      <div className="scan-card">
        <p className="eyebrow">Quick scan</p>
        <p className="scan-figure muted">Not run</p>
      </div>
    );
  }
  const unavailable = q.reason === 'QUICK_SCAN_UNAVAILABLE';
  return (
    <div className="scan-card">
      <p className="eyebrow">Quick scan</p>
      <p className="scan-figure">{unavailable ? '-' : formatScore(q.score)}</p>
      <p className="small">{REASONS[q.reason] ?? q.reason}</p>
      {!unavailable && (
        <Meter
          value={q.score}
          max={Math.max(1, q.score, q.threshold)}
          marker={q.threshold}
          tone={q.flagged ? 'flagged' : 'ok'}
          label="Anomaly score against the threshold"
        />
      )}
      <p className="muted small">
        {unavailable ? 'No score' : `Threshold ${formatScore(q.threshold)}`}
        {q.modelVersion ? ` · model v${q.modelVersion}` : ''}
      </p>
    </div>
  );
}

function DeepScanCard({ tx }) {
  const d = tx.deepScan;
  return (
    <div className="scan-card">
      <p className="eyebrow">Deep scan</p>
      {d ? (
        <>
          <p className="scan-figure">{formatPercent(d.probability)}</p>
          <p className="small">Fraud probability</p>
          <Meter value={d.probability} tone={TIER_TONE[d.riskTier]} label="Fraud probability" />
          <p className="muted small">
            Tier {d.riskTier} · model v{d.modelVersion}
          </p>
        </>
      ) : (
        <p className="scan-figure muted">
          {tx.status === 'UNDER_REVIEW' || tx.status === 'PENDING' ? 'In progress' : 'Not needed'}
        </p>
      )}
    </div>
  );
}

/** Scan results and status history of one transaction. */
export function TransactionDetails({ tx }) {
  return (
    <div className="details">
      <div className="scan-grid">
        <QuickScanCard q={tx.quickScan} />
        <DeepScanCard tx={tx} />
        <div className="scan-card">
          <p className="eyebrow">Mitigation</p>
          <p className="scan-figure scan-figure-text">
            {tx.action ? (ACTION_LABELS[tx.action] ?? tx.action) : 'Pending'}
          </p>
          <p className="muted small">Status {STATUS_LABELS[tx.status] ?? tx.status}</p>
        </div>
      </div>

      <div className="details-cols">
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
        </dl>
        <div>
          <h4>Status history</h4>
          <ol className="timeline">
            {tx.statusHistory.map((h, i) => (
              <li key={i} className={`tone-${STATUS_TONE[h.status] ?? 'neutral'}`}>
                <span className="timeline-status">{STATUS_LABELS[h.status] ?? h.status}</span>
                <span className="muted small">
                  {formatDateTime(h.at)} · {h.source}
                  {h.reason ? ` · ${h.reason}` : ''}
                </span>
              </li>
            ))}
          </ol>
        </div>
      </div>
    </div>
  );
}
