// k6 load test: transfers through the ingress and the nginx gateway (docs/performance.md).
//
// Runs inside the kind cluster as several pods (tests/load/run.sh, `make load-test`). The gateway
// rate-limits each client IP to 20 requests/s (contract §8), so every pod stays at or below 18/s
// and the total load scales with the number of pods. Each pod:
//   - registers and funds its own users, then waits for START_AT so all pods ramp together;
//   - sends transfers in a ring between its users (sender i pays i+1, so balances stay level),
//     each with a real dataset row's features (normal rows only: tools/make_load_rows.py);
//   - pushes its metrics to Prometheus (remote write, native histograms): p95 across pods is exact,
//     and Grafana shows the client-side view next to the services.
import http from 'k6/http';
import { check, fail, sleep } from 'k6';
import { SharedArray } from 'k6/data';
import exec from 'k6/execution';

const BASE_URL = __ENV.BASE_URL || 'http://traefik.traefik.svc.cluster.local';
const POD = __ENV.JOB_COMPLETION_INDEX || '0';
const RUN_ID = __ENV.RUN_ID || `${Date.now()}`;
const START_AT = Number(__ENV.START_AT || 0); // epoch milliseconds
const USERS = Number(__ENV.USERS_PER_POD || 4);
const DEPOSIT = 100000;
const PASSWORD = 'Load-test-2026';
const MAX_RATE_PER_POD = 18;

const profile = JSON.parse(open(__ENV.PROFILE_FILE || './profiles/ramp.json'));
for (const stage of profile.stages) {
  if (stage.target > MAX_RATE_PER_POD) {
    throw new Error(`stage target ${stage.target}/s exceeds ${MAX_RATE_PER_POD}/s per pod (gateway limit)`);
  }
}

// One copy of the rows per pod, shared by all VUs.
const rows = new SharedArray('rows', () => {
  const doc = JSON.parse(open(__ENV.ROWS_FILE || './data/rows.json'));
  return doc.rows.map((values) => Object.fromEntries(doc.columns.map((name, i) => [name, values[i]])));
});

export const options = {
  scenarios: {
    transfers: {
      executor: 'ramping-arrival-rate',
      startRate: 0,
      timeUnit: '1s',
      preAllocatedVUs: 10,
      maxVUs: 60,
      stages: profile.stages.map(({ duration, target }) => ({ duration, target })),
    },
  },
  setupTimeout: '4m',
  discardResponseBodies: true,
  // Every series carries the run and the pod (remote write needs unique series per pod).
  tags: { testid: RUN_ID, pod: POD },
  summaryTrendStats: ['avg', 'med', 'p(95)', 'p(99)', 'max'],
};

function call(method, path, body, token, expected) {
  const params = {
    headers: { 'Content-Type': 'application/json' },
    responseType: 'text',
    tags: { name: `setup ${path}` },
  };
  if (token) params.headers.Authorization = `Bearer ${token}`;
  for (let attempt = 1; attempt <= 5; attempt++) {
    const res = http.request(method, `${BASE_URL}${path}`, body && JSON.stringify(body), params);
    if (res.status === expected) return res;
    if (res.status !== 429 && res.status < 500) fail(`${method} ${path}: HTTP ${res.status} ${res.body}`);
    sleep(attempt);
  }
  return fail(`${method} ${path}: still failing after retries`);
}

export function setup() {
  const users = [];
  for (let i = 0; i < USERS; i++) {
    const email = `load-${RUN_ID}-${POD}-${i}@example.com`;
    call('POST', '/api/auth/register', { email, password: PASSWORD, name: `Load ${POD}-${i}` }, null, 201);
    const token = call('POST', '/api/auth/login', { email, password: PASSWORD }, null, 200).json('accessToken');
    call('POST', '/api/wallet/deposit', { amount: DEPOSIT }, token, 200);
    users.push({ email, token });
  }
  // Access tokens live 15 minutes (contract §1): profiles stay well inside that.
  const wait = START_AT - Date.now();
  if (wait > 0) sleep(wait / 1000);
  return { users };
}

export default function (data) {
  const n = exec.scenario.iterationInTest;
  const sender = data.users[n % data.users.length];
  const recipient = data.users[(n + 1) % data.users.length];
  const features = rows[Math.floor(Math.random() * rows.length)];
  const res = http.post(
    `${BASE_URL}/api/transactions`,
    JSON.stringify({ recipientEmail: recipient.email, amount: features.Amount, currency: 'USD', features }),
    {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${sender.token}`,
        'Idempotency-Key': `${RUN_ID}-${POD}-${n}`,
      },
      tags: { name: 'POST /api/transactions' },
    },
  );
  check(res, { 'transfer created (201)': (r) => r.status === 201 });
}
