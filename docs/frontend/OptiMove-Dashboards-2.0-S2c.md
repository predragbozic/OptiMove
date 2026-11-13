# Dashboards 2.0 S2c — atomic save candidate

Specification: S1.1 `26162ae8f266eb24c88c601c8d4e8b9f1ca59be7` (PR #265).
Stacked base: S2b `2317aa47019afaa5357cabfbea00ec017c1d0265` (Draft PR #279),
which depends on S2a Draft PR #270. These dependencies remain unmerged.

## Scope

The save service and router are factories. They are not mounted in `server.js`.
New saves require explicit server-owned `activation.atomicSaveVerified === true`;
the default refuses writes. No frontend rollout, signing configuration, production
migration, deployment, or environment change is included.

The composite SQL function commits one widget, exactly one series, its presentation
and a minimal durable receipt together. Creates allocate current free placement
under the dashboard lock, without using the preview dashboard revision as a guard.
Updates use the existing widget revision. The request advisory lock precedes the
dashboard, widget, series and compatible catalog locks.

Every save/status/recovery checks current authentication, workspace and target
rights. A completed matching receipt is replayed before token expiration, key
rotation, stale revision or relative-period recomputation. Canonical hashes include
the original issued time, resolved period, target and input; they exclude the proof
token. Set-like athlete IDs and rule priorities have deterministic ordering.

The original request window is 168 elapsed hours. Receipts are retained for at
least 168 hours plus 10 minutes, including across daylight-saving transitions.
Bounded cleanup skips a request whose advisory lock is held; no cleanup job is
enabled. An expired request cannot silently become another create after cleanup.

Commit acknowledgement has a maximum five-second budget. An acknowledgement error
destroys the original connection and uses a separate bounded read-only receipt
check, including checkout, within an additional five seconds. A matching receipt
returns `verifiedAfterCommitError`; an absent/unavailable result returns
`503 outcomeUnknown` and the original request ID. Recovery never issues another
business write or claims that a lost acknowledgement proves rollback.

Checked-out save and read-only clients are observed for connection error/end
events. The observer is installed synchronously inside the pool's checkout
callback, before resolving the application Promise, and races transaction work.
Failed clients are destroyed; owned listeners are removed only after pool handoff.
Pool adapters must forward callback checkout synchronously to preserve this
boundary. Promise-only fixtures remain supported for in-memory unit tests.

## Presentation compatibility

`presentation_config` is nullable and revision-aware. Legacy writers retain their
existing call signatures when no presentation operation is supplied; explicit
preserve, replace and clear use separate sanctioned wrappers. Detail, saved-query
and preview projections carry the sidecar. Template clone copies its exact JSON
only after cloning series, inside its existing transaction.

Unknown versions are opaque. Safe title/layout edits preserve them; semantic edits
must explicitly clear or replace them. Composite transitions temporarily detach
presentation inside the same transaction and validate the final attachment after
series changes. A subsequent failure rolls the entire transition back. Known V1
chart presentation requires resolved bindings to be numeric in both attachment
and series mutation guards. Portable clone placeholders with unresolved/ambiguous
status and no bound metric/builtin preserve their exact sidecar and repair path;
existing hints/candidates constraints still apply. Repair to text/boolean remains
rejected, while numeric repair succeeds. Null-sidecar legacy behavior is preserved.

Nonempty table rules, reference/percent evaluators, Pages and S2d KPI width changes
remain outside this phase. Save transport accepts at most 96 KiB of original
request bytes to accommodate the existing bounded preview envelope and proof.

## Verification and activation gates

The independent reviewer found two P2 issues in opaque transitions and numeric
chart eligibility. Both fixes passed the reviewer's subsequent static review;
that review did not execute tests. Measured test results are recorded separately
in the coordinator's S2c status report.

A subsequent independent review of `4132100` reproduced checked-out connection
process termination (P1) and V1-chart clone rejection for unresolved metrics (P2).
The follow-up changes add synchronous checkout observation and preserve valid
placeholder bindings. Regressions include real PostgreSQL disconnects in child
processes, installed pg protocol checkout-boundary tests without sockets, and
clone/repair cases. The original external reproductions were rerun unchanged.

The stacked branch had a pre-existing Builder unit failure; it remains recorded
in the historical results. The isolated integration on main `5a2b39d` passed
579 backend unit tests, including Builder. This does not change the old results.

## Main compatibility corrections

The unpublished S2c migration is now
`202611131300_training_load_v68_dashboard_simple_atomic_save.sql`, avoiding a timestamp collision
with main's v46 migration. It is an unmerged Draft candidate, not a migration
upgrade for any database that already recorded the old filename. Before any
activation, verify the target ledger has neither S2c identity; if the old identity
exists, stop and prepare a separate forward migration. No such target inspection
or production execution is authorized by this change.

On schemas with v50 source-instance end, an existing single resolved series may
retain its exact ended source pin during title, presentation, aggregation and
widget-type edits. The capability reader derives eligibility from the stored
widget on the authorized dashboard. The compiler and SQL independently require
the same widget, series, metric, source policy and connection identity; request
body claims do not grant eligibility. The SQL path keeps the original series ID
when type and aggregation change together. Creating, cloning or rebinding to an
ended connection remains refused. A preview made before source end cannot be
used afterward; a fresh preview is required. Actual retained-pin editing depends
on v50 trigger behavior, so activation on the older stacked schema is unsupported.

Ten pure compiler/reader regressions run on the stacked PR. The full real HTTP
source-end scenario is exercised separately against the current-main integration
fixture, with historical reads, both type/aggregation transitions, stale preview,
create/rebind/clone refusal and authorization controls. That integration fixture
is not imported into the older stacked test suite.

Before activation, reconcile the stack with the then-current pinned main and test
the full migration sequence on a verified baseline. Confirm dedicated signing
and rotation, preview coordination and budgets, and load-test save/recovery.
The synthetic legacy reconstruction used for investigation is unverified and is
not a substitute for production-data or staging rehearsal. Factories remain
unmounted and new saves disabled by default. No production-readiness claim is
made by these compatibility corrections.
