import { useState } from 'react';
import { useAuth } from '../auth/context.js';
import { parseAmount } from '../lib/format.js';
import { ErrorNotice } from './ErrorNotice.jsx';
import { IconArrowDownLeft } from './icons.jsx';

const QUICK_AMOUNTS = ['100', '500', '1000'];

export function DepositForm({ disabled, onDeposited }) {
  const { api } = useAuth();
  const [amount, setAmount] = useState('');
  const [fieldError, setFieldError] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(0);

  async function submit(event) {
    event.preventDefault();
    const parsed = parseAmount(amount);
    setFieldError(parsed.error ?? null);
    if (parsed.error) return;
    setBusy(true);
    setError(null);
    try {
      const { wallet } = await api.deposit(parsed.value);
      setAmount('');
      setDone((n) => n + 1);
      onDeposited(wallet);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card deposit" id="add-funds">
      <div className="card-head">
        <h2>Add funds</h2>
        <span className="chip chip-mint">Demo</span>
      </div>
      <p className="muted small">Demo deposits are not fraud-scanned.</p>
      <form onSubmit={submit} className="deposit-form" noValidate>
        <label className="field">
          <span>Amount (USD)</span>
          <span className="input-money">
            <input
              id="deposit-amount"
              name="deposit-amount"
              inputMode="decimal"
              placeholder="500.00"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              aria-invalid={Boolean(fieldError)}
              disabled={disabled}
            />
          </span>
          {fieldError && <span className="field-error">{fieldError}</span>}
        </label>
        <div className="quick-amounts">
          {QUICK_AMOUNTS.map((q) => (
            <button
              key={q}
              type="button"
              className="chip chip-button"
              onClick={() => setAmount(q)}
              disabled={disabled}
              aria-label={`Fill in $${q}`}
            >
              +{Number(q).toLocaleString('en-US')}
            </button>
          ))}
        </div>
        <button type="submit" className="btn btn-light" disabled={disabled || busy}>
          <IconArrowDownLeft size={18} />
          {busy ? 'Adding...' : 'Deposit'}
        </button>
      </form>
      {done > 0 && (
        <p key={done} className="flash small" role="status">
          Funds added.
        </p>
      )}
      <ErrorNotice error={error} />
    </section>
  );
}
