import { useCallback, useState } from 'react';
import { useAuth } from '../auth/context.js';
import { StatusBadge, TierBadge } from '../components/Badges.jsx';
import { ErrorNotice } from '../components/ErrorNotice.jsx';
import { TransactionDetails } from '../components/TransactionDetails.jsx';
import { usePagedList } from '../hooks/useResource.js';
import { useTransactionPolling } from '../hooks/useTransactionPolling.js';
import { formatDateTime, formatMoney, formatPercent } from '../lib/format.js';
import { STATUS_LABELS, STATUSES } from '../lib/transactions.js';

function TransactionRow({ initial }) {
  const { transaction: tx, polling } = useTransactionPolling(initial);
  const [open, setOpen] = useState(false);
  return (
    <li className="tx">
      <button type="button" className="tx-summary" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span className="tx-when muted small">{formatDateTime(tx.createdAt)}</span>
        <span className="tx-what">
          <strong>{formatMoney(tx.amount)}</strong> <span className="muted">{tx.description || 'Transfer'}</span>
        </span>
        <span className="tx-score muted small" title="Deep-scan fraud probability">
          {tx.riskScore === null ? '' : `risk ${formatPercent(tx.riskScore)}`}
        </span>
        <span className="badges">
          <StatusBadge status={tx.status} />
          <TierBadge tier={tx.riskTier} />
          {polling && <span className="live">live</span>}
        </span>
      </button>
      {open && <TransactionDetails tx={tx} />}
    </li>
  );
}

export function TransactionsPage() {
  const { api } = useAuth();
  const [status, setStatus] = useState('');
  const fetchPage = useCallback((cursor) => api.listTransactions({ status, cursor }), [api, status]);
  const { items, cursor, loading, error, loadMore } = usePagedList(fetchPage);

  return (
    <div className="page">
      <div className="page-head">
        <h1>Transactions</h1>
        <label className="field field-inline">
          <span>Status</span>
          <select value={status} onChange={(e) => setStatus(e.target.value)} name="status-filter">
            <option value="">All</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {STATUS_LABELS[s]}
              </option>
            ))}
          </select>
        </label>
      </div>
      <ErrorNotice error={error} />
      <section className="card flush">
        {items.length === 0 && !loading ? (
          <p className="muted pad">No transactions{status ? ` with status ${STATUS_LABELS[status]}` : ''}.</p>
        ) : (
          <ul className="tx-list">
            {items.map((tx) => (
              <TransactionRow key={tx.id} initial={tx} />
            ))}
          </ul>
        )}
        {cursor && (
          <div className="pad">
            <button type="button" className="btn" onClick={loadMore} disabled={loading}>
              {loading ? 'Loading...' : 'Load more'}
            </button>
          </div>
        )}
      </section>
    </div>
  );
}
