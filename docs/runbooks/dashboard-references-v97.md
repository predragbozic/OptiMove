# P3 references and Radar — v97 owner runbook

This packet is not an instruction to apply anything automatically. Production migration, merge, deploy and feature activation require the owner's separate order naming the exact file.

## Artifacts and prerequisites

- Migration: migrations_v2/202611291000_training_load_v97_references.sql; SHA256 and all installed function-body md5 values are in dashboard-references-v97-manifest.json.
- Requires the exact recorded v94 checksum and its three existing presentation/remap bodies. v95/v96 are independent and are not required to be the last recorded migration. No existing dashboard, widget, series, layout, revision or observation is backfilled or rewritten.
- Preflight: dashboard-references-v97-preflight.sql. Run read-only and require every boolean true; record dashboard/widget/series counts and the existing P1 digest evidence. Review changed prerequisite bodies before proceeding.
- Postcheck: dashboard-references-v97-postcheck.sql. Every boolean must be true; existing dashboard/widget/series digests must equal preflight evidence. Application flag remains false throughout migration/deploy verification.
- Lock timeout is 5 seconds. Function replacement and new deferred triggers briefly lock dashboard widget/series relations; rehearse on PostgreSQL 17 and use a quiet deployment window. No trigger is disabled and no superuser setting is used.

## Local owner rehearsal

Use a dedicated temporary loopback PostgreSQL cluster, never production or an existing application database. The script creates and drops only uniquely named optimove_tests_* databases through the repository disposable helper.

PowerShell (Node >=20):

    .\backend\scripts\dashboard-references-rehearsal.ps1 -Port 55470

The wrapper asks for the password securely (Enter for trust), restores DATABASE_URL afterwards and never prints it. For a trust cluster, DATABASE_URL may instead be set process-locally and backend/scripts/dashboard-references-rehearsal.mjs run directly. On Linux use the .sh wrapper with a loopback DATABASE_URL; PGPASSWORD is supported by PostgreSQL. Success ends with RESULT: PASS.

The rehearsal includes actual apply -> rollback -> identical dashboard catalog -> reapply, body-change and later-migration refusals, refusal after real table creation, strict JS/SQL contract checks, real HTTP access and replay tests, reference query checks and math. Browser evidence is separate; run pages, gallery, simple and references e2e files before freeze.

## Deployment and activation order

1. Review both independent reviews, frozen full head, migration sha256, owner's PG17 RESULT: PASS and preflight evidence.
2. Owner orders this exact migration/merge/deploy, with DASHBOARD_REFERENCES_ENABLED=false. The repository migration runner owns the transaction; do not add BEGIN/COMMIT to the migration file.
3. Owner runs postcheck and compares the pre/post dashboard/widget/series evidence. Verify feature-off routes remain unavailable and normal dashboards work.
4. Only a separate owner decision sets DASHBOARD_REFERENCES_ENABLED=true. Use a club/team workspace with existing canonical-variable/dashboard rights. club_view/team_view stay closed; no new R4 permission word is enabled by P3.
5. Set DASHBOARD_REFERENCES_ENABLED=false to stop P3 access. Existing tables/pins are retained. Do not delete reference data to force a rollback.

## Rollback boundary

Run dashboard-references-v97-rollback.sql only on the owner's order. It checks every installed function-body md5, refuses any later recorded migration, locks dashboard -> Page -> widget -> series before reference tables, and refuses any real reference table, receipt, persistent usage evidence or current binding. Receipt retention does not erase usage evidence. No CASCADE drop is used: an unexpected dependency aborts.

The rollback restores the exact v94 bodies and verifies their md5 values before committing; the rehearsal compares the entire dashboard catalog with the pre-v97 catalog. Once references have been used, use feature-off and a reviewed forward correction. No destructive rollback is offered after use.

## Known product boundaries

Published versions are pinned; archived tables remain readable only through authorized existing pins. Individual references use the current per-club position. Group references require the selected team's authorized activities/roster and at least three imported measured athlete aggregates; manual, derived, estimated, calculated and conflicting values are excluded. Incompatible units/activity types and missing position/target show a reason, never an invented number. Historical positions, file import and team/athlete preset rows remain later work. Overlays support a shaded band; Radar shows multiple named reference lines.
