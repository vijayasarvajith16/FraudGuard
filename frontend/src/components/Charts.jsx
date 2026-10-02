import { useId } from 'react';
import { formatMoney, formatScore } from '../lib/format.js';
import { chartTop, smoothPath } from '../lib/stats.js';

function EmptyChart({ children }) {
  return <p className="chart-empty muted small">{children}</p>;
}

/** Quick-scan score per transfer (oldest left), with the model's flag threshold as a dashed line. */
export function ScoreBars({ series }) {
  if (series.length === 0) {
    return <EmptyChart>Send a transfer to see its quick-scan score here.</EmptyChart>;
  }
  const threshold = series[series.length - 1].threshold;
  const top = chartTop([...series.map((s) => s.score), threshold ?? 0], 1.25);
  const flagged = series.filter((s) => s.flagged).length;
  return (
    <div
      className="bars"
      role="img"
      aria-label={`Quick-scan scores of your last ${series.length} transfers: ${flagged} at or above the threshold`}
    >
      <div className="bars-plot">
        {typeof threshold === 'number' && (
          <div className="bars-threshold" style={{ bottom: `${(threshold / top) * 100}%` }}>
            <span>{formatScore(threshold)}</span>
          </div>
        )}
        {series.map((s, i) => (
          <div key={s.id} className="bar-slot">
            <div
              className={s.flagged ? 'bar bar-flagged' : 'bar'}
              style={{ height: `${Math.max(3, (s.score / top) * 100)}%`, animationDelay: `${i * 45}ms` }}
              data-value={formatScore(s.score)}
            />
          </div>
        ))}
      </div>
      <div className="bars-axis" aria-hidden="true">
        {series.map((s, i) => (
          <span key={s.id}>{i + 1}</span>
        ))}
      </div>
    </div>
  );
}

const W = 320;
const H = 120;

/** Smooth area chart of transfer amounts (oldest left). */
export function AmountArea({ series }) {
  const gradient = `area-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  if (series.length === 0) {
    return <EmptyChart>Your transfer amounts will be charted here.</EmptyChart>;
  }
  const values = series.map((p) => p.amount);
  const top = chartTop(values, 1.25);
  const { line, area } = smoothPath(values, W, H, top);
  const largest = Math.max(...values);
  return (
    <div className="area">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={`Amounts of your last ${series.length} transfers, largest ${formatMoney(largest)}`}
      >
        <defs>
          <linearGradient id={gradient} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--mint)" stopOpacity="0.35" />
            <stop offset="100%" stopColor="var(--mint)" stopOpacity="0" />
          </linearGradient>
        </defs>
        {[0.25, 0.5, 0.75].map((g) => (
          <line key={g} x1="0" x2={W} y1={H * g} y2={H * g} className="area-grid" vectorEffect="non-scaling-stroke" />
        ))}
        <path d={area} fill={`url(#${gradient})`} className="area-fill" />
        <path d={line} pathLength="1" className="area-line" vectorEffect="non-scaling-stroke" />
      </svg>
    </div>
  );
}

/**
 * Horizontal meter: `value` of `max`, optionally with a marker (e.g. the flag threshold).
 * `tone` colours the fill (ok, info, warn, danger, flagged).
 */
export function Meter({ value, max = 1, marker, tone = 'ok', label }) {
  const pct = (v) => `${Math.min(100, Math.max(0, (v / max) * 100))}%`;
  return (
    <div className="meter" role="meter" aria-valuemin={0} aria-valuemax={max} aria-valuenow={value} aria-label={label}>
      <div className={`meter-fill tone-${tone}`} style={{ width: pct(value) }} />
      {typeof marker === 'number' && <div className="meter-marker" style={{ left: pct(marker) }} />}
    </div>
  );
}

/** Placeholder block with a shimmer while data loads. */
export function Skeleton({ className = '' }) {
  return <div className={`skeleton ${className}`} aria-hidden="true" />;
}
