import { useCallback, useState } from 'react';
import { Link } from 'react-router';
import { useAuth } from '../auth/context.js';
import { StatusBadge, TierBadge } from '../components/Badges.jsx';
import { DepositForm } from '../components/DepositForm.jsx';
import { ErrorNotice } from '../components/ErrorNotice.jsx';
import { TransferForm } from '../components/TransferForm.jsx';
import { TransferTracker } from '../components/TransferTracker.jsx';
import { WalletCard } from '../components/WalletCard.jsx';
import { useResource } from '../hooks/useResource.js';
import { formatDateTime, formatMoney } from '../lib/format.js';

export function DashboardPage() {
  const { api, user } = useAuth();
  const [tracked, setTracked] = useState(null);
  const load = useCallback(async () => {
    const [w, list] = await Promise.all([api.wallet(), api.listTransactions({ limit: 5 })]);
    return { wallet: w.wallet, recent: list.items };
  }, [api]);
  const { data, error, reload, setData } = useResource(load);
  const wallet = data?.wallet;
  const recent = data?.recent ?? [];

  function onCreated(tx) {
    setTracked(tx);
    reload();
  }

  return (
    <div className="page">
      <div className="page-head">
        <h1>Hello, {user.name}</h1>
      </div>
      <ErrorNotice error={error} />
      {wallet && <WalletCard wallet={wallet} />}
      {tracked && (
        <TransferTracker
          key={tracked.id}
          initial={tracked}
          latest={recent.find((t) => t.id === tracked.id)}
          onSettled={reload}
        />
      )}
      <div className="columns">
        <TransferForm disabled={!wallet || wallet.frozen} onCreated={onCreated} />
        <div className="stack">
          <DepositForm
            disabled={!wallet || wallet.frozen}
            onDeposited={(next) => setData((d) => ({ ...d, wallet: next }))}
          />
          <section className="card">
            <div className="card-head">
              <h2>Recent activity</h2>
              <Link to="/transactions" className="small">
                View all
              </Link>
            </div>
            {recent.length === 0 ? (
              <p className="muted">No transfers yet.</p>
            ) : (
              <ul className="list">
                {recent.map((tx) => (
                  <li key={tx.id} className="list-row">
                    <div>
                      <strong>{formatMoney(tx.amount)}</strong>
                      <span className="muted small"> {tx.description || 'Transfer'}</span>
                      <div className="muted small">{formatDateTime(tx.createdAt)}</div>
                    </div>
                    <div className="badges">
                      <StatusBadge status={tx.status} />
                      <TierBadge tier={tx.riskTier} />
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
