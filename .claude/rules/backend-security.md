---
paths:
  - "backend/src/**"
  - "backend/tests/**"
---

# Backend security

Multi-tenant system where one user can hold multiple roles across workspaces at once —
the real risk is an authorization mistake (IDOR / cross-workspace leak), not an exotic
attack. See `docs/decisions/ADR-002-owner-scope-vs-data-workspace.md` for the full
verified contract this file summarizes.

## Identity and workspace

- Every route needs `requireAuth`. Identity comes from `req.user`/`req.authz` (the
  session), never from anything in the request payload.
- `role_hint` on `users` is a legacy UI display label only (`backend/src/authz.js`,
  `frontend/access.js`) — it is never read for an authorization decision anywhere in the
  backend. If new code reads it for anything but a label, that's a finding.
- `resolveActiveWorkspace()` (`backend/src/workspace.js`) is not memoized internally —
  each call re-queries. The existing convention (`trainingLoadDashboardAccess.js`,
  `trainingLoadAccess.js`, `trainingLoadMetricsAccess.js`) is to resolve it once per
  request and thread that one snapshot through the rest of the call chain — for
  concurrent internal calls within one request, memoize the in-flight *promise*, not just
  the resolved value, to avoid a duplicate resolution race. A new domain's access helper
  should follow the same pattern rather than calling `resolveActiveWorkspace` fresh at
  multiple points in one request.

## owner_scope vs data workspace — two independent checks

- `owner_scope` (plus `owner_user_id`/`owner_club_id`/`owner_team_id`) answers "who may
  manage this row" — a platform admin, or a matching scope owner.
  `data_workspace_type`/`data_workspace_scope_id` answers a different question: "which
  workspace's data does this row's own query read" — these are independent contracts,
  never collapse them into one equality check.
- Concrete pattern (`trainingLoadDashboardAccess.js`, `routes/trainingLoadDashboard.js`):
  a user who can *manage* a dashboard (broader — e.g. an admin of two different clubs)
  isn't automatically allowed to *query* it while a DIFFERENT workspace is active; the
  query path re-checks the caller's currently-active workspace against the dashboard's
  own data workspace, independently of the manage check.

## Response contracts

- A resource that doesn't exist and a resource that exists but the caller can't access
  return the same status and the same `error` value — `404 {error: "notFound"}` — never
  a different status/error for the two. This is a deliberate app-wide convention, not
  accidental. The rest of the body (e.g. a `message` field) isn't always guaranteed
  byte-identical across every code path that produces this 404 (see ADR-006's own known
  gap) — match status+`error` as the hard requirement; treat full body identity as the
  goal, not yet a verified guarantee everywhere.
- `400` for a malformed/invalid request shape. `409` for a valid request that conflicts
  with current state — known real examples: `"staleRevision"`, `"dashboardArchived"`,
  `"templateRequiresClone"`, `"conflict"` (unique-violation).
- Idempotent retry paths re-evaluate authorization at retry time — don't reuse a cached
  decision from the first attempt; permissions can change in between.
- SQL is always parametrized (`$1, $2, ...`) — string-interpolating a user-supplied value
  into SQL text is a CRITICAL finding.

## Raw DB detail in responses — verify per-route, don't assume

The dashboard router (`routes/trainingLoadDashboard.js`) is clean: SQLSTATEs are mapped
to stable generic error codes, and a raw `RAISE EXCEPTION` (`P0001`) is never forwarded
as text. **This is not true of every route.** At least `trainingActivity.js`,
`trainingLoadMetrics.js`, `trainingLoad.js`, and `tests.js` intentionally forward the raw
Postgres exception message on `P0001` — a deliberate choice in those files, documented in
their own comments, not an oversight to "fix" reflexively. Before asserting "this route
never leaks a raw DB message," check that specific route rather than assuming the
dashboard router's pattern applies everywhere. If a new or touched route forwards a
`P0001` message, verify by hand that no reachable trigger message on that path names a
foreign user/workspace id (see `trainingActivityMaterialize.js`'s own comment on exactly
this risk) — that's the actual thing to check, not the mere presence of message
forwarding.

## Auth flow specifically

If `auth.js` is touched: PBKDF2 stays >= 210,000 iterations, the session token is hashed
in the database (never stored plain), comparison uses `timingSafeEqual`, and the session
cookie stays `HttpOnly` + `SameSite`.
