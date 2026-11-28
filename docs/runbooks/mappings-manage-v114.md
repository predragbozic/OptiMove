# Mappings Manage v114 bridge

The bridge stages `mappings.manage` for active native Club admin layers that already have Variables View. It covers mapping create and draft, submit, activate or replace, disable, activation start, end and switch-to-copy, and the Board confirmation. These are nine existing command routes. Atomic variable Copy keeps its existing Variables Manage authority and receipt. Source credentials, the GPEXE settings pointer, imports and platform registry actions keep their own rules.

- Migration `migrations_v2/202612161000_training_load_v114_mappings_manage_bridge.sql`
- SHA-256 `7eefcd2204babab96633ff69905405349fa9eadb9ce19643670879ebf603dbfb`
- Required v113 SHA-256 `605745415a4f99b0c4f01a02dbb76aaff8d757ed1b5004891ac08b21e61b414e`
- Permission evaluator MD5 before `9f0ca6cadde07c1c60aa1f4dfa36f163`, after `5049fee9f1790dee54fc174de2d0c058`
- First-use guard MD5 `85acb99dd33fe5afbcc626aaf37ed682`

The audited seed includes eligible live Club versions and actually held club-scoped custom layers with Variables View. It does not require Variables Manage. Team coach, team-scoped custom roles, standalone assignments and archived or unheld layers receive no grant.

1. Confirm the exact previous Variables Manage exposure build and the v114 registry slot before freeze. Run the operator rehearsal against the pinned old build and the bridge on isolated PostgreSQL 17 with Node 20 or later.
2. Use `backend/scripts/mappings-manage-v114-rehearsal.ps1` or the corresponding `.sh` wrapper. PowerShell prompts securely if no local database URL or `PGPASSWORD` is set. Require `RESULT: PASS`.
3. Run `mappings-manage-v114-preflight.sql` and require every boolean to be true. Apply with the repository migration runner. Run `mappings-manage-v114-postcheck.sql` and verify the checksums, marker guard, exact audit and seed, prior v113 evidence, and the empty first-use timestamp.
4. Deploy the bridge while Mappings Manage remains closed in Settings. Drain the exact pre-bridge writers before the separate Settings exposure. The old writer and bridge can share the request ledger during overlap.
5. To roll back before first checked use and Settings exposure, stop the bridge and run `mappings-manage-v114-rollback.sql`. It rejects a later migration, recorded checked use, modified seeded revisions, unexpected grants or audit rows, and changes to the exact evaluator or marker guard. Confirm the v113 evaluator and audited role catalogue are restored after rollback. Keep v114 deployed and repair forward after checked use.

The first-use marker and the checked mutation share one transaction. The native writer records first use after storing the normal request receipt, before COMMIT. Replays, platform writes, refused requests and rolled-back transactions leave the marker unchanged.
