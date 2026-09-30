import { useCallback, useState } from 'react';
import { useAuth } from '../auth/context.js';
import { StatusBadge, TierBadge } from '../components/Badges.jsx';
import { ErrorNotice } from '../components/ErrorNotice.jsx';
import { usePagedList, useResource } from '../hooks/useResource.js';
import { formatDateTime, formatMoney } from '../lib/format.js';
import { ACTION_LABELS } from '../lib/transactions.js';

function otpErrorMessage(err) {
  switch (err.code) {
    case 'INVALID_OTP': {
      const left = err.details.find((d) => typeof d.attemptsRemaining === 'number')?.attemptsRemaining;
      if (left === 0 || left === undefined) return 'Wrong code. No attempts left: the transfer was blocked.';
      return `Wrong code. ${left} attempt${left === 1 ? '' : 's'} left.`;
    }
    case 'OTP_EXPIRED':
      return 'The code expired, so the transfer was blocked and the funds returned to your balance.';
    case 'OTP_ALREADY_RESOLVED':
      return 'This transfer has already been resolved.';
    default:
      return err.message;
  }
}

/** OTP entry for an OTP_STEP_UP alert, shown while its transaction is AWAITING_OTP. */
function OtpPanel({ alert }) {
  const { api } = useAuth();
  const [code, setCode] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(
    (signal) => api.getTransaction(alert.transactionId, { signal }).then((r) => r.transaction),
    [api, alert.transactionId],
  );
  const { data: tx, error: loadError, reload } = useResource(load);

  async function submit(event) {
    event.preventDefault();
    if (!/^\d{6}$/.test(code)) {
      setError({ message: 'Enter the 6-digit code', details: [] });
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.verifyOtp(alert.transactionId, code);
      setCode('');
    } catch (err) {
      setError({ ...err, details: err.details ?? [], message: otpErrorMessage(err) });
    } finally {
      setBusy(false);
      reload();
    }
  }

  if (!tx) return <ErrorNotice error={loadError} />;
  if (tx.status !== 'AWAITING_OTP') {
    return (
      <div className="otp otp-resolved">
        <span className="muted small">Transfer {formatMoney(tx.amount)}:</span> <StatusBadge status={tx.status} />
        {error && <ErrorNotice error={error} />}
      </div>
    );
  }
  return (
    <div className="otp">
      <form onSubmit={submit} className="inline-form" noValidate>
        <label className="field">
          <span>One-time code for {formatMoney(tx.amount)}</span>
          <input
            name="otp"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="\d{6}"
            maxLength={6}
            placeholder="123456"
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
          />
        </label>
        <button type="submit" className="btn btn-primary" disabled={busy}>
          {busy ? 'Checking...' : 'Confirm transfer'}
        </button>
      </form>
      {alert.simulatedOtp && (
        <p className="notice notice-info small">
          Demo: the simulated text message says <strong className="mono">{alert.simulatedOtp}</strong>.{' '}
          <button type="button" className="btn-link" onClick={() => setCode(alert.simulatedOtp)}>
            Fill it in
          </button>
        </p>
      )}
      <ErrorNotice error={error} />
    </div>
  );
}

export function AlertsPage() {
  const { api } = useAuth();
  const fetchPage = useCallback((cursor) => api.listAlerts({ cursor }), [api]);
  const { items, cursor, loading, error, loadMore, reload } = usePagedList(fetchPage);

  return (
    <div className="page">
      <div className="page-head">
        <h1>Alerts</h1>
        <button type="button" className="btn" onClick={reload} disabled={loading}>
          Refresh
        </button>
      </div>
      <ErrorNotice error={error} />
      {items.length === 0 && !loading && (
        <section className="card">
          <p className="muted">No alerts. Transfers rated medium risk or above show up here.</p>
        </section>
      )}
      <ul className="alerts">
        {items.map((a) => (
          <li key={a.id} className={`card alert alert-${a.riskTier.toLowerCase()}`}>
            <div className="card-head">
              <div className="badges">
                <TierBadge tier={a.riskTier} />
                <span className="small">{ACTION_LABELS[a.action] ?? a.action}</span>
              </div>
              <span className="muted small">{formatDateTime(a.createdAt)}</span>
            </div>
            <p>{a.message}</p>
            {a.action === 'OTP_STEP_UP' && <OtpPanel alert={a} />}
          </li>
        ))}
      </ul>
      {cursor && (
        <button type="button" className="btn" onClick={loadMore} disabled={loading}>
          {loading ? 'Loading...' : 'Load more'}
        </button>
      )}
    </div>
  );
}
