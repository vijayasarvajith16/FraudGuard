import { useCallback, useState } from 'react';
import { useAuth } from '../auth/context.js';
import { StatusBadge, StatusIcon, TierBadge } from '../components/Badges.jsx';
import { Skeleton } from '../components/Charts.jsx';
import { ErrorNotice } from '../components/ErrorNotice.jsx';
import { TransactionDetails } from '../components/TransactionDetails.jsx';
import { IconActivity, IconChevron } from '../components/icons.jsx';
import { usePagedList } from '../hooks/useResource.js';
import { useTransactionPolling } from '../hooks/useTransactionPolling.js';
import { formatDateTime, formatMoney, formatPercent } from '../lib/format.js';
import { STATUS_LABELS, STATUSES } from '../lib/transactions.js';
import { usePageTitle } from '../hooks/usePageTitle.js';

function TransactionRow({ initial }) {
  const { transaction: tx, polling } = useTransactionPolling(initial);
  const [open, setOpen] = useState(false);
  return (
    <li className={open ? 'tx tx-open' : 'tx'}>
      <button type="button" className="tx-summary" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <StatusIcon status={tx.status} />
        <span className="tx-what">
          <strong>{tx.description || 'Transfer'}</strong>
          <span className="muted small">{formatDateTime(tx.createdAt)}</span>
        </span>
        <span className="tx-score muted small" title="Deep-scan fraud probability">
          {tx.riskScore === null ? '' : `risk ${formatPercent(tx.riskScore)}`}
        </span>
        <span className="badges">
          <StatusBadge status={tx.status} />
          <TierBadge tier={tx.riskTier} />
          {polling && <span className="live">live</span>}
        </span>
        <span className="tx-amount">{formatMoney(tx.amount)}</span>
        <IconChevron className="tx-chevron" size={18} />
      </button>
      {open && (
        <div className="tx-body">
          <TransactionDetails tx={tx} />
        </div>
      )}
    </li>
  );
}

export function TransactionsPage() {
  usePageTitle('Transactions');
  const { api } = useAuth();
  const [status, setStatus] = useState('');
  const fetchPage = useCallback((cursor) => api.listTransactions({ status, cursor }), [api, status]);
  const { items, cursor, loading, error, loadMore } = usePagedList(fetchPage);

  return (
    <div className="page">
      <div className="page-head rise">
        <div>
          <h1>Transactions</h1>
          <p className="muted">Every transfer you sent, with what each scan decided. Select one for details.</p>
        </div>
      </div>
      <fieldset className="segmented segmented-scroll rise">
        <legend className="sr-only">Filter by status</legend>
        {[['', 'All'], ...STATUSES.map((s) => [s, STATUS_LABELS[s]])].map(([value, label]) => (
          <label key={value || 'all'} className={status === value ? 'segment segment-active' : 'segment'}>
            <input
              type="radio"
              name="status-filter"
              value={value}
              checked={status === value}
              onChange={() => setStatus(value)}
            />
            <span>{label}</span>
          </label>
        ))}
      </fieldset>
      <ErrorNotice error={error} />
      <section className="card flush rise rise-late" aria-label="Transfers">
        {loading && items.length === 0 ? (
          <div className="pad stack">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="sk-row" />
            ))}
          </div>
        ) : items.length === 0 ? (
          <div className="empty-state">
            <span className="empty-icon tone-info" aria-hidden="true">
              <IconActivity size={26} />
            </span>
            <p className="muted">No transactions{status ? ` with status ${STATUS_LABELS[status]}` : ''}.</p>
          </div>
        ) : (
          <ul className="tx-list">
            {items.map((tx) => (
              <TransactionRow key={tx.id} initial={tx} />
            ))}
          </ul>
        )}
        {cursor && (
          <div className="pad center">
            <button type="button" className="btn" onClick={loadMore} disabled={loading}>
              {loading ? 'Loading...' : 'Load more'}
            </button>
          </div>
        )}
      </section>
    </div>
  );
}
