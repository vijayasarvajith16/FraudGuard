# Architecture decision records

Short records of the decisions that shape FraudGuard: the context, what was decided, what else was
considered, and what it cost. Evidence links point to measurements and tests in this repository.

| ADR | Decision | Status |
|---|---|---|
| [0001](0001-rabbitmq-over-kafka.md) | RabbitMQ, not Kafka, for the flagged and scored events | Accepted |
| [0002](0002-gitops-with-argo-cd.md) | GitOps with Argo CD: the cluster pulls what Git says | Accepted |
| [0003](0003-two-stage-cascade.md) | A two-stage detection cascade: a cheap screen for everything, a stronger model for the few | Accepted |
| [0004](0004-policy-decoupled-from-models.md) | Models output a risk tier; a separate, hot-reloaded policy decides the action | Accepted |
| [0005](0005-fail-toward-review.md) | When in doubt, send the transfer to review; never approve it unscored | Accepted |
