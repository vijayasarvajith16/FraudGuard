import { useCallback, useState } from 'react';
import { useAuth } from '../auth/context.js';
import { StatusBadge, TierBadge } from '../components/Badges.jsx';
import { Skeleton } from '../components/Charts.jsx';
import { ErrorNotice } from '../components/ErrorNotice.jsx';
import { IconBell, IconCheck, IconFile, IconKey, IconLock, IconRefresh } from '../components/icons.jsx';
import { usePagedList, useResource } from '../hooks/useResource.js';
import { formatDateTime, formatMoney } from '../lib/format.js';
import { ACTION_LABELS, TIER_TONE } from '../lib/transactions.js';
import { usePageTitle } from '../hooks/usePageTitle.js';

const ACTION_ICON = { LOG: IconFile, NOTIFY: IconBell, OTP_STEP_UP: IconKey, BLOCK_AND_FREEZE: IconLock };
const SUMMARY_TIERS = ['MEDIUM', 'HIGH', 'CRITICAL'];

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

  if (!tx) return loadError ? <ErrorNotice error={loadError} /> : <Skeleton className="sk-row" />;
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
      <form onSubmit={submit} className="otp-form" noValidate>
        <label className="field">
          <span>One-time code for {formatMoney(tx.amount)}</span>
          <input
            name="otp"
            className="otp-input"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="\d{6}"
            maxLength={6}
            placeholder="······"
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
          />
        </label>
        <button type="submit" className="btn btn-primary" disabled={busy}>
          {busy ? <span className="spinner" aria-hidden="true" /> : <IconCheck size={18} />}
          {busy ? 'Checking...' : 'Confirm transfer'}
        </button>
      </form>
      {alert.simulatedOtp && (
        <p className="notice notice-info small">
          <span>
            Demo: the simulated text message says <strong className="mono">{alert.simulatedOtp}</strong>.{' '}
            <button type="button" className="btn-link" onClick={() => setCode(alert.simulatedOtp)}>
              Fill it in
            </button>
          </span>
        </p>
      )}
      <ErrorNotice error={error} />
    </div>
  );
}

export function AlertsPage() {
  usePageTitle('Alerts');
  const { api } = useAuth();
  const fetchPage = useCallback((cursor) => api.listAlerts({ cursor }), [api]);
  const { items, cursor, loading, error, loadMore, reload } = usePagedList(fetchPage);

  return (
    <div className="page">
      <div className="page-head rise">
        <div>
          <h1>Alerts</h1>
          <p className="muted">Transfers rated medium risk or above, and what was done about each.</p>
        </div>
        <button type="button" className="btn" onClick={reload} disabled={loading}>
          <IconRefresh size={18} className={loading ? 'spin' : undefined} />
          Refresh
        </button>
      </div>

      {items.length > 0 && (
        <div className="tier-summary stagger" aria-label="Loaded alerts by risk tier">
          {SUMMARY_TIERS.map((tier) => (
            <div key={tier} className={`tier-chip tone-${TIER_TONE[tier]}`}>
              <span className="tier-count">{items.filter((a) => a.riskTier === tier).length}</span>
              <span className="small">{tier.toLowerCase()}</span>
            </div>
          ))}
        </div>
      )}

      <ErrorNotice error={error} />
      {loading && items.length === 0 && (
        <div className="stack">
          <Skeleton className="sk-card" />
          <Skeleton className="sk-card" />
        </div>
      )}
      {items.length === 0 && !loading && (
        <section className="card empty-state rise">
          <span className="empty-icon tone-ok" aria-hidden="true">
            <IconBell size={26} />
          </span>
          <p className="muted">No alerts. Transfers rated medium risk or above show up here.</p>
        </section>
      )}
      <ul className="alerts stagger">
        {items.map((a) => {
          const Glyph = ACTION_ICON[a.action] ?? IconBell;
          return (
            <li key={a.id} className={`card alert tone-${TIER_TONE[a.riskTier] ?? 'neutral'}`}>
              <span className="alert-icon" aria-hidden="true">
                <Glyph size={20} />
              </span>
              <div className="alert-body">
                <div className="card-head">
                  <div className="badges">
                    <TierBadge tier={a.riskTier} />
                    <span className="small alert-action">{ACTION_LABELS[a.action] ?? a.action}</span>
                  </div>
                  <span className="muted small">{formatDateTime(a.createdAt)}</span>
                </div>
                <p>{a.message}</p>
                {a.action === 'OTP_STEP_UP' && <OtpPanel alert={a} />}
              </div>
            </li>
          );
        })}
      </ul>
      {cursor && (
        <div className="center">
          <button type="button" className="btn" onClick={loadMore} disabled={loading}>
            {loading ? 'Loading...' : 'Load more'}
          </button>
        </div>
      )}
    </div>
  );
}
