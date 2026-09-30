'use strict';

const { AppError } = require('../errors');

/** Resolves a recipient email through auth-service's internal lookup (docs/contracts.md §1.1). */
function createAuthClient({ baseUrl, serviceToken, timeoutMs, fetchImpl = fetch }) {
  return async function lookupUserByEmail(email, { requestId } = {}) {
    let res;
    try {
      res = await fetchImpl(`${baseUrl}/internal/users/lookup?email=${encodeURIComponent(email)}`, {
        headers: { 'X-Service-Token': serviceToken, 'X-Request-Id': requestId },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new AppError(503, 'SERVICE_UNAVAILABLE', 'User directory is unavailable');
    }
    if (res.status === 404) return null;
    if (!res.ok) throw new AppError(503, 'SERVICE_UNAVAILABLE', 'User directory is unavailable');
    const body = await res.json();
    return body.user;
  };
}

module.exports = { createAuthClient };
