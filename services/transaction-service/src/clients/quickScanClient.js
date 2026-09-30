'use strict';

// Synchronous quick-scan call (docs/contracts.md §2.3 step 2, §4). Never throws: any error,
// timeout, non-200 or malformed response is reported as unavailable, and the caller treats
// that as flagged (fail toward review, §9).

function createQuickScanClient({ baseUrl, timeoutMs, metrics, fetchImpl = fetch }) {
  return async function scan({ transactionId, features, requestId }) {
    const stopTimer = metrics.quickScanDuration.startTimer();
    try {
      const res = await fetchImpl(`${baseUrl}/score`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Request-Id': requestId },
        body: JSON.stringify({ transactionId, features }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) {
        metrics.quickScanCalls.inc({ result: 'error' });
        return { available: false, error: `HTTP ${res.status}` };
      }
      const body = await res.json();
      const wellFormed =
        typeof body?.flagged === 'boolean' &&
        Number.isFinite(body?.score) &&
        Number.isFinite(body?.threshold) &&
        typeof body?.modelVersion === 'string';
      if (!wellFormed) {
        metrics.quickScanCalls.inc({ result: 'error' });
        return { available: false, error: 'malformed response' };
      }
      metrics.quickScanCalls.inc({ result: body.flagged ? 'flagged' : 'ok' });
      return {
        available: true,
        flagged: body.flagged,
        score: body.score,
        threshold: body.threshold,
        modelVersion: body.modelVersion,
      };
    } catch (err) {
      const timedOut = err?.name === 'TimeoutError';
      metrics.quickScanCalls.inc({ result: timedOut ? 'timeout' : 'error' });
      return { available: false, error: timedOut ? 'timeout' : err.message };
    } finally {
      stopTimer();
    }
  };
}

module.exports = { createQuickScanClient };
