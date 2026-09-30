'use strict';

// Tier -> mitigation (docs/contracts.md §6.2, §7): applies the policy to scored transactions,
// verifies OTP step-ups, and resolves manual reviews. transaction-service owns transaction
// state and money; this service only asks it to move a transaction through its state machine.

const { createHmac, timingSafeEqual } = require('node:crypto');
const { AppError } = require('../errors');
const { TransactionServiceError } = require('../clients/transactionClient');

class PermanentProcessingError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PermanentProcessingError';
  }
}

const money = (amount) => `$${Number(amount).toFixed(2)}`;

const MESSAGES = {
  LOG: (amount, tier) => `Transfer of ${money(amount)} scored ${tier}; approved and logged.`,
  NOTIFY: (amount) =>
    `We noticed unusual activity on your ${money(amount)} transfer. It was approved; contact support if this was not you.`,
  OTP_STEP_UP: (amount) =>
    `Confirm your ${money(amount)} transfer with the verification code sent to you. The funds are on hold until you do.`,
  BLOCK_AND_FREEZE: (amount) =>
    `Your ${money(amount)} transfer was blocked and your account is frozen pending a security review.`,
};

class AlertingService {
  constructor({ policy, alerts, otps, reviews, processed, transactions, metrics, logger, otpConfig }) {
    Object.assign(this, { policy, alerts, otps, reviews, processed, transactions, metrics, logger, otpConfig });
  }

  // ---- OTP codes -------------------------------------------------------------------------

  /** Deterministic per transaction, unguessable without OTP_SECRET (contract §6.2). */
  otpCodeFor(transactionId) {
    const digest = createHmac('sha256', this.otpConfig.secret).update(`otp-code:${transactionId}`).digest();
    return String(digest.readUInt32BE(0) % 1_000_000).padStart(6, '0');
  }

