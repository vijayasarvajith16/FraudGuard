/**
 * Dashboard figures computed from the caller's own transactions (newest first, as the API returns
 * them). Everything here is derived from fields the API sends; nothing is estimated.
 */

/** Outcome groups shown as the dashboard tiles, in display order. */
export const OUTCOME_GROUPS = [
  { id: 'approved', label: 'Approved', statuses: ['APPROVED'], tone: 'ok' },
  { id: 'review', label: 'In review', statuses: ['PENDING', 'UNDER_REVIEW'], tone: 'info' },
  { id: 'otp', label: 'Awaiting OTP', statuses: ['AWAITING_OTP'], tone: 'warn' },
  { id: 'stopped', label: 'Blocked or frozen', statuses: ['BLOCKED', 'ACCOUNT_FROZEN'], tone: 'danger' },
];

const cents = (amount) => Math.round(amount * 100);

export function summarize(transactions) {
  const total = transactions.length;
  const groups = OUTCOME_GROUPS.map((group) => {
    const count = transactions.filter((tx) => group.statuses.includes(tx.status)).length;
    return { ...group, count, share: total ? count / total : 0 };
  });
  const scanned = transactions.filter((tx) => tx.quickScan);
  const cleared = scanned.filter((tx) => !tx.quickScan.flagged).length;
  const settledCents = transactions.filter((tx) => tx.status === 'APPROVED').reduce((s, tx) => s + cents(tx.amount), 0);
  return {
    total,
    groups,
    scanned: scanned.length,
    cleared,
    clearedShare: scanned.length ? cleared / scanned.length : null,
    settled: settledCents / 100,
  };
}

/** The last `limit` quick-scan scores, oldest first (transfers where the quick scan was unavailable have none). */
export function scoreSeries(transactions, limit = 12) {
  return transactions
    .filter((tx) => typeof tx.quickScan?.score === 'number')
    .slice(0, limit)
    .reverse()
    .map((tx) => ({
      id: tx.id,
      score: tx.quickScan.score,
      threshold: tx.quickScan.threshold,
      flagged: tx.quickScan.flagged,
    }));
}

/** The last `limit` transfer amounts, oldest first. */
export function amountSeries(transactions, limit = 20) {
  return transactions
    .slice(0, limit)
    .reverse()
    .map((tx) => ({ id: tx.id, amount: tx.amount, at: tx.createdAt }));
}

/** Upper bound of a chart's value axis: the largest value plus headroom, never 0. */
export function chartTop(values, headroom = 1.15) {
  const max = Math.max(0, ...values);
  return max > 0 ? max * headroom : 1;
}

/**
 * Smooth SVG path through points (Catmull-Rom converted to cubic Béziers), in a 0..width × 0..height
 * box with y growing downwards. Returns { line, area }; `area` closes the shape along the bottom.
 */
export function smoothPath(values, width, height, top = chartTop(values)) {
  if (values.length === 0) return { line: '', area: '' };
  const points = values.map((v, i) => [
    values.length === 1 ? width / 2 : (i / (values.length - 1)) * width,
    height - (v / top) * height,
  ]);
  if (points.length === 1) {
    const [, y] = points[0];
    const line = `M0,${y} L${width},${y}`;
    return { line, area: `${line} L${width},${height} L0,${height} Z` };
  }
  const f = (n) => Number(n.toFixed(2));
  const clampY = (y) => Math.min(height, Math.max(0, y));
  let line = `M${f(points[0][0])},${f(points[0][1])}`;
  for (let i = 0; i < points.length - 1; i += 1) {
    const p0 = points[i - 1] ?? points[i];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[i + 2] ?? p2;
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, clampY(p1[1] + (p2[1] - p0[1]) / 6)];
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, clampY(p2[1] - (p3[1] - p1[1]) / 6)];
    line += ` C${f(c1[0])},${f(c1[1])} ${f(c2[0])},${f(c2[1])} ${f(p2[0])},${f(p2[1])}`;
  }
  return { line, area: `${line} L${width},${height} L0,${height} Z` };
}

/** Initials for the avatar: first letters of the first two words of the name. */
export function initials(name) {
  const words = String(name ?? '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  return (
    words
      .slice(0, 2)
      .map((w) => w[0].toUpperCase())
      .join('') || '?'
  );
}
