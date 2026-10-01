// Health check for the single-node replica set (docs/contracts.md §0.1), used by the compose
// healthcheck and the Kubernetes readiness probe. Initiates the set on first start, then reports
// healthy only once this node is a writable primary, so dependents never start against a
// read-only member.
//
// MONGO_RS_HOST is the member's address as clients must reach it: "mongodb:27017" in compose; in
// Kubernetes the pod's stable headless-service name (a plain Service has no endpoints until the
// pod is ready, which would deadlock the initiation).
const host = process.env.MONGO_RS_HOST || "mongodb:27017";
try {
  rs.status();
} catch (e) {
  rs.initiate({ _id: "rs0", members: [{ _id: 0, host }] });
}
quit(db.hello().isWritablePrimary ? 0 : 1);
