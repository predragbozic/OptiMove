# Sources binding generation, closed-stage plan

Base: v117 candidate `16e04fc3a8c5ba2d043677c4f6eb8d9ab1bce6b0`. This checkpoint adds disposable tests only. Provider admission stays closed.

## Capture and seed

- Keep an immutable private per-connection baseline and one positive bigint delta per changed (connection, team). A new connection with no history has an implicit baseline of zero. Insert adds one for an active row or two for a directly ended row. Ending an active row adds one. Preserve the v27 and v30 guards and append-only history. Read the exact active bindings and baseline plus deltas in one SQL statement. Keep the full immutable history count as an independent oracle.
- Seed under SHARE ROW EXCLUSIVE on source_team_bindings with a short lock timeout. Acquire it before reading history and keep it through trigger install and commit. Preflight proves exact predecessor, trigger identities and function bodies; measure both lock acquisition and hold on representative history, cap the statement duration, and stop for rescheduling if the measured budget is exceeded. Batching within this transaction does not shorten the writer pause. For an oversized table, design and rehearse a separate pre-stage and final reconciliation before retrying.
- Existing INSERT and END paths take the same TRY team lock before the new AFTER trigger can write. The sidecar has no parent FK; it touches neither connection, team nor host rows. Independent teams on one connection write separate rows. Preserve cumulative rows. The snapshot work scales with changed team keys rather than historical binding events.

## ACL and overlap

- Keep sidecar tables, functions and generation values private. Preflight checks schema and default privilege ACLs, including column defaults. Explicitly remove PUBLIC and anon/authenticated/service_role grants and verify effective privileges including inherited grants, REFERENCES and TRIGGER. If a fixed-path SECURITY DEFINER trigger is needed for existing writer roles, use a constrained owner and revoke public/API EXECUTE; test actual writer identities with seeded ACLs. No API projection changes.
- Install only with admission closed and no attempts. Old binaries keep all existing writes and use the same DB trigger after commit of the future migration. Rehearse exact old/new Bind/End with committed, aborted, direct-ended and reverse-order cases, same-team try-lock and old guard refusals. Confirm legacy HTTP response envelopes and same snapshot results. No mounted routes or provider traffic in this slice.

## Rollback

- Verify migration registry, trigger bodies/ACL and exact dependency set. Refuse if admission was opened or a consumer/attempt or later migration exists; use an immutable first-use marker if admission history is not established enough to prove this. Refuse drift and missing evidence. Compatible old binding writes stay in the binding table, and disposable rehearsal must compare history before/after removing only the capture trigger, functions and sidecars. Reapply under the same bounded seed barrier and prove identical catalog when down and matching oracle after reapply.
- Operator package before any future official migration: read-only preflight/postcheck, exact checksum and function md5 checks, rollback SQL, PostgreSQL 17 rehearsal and named ACL tests. This checkpoint allocates no migration slot.

## Prototype checkpoint

The disposable-only draft SQL lives under backend test support. It rejects a different or later registry, verifies the existing binding trigger set and body hashes, and takes a NOWAIT writer barrier before counting. The sample is capped at 10,001 rows to reject more than 10,000, with per-statement and per-transaction timeouts. These are prototype limits. Confirm a production-sized lock budget before selecting final limits. No provider or compatibility route reads the sparse witness.

The down draft first checks that admission is closed and the exact registry, trigger set, hashes and effective ACLs hold. It refuses once a real binding effect has produced a delta. The focused rehearsal checks down then reapply, exact pre-existing binding trigger catalogue restoration, actual default ACL revocation and rollback refusal after a successful binding effect. Real old and current server process overlap, full dump equality, the cap refusal under representative load, and a final preflight/postcheck remain required for a deployable migration. Existing SQL writers were exercised directly with real v27/v30 guards in the temporary database.
