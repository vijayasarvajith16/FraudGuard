# 0001: RabbitMQ, not Kafka, for the flagged and scored events

- **Status:** Accepted
- **Date:** 2026-09-30

## Context

Flagged transfers (about 6% of traffic) must reach deep-scan, and deep-scan's verdicts must reach
alerting. Each message is a unit of work that has to be processed exactly once in effect, retried on
transient failure, and parked for a human when it cannot be processed. Nobody needs to replay last
week's events. Everything also has to run on a 16 GB laptop next to MongoDB, seven services and a
Kubernetes cluster.

## Decision

RabbitMQ with quorum queues: a topic exchange for events, a delayed-retry exchange, and a dead-letter
exchange (contract §3). Publishers use publisher confirms and mandatory publishes; consumers ack after
their side effects and deduplicate on the event's idempotency key.

## Alternatives considered

- **Kafka:** a replayable log with consumer offsets. Its strengths, retention, replay and very high
  throughput, are not needed here. Per-message retry and dead-lettering would have to be built on
  top (retry topics, offset handling), and a broker cluster is heavier to run locally.
- **Calling deep-scan over HTTP:** simpler, but couples transaction-service's availability to
  deep-scan's and loses the buffer that absorbs bursts and outages.

## Consequences

- Retries, dead-lettering and per-message acks come from the broker; each consumer stays small.
- The queue absorbs outages. In the load-test drill, deep-scan was down for 89 s while 68 messages
  queued; clients saw no errors, and the backlog drained 35 s after it returned
  ([performance.md](../performance.md)).
- Queue depth is a direct autoscaling signal: deep-scan scales on ready messages in
  `transactions.flagged` ([monitoring.md](../monitoring.md)).
- The broker stays light: RabbitMQ uses about 140 MiB in the local cluster
  ([kubernetes.md](../kubernetes.md)).
- No event history: rebuilding state from events is not possible, which this system never needs
  (MongoDB is the record).
