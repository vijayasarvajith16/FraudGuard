'use strict';

// Risk tier -> mitigation policy (docs/contracts.md §6.2), loaded from a JSON file.
// Reloaded by content-hash polling (works with Kubernetes ConfigMap symlink swaps, which
// fs.watch misses) and on demand. An invalid file never replaces the last good policy.

const fs = require('node:fs/promises');
const { createHash } = require('node:crypto');
const { z } = require('zod');

const TIERS = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];

// Each action has exactly one consistent outcome; the file states it explicitly for readers.
const STATUS_FOR_ACTION = Object.freeze({
  LOG: 'APPROVED',
  NOTIFY: 'APPROVED',
  OTP_STEP_UP: 'AWAITING_OTP',
  BLOCK_AND_FREEZE: 'ACCOUNT_FROZEN',
});

const tierPolicySchema = z
  .strictObject({
    action: z.enum(Object.keys(STATUS_FOR_ACTION)),
    resultingStatus: z.enum(['APPROVED', 'AWAITING_OTP', 'ACCOUNT_FROZEN']),
    notifyUser: z.boolean(),
    openReviewCase: z.boolean().optional(),
  })
  .superRefine((p, ctx) => {
    if (p.resultingStatus !== STATUS_FOR_ACTION[p.action]) {
      ctx.addIssue({ code: 'custom', message: `${p.action} must result in ${STATUS_FOR_ACTION[p.action]}` });
    }
    if ((p.action === 'OTP_STEP_UP' || p.action === 'BLOCK_AND_FREEZE') && !p.notifyUser) {
      ctx.addIssue({ code: 'custom', message: `${p.action} requires notifyUser: true` });
    }
    if ((p.action === 'BLOCK_AND_FREEZE') !== (p.openReviewCase === true)) {
      ctx.addIssue({
        code: 'custom',
        message: 'openReviewCase: true is required for, and only allowed on, BLOCK_AND_FREEZE',
      });
    }
  });

const policySchema = z.strictObject({
  version: z.literal(1),
  tiers: z.strictObject(Object.fromEntries(TIERS.map((t) => [t, tierPolicySchema]))),
});

class InvalidPolicyError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InvalidPolicyError';
  }
}

/** Parse and validate policy file content; throws InvalidPolicyError listing every problem. */
function parsePolicy(text) {
  let json;
  try {
    json = JSON.parse(text);
  } catch (err) {
    throw new InvalidPolicyError(`not valid JSON: ${err.message}`);
  }
  const result = policySchema.safeParse(json);
  if (!result.success) {
    throw new InvalidPolicyError(result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  }
  return result.data;
}

class TierActionPolicy {
  constructor({ path, pollSeconds, logger, metrics }) {
    Object.assign(this, { path, pollSeconds, logger, metrics });
    this.policy = null;
    this.sha256 = null;
    this.loadedAt = null;
    this.timer = null;
  }

  /** Initial load. Unlike later reloads, an invalid file here is fatal: there is no last good policy. */
  async load() {
    const outcome = await this.reload();
    if (outcome.result !== 'loaded') throw new InvalidPolicyError(`cannot start: ${outcome.error}`);
  }

  /**
   * Re-read the file. Returns { result: 'loaded' | 'unchanged' | 'invalid', ... }.
   * Keeps the current policy on any failure.
   */
  async reload() {
    let text;
    try {
      text = await fs.readFile(this.path, 'utf8');
    } catch (err) {
      return this.#reject(`cannot read ${this.path}: ${err.message}`);
    }
    const sha256 = createHash('sha256').update(text).digest('hex');
    if (sha256 === this.sha256) return { result: 'unchanged', sha256 };

    let policy;
    try {
      policy = parsePolicy(text);
    } catch (err) {
      return this.#reject(err.message);
    }
    const previous = this.sha256;
    this.policy = policy;
    this.sha256 = sha256;
    this.loadedAt = new Date();
    this.metrics.tierActionsReloads.inc({ result: 'loaded' });
    this.metrics.tierActionsVersion.reset();
    this.metrics.tierActionsVersion.set({ sha256: sha256.slice(0, 12) }, 1);
    this.logger.info(
      { sha256: sha256.slice(0, 12), previous: previous?.slice(0, 12) ?? null },
      'tier-action policy loaded',
    );
    return { result: 'loaded', sha256 };
  }

  #reject(error) {
    this.metrics.tierActionsReloads.inc({ result: 'invalid' });
    this.logger.error({ path: this.path, error }, 'tier-action policy rejected; keeping the last good policy');
    return { result: 'invalid', error };
  }

  startPolling() {
    if (!this.pollSeconds) return;
    this.timer = setInterval(() => {
      this.reload().catch((err) => this.logger.error({ err: err.message }, 'policy poll failed'));
    }, this.pollSeconds * 1000);
    this.timer.unref();
  }

  stopPolling() {
    clearInterval(this.timer);
  }

  forTier(tier) {
    return this.policy.tiers[tier];
  }

  describe() {
    return {
      sha256: this.sha256,
      loadedAt: this.loadedAt?.toISOString() ?? null,
      path: this.path,
      policy: this.policy,
    };
  }
}

module.exports = { TierActionPolicy, parsePolicy, InvalidPolicyError, STATUS_FOR_ACTION, TIERS };
