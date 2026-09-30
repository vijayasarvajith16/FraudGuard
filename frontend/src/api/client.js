/**
 * Minimal JSON client for the gateway's /api/* routes (docs/contracts.md §8, §8.1).
 * Every non-2xx answer becomes an ApiError carrying the §0.5 envelope.
 */

export class ApiError extends Error {
  constructor(status, { code, message, details, requestId } = {}) {
    super(message || (status ? `Request failed (HTTP ${status})` : 'Network error'));
    this.name = 'ApiError';
    this.status = status;
    this.code = code || (status ? `HTTP_${status}` : 'NETWORK_ERROR');
    this.details = Array.isArray(details) ? details : [];
    this.requestId = requestId || null;
  }

  /** No definite answer from the server: the same request may be retried (idempotently). */
  get retryable() {
    return this.status === 0 || this.status >= 500;
  }
}

export function createApiClient({ baseUrl = '/api', getToken = () => null, onUnauthorized = () => {} } = {}) {
  async function request(method, path, { body, headers = {}, signal } = {}) {
    const token = getToken();
    const init = { method, headers: { Accept: 'application/json', ...headers }, signal };
    if (body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    if (token) init.headers.Authorization = `Bearer ${token}`;

    let res;
    try {
      res = await fetch(`${baseUrl}${path}`, init);
    } catch (err) {
      if (err?.name === 'AbortError') throw err;
      throw new ApiError(0, { message: 'Could not reach FraudGuard. Check your connection and try again.' });
    }

    const text = await res.text();
    let data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = null;
      }
    }
    if (!res.ok) {
      const envelope = data?.error ?? {};
      const error = new ApiError(res.status, {
        ...envelope,
        requestId: envelope.requestId ?? res.headers.get('X-Request-Id'),
      });
      // A 401 on an authenticated call means the token expired or was rejected (no refresh tokens, §0.4).
      if (res.status === 401 && token) onUnauthorized(error);
      throw error;
    }
    return data;
  }

  return {
    get: (path, options) => request('GET', path, options),
    post: (path, body, options) => request('POST', path, { ...options, body }),
  };
}

function query(params) {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') qs.set(key, String(value));
  }
  const s = qs.toString();
  return s ? `?${s}` : '';
}

/** Typed-ish wrappers for every route the UI uses. Nothing here reaches a scan service or /internal. */
export function createEndpoints(api) {
  return {
    login: (email, password) => api.post('/auth/login', { email, password }),
    register: ({ email, password, name }) => api.post('/auth/register', { email, password, name }),

    wallet: () => api.get('/wallet'),
    deposit: (amount) => api.post('/wallet/deposit', { amount }),

    createTransfer: (body, idempotencyKey) =>
      api.post('/transactions', body, { headers: { 'Idempotency-Key': idempotencyKey } }),
    listTransactions: ({ status, cursor, limit = 20 } = {}) =>
      api.get(`/transactions${query({ status, cursor, limit })}`),
    getTransaction: (id, options) => api.get(`/transactions/${encodeURIComponent(id)}`, options),

    listAlerts: ({ cursor, limit = 20 } = {}) => api.get(`/alerts${query({ cursor, limit })}`),
    verifyOtp: (transactionId, code) => api.post('/alerts/otp/verify', { transactionId, code }),

    listReviews: (status) => api.get(`/alerts/admin/reviews${query({ status })}`),
    decideReview: (id, decision, note) =>
      api.post(`/alerts/admin/reviews/${encodeURIComponent(id)}/decision`, note ? { decision, note } : { decision }),
    unfreezeAccount: (userId) => api.post(`/alerts/admin/accounts/${encodeURIComponent(userId)}/unfreeze`),
    tierActions: () => api.get('/alerts/admin/config/tier-actions'),
    reloadTierActions: () => api.post('/alerts/admin/config/reload'),
  };
}
