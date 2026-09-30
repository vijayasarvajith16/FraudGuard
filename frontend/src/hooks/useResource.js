import { useCallback, useEffect, useState } from 'react';

/**
 * Load data when `load` changes (memoize it with useCallback) and on reload().
 * State is set only from promise callbacks, and a stale response (after unmount or a newer
 * load) is ignored. `load` receives an AbortSignal.
 */
export function useResource(load) {
  const [state, setState] = useState({ data: null, error: null, loading: true });
  const [version, setVersion] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal).then(
      (data) => {
        if (!controller.signal.aborted) setState({ data, error: null, loading: false });
      },
      (error) => {
        if (!controller.signal.aborted && error?.name !== 'AbortError') {
          setState((s) => ({ ...s, error, loading: false }));
        }
      },
    );
    return () => controller.abort();
  }, [load, version]);

  const reload = useCallback(() => {
    setState((s) => ({ ...s, loading: true }));
    setVersion((v) => v + 1);
  }, []);

  const setData = useCallback(
    (updater) => setState((s) => ({ ...s, data: typeof updater === 'function' ? updater(s.data) : updater })),
    [],
  );

  return { ...state, reload, setData };
}

/**
 * Cursor pagination (contracts §0.7). `fetchPage(cursor)` returns { items, nextCursor }; the first
 * page loads whenever `fetchPage` changes (e.g. a new filter) and on reload().
 */
export function usePagedList(fetchPage) {
  const [state, setState] = useState({ items: [], cursor: null, loading: true, error: null });
  const [version, setVersion] = useState(0);

  useEffect(() => {
    let active = true;
    fetchPage(null).then(
      (page) => {
        if (active) setState({ items: page.items, cursor: page.nextCursor, loading: false, error: null });
      },
      (error) => {
        if (active) setState((s) => ({ ...s, loading: false, error }));
      },
    );
    return () => {
      active = false;
    };
  }, [fetchPage, version]);

  const { cursor } = state;
  const loadMore = useCallback(async () => {
    if (!cursor) return;
    setState((s) => ({ ...s, loading: true }));
    try {
      const page = await fetchPage(cursor);
      setState((s) => ({ items: [...s.items, ...page.items], cursor: page.nextCursor, loading: false, error: null }));
    } catch (error) {
      setState((s) => ({ ...s, loading: false, error }));
    }
  }, [fetchPage, cursor]);

  const reload = useCallback(() => {
    setState((s) => ({ ...s, loading: true }));
    setVersion((v) => v + 1);
  }, []);

  return { ...state, loadMore, reload };
}
