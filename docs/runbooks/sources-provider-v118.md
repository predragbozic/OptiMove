# Sources sparse binding generation v118

v118 stages a private initial generation and sparse connection/team deltas. Provider admission stays closed. Existing binding routes and server code are unchanged.

1. Confirm the exact v117 predecessor and a quiet write window. Run sources-provider-v118-preflight.sql and require every result to be true. The migration adopts a 10,000-row cap, fails immediately if the binding relation is busy, and applies a 3-second statement and 5-second transaction limit. The actual row count is independent of those limits.
2. Rehearse on PostgreSQL 17 with Node 20 or newer using the matching script in backend/scripts. Use a fresh disposable loopback cluster. The runner requires pg_dump from the same PostgreSQL major version. Set DATABASE_URL or PGPASSWORD using the local-only wrapper. Expected output is RESULT: PASS.
3. The normal migration runner applies v118 in one transaction. Run sources-provider-v118-postcheck.sql and require all checks true. It verifies registry, closed admission, the enabled capture trigger and consistency with exact immutable history.
4. Roll back only while closed and before any binding effect, with the matching registry and SQL definitions. Run sources-provider-v118-rollback.sql on operator order. It drops only sparse objects and removes the v118 registry entry. Existing binding and audit history remains durable. After the first capture, stop and plan a forward fix.

The legacy v27/v30 guards still decide whether the binding write is valid. The new AFTER trigger captures changes in the same transaction after those guards. Rows already ended count twice. The per-team write uses no parent row or shared connection counter. In-memory provider admission stays unchanged.
