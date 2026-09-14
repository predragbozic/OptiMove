# OptiMove — Project Context

Stable architectural context. Changes only when the architecture itself changes — not
per merged PR. For what's currently in progress, see `docs/ai/CURRENT_STATE.md`. For a
specific architectural decision and its evidence, see `docs/decisions/`.

## What OptiMove is

A training-planning platform for coaches and athletes: program building (weekly plans,
specific programs, templates), an exercise library, and — the newest domain — Training
Load tracking (RPE/sRPE capture, calendar-based session review, and an Analysis
dashboard system). Node/Express backend, plain-ES-module frontend (no framework/bundler
in dev; Vite for the production build), Postgres.

Superseding an earlier version of this document: real session-based authentication now
exists (PBKDF2, `requireAuth` middleware, hashed session tokens — see
`.claude/rules/backend-security.md`) and a Tests module is implemented — both were
previously listed as "not yet built." Don't rely on an older snapshot of this file or a
delivery report that predates 2026-09 for either claim.

## Key domains / modules

Athletes, Calendar, Coaches, Builder (program/plan editor), Program Library, Exercise
Library, Tests, Training Load (own Calendar/Schedule/Results/Analysis tabs), Settings
(Users/Clubs/Teams/Athletes/Tags), Messages, Notifications, Account. Training Load
Analysis is the most recently built area (see `docs/ai/CURRENT_STATE.md`).

## Repo structure map

- `backend/src/routes/` — one file per route group (`trainingActivity.js`,
  `trainingLoad.js`, `trainingLoadDashboard.js`, `trainingLoadMetrics.js`, `auth.js`,
  `organization.js`, `tests.js`, …).
- `backend/src/` (outside `routes/`) — domain service files following an
  Access/Query/Catalog/Widgets split for Training Load
  (`trainingLoadAccess.js`, `trainingLoadDashboardAccess.js`,
  `trainingLoadDashboardQuery.js`, `trainingLoadDashboardCatalog.js`,
  `trainingLoadDashboardWidgets.js`, `trainingLoadMetricsAccess.js`,
  `trainingLoadMetricsCatalog.js`) — check for an existing helper here before writing a
  new one.
- `backend/tests/` — ~68 test files, `*.test.mjs`.
- `frontend/` — one domain = `{name}-view.js` (render) + `{name}-actions.js`
  (events/mutations) + `{name}-data.js` (API/cache); `app.js` is the shared
  event-delegation orchestrator, not a domain module. `state.js` holds shared client
  state shape.
- `frontend/tests/` — ~79 test files, `*.test.mjs`.
- `migrations_v2/` — flat, `YYYYMMDDHHMM_description.sql`, checksum-protected once
  applied (see `.claude/rules/migrations.md`, ADR-005). 36 files as of 2026-09-14.
- `migrations/` (no `_v2`) — legacy/historical, not where new migrations go.
- `.claude/agents/` — the four read-only review agents
  (`code-reviewer`/`db-reviewer`/`mobile-qa`/`security-reviewer`); `.claude/rules/` —
  topic-scoped operating rules `CLAUDE.md` links to instead of duplicating.
- Repo root also holds legacy Google Apps Script reference files (`Code.gs`, several
  `*.html` files) and old import artifacts — reference only, not deployed; don't delete
  them without being asked.

## Identity, ownership, and workspace

- A user's active workspace is one of: `platform`, `private_coach`, `club`, `team`,
  `athlete` — resolved via `resolveActiveWorkspace()` in `backend/src/workspace.js`,
  once per request (see `.claude/rules/backend-security.md`).
- `owner_scope` (who may manage a resource) and `data_workspace` (which data a resource's
  own queries read) are two **independent** contracts, not one equality check — full
  contract and evidence in ADR-002. This is the single most common place a new
  contributor gets authorization wrong on this codebase; read ADR-002 before adding a
  new workspace-scoped resource.
- `role_hint` on `users` is a legacy UI display label only, never an authorization
  source (ADR-002, `.claude/rules/backend-security.md`).
- A resource that's missing and one that exists-but-unauthorized return the identical
  response (info-hiding) — see ADR-006.

## Main sources of truth

Current explicit user request / confirmed product decision, then actual checked-out code
and introspected schema, then executed tests (as evidence, not requirement), then project
rules (`CLAUDE.md`/`.claude/rules/`), then old delivery reports last. Full statement and
reasoning in `CLAUDE.md`.

## Environments

- **Local dev**: Postgres on `localhost:5432`, database name `OPTIMOVE`
  (`backend/.env`'s `DATABASE_URL`) — this is the "local persistent OPTIMOVE" database
  referenced throughout `.claude/rules/database-safety.md`. Backend dev server:
  `npm run dev` from `backend/` (port 3001, serves both the API and the frontend static
  files — open `http://localhost:3001` directly, no separate frontend server needed for
  a full app check).
- **Deployed**: Supabase Postgres is the database used in the actually-deployed
  environment — separate from local dev, data can diverge between the two. Its
  connection uses the Supabase pooler; `db.js`'s `ssl: { rejectUnauthorized: false }` is
  a deliberate, narrow workaround for that pooler's certificate, not a general pattern
  (`.claude/rules/database-safety.md`).
- **monitoring2**: a separate reference database used for porting modules into
  OptiMove — read-only unless a task explicitly asks for a write to it.
- Email delivery: code and `.env.example` describe `gmail` as the "current production
  provider," but Render's outbound network is known to block Gmail SMTP — `brevo` exists
  as an HTTPS-based alternative for exactly that reason. These two facts partly
  contradict each other; don't assert which provider is actually active in a given
  deployment without checking that environment's real `EMAIL_PROVIDER` value.

## Architectural invariants worth knowing before touching Training Load

- Dashboard/widget/series writes go through sanctioned Postgres functions only, one
  documented raw-SQL exception (`cloneDashboard`) — ADR-003.
- Lock order for that subsystem: dashboard → widget → series — ADR-003,
  `.claude/rules/migrations.md`.
- RPE/sRPE/duration live in one table, read live by the dashboard, never duplicated —
  ADR-004.
- `training.canonical_activity_results()` is the one place activity-level facts (RPE,
  metrics, component performance) get assembled — ADR-001.
