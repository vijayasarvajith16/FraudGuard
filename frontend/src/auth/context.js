import { createContext, useContext } from 'react';

export const AuthContext = createContext(null);

/** { user, api, login, register, logout, notice } from the nearest <AuthProvider>. */
export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}
