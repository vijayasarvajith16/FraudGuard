// Docker healthcheck for the single-node replica set (docs/contracts.md §0.1).
// Initiates the set on first start, then reports healthy only once this node is a
// writable primary, so dependent services never start against a read-only member.
try {
  rs.status();
} catch (e) {
  rs.initiate({ _id: "rs0", members: [{ _id: 0, host: "mongodb:27017" }] });
}
quit(db.hello().isWritablePrimary ? 0 : 1);
