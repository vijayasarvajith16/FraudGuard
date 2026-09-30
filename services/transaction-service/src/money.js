'use strict';

// docs/contracts.md §0.2: the API speaks major units (12.50) with at most 2 decimals;
// storage and arithmetic use integer cents so no float rounding can leak into balances.

const MAX_AMOUNT_CENTS = 100_000_000; // 1,000,000.00

/** Convert a validated major-unit amount to integer cents, or return null if it is not a valid amount. */
function toCents(amount) {
  if (typeof amount !== 'number' || !Number.isFinite(amount)) return null;
  const cents = Math.round(amount * 100);
  // Reject more than 2 decimals (12.345); tolerate binary float noise (0.1 * 100 = 10.000000000000002).
  if (Math.abs(amount * 100 - cents) > 1e-6) return null;
  if (cents <= 0 || cents > MAX_AMOUNT_CENTS) return null;
  return cents;
}

function fromCents(cents) {
  return cents / 100;
}

module.exports = { toCents, fromCents, MAX_AMOUNT_CENTS };
