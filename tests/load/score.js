// k6 component test: quick-scan's /score directly, inside the cluster (docs/performance.md).
//
// End to end, transaction-service and MongoDB saturate long before quick-scan does (each transfer
// costs far more there than one scoring call), so the transfer ramp never pushes quick-scan near its
// CPU target. This test isolates quick-scan to measure its per-pod capacity and its autoscaler.
// quick-scan is an internal service, never exposed (no ingress); k6 reaches it from the load-test
// namespace like transaction-service does. Rows: tools/make_load_rows.py. Runner: tests/load/run.sh.
import http from 'k6/http';
import { check, sleep } from 'k6';
import { SharedArray } from 'k6/data';

const URL = __ENV.QUICK_SCAN_URL || 'http://quick-scan-service.fraudguard.svc.cluster.local:8001/score';
const POD = __ENV.JOB_COMPLETION_INDEX || '0';
const RUN_ID = __ENV.RUN_ID || `${Date.now()}`;
const START_AT = Number(__ENV.START_AT || 0); // epoch milliseconds

const profile = JSON.parse(open(__ENV.PROFILE_FILE || './profiles/quick-scan.json'));
const rows = new SharedArray('rows', () => {
  const doc = JSON.parse(open(__ENV.ROWS_FILE || './data/rows.json'));
  return doc.rows.map((values) => Object.fromEntries(doc.columns.map((name, i) => [name, values[i]])));
});

export const options = {
  scenarios: {
    score: {
      executor: 'ramping-arrival-rate',
      startRate: 0,
      timeUnit: '1s',
      preAllocatedVUs: 20,
      maxVUs: 150,
      stages: profile.stages.map(({ duration, target }) => ({ duration, target })),
    },
  },
  setupTimeout: '4m',
  discardResponseBodies: true,
  tags: { testid: RUN_ID, pod: POD },
  summaryTrendStats: ['avg', 'med', 'p(95)', 'p(99)', 'max'],
};

export function setup() {
  const wait = START_AT - Date.now();
  if (wait > 0) sleep(wait / 1000);
}

export default function () {
  const features = rows[Math.floor(Math.random() * rows.length)];
  const res = http.post(URL, JSON.stringify({ features }), {
    headers: { 'Content-Type': 'application/json' },
    tags: { name: 'POST /score' },
  });
  check(res, { 'scored (200)': (r) => r.status === 200 });
}
