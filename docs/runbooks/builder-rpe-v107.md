# Builder RPE v107 copy attestation

v107 adds immutable opening proof to the existing plan and session provenance rows. Existing rows and overlapping v106 writers receive the default false value. v107 never reconstructs proof from timestamps or from the current status of an old copied source. The app records new proof in the copy or assignment transaction only for exact enabled flags verified from a locked active source or from an already attested opening. Current, authorized explicit changes stay separate in the v106 effect ledger.

An unclassified enabled draft stays saved. All-off drafts and verified unchanged edits still work. The separate confirmation flow can later consume an explicit, narrowly scoped review without rewriting a historical baseline.

## Before release

- Rehearse with Node 20 or newer on an isolated PostgreSQL cluster. On Windows run `backend/scripts/builder-rpe-v107-rehearsal.ps1`. It accepts an existing loopback URL or prompts for a local password. On Linux or macOS set the disposable cluster URL and use the matching shell script. Both print `RESULT: PASS` after their test suites complete.
- Check the exact v106 checksum, absence of v107 and absence of existing attestation objects with `builder-rpe-v107-preflight.sql`.
- Keep RPE Settings exposure closed while v106 and v107 can both be running. Apply the v107 schema before the new writer accepts requests. Verify checksum, both closed defaults, both constraints and all trigger bodies with `builder-rpe-v107-postcheck.sql`. Wait for the old v106 writer to drain before any exposure release.

## Rollback

Drain all new writers first. Before any attestation use, run `builder-rpe-v107-rollback.sql` and the preflight again. Abort if the registered checksum or function bodies differ or a later migration is listed. A sticky first-use marker survives normal plan/session deletion, so SQL rollback after a real attestation is refused. Use a forward repair in that case. Ordinary plan/session content and pending drafts are preserved.
