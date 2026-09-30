import { useState } from 'react';
import { useAuth } from '../auth/context.js';
import { parseAmount } from '../lib/format.js';
import { ErrorNotice } from './ErrorNotice.jsx';

export function DepositForm({ disabled, onDeposited }) {
  const { api } = useAuth();
  const [amount, setAmount] = useState('');
  const [fieldError, setFieldError] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

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
      onDeposited(wallet);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card">
      <h2>Add funds</h2>
      <p className="muted small">Demo deposits are not fraud-scanned.</p>
      <form onSubmit={submit} className="inline-form" noValidate>
        <label className="field">
          <span>Amount (USD)</span>
          <input
            name="deposit-amount"
            inputMode="decimal"
            placeholder="500.00"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            aria-invalid={Boolean(fieldError)}
            disabled={disabled}
          />
          {fieldError && <span className="field-error">{fieldError}</span>}
        </label>
        <button type="submit" className="btn" disabled={disabled || busy}>
          {busy ? 'Adding...' : 'Deposit'}
        </button>
      </form>
      <ErrorNotice error={error} />
    </section>
  );
}
