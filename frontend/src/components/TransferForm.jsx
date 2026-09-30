import { useRef, useState } from 'react';
import { useAuth } from '../auth/context.js';
import { pickSample, RISK_PROFILES, SAMPLE_MODELS, sampleAmount } from '../demo/riskProfiles.js';
import { parseAmount } from '../lib/format.js';
import { newIdempotencyKey } from '../lib/ids.js';
import { ErrorNotice } from './ErrorNotice.jsx';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Transfer form with the demo Risk profile selector (contracts §0.8, §8.1).
 *
 * Idempotency: one key per attempt. After a network error or 5xx the key is kept, so pressing
 * Send again replays the same request instead of creating a second transfer. Editing any field,
 * or a definite answer from the server, starts a new attempt.
 */
export function TransferForm({ disabled, onCreated }) {
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
    <section className="card">
      <h2>Send money</h2>
      <form onSubmit={submit} noValidate className="stack">
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
            <input
              name="amount"
              inputMode="decimal"
              placeholder="42.50"
              value={form.amount}
              onChange={(e) => update('amount', e.target.value)}
              aria-invalid={Boolean(fieldErrors.amount)}
              disabled={disabled}
            />
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

        <fieldset className="profile" disabled={disabled}>
          <legend>Risk profile (demo)</legend>
          <label className="field">
            <span className="sr-only">Risk profile</span>
            <select name="risk-profile" value={profile} onChange={(e) => choose(e.target.value)}>
              {RISK_PROFILES.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>
          <p className="muted small">{profileInfo.hint}</p>
          {sample && (
            <p className="small">
              Using dataset sample {sample.index + 1} of {sample.count}, originally ${sampleAmount(sample)}.{' '}
              <button type="button" className="btn-link" onClick={() => choose(profile, sample)}>
                Another sample
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
        </fieldset>

        <button type="submit" className="btn btn-primary" disabled={disabled || busy}>
          {busy ? 'Sending...' : error?.retryable ? 'Retry send' : 'Send'}
        </button>
      </form>
      <ErrorNotice error={error}>
        {error?.retryable
          ? `${error.message} Retrying is safe: the same request will not be applied twice.`
          : error?.message}
      </ErrorNotice>
    </section>
  );
}
