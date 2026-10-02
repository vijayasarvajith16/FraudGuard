import { useEffect, useRef, useState, useSyncExternalStore } from 'react';

const QUERY = '(prefers-reduced-motion: reduce)';

function subscribe(onChange) {
  if (typeof window === 'undefined' || !window.matchMedia) return () => {};
  const mql = window.matchMedia(QUERY);
  mql.addEventListener?.('change', onChange);
  return () => mql.removeEventListener?.('change', onChange);
}

/** True when the user asked for reduced motion, or the environment cannot tell (no matchMedia). */
function snapshot() {
  if (typeof window === 'undefined' || !window.matchMedia) return true;
  return window.matchMedia(QUERY).matches;
}

export function useReducedMotion() {
  return useSyncExternalStore(subscribe, snapshot, () => true);
}

/**
 * Animate a number towards `target` (ease-out). Shows `target` directly when motion is reduced,
 * so the rendered text is always the real value once the animation ends.
 */
export function useCountUp(target, duration = 900) {
  const reduced = useReducedMotion();
  const [shown, setShown] = useState(0);
  const from = useRef(0);

  useEffect(() => {
    if (reduced) return undefined;
    const start = performance.now();
    const origin = from.current;
    let frame;
    const step = (now) => {
      const t = Math.min(1, (now - start) / duration);
      const value = origin + (target - origin) * (1 - (1 - t) ** 3);
      from.current = value;
      setShown(t === 1 ? target : value);
      if (t < 1) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [target, duration, reduced]);

  return reduced ? target : shown;
}
