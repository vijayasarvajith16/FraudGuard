const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const dateTime = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short' });
const time = new Intl.DateTimeFormat('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

export const formatMoney = (amount) => usd.format(amount ?? 0);
export const formatDateTime = (iso) => (iso ? dateTime.format(new Date(iso)) : '');
export const formatTime = (iso) => (iso ? time.format(new Date(iso)) : '');
export const formatScore = (value) => (typeof value === 'number' ? value.toFixed(3) : '-');
export const formatPercent = (value) => (typeof value === 'number' ? `${(value * 100).toFixed(1)}%` : '-');
export const shortId = (id) => (id ? id.slice(0, 8) : '');

/** Parse a money input: a positive number with at most 2 decimals, up to 1,000,000 (contracts §0.2). */
export function parseAmount(text) {
  const trimmed = String(text).trim();
  if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) return { error: 'Enter an amount like 42 or 42.50' };
  const value = Number(trimmed);
  if (value <= 0) return { error: 'The amount must be greater than 0' };
  if (value > 1_000_000) return { error: 'The maximum is $1,000,000.00' };
  return { value };
}
