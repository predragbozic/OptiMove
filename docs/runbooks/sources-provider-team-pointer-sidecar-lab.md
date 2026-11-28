# Closed Sources team and pointer generation rehearsal

The migration requires the exact v118 checksum and enabled binding capture,
closed epoch zero, and an empty attempt store.
Installation snapshots eight legacy trigger definitions, enabled states and
bound function definitions. It takes immediate exclusive relation locks on teams
and settings in a single transaction. If either table is busy, installation
aborts before adding capture triggers.

The sidecars store one private counter per team key per relation, written in the
same transaction as the original effect. Existing teams and pointers do not
require backfill. An absent counter means generation zero. A deleted or rekeyed
team leaves a tombstone, so reusing an ID cannot restore the previous generation.
Keep tombstones for any epoch whose claims can refer to them. The team capture
tracks ownership and effective activity. The pointer capture tracks the
canonical source-team value. Neither trigger updates a parent row or adds a
foreign key. Both sidecars have RLS and deny direct access to PUBLIC and the
three named API roles. A trigger-only definer lets existing authorized raw team
writers keep their original privileges without granting sidecar writes.

The disposable rehearsal checks live named-role default grants, the original
public team shape, old bind/unbind and settings history behavior, no-ops and
round trips, independent team updates, capture rollback and apply/down/reapply.
Down checks the exact registry row and rejects later migrations, even those with
an older applied timestamp. It also refuses after any capture, closed-state
drift, capture or legacy trigger drift, or sidecar ACL drift. A permitted down
removes the two new tables, triggers and functions and its own registry row.

Run the preflight and postcheck SQL around the normal migration runner. Use a
private loopback PostgreSQL cluster for the rehearsal and point
OPTIMOVE_SOURCES_V119_PREVIOUS_SERVER at a clean checkout of
5016ba1cfcf1396379eac4b40aca6a4b0c87a67d with backend packages installed.
The shell and PowerShell wrappers require that checkout. They exercise the same
previous server before and after the migration with team create, rename, archive
and restore, plus initial and repeated approved GPEXE pointer writes. The
database checks capture values and legacy response structure. The standard
runner also supports this file without the predecessor and reports that
specific HTTP case as skipped.

A future admission phase must take current team and pointer facts together
with their counters in the same authorized snapshot, and account for
privileged maintenance paths such as TRUNCATE, trigger bypass and restore.
This phase leaves all provider routes, producer cutover and admission closed.
