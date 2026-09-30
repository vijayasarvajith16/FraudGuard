'use strict';

// Calls transaction-service's internal API (docs/contracts.md §2.3). Errors are classified
// so callers can decide between "done", "retry later" and "give up".

class TransactionServiceError extends Error {
  /** kind: 'conflict' (409, already moved on) | 'not_found' (404) | 'transient' (5xx, timeout, network) | 'rejected' (other 4xx) */
  constructor(kind, message, status = null) {
    super(message);
    this.name = 'TransactionServiceError';
    this.kind = kind;
    this.status = status;
  }
}

function createTransactionClient({ baseUrl, serviceToken, timeoutMs, fetchImpl = fetch }) {
  async function call(method, path, body, requestId) {
    let res;
    try {
      res = await fetchImpl(`${baseUrl}${path}`, {
        method,
        headers: {
          'Content-Type': 'application/json',
          'X-Service-Token': serviceToken,
          ...(requestId ? { 'X-Request-Id': requestId } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      const reason = err?.name === 'TimeoutError' ? 'timed out' : err.message;
      throw new TransactionServiceError('transient', `transaction-service unreachable: ${reason}`);
    }
    const payload = await res.json().catch(() => null);
    if (res.ok) return payload;
    const code = payload?.error?.code ?? `HTTP_${res.status}`;
    if (res.status === 409) throw new TransactionServiceError('conflict', code, 409);
    if (res.status === 404) throw new TransactionServiceError('not_found', code, 404);
    if (res.status >= 500) throw new TransactionServiceError('transient', code, res.status);
    throw new TransactionServiceError('rejected', code, res.status);
  }

  return {
    updateStatus: (transactionId, body, { requestId } = {}) =>
      call('PATCH', `/internal/transactions/${transactionId}/status`, body, requestId).then((b) => b.transaction),
    unfreeze: (userId, { requestId } = {}) =>
      call('POST', `/internal/accounts/${userId}/unfreeze`, undefined, requestId).then((b) => b.wallet),
  };
}

module.exports = { createTransactionClient, TransactionServiceError };
