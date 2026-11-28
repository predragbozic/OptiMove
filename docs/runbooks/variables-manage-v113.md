# Variables Manage v113 bridge

This migration seeds `variables.manage` only for native Club admin roles with Variables View, including active club versions and currently held club-scoped custom layers that include View. Team coach, team-scoped custom roles and standalone assignments receive no new grant. Settings keeps the word closed during the bridge. The staged write boundary covers canonical variable creation and versioning, Copy, Hide and Show, owned classification changes, and P3 reference-table authoring. Dashboard binding, narrow Rename and Archive, personal settings, mapping, sources and import retain their existing contracts.

- Migration `migrations_v2/202612151000_training_load_v113_variables_manage_bridge.sql`
- SHA-256 `605745415a4f99b0c4f01a02dbb76aaff8d757ed1b5004891ac08b21e61b414e`
- Required v112 SHA-256 `f7a99f8e9242a681276076e444dfb5c2b4180384216a87ec9dcfefe0706c33d2`
- Permission evaluator MD5 before `3b1a627d31c6f0c6ab97453d0dc25f07`, after `9f0ca6cadde07c1c60aa1f4dfa36f163`
- First-use guard MD5 `450516d74a293befa18613466c6791a5`

1. Pin the predecessor to the exact live Variables Rename and Archive Settings release and verify that the migration slot is free.
2. On a disposable loopback PostgreSQL 17 cluster with Node 20 or later, run `backend/scripts/variables-manage-v113-rehearsal.ps1` or the corresponding `.sh` wrapper. PowerShell prompts securely if no local database URL or `PGPASSWORD` is set. Require `RESULT: PASS`.
3. Run `variables-manage-v113-preflight.sql` and require every boolean to be true. Apply with the repository migration runner. Run `variables-manage-v113-postcheck.sql` and verify the recorded checksum, exact seed and audit, existing v112 objects, and a null first-use timestamp.
4. Deploy the bridge while the word stays closed in Settings. Wait for all previous-server instances to drain before deploying the separate Settings exposure.
5. To roll back before exposure and first checked use, stop bridge traffic and run `variables-manage-v113-rollback.sql`. It refuses a later migration, recorded use, changed seeded revisions, extra grants or audit rows, and changed evaluator or marker guard. Confirm the original v112 evaluator and role state are restored. After any checked write, keep v113 installed and repair forward.

The native writer records first use in the transaction that persists the checked change and its request receipt. Replays, platform writes, rejected requests and rolled-back transactions leave the marker unchanged.
