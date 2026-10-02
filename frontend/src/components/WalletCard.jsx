import { useCountUp } from '../hooks/useMotion.js';
import { formatMoney } from '../lib/format.js';
import { IconClock, IconLock } from './icons.jsx';

export function WalletCard({ wallet }) {
  const balance = useCountUp(wallet.balance);
  return (
    <section className="wallet" aria-label="Wallet">
      <div className={wallet.frozen ? 'balance balance-frozen' : 'balance'}>
        <div className="balance-top">
          <span className="balance-chip">{wallet.currency ?? 'USD'}</span>
          {wallet.frozen && (
            <span className="balance-chip balance-chip-frozen">
              <IconLock size={14} /> Frozen
            </span>
          )}
        </div>
        <p className="balance-label">Available balance</p>
        <p className="balance-figure">{formatMoney(balance)}</p>
        <p className="balance-held">
          <IconClock size={14} />
          <span>
            {formatMoney(wallet.held)} <span className="balance-held-label">held for review</span>
          </span>
        </p>
      </div>
      {wallet.frozen && (
        <div className="notice notice-error" role="status">
          <IconLock size={18} />
          <p>
            <strong>Your account is frozen.</strong> A transfer was rated critical risk and is waiting for a reviewer.
            You cannot send money or deposit until the review is resolved.
          </p>
        </div>
      )}
    </section>
  );
}
