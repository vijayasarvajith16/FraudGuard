'use strict';

// Transaction status state machine (docs/contracts.md §2.3). Each allowed transition names
// the money effect applied atomically with the status change.

const STATUSES = Object.freeze(['PENDING', 'APPROVED', 'UNDER_REVIEW', 'BLOCKED', 'ACCOUNT_FROZEN', 'AWAITING_OTP']);
const TERMINAL = Object.freeze(new Set(['APPROVED', 'BLOCKED']));

/** Money effects: settle = held -> recipient; release = held -> sender balance; freeze = lock sender wallet. */
const TRANSITIONS = Object.freeze({
  PENDING: { APPROVED: ['settle'], UNDER_REVIEW: [] },
  UNDER_REVIEW: { APPROVED: ['settle'], AWAITING_OTP: [], ACCOUNT_FROZEN: ['freeze'], BLOCKED: ['release'] },
  AWAITING_OTP: { APPROVED: ['settle'], BLOCKED: ['release'] },
  ACCOUNT_FROZEN: { APPROVED: ['settle', 'unfreeze'], BLOCKED: ['release'] },
  APPROVED: {},
  BLOCKED: {},
});

/** Money effects for from -> to, or null if the transition is not allowed. */
function effectsFor(from, to) {
  const allowed = TRANSITIONS[from] || {};
  return Object.hasOwn(allowed, to) ? allowed[to] : null;
}

module.exports = { STATUSES, TERMINAL, TRANSITIONS, effectsFor };
