# Sources Connect local write checkpoint

This checkpoint covers the connection Create and keyed Unbind routes. An
existing native Club admin must hold the staged Sources Connect word in the
active workspace that owns the connection. The transaction checks the grant,
active session and workspace before disclosing a receipt or writing. The same
key and body still replay one durable result. A conflicting key in the same club
keeps its 409. Reuse across clubs returns the same 404 as a missing resource.
A native Unbind receipt requires the binding's team to remain in the owning
club. The platform path keeps its deployed behavior.

Create keeps its per-user advisory. Unbind keeps the per-user advisory,
connection lock, target-team import try-lock and binding lock for new writes.
A receipt replay still skips the team advisory. Post-commit disclosure has a
fresh authorization transaction after the writer releases its client.

A future bridge can record first use after the checked native effect and its
success audit, inside the same transaction before COMMIT. Platform writes,
replays, refusals and quarantined outcomes do not stamp it. Rollback and any
operator marker table belong to the complete bridge.

The legacy `PUT /api/training-load/gpexe/teams/:teamId/settings` still uses
its existing team access and transaction. A platform admin can approve or
replace a pair subject to the binding constraints. A native club admin in
the owning workspace can approve the first pair, or repeat that same pair
without a write, provided the club's verified connection is available. The
team import lock and database guard prevent replacing an actively bound pair.
The native write and same-pair response now check the staged Sources Connect word
under the same transaction and keep the existing 403/404 split. Platform
behavior and the separate session-time-zone route remain unchanged. Bind,
Connect, Reconnect, Test, provider claims, credentials and Imports retain
their deployed behavior.
