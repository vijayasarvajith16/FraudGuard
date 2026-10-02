import { STATUS_LABELS, STATUS_TONE, TIER_TONE } from '../lib/transactions.js';
import { IconBan, IconCheck, IconClock, IconKey, IconLock } from './icons.jsx';

const STATUS_ICON = {
  PENDING: IconClock,
  UNDER_REVIEW: IconClock,
  APPROVED: IconCheck,
  AWAITING_OTP: IconKey,
  ACCOUNT_FROZEN: IconLock,
  BLOCKED: IconBan,
};

export function StatusBadge({ status }) {
  return (
    <span className={`badge tone-${STATUS_TONE[status] ?? 'neutral'}`}>
      <span className="badge-dot" aria-hidden="true" />
      {STATUS_LABELS[status] ?? status}
    </span>
  );
}

export function TierBadge({ tier }) {
  if (!tier) return <span className="badge badge-ghost">Tier pending</span>;
  return (
    <span className={`badge badge-outline tone-${TIER_TONE[tier]}`} title={`Risk tier ${tier}`}>
      {tier}
    </span>
  );
}

/** Round status icon for list rows. */
export function StatusIcon({ status }) {
  const Glyph = STATUS_ICON[status] ?? IconClock;
  return (
    <span className={`status-icon tone-${STATUS_TONE[status] ?? 'neutral'}`} aria-hidden="true">
      <Glyph size={18} />
    </span>
  );
}
