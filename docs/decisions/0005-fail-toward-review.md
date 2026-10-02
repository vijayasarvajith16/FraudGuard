# 0005: Fail toward review

- **Status:** Accepted
- **Date:** 2026-09-30

## Context

Each transfer depends on several moving parts: the quick-scan call, the broker, deep-scan, the
alerting consumer, and the process handling the request. Any of them can be slow or down. A fraud
system has two failure modes: it can approve something it should not have, or delay something
legitimate. Only the first loses money.

## Decision

When the system cannot decide, the transfer goes to review with its funds held; it is never approved
unscored.
- A quick-scan timeout (300 ms), error or malformed answer counts as **flagged**: the transfer goes
  `UNDER_REVIEW` with reason `QUICK_SCAN_UNAVAILABLE` and is scored by deep-scan (contract §2.3).
- A transfer left `PENDING` by an interrupted request is moved to review after 30 s, not approved.
- A broker outage does not stop transfers: the outbox keeps the event until RabbitMQ is back, so
  transaction-service stays ready (readiness does not depend on RabbitMQ).
- Expired or failed OTP challenges block the transfer and release the funds.

## Alternatives considered

- **Fail open (approve when quick-scan is unavailable):** keeps latency low during outages, but an
  attacker who can slow quick-scan gets unscored approvals.
- **Fail closed (reject):** safe for money, but turns every outage into lost legitimate transfers.

## Consequences

- An outage costs latency, not money: transfers wait for deep-scan instead of being approved.
- The end-to-end suite proves it with quick-scan paused and stopped: transfers go `UNDER_REVIEW`
  within the 300 ms budget, are decided by deep-scan, and normal traffic is approved instantly again
  after quick-scan restarts ([testing.md](../testing.md)).
- Deep-scan's load jumps when quick-scan fails. Its queue-depth autoscaler and the
  `QuickScanCallsFailing` alert cover that ([monitoring.md](../monitoring.md)).
- Under extreme overload, the recovery path itself adds work (performance.md, finding 4). Load
  shedding is listed as a follow-up there.
