'use strict';

// Background relay (docs/contracts.md §2.3 step 5, §3.3). Every interval it:
//  1. recovers transfers stuck in PENDING (process died mid-request) -> UNDER_REVIEW,
//  2. republishes outbox events the broker never confirmed,
//  3. refreshes the outbox_pending / transactions_under_review gauges.
// Publishing an event twice is safe: consumers deduplicate on idempotencyKey (§3.5).

// Events younger than this are still being published inline by the request that created them.
const INLINE_PUBLISH_GRACE_MS = 2000;

class OutboxRelay {
  constructor({ transferService, transactions, metrics, logger, intervalMs, pendingRecoverySeconds }) {
    Object.assign(this, { transferService, transactions, metrics, logger, intervalMs, pendingRecoverySeconds });
    this.timer = null;
    this.running = null;
  }

  start() {
    this.timer = setInterval(() => {
      if (!this.running) this.running = this.tick().finally(() => (this.running = null));
    }, this.intervalMs);
    this.timer.unref();
  }

  async stop() {
    clearInterval(this.timer);
    await this.running;
  }

  async tick() {
    try {
      await this.recoverStalePending();
      await this.republishUnconfirmed();
      this.metrics.outboxPending.set(await this.transactions.countOutboxPending());
      this.metrics.underReview.set(await this.transactions.countByStatus('UNDER_REVIEW'));
    } catch (err) {
      this.logger.error({ err: err.message }, 'outbox relay tick failed');
    }
  }

  async recoverStalePending() {
    const cutoff = new Date(Date.now() - this.pendingRecoverySeconds * 1000);
    for (const tx of await this.transactions.findStalePending(cutoff)) {
      const quickScan = {
        score: null,
        threshold: null,
        flagged: true,
        reason: 'QUICK_SCAN_UNAVAILABLE',
        modelVersion: null,
        scoredAt: new Date(),
      };
      try {
        await this.transferService.flagForReview(tx._id, quickScan, { reason: 'recovered after interruption' });
        this.metrics.recoveredPending.inc();
        this.logger.warn({ transactionId: tx._id }, 'recovered interrupted PENDING transfer to UNDER_REVIEW');
      } catch (err) {
        // Most likely the request finished concurrently (INVALID_TRANSITION); anything else retries next tick.
        this.logger.info({ transactionId: tx._id, err: err.message }, 'pending recovery skipped');
      }
    }
  }

  async republishUnconfirmed() {
    const cutoff = new Date(Date.now() - INLINE_PUBLISH_GRACE_MS);
    for (const tx of await this.transactions.findUnpublished(cutoff)) {
      const published = await this.transferService.publishOutbox(tx);
      if (!published) break; // broker still unavailable; try the rest next tick
    }
  }
}

module.exports = { OutboxRelay, INLINE_PUBLISH_GRACE_MS };
