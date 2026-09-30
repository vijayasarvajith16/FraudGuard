/**
 * Session persistence. The access token lives in sessionStorage: it survives a reload but not
 * closing the tab (contracts §8.1). There is no refresh token, so an expired token ends the session.
 */

const KEY = 'fraudguard.session';

/** Decode a JWT payload without verifying it (the services verify; the UI only reads exp/role). */
export function decodeJwt(token) {
  try {
    const part = token.split('.')[1];
    const json = atob(
      part
        .replace(/-/g, '+')
        .replace(/_/g, '/')
        .padEnd(Math.ceil(part.length / 4) * 4, '='),
    );
    return JSON.parse(json);
  } catch {
    return null;
  }
}

/** Milliseconds until the token expires (negative when already expired, null when unknown). */
export function msUntilExpiry(token, now = Date.now()) {
  const exp = decodeJwt(token)?.exp;
  return typeof exp === 'number' ? exp * 1000 - now : null;
}

export function loadSession(now = Date.now()) {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return null;
    const session = JSON.parse(raw);
    const left = msUntilExpiry(session?.token, now);
    if (!session?.user || left === null || left <= 0) {
      sessionStorage.removeItem(KEY);
      return null;
    }
    return session;
  } catch {
    return null;
  }
}

export function saveSession(session) {
  try {
    if (session) sessionStorage.setItem(KEY, JSON.stringify(session));
    else sessionStorage.removeItem(KEY);
  } catch {
    // Storage unavailable (private mode, blocked): the session simply lasts for this page view.
  }
}
