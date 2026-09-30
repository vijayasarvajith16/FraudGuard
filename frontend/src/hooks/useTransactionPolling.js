import { useEffect, useRef, useState } from 'react';
import { useAuth } from '../auth/context.js';
import { isResting, pollDelay } from '../lib/transactions.js';

/** The more advanced of two copies of one transaction (statusHistory only ever grows). */
function fresher(a, b) {
  if (!b || b.id !== a?.id) return a;
  return (b.statusHistory?.length ?? 0) > (a.statusHistory?.length ?? 0) ? b : a;
}

/**
 * Follow a transaction until it rests (contracts §8): poll GET /api/transactions/{id} every 2 s,
 * backing off to 10 s. `onSettled` fires once when a poll returns a resting status, so callers can
 * refresh the wallet. `latest` is an optional newer copy the caller already has (e.g. from its own
 * list reload); whichever copy is further along is shown, and polling stops once either rests.
 * To track a different transaction, remount the caller with a new `key`.
 */
export function useTransactionPolling(initial, { onSettled, latest } = {}) {
  const { api } = useAuth();
  const [polled, setPolled] = useState(initial);
  const onSettledRef = useRef(onSettled);
  useEffect(() => {
    onSettledRef.current = onSettled;
  });

  const tx = fresher(polled, latest);
  const id = tx?.id;
  const polling = Boolean(id) && !isResting(tx.status);

  useEffect(() => {
    if (!polling) return undefined;
    const controller = new AbortController();
    let attempt = 0;
    let timer;
    const tick = async () => {
      try {
        const { transaction } = await api.getTransaction(id, { signal: controller.signal });
        if (controller.signal.aborted) return;
        setPolled(transaction);
        if (isResting(transaction.status)) {
          onSettledRef.current?.(transaction);
          return;
        }
      } catch (err) {
        // Aborted (unmounted), signed out, or gone: stop. Anything else: keep trying with backoff.
        if (err?.name === 'AbortError' || err?.status === 401 || err?.status === 404) return;
      }
      attempt += 1;
      timer = setTimeout(tick, pollDelay(attempt));
    };
    timer = setTimeout(tick, pollDelay(0));
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [api, id, polling]);

  return { transaction: tx, polling };
}
