import { useRef, useState } from 'react';
import { useAuth } from '../auth/context.js';
import { pickSample, RISK_PROFILES, SAMPLE_MODELS, sampleAmount } from '../demo/riskProfiles.js';
import { parseAmount } from '../lib/format.js';
import { newIdempotencyKey } from '../lib/ids.js';
import { ErrorNotice } from './ErrorNotice.jsx';
import { IconArrowUpRight, IconLock, IconRefresh } from './icons.jsx';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Transfer form with the demo Risk profile selector (contracts §0.8, §8.1). `aside` renders next to
 * the form (the live tracker, or how screening works before the first transfer).
 *
 * Idempotency: one key per attempt. After a network error or 5xx the key is kept, so pressing
 * Send again replays the same request instead of creating a second transfer. Editing any field,
 * or a definite answer from the server, starts a new attempt.
 */
export function TransferForm({ disabled, onCreated, aside }) {
  const { api, user } = useAuth();
  const [form, setForm] = useState({ recipient: '', amount: '', description: '' });
  const [profile, setProfile] = useState('default');
  const [sample, setSample] = useState(null);
  const [fieldErrors, setFieldErrors] = useState({});
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const attemptKey = useRef(null);

  const profileInfo = RISK_PROFILES.find((p) => p.id === profile);
  const amountDiffers = sample && form.amount.trim() !== sampleAmount(sample);

  function update(field, value) {
    attemptKey.current = null;
    setForm((f) => ({ ...f, [field]: value }));
  }

  function choose(profileId, previous = null) {
    attemptKey.current = null;
    setProfile(profileId);
    let next = pickSample(profileId);
    // "Another sample": avoid showing the same row twice in a row when there is a choice.
    if (previous && next && next.count > 1 && next.index === previous.index) {
      next = pickSample(profileId, () => ((previous.index + 1) % next.count) / next.count);
    }
    setSample(next);
    if (next) setForm((f) => ({ ...f, amount: sampleAmount(next) }));
  }

  function validate() {
    const errors = {};
    const recipient = form.recipient.trim().toLowerCase();
    if (!EMAIL.test(recipient)) errors.recipient = 'Enter the recipient’s email address';
    else if (recipient === user?.email) errors.recipient = 'You cannot send money to yourself';
    const amount = parseAmount(form.amount);
    if (amount.error) errors.amount = amount.error;
    if (form.description.length > 140) errors.description = 'At most 140 characters';
    setFieldErrors(errors);
    return Object.keys(errors).length ? null : { recipient, amount: amount.value };
  }

  async function submit(event) {
    event.preventDefault();
    const valid = validate();
    if (!valid) return;
    const body = { recipientEmail: valid.recipient, amount: valid.amount, currency: 'USD' };
    if (form.description.trim()) body.description = form.description.trim();
    if (sample) body.features = sample.features;

    attemptKey.current ??= newIdempotencyKey();
    setBusy(true);
    setError(null);
    try {
      const { transaction } = await api.createTransfer(body, attemptKey.current);
      attemptKey.current = null;
      setForm((f) => ({ ...f, amount: '', description: '' }));
      setSample(null);
      setProfile('default');
      onCreated(transaction);
    } catch (err) {
      if (!err.retryable) attemptKey.current = null;
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card send" id="send">
      <div className="send-head">
        <div>
          <h2>Send money</h2>
          <p className="muted small">Every transfer is scored by the quick scan before any money moves.</p>
        </div>
        <fieldset className="segmented" disabled={disabled}>
          <legend className="sr-only">Risk profile (demo)</legend>
          {RISK_PROFILES.map((p) => (
            <label key={p.id} className={profile === p.id ? 'segment segment-active' : 'segment'}>
              <input
                type="radio"
                name="risk-profile"
                value={p.id}
                checked={profile === p.id}
                onChange={() => choose(p.id)}
                aria-describedby="risk-profile-hint"
              />
              <span>{p.short}</span>
            </label>
          ))}
        </fieldset>
      </div>

      <div className="send-body">
        <form onSubmit={submit} noValidate className="stack send-form">
          {disabled && (
            <p className="notice notice-error small">
              <IconLock size={16} /> Sending is paused while the account is frozen.
            </p>
          )}
          <label className="field">
            <span>Recipient email</span>
            <input
              name="recipient"
              type="email"
              autoComplete="off"
              placeholder="bob@example.com"
              value={form.recipient}
              onChange={(e) => update('recipient', e.target.value)}
              aria-invalid={Boolean(fieldErrors.recipient)}
              disabled={disabled}
            />
            {fieldErrors.recipient && <span className="field-error">{fieldErrors.recipient}</span>}
          </label>

          <div className="row">
            <label className="field">
              <span>Amount (USD)</span>
              <span className="input-money">
                <input
                  name="amount"
                  inputMode="decimal"
                  placeholder="42.50"
                  value={form.amount}
                  onChange={(e) => update('amount', e.target.value)}
                  aria-invalid={Boolean(fieldErrors.amount)}
                  disabled={disabled}
                />
              </span>
              {fieldErrors.amount && <span className="field-error">{fieldErrors.amount}</span>}
            </label>
            <label className="field">
              <span>Description (optional)</span>
              <input
                name="description"
                maxLength={140}
                placeholder="Rent"
                value={form.description}
                onChange={(e) => update('description', e.target.value)}
                disabled={disabled}
              />
              {fieldErrors.description && <span className="field-error">{fieldErrors.description}</span>}
            </label>
          </div>

          <div className="profile-info" key={profile}>
            <p className="small" id="risk-profile-hint">
              <span className="profile-name">{profileInfo.label}.</span> {profileInfo.hint}
            </p>
            {sample && (
              <p className="small">
                Using dataset sample {sample.index + 1} of {sample.count}, originally ${sampleAmount(sample)}.{' '}
                <button type="button" className="btn-link" onClick={() => choose(profile, sample)}>
                  <IconRefresh size={14} /> Another sample
                </button>
              </p>
            )}
            {amountDiffers && (
              <p className="notice notice-warn small" role="status">
                The amount is one of the model’s features. Changing it from ${sampleAmount(sample)} can change the
                outcome.
              </p>
            )}
            {sample && (
              <p className="muted small">
                Categories were assigned with quick-scan v{SAMPLE_MODELS.quickScan} and deep-scan v
                {SAMPLE_MODELS.deepScan}.
              </p>
            )}
          </div>

          <button type="submit" className="btn btn-primary btn-wide" disabled={disabled || busy}>
            {busy ? (
              <>
                <span className="spinner" aria-hidden="true" />
                Sending...
              </>
            ) : (
              <>
                <IconArrowUpRight size={18} />
                {error?.retryable ? 'Retry send' : 'Send'}
              </>
            )}
          </button>
          <ErrorNotice error={error}>
            {error?.retryable
              ? `${error.message} Retrying is safe: the same request will not be applied twice.`
              : error?.message}
          </ErrorNotice>
        </form>
        <div className="send-aside">{aside}</div>
      </div>
    </section>
  );
}
