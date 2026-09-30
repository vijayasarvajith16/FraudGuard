import { formatMoney } from '../lib/format.js';

export function WalletCard({ wallet }) {
  return (
    <section className="card wallet" aria-label="Wallet">
      <div className="wallet-figures">
        <div>
          <p className="label">Available</p>
          <p className="figure">{formatMoney(wallet.balance)}</p>
        </div>
        <div>
          <p className="label">Held for review</p>
          <p className="figure figure-muted">{formatMoney(wallet.held)}</p>
        </div>
      </div>
      {wallet.frozen && (
        <div className="notice notice-error" role="status">
          <strong>Your account is frozen.</strong> A transfer was rated critical risk and is waiting for a reviewer. You
          cannot send money or deposit until the review is resolved.
        </div>
      )}
    </section>
  );
}
