# 0003: A two-stage detection cascade

- **Status:** Accepted
- **Date:** 2026-09-30

## Context

Every transfer must be screened before it is approved, inside a short latency budget (the
quick-scan call has 300 ms, contract §2.3). Fraud is rare (0.17% of the dataset), and catching it
well needs a supervised model whose verdict can drive strong actions such as freezing an account.

## Decision

Two models in sequence:
1. **quick-scan:** an Isolation Forest (unsupervised) scores every transfer synchronously and flags
   the anomalous few. Its threshold is chosen in training for recall at a capped flag rate.
2. **deep-scan:** an XGBoost classifier scores only the flagged transfers, asynchronously through
   RabbitMQ. Its probability sets the risk tier (contract §6.1).

## Alternatives considered

- **One supervised model on every transfer, synchronously:** simpler, but the strong model, its
  dependencies and its failure modes would sit on every transfer's critical path, and it would scale
  with all traffic rather than the flagged share.
- **One unsupervised model only:** cheap, but anomaly scores are not calibrated enough to justify
  blocking or freezing.

## Consequences

- The expensive path handles 6.10% of transactions; the cheap screen scores in ≤ 2.5 ms (p95) inside
  the service ([ml-results.md](../ml-results.md)).
- Measured on the held-out test split: cascade recall 77.9%, precision 93.7%; stopped transactions
  (OTP or freeze) are 97.3% precise.
- The cascade can only be as good as its first stage: quick-scan flags 84.2% of test fraud, and 15 of
  the 21 missed fraud cases were never flagged. Its recall is the main lever for improvement.
- Raising quick-scan recall costs deep-scan traffic. The first promotion showed it: a quick-scan
  tuned for recall raised deep-scan traffic from 6.1% to 10.2% with no gain, and the promotion rules
  now reject that ([mlops.md](../mlops.md)).
- Each stage scales on its own signal: quick-scan on CPU, deep-scan on queue depth
  ([monitoring.md](../monitoring.md)).
