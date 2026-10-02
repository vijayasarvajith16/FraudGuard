import { useCallback, useEffect, useState } from 'react';
import { useResource } from '../hooks/useResource.js';
import { useAuth } from '../auth/context.js';
import { TierBadge } from '../components/Badges.jsx';
import { Meter, Skeleton } from '../components/Charts.jsx';
import { ErrorNotice } from '../components/ErrorNotice.jsx';
import { TransactionDetails } from '../components/TransactionDetails.jsx';
import { IconBan, IconCheck, IconChevron, IconRefresh, IconShield } from '../components/icons.jsx';
import { formatDateTime, formatMoney, formatPercent, shortId } from '../lib/format.js';
import { ACTION_LABELS, STATUS_LABELS, TIER_TONE } from '../lib/transactions.js';
import { usePageTitle } from '../hooks/usePageTitle.js';

function ReviewCard({ review, onDecided }) {
  const { api } = useAuth();
  const [tx, setTx] = useState(null);
  const [showTx, setShowTx] = useState(false);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [unfrozen, setUnfrozen] = useState(false);

  async function toggleTransaction() {
    setShowTx((s) => !s);
    if (tx) return;
    try {
      setTx((await api.getTransaction(review.transactionId)).transaction);
    } catch (err) {
      setError(err);
    }
  }

  async function decide(decision) {
    setBusy(true);
    setError(null);
    try {
      await api.decideReview(review.id, decision, note.trim());
      onDecided();
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  async function unfreeze() {
    setBusy(true);
    setError(null);
    try {
      await api.unfreezeAccount(review.userId);
      setUnfrozen(true);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  const open = review.status === 'OPEN';
  return (
    <li className={`card review tone-${TIER_TONE[review.riskTier] ?? 'neutral'}${showTx ? ' review-open' : ''}`}>
      <div className="review-summary">
        <span className="alert-icon" aria-hidden="true">
          <IconShield size={20} />
        </span>
        <div className="review-main">
          <div className="badges">
            <strong className="review-amount">{formatMoney(review.amount)}</strong>
            <TierBadge tier={review.riskTier} />
          </div>
          <span className="muted small">
            customer <span className="mono">{shortId(review.userId)}</span> · {formatDateTime(review.createdAt)}
          </span>
        </div>
        <div className="review-risk">
          <span className="small">fraud probability {formatPercent(review.riskScore)}</span>
          <Meter value={review.riskScore ?? 0} tone={TIER_TONE[review.riskTier]} label="Fraud probability" />
        </div>
        <button type="button" className="btn" onClick={toggleTransaction} aria-expanded={showTx}>
          {showTx ? 'Close' : open ? 'Review' : 'Details'}
          <IconChevron size={16} className="btn-chevron" />
        </button>
      </div>
      {review.status === 'RESOLVED' && (
        <p className="small review-decision">
          {review.decision === 'APPROVE' ? 'Approved' : 'Rejected'} {formatDateTime(review.resolvedAt)}
          {review.note ? `: “${review.note}”` : ''}
        </p>
      )}

      {showTx && (
        <div className="review-body">
          {tx && (
            <>
              <p className="small">
                Status <strong>{STATUS_LABELS[tx.status]}</strong> · action {ACTION_LABELS[tx.action] ?? tx.action}
              </p>
              <TransactionDetails tx={tx} />
            </>
          )}
          {open && (
            <div className="decision">
              <label className="field">
                <span>Note (optional)</span>
                <textarea
                  name="note"
                  rows={2}
                  maxLength={500}
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="e.g. customer confirmed by phone"
                />
              </label>
              <div className="row-actions">
                <button type="button" className="btn btn-primary" disabled={busy} onClick={() => decide('APPROVE')}>
                  <IconCheck size={18} />
                  Approve and unfreeze
                </button>
                <button type="button" className="btn btn-danger" disabled={busy} onClick={() => decide('REJECT')}>
                  <IconBan size={18} />
                  Reject
                </button>
              </div>
              <p className="muted small">
                Approve settles the transfer and unfreezes the account. Reject returns the funds to the customer and
                keeps the account frozen.
              </p>
            </div>
          )}
        </div>
      )}
      {review.status === 'RESOLVED' && review.decision === 'REJECT' && (
        <div className="row-actions">
          {unfrozen ? (
            <span className="notice notice-info small">Account unfrozen.</span>
          ) : (
            <button type="button" className="btn" disabled={busy} onClick={unfreeze}>
              Unfreeze account
            </button>
          )}
        </div>
      )}
      <ErrorNotice error={error} />
    </li>
  );
}

function ReviewQueue() {
  const { api } = useAuth();
  const [status, setStatus] = useState('OPEN');
  const load = useCallback(() => api.listReviews(status).then((r) => r.items), [api, status]);
  const { data: items, error, reload } = useResource(load);

  return (
    <section className="rise">
      <div className="section-head">
        <div>
          <div className="title-row">
            <h2>Manual review queue</h2>
            {items?.length > 0 && (
              <span className="count-chip" key={status}>
                {items.length >= 100 ? '100+' : items.length} {status === 'OPEN' ? 'open' : 'resolved'}
              </span>
            )}
          </div>
          <p className="muted small">Critical-risk transfers wait here, with the account frozen, until you decide.</p>
        </div>
        <div className="section-actions">
          <div className="segmented" role="tablist" aria-label="Case status">
            {['OPEN', 'RESOLVED'].map((s) => (
              <button
                key={s}
                type="button"
                role="tab"
                aria-selected={status === s}
                className={status === s ? 'segment segment-active' : 'segment'}
                onClick={() => setStatus(s)}
              >
                {s === 'OPEN' ? 'Open' : 'Resolved'}
              </button>
            ))}
          </div>
          <button type="button" className="round-btn" onClick={reload} aria-label="Refresh the queue" title="Refresh">
            <IconRefresh size={18} />
          </button>
        </div>
      </div>
      <ErrorNotice error={error} />
      {!items && !error && <Skeleton className="sk-card" />}
      {items?.length === 0 && (
        <div className="card empty-state">
          <span className="empty-icon tone-ok" aria-hidden="true">
            <IconCheck size={26} />
          </span>
          <p className="muted">{status === 'OPEN' ? 'No cases waiting for a decision.' : 'No resolved cases.'}</p>
        </div>
      )}
      <ul className="reviews stagger">
        {items?.map((r) => (
          <ReviewCard key={r.id} review={r} onDecided={reload} />
        ))}
      </ul>
    </section>
  );
}

function PolicyPanel() {
  const { api } = useAuth();
  const [config, setConfig] = useState(null);
  const [message, setMessage] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.tierActions().then(setConfig, setError);
  }, [api]);

  async function reload() {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const res = await api.reloadTierActions();
      setConfig(res);
      setMessage(res.result === 'unchanged' ? 'The file has not changed.' : 'New policy loaded.');
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card rise rise-late">
      <div className="card-head">
        <div>
          <h2>Risk tier policy</h2>
          <p className="muted small">What the alerting service does for each deep-scan risk tier.</p>
        </div>
        <button type="button" className="btn" onClick={reload} disabled={busy}>
          <IconRefresh size={18} className={busy ? 'spin' : undefined} />
          {busy ? 'Reloading...' : 'Reload from file'}
        </button>
      </div>
      {config && (
        <>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Tier</th>
                  <th>Action</th>
                  <th>Resulting status</th>
                  <th>Notify user</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(config.policy.tiers).map(([tier, rule]) => (
                  <tr key={tier}>
                    <td>
                      <TierBadge tier={tier} />
                    </td>
                    <td>{ACTION_LABELS[rule.action] ?? rule.action}</td>
                    <td>{STATUS_LABELS[rule.resultingStatus] ?? rule.resultingStatus}</td>
                    <td>
                      <span className={rule.notifyUser ? 'yes' : 'no'}>{rule.notifyUser ? 'yes' : 'no'}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="muted small">
            Version {config.policy.version}, loaded {formatDateTime(config.loadedAt)}, sha256{' '}
            <span className="mono">{config.sha256?.slice(0, 12)}</span>. The file is re-read automatically when it
            changes; an invalid file is rejected and the current policy stays active.
          </p>
        </>
      )}
      {message && <p className="notice notice-info small">{message}</p>}
      <ErrorNotice error={error} />
    </section>
  );
}

export function AdminPage() {
  usePageTitle('Review queue');
  return (
    <div className="page">
      <div className="page-head rise">
        <div>
          <h1>Administration</h1>
          <p className="muted">Decide manual-review cases and check the live tier policy.</p>
        </div>
      </div>
      <ReviewQueue />
      <PolicyPanel />
    </div>
  );
}
