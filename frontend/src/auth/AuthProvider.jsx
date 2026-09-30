import { useCallback, useEffect, useMemo, useState } from 'react';
import { createApiClient, createEndpoints } from '../api/client.js';
import { AuthContext } from './context.js';
import { loadSession, msUntilExpiry, saveSession } from './session.js';

const API_BASE = import.meta.env.VITE_API_BASE_URL || '/api';
const EXPIRED_NOTICE = 'Your session expired. Please sign in again.';

export function AuthProvider({ children }) {
  const [session, setSession] = useState(() => loadSession());
  const [notice, setNotice] = useState(null);

  const logout = useCallback((reason) => {
    saveSession(null);
    setSession(null);
    setNotice(reason === 'expired' ? EXPIRED_NOTICE : null);
  }, []);

  const token = session?.token ?? null;
  const api = useMemo(
    () =>
      createEndpoints(
        createApiClient({ baseUrl: API_BASE, getToken: () => token, onUnauthorized: () => logout('expired') }),
      ),
    [token, logout],
  );

  // No refresh tokens (contracts §0.4): end the session when the access token expires.
  useEffect(() => {
    if (!token) return undefined;
    const left = msUntilExpiry(token);
    if (left === null) return undefined;
    const timer = setTimeout(() => logout('expired'), Math.max(0, Math.min(left, 2 ** 31 - 1)));
    return () => clearTimeout(timer);
  }, [token, logout]);

  const login = useCallback(
    async (email, password) => {
      const res = await api.login(email, password);
      const next = { token: res.accessToken, user: res.user };
      saveSession(next);
      setSession(next);
      setNotice(null);
      return res.user;
    },
    [api],
  );

  const register = useCallback(
    async ({ email, password, name }) => {
      await api.register({ email, password, name });
      return login(email, password);
    },
    [api, login],
  );

  const value = useMemo(
    () => ({ user: session?.user ?? null, api, login, register, logout, notice }),
    [session, api, login, register, logout, notice],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
