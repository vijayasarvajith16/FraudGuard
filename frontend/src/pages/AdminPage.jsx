import { useCallback, useEffect, useState } from 'react';
import { useResource } from '../hooks/useResource.js';
import { useAuth } from '../auth/context.js';
import { TierBadge } from '../components/Badges.jsx';
import { ErrorNotice } from '../components/ErrorNotice.jsx';
import { TransactionDetails } from '../components/TransactionDetails.jsx';
import { formatDateTime, formatMoney, formatPercent, shortId } from '../lib/format.js';
import { ACTION_LABELS, STATUS_LABELS } from '../lib/transactions.js';

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
    <li className="card review">
      <div className="review-summary">
        <div className="badges">
          <TierBadge tier={review.riskTier} />
          <strong>{formatMoney(review.amount)}</strong>
          <span className="muted small">fraud probability {formatPercent(review.riskScore)}</span>
        </div>
        <span className="muted small">
          customer <span className="mono">{shortId(review.userId)}</span> · {formatDateTime(review.createdAt)}
        </span>
        <button type="button" className="btn" onClick={toggleTransaction} aria-expanded={showTx}>
          {showTx ? 'Close' : open ? 'Review' : 'Details'}
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
                  Approve and unfreeze
                </button>
                <button type="button" className="btn btn-danger" disabled={busy} onClick={() => decide('REJECT')}>
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
    <section>
      <div className="page-head">
        <h2>Manual review queue</h2>
        <div className="tabs" role="tablist">
          {['OPEN', 'RESOLVED'].map((s) => (
            <button
              key={s}
              type="button"
              role="tab"
              aria-selected={status === s}
              className={status === s ? 'tab tab-active' : 'tab'}
              onClick={() => setStatus(s)}
            >
              {s === 'OPEN' ? 'Open' : 'Resolved'}
            </button>
          ))}
          <button type="button" className="btn" onClick={reload}>
            Refresh
          </button>
        </div>
      </div>
      <ErrorNotice error={error} />
      {items?.length === 0 && (
        <p className="card muted">{status === 'OPEN' ? 'No cases waiting for a decision.' : 'No resolved cases.'}</p>
      )}
      <ul className="reviews">
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
    <section className="card">
      <div className="card-head">
        <h2>Risk tier policy</h2>
        <button type="button" className="btn" onClick={reload} disabled={busy}>
          {busy ? 'Reloading...' : 'Reload from file'}
        </button>
      </div>
      {config && (
        <>
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
                  <td>{rule.notifyUser ? 'yes' : 'no'}</td>
                </tr>
              ))}
            </tbody>
          </table>
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
  return (
    <div className="page">
      <h1>Administration</h1>
      <ReviewQueue />
      <PolicyPanel />
    </div>
  );
}
