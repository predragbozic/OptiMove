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

The pre-existing Builder unit failure remains a failure; it is not waived or
reclassified here. Before activation, reconcile the stacked branch with current
main, apply/test the full migration sequence in an isolated integration environment,
confirm dedicated signing/rotation configuration and preview coordination/budgets,
and load-test save/recovery capacity. Current main was inspected at
`e7d7e4f67f6a34bb545549da05d849dd1bbda0e7`; it contains v43 and v44 migrations absent
from the pinned stack. This change uses a unique timestamp migration rather than
reserving a numbered v45. No claim of current-main integration or production
readiness follows from the pinned-stack tests.