  #hashCode(transactionId, code) {
    return createHmac('sha256', this.otpConfig.secret).update(`${transactionId}:${code}`).digest();
  }

  #codeMatches(challenge, code) {
    const expected = Buffer.from(challenge.codeHash, 'hex');
    return timingSafeEqual(this.#hashCode(challenge._id, code), expected);
  }

  // ---- queue: transaction.scored ---------------------------------------------------------

  /**
   * Apply the tier policy to one scored event. Returns 'applied' | 'duplicate' | 'already_final'.
   * Throws PermanentProcessingError (dead-letter) or TransactionServiceError('transient') (retry).
   */
  async processScoredEvent(event, { requestId } = {}) {
    if (await this.processed.has(event.idempotencyKey)) return 'duplicate';

    const p = event.payload;
    const tierPolicy = this.policy.forTier(p.riskTier);
    const { action } = tierPolicy;
    let simulatedOtp = null;

    if (action === 'OTP_STEP_UP') {
      const code = this.otpCodeFor(p.transactionId);
      await this.otps.createOnce({
        transactionId: p.transactionId,
        userId: p.userId,
        amount: p.amount,
        riskTier: p.riskTier,
        codeHash: this.#hashCode(p.transactionId, code).toString('hex'),
        expiresAt: new Date(Date.now() + this.otpConfig.ttlSeconds * 1000),
        maxAttempts: this.otpConfig.maxAttempts,
      });
      if (this.otpConfig.exposeSimulated) simulatedOtp = code;
    }
    if (action === 'BLOCK_AND_FREEZE') {
      await this.reviews.createOnce({
        transactionId: p.transactionId,
        userId: p.userId,
        riskScore: p.probability,
        riskTier: p.riskTier,
        amount: p.amount,
      });
      this.metrics.reviewCasesOpen.set(await this.reviews.countOpen());
    }

    const created = await this.alerts.createOnce({
      transactionId: p.transactionId,
      kind: 'tier',
      userId: p.userId,
      riskTier: p.riskTier,
      action,
      message: MESSAGES[action](p.amount, p.riskTier),
      simulatedOtp,
      visible: tierPolicy.notifyUser,
    });
    if (created) this.metrics.alertsCreated.inc({ tier: p.riskTier, action });

    let outcome = 'applied';
    try {
      await this.transactions.updateStatus(
        p.transactionId,
        {
          status: tierPolicy.resultingStatus,
          riskScore: p.probability,
          riskTier: p.riskTier,
          deepScan: {
            probability: p.probability,
            riskTier: p.riskTier,
            modelVersion: p.modelVersion,
            scoredAt: p.scoredAt,
          },
          action,
          source: 'alerting-service',
          reason: `tier ${p.riskTier} -> ${action}`,
        },
        { requestId },
      );
    } catch (err) {
      if (!(err instanceof TransactionServiceError)) throw err;
      if (err.kind === 'conflict') {
        // Already moved on (e.g. an admin finalized it): nothing left to do.
        this.logger.warn({ transactionId: p.transactionId, code: err.message }, 'transaction already moved on');
        outcome = 'already_final';
      } else if (err.kind === 'transient') {
        throw err;
      } else {
        throw new PermanentProcessingError(`transaction-service rejected the update: ${err.message}`);
      }
    }

    await this.processed.record(event.idempotencyKey, p.transactionId, outcome);
    this.logger.info(
      { transactionId: p.transactionId, riskTier: p.riskTier, action, outcome, requestId },
      'scored transaction handled',
    );
    return outcome;
  }

  // ---- OTP step-up -----------------------------------------------------------------------

  async verifyOtp(user, { transactionId, code }, { requestId } = {}) {
    const challenge = await this.otps.findForUser(transactionId, user.id);
    if (!challenge) throw AppError.notFound('No verification pending for this transaction');
    if (challenge.status !== 'OPEN') {
      throw AppError.conflict('OTP_ALREADY_RESOLVED', `Verification already ${challenge.status.toLowerCase()}`);
    }
    if (challenge.expiresAt <= new Date()) {
      this.metrics.otpVerifications.inc({ result: 'expired' });
      await this.#blockForOtp(challenge, 'EXPIRED', 'otp expired', requestId);
      throw new AppError(410, 'OTP_EXPIRED', 'Verification code expired; the transfer was blocked');
    }

    if (!this.#codeMatches(challenge, code)) {
      this.metrics.otpVerifications.inc({ result: 'invalid' });
      const after = await this.otps.consumeAttempt(transactionId);
      const remaining = after ? after.attemptsRemaining : 0;
      if (remaining === 0) await this.#blockForOtp(after ?? challenge, 'FAILED', 'otp attempts exhausted', requestId);
      throw new AppError(
        400,
        'INVALID_OTP',
        remaining === 0 ? 'Invalid code; no attempts left, the transfer was blocked' : 'Invalid code',
        [{ attemptsRemaining: remaining }],
      );
    }

    let transaction;
    try {
      transaction = await this.transactions.updateStatus(
        transactionId,
        { status: 'APPROVED', source: 'otp', reason: 'otp verified' },
        { requestId },
      );
    } catch (err) {
      throw this.#asHttpError(err, 'OTP_ALREADY_RESOLVED');
    }
    await this.otps.resolve(transactionId, 'VERIFIED');
    this.metrics.otpVerifications.inc({ result: 'success' });
    return { transactionId, status: transaction.status };
  }

  /**
   * Block the transaction behind a failed/expired challenge, then close the challenge.
   * If transaction-service is unreachable the challenge stays OPEN and the sweeper retries.
   */
  async #blockForOtp(challenge, status, reason, requestId) {
    try {
      await this.transactions.updateStatus(challenge._id, { status: 'BLOCKED', source: 'otp', reason }, { requestId });
    } catch (err) {
      if (!(err instanceof TransactionServiceError) || err.kind !== 'conflict') {
        this.logger.warn({ transactionId: challenge._id, err: err.message }, 'otp block deferred to sweeper');
        return false;
      }
    }
    if (await this.otps.resolve(challenge._id, status)) {
      await this.alerts.createOnce({
        transactionId: challenge._id,
        kind: 'otp-blocked',
        userId: challenge.userId,
        riskTier: challenge.riskTier ?? null,
        action: 'OTP_STEP_UP',
        message: `Your ${money(challenge.amount)} transfer was blocked: ${reason.replace('otp', 'verification')}.`,
        visible: true,
      });
    }
    return true;
  }

  /** Periodic: block transactions whose challenge expired or ran out of attempts. */
  async sweepOtps() {
    let blocked = 0;
    for (const challenge of await this.otps.findStale()) {
      const expired = challenge.expiresAt <= new Date();
      const ok = await this.#blockForOtp(
        challenge,
        expired ? 'EXPIRED' : 'FAILED',
        expired ? 'otp expired' : 'otp attempts exhausted',
      );
      if (ok) blocked += 1;
    }
    return blocked;
  }

  // ---- manual review ---------------------------------------------------------------------

  async decideReview(admin, reviewId, { decision, note }, { requestId } = {}) {
    const review = await this.reviews.findById(reviewId);
    if (!review) throw AppError.notFound('Review case not found');
    if (review.status !== 'OPEN') throw AppError.conflict('REVIEW_ALREADY_RESOLVED', 'Review already resolved');

    let transaction;
    try {
      transaction = await this.transactions.updateStatus(
        review.transactionId,
        {
          status: decision === 'APPROVE' ? 'APPROVED' : 'BLOCKED',
          source: 'admin',
          reason: `manual review ${decision.toLowerCase()}d${note ? `: ${note}` : ''}`.slice(0, 200),
        },
        { requestId },
      );
    } catch (err) {
      throw this.#asHttpError(err, 'REVIEW_ALREADY_RESOLVED');
    }

    const resolved = await this.reviews.resolve(reviewId, { decision, decidedBy: admin.id, note });
    if (!resolved) throw AppError.conflict('REVIEW_ALREADY_RESOLVED', 'Review already resolved');
    this.metrics.reviewCasesOpen.set(await this.reviews.countOpen());
    await this.alerts.createOnce({
      transactionId: review.transactionId,
      kind: 'review',
      userId: review.userId,
      riskTier: review.riskTier,
      action: 'BLOCK_AND_FREEZE',
      message:
        decision === 'APPROVE'
          ? `Your ${money(review.amount)} transfer was approved after review and your account is unfrozen.`
          : `Your ${money(review.amount)} transfer was rejected after review. Your account stays frozen; contact support.`,
      visible: true,
    });
    this.logger.info({ reviewId, transactionId: review.transactionId, decision, admin: admin.id }, 'review decided');
    return { review: resolved, transaction };
  }

  async unfreeze(userId, { requestId } = {}) {
    try {
      return await this.transactions.unfreeze(userId, { requestId });
    } catch (err) {
      throw this.#asHttpError(err, 'CONFLICT');
    }
  }

  #asHttpError(err, conflictCode) {
    if (!(err instanceof TransactionServiceError)) return err;
    if (err.kind === 'conflict') return AppError.conflict(conflictCode, 'The transaction was already finalized');
    if (err.kind === 'not_found') return AppError.notFound('Transaction or account not found');
    return new AppError(503, 'SERVICE_UNAVAILABLE', 'Transaction service is unavailable; try again');
  }
}

module.exports = { AlertingService, PermanentProcessingError, MESSAGES };
