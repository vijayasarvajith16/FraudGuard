/** Transaction state helpers shared by the tracker, history and alerts (contracts §2.3, §8). */

export const STATUSES = ['PENDING', 'APPROVED', 'UNDER_REVIEW', 'AWAITING_OTP', 'ACCOUNT_FROZEN', 'BLOCKED'];

/**
 * Statuses that no longer depend on the scan pipeline: terminal ones, plus those waiting on the
 * user (OTP) or an admin (frozen). Polling stops here.
 */
export const RESTING_STATUSES = new Set(['APPROVED', 'BLOCKED', 'AWAITING_OTP', 'ACCOUNT_FROZEN']);

export const isResting = (status) => RESTING_STATUSES.has(status);

/** Poll delay: 2 s for the first three polls, then doubling up to 10 s (2, 2, 2, 4, 8, 10, 10, ...). */
export function pollDelay(attempt) {
  return Math.min(10_000, 2_000 * 2 ** Math.max(0, attempt - 2));
}

export const STATUS_LABELS = {
  PENDING: 'Pending',
  APPROVED: 'Approved',
  UNDER_REVIEW: 'Under review',
  AWAITING_OTP: 'Awaiting OTP',
  ACCOUNT_FROZEN: 'Account frozen',
  BLOCKED: 'Blocked',
};

export const ACTION_LABELS = {
  NONE: 'None (quick-scan approved)',
  LOG: 'Logged for audit',
  NOTIFY: 'User notified',
  OTP_STEP_UP: 'OTP step-up',
  BLOCK_AND_FREEZE: 'Blocked and account frozen',
};

/** One sentence explaining where a transfer stands, for the live tracker. */
export function statusExplanation(tx) {
  switch (tx.status) {
    case 'PENDING':
      return 'Received. Running the quick fraud scan...';
    case 'UNDER_REVIEW':
      return tx.quickScan?.reason === 'QUICK_SCAN_UNAVAILABLE'
        ? 'The quick scan was unavailable, so the transfer went to the deep scan as a precaution. Funds are held.'
        : 'The quick scan flagged this transfer. The deep scan is scoring it now; funds are held.';
    case 'APPROVED':
      if (!tx.deepScan) return 'Approved instantly: the quick scan found nothing unusual.';
      return tx.statusHistory?.some((h) => h.source === 'otp')
        ? 'Approved after you confirmed the one-time code.'
        : tx.statusHistory?.some((h) => h.source === 'admin')
          ? 'Approved by a reviewer.'
          : `Approved after the deep scan rated it ${tx.riskTier} risk.`;
    case 'AWAITING_OTP':
      return 'High risk: confirm this transfer with the one-time code on the Alerts page. Funds are held until then.';
    case 'ACCOUNT_FROZEN':
      return 'Critical risk: the transfer is on hold and your account is frozen until a reviewer decides.';
    case 'BLOCKED':
      return 'Blocked. The held funds were returned to your balance.';
    default:
      return tx.status;
  }
}
