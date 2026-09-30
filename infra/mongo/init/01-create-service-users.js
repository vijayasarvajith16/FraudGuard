// Runs once, when the MongoDB data volume is first initialized (docker-entrypoint-initdb.d).
// Creates one least-privilege user per service, scoped to that service's own database
// (docs/contracts.md §0.1). A service whose password variable is unset is skipped.

const serviceUsers = [
  { user: 'auth_service', db: 'fraudguard_auth', passwordEnv: 'MONGO_AUTH_PASSWORD' },
  { user: 'transaction_service', db: 'fraudguard_transactions', passwordEnv: 'MONGO_TRANSACTIONS_PASSWORD' },
  { user: 'alerting_service', db: 'fraudguard_alerts', passwordEnv: 'MONGO_ALERTS_PASSWORD' },
];

for (const { user, db: dbName, passwordEnv } of serviceUsers) {
  const pwd = process.env[passwordEnv];
  if (!pwd) {
    print(`[init] ${passwordEnv} not set, skipping user ${user}`);
    continue;
  }
  db.getSiblingDB(dbName).createUser({ user, pwd, roles: [{ role: 'readWrite', db: dbName }] });
  print(`[init] created user ${user} on ${dbName}`);
}
