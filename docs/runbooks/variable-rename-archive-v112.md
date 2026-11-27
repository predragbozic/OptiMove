# Variables Rename and Archive v112 bridge

The bridge stages `variables.rename_archive` for native editors while Settings
keeps the word closed. It covers Rename, Icon, Archive and Restore for the
club's variables. Variable creation, versions, mappings, source connections,
imports and private or platform rules retain their existing authority.

- Migration `migrations_v2/202612141000_training_load_v112_variable_rename_archive_bridge.sql`
- SHA-256 `f7a99f8e9242a681276076e444dfb5c2b4180384216a87ec9dcfefe0706c33d2`
- Required v111 SHA-256 `822f6cc61c51aa66bf48639e9d577439d83d38b8b18efe8b7b41a5bd323f2cf3`
- Permission evaluator MD5 before `a09af1e41b096da583fbaf04727fe992`, after `3b1a627d31c6f0c6ab97453d0dc25f07`

The seed adds the word to active Club admin and Team coach built-ins with
Variables View. An active club version and a currently held native custom
role of those built-ins are eligible only if their own items include View.
Standalone assignments and ended or unheld custom roles get no grant. The
migration audits the exact items, preserves review state and takes club
ceilings in UUID order before the permission table locks.

1. Before freezing, pin the rehearsal to the exact deployed Tests Settings
   build and confirm the registry slot. The current local checkpoint uses
   Tests bridge build `519ad0107d0e1328de7ddb5689e87fec3f09d383`.
2. Rehearse on isolated loopback PostgreSQL 17 with Node 20 or later using
   `backend/scripts/variable-rename-archive-v112-rehearsal.ps1` or the
   accompanying `.sh`. The PowerShell wrapper prompts securely when a local
   database URL and `PGPASSWORD` are both absent. Require `RESULT: PASS`.
3. Run the read-only `variable-rename-archive-v112-preflight.sql` and require
   every boolean to be true. Use the repository runner to apply v112. Run
   `variable-rename-archive-v112-postcheck.sql` before allowing native traffic.
   Verify the recorded checksum, both staging objects, the guard, the listed
   grant and audit counts, and the empty first-use timestamp.
4. Deploy the bridge with Settings still closed for the new word. The old
   server can finish its existing Variables and Settings commands during the
   overlap. Drain the old server before the separate Settings exposure.
5. To roll back before use and exposure, stop bridge traffic and run
   `variable-rename-archive-v112-rollback.sql`. It rejects a later migration,
   any native checked write, unexpected grants or audits, changed seeded
   revisions, or changed permission/marker guards. Confirm v111's permission
   evaluator and audited role state are restored. After checked usage, keep
   v112 installed and repair forward.

The native writer records first use in the same transaction as the changed
value, audit record and durable request receipt. Replays, refused requests,
platform writes and rolled-back transactions leave the marker unchanged.
