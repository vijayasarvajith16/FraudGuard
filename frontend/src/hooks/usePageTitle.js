import { useEffect } from 'react';

const APP = 'FraudGuard';

/** Sets the browser tab title ("Alerts · FraudGuard"): it identifies tabs and is announced by screen readers. */
export function usePageTitle(title) {
  useEffect(() => {
    document.title = title ? `${title} · ${APP}` : APP;
  }, [title]);
}
