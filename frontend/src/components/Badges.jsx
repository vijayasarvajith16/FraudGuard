import { STATUS_LABELS } from '../lib/transactions.js';

const STATUS_TONE = {
  PENDING: 'neutral',
  UNDER_REVIEW: 'info',
  APPROVED: 'ok',
  AWAITING_OTP: 'warn',
  ACCOUNT_FROZEN: 'danger',
  BLOCKED: 'danger',
};

const TIER_TONE = { LOW: 'ok', MEDIUM: 'info', HIGH: 'warn', CRITICAL: 'danger' };

export function StatusBadge({ status }) {
  return <span className={`badge badge-${STATUS_TONE[status] ?? 'neutral'}`}>{STATUS_LABELS[status] ?? status}</span>;
}

export function TierBadge({ tier }) {
  if (!tier) return <span className="badge badge-muted">Tier pending</span>;
  return (
    <span className={`badge badge-outline badge-${TIER_TONE[tier]}`} title={`Risk tier ${tier}`}>
      {tier}
    </span>
  );
}
