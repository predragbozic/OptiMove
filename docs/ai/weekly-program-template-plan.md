# Weekly program template (multi-week) — plan

Status: **Proposed** (2026-11-22, written against `main` `5308a301`). Owner's decisions 1–9 are final (relayed by the
Calendar/Builder stream manager); this document records the proven current state, the model, the HTTP contract and the
parts. Where code and this document differ, code wins. ★★ for parts B and C (external-review triggers 3 and 4: copy /
materialization into athletes' plans, transactions, lock order, idempotency).

## 1. What exists today (proven, file:line on `5308a301`)

- **Plan shapes.** `plans.plans.plan_type` is `weekly` or `program` (`plans_plan_type_check`); `plans_type_shape_check`
  (`backend/tests/support/legacy-schema.sql:13507`): a weekly plan has an athlete, `week_start`, `is_template = false`; a
  program is either a template (`is_template = true`, `athlete_id` null) or an athlete's specific program.
- **Blocks.** A program's blocks are `plans.plan_days` rows with `date` null and `block_index` set
  (`plan_days_shape_check`, :13196); `(plan_id, block_index)` is unique for them (`plan_days_program_block_unique`,
  :18526, not deferrable). `block_type` is `varchar(40)` with **no check constraint**; the Builder writes `session` by
  default (`backend/src/routes/builder.js:1131`), copies it verbatim (`copyProgramTree`, :2673; block copy :1186).
- **Microcycle grouping.** `buildProgramData` (`backend/src/utils/grouping.js:133`) switches to `mode: "microcycle"` when
  any block has `block_type = 'week_day'` and a name, and groups by the part of `block_name` before `" - "`
  (`buildMicrocycles`, :190). Nothing in the code writes `week_day`; such rows come only from older imports.
- **Weekly plans.** Always seven days Monday–Sunday: `createWeeklyDays` (`builder.js:3610`), `normalizedWeekStart`
  anchors any date to its Monday (:3619). One weekly plan per athlete and week: `ensureWeeklySlot` (:3521) deletes an
  **empty** builder plan of the same coach and refuses anything else ("already has a weekly plan for that week").
- **Assign today — the owner's remark is confirmed, two paths:**
  1. Builder → *Assign to athlete* on a template → `POST /api/builder/plans/:id/duplicate` with `intent: "assign"`
     (`builder.js:754`, `frontend/builder-actions.js:312-446`). For a program template it creates a **specific
     program** (`plan_type = 'program'`, the athlete, `copyProgramTree`, :839-852), `status = 'active'`, notified,
     idempotent by `assignmentRequestId` in `public.builder_assignment_requests`
     (`migrations_v2/202608290900_builder_assignment_requests.sql`). This is "assigning goes into a specific program".
  2. Program Library → *Assign* → `POST /api/templates/:planId/assignments` (`backend/src/routes/templates.js:513`)
     copies nothing: it grants the athlete's user access to the template (`library.program_access`,
     `assignProgramAccess`). The athlete then finds it in the **Templates** part of their library. This is "Assign goes
     into the Templates part of the athlete".
- **Program Library list.** `GET /api/templates` (`templates.js:20`) returns program templates; only `scope` varies on
  the server, every other filter is applied in the browser (`frontend/program-library-data.js:10-17`).
- **Session guard (#702).** A published plan's session with results or a live event link is never removed or moved:
  `blockedSessionsOf(client, planId, pick, change)` (`backend/src/builderBatchEdit.js:412`) locks the chosen session
  rows `FOR UPDATE` ascending and reads results (fail-closed union) and live links; `directSessionsLocked`
  (`builder.js:2483`) is its route wrapper (`409 edit_sessions_locked`).
- **Picker.** `renderBuilderAthletePicker` / `renderCopyPlanModal` (`frontend/builder-modals.js:7`, `:58`) with
  `athlete-list-tools.js` (filter, select all).

## 2. The model: no new plan type, no migration

A **weekly program template** is an ordinary program template (`plan_type = 'program'`, `is_template = true`,
`athlete_id` null) whose blocks are all `block_type = 'template_week_day'`:

- exactly `7 × N` blocks, `block_index = block_order = (week − 1) × 7 + weekday` (weekday 1 = day 1 of the template
  week … 7), `block_name = "Week {w} - Day {d}"`;
- a template is "weekly" when it has at least one block and **every** block is `template_week_day`; anything else is a
  block template, unchanged.

Why a new `block_type` value and not `week_day`: rows with `week_day` already exist from imports with free-form names
(`"MC1 - Day 3"`); reading them as weekly would mislabel and could assign them as calendar weeks. The new value is
exact, needs no DDL (no check on `block_type`), and every existing copy path already carries it. `grouping.js` treats
it like `week_day` for the library preview (microcycle = week).

Why not a new `plan_type` or a column: both are migrations of the shape check plus every reader of `plan_type`
(views, library, athletes routes, notifications) for a feature the block marker already expresses. A column
`template_kind` would only be needed if the owner later wants weekly templates with mixed blocks — not asked.

Template days have no date; "Day 1" of week 1 lands on the chosen start date (decision 5), so the template does not
fix a weekday. The week strip labels days **Day 1 … Day 7**; the assign preview shows the real weekday and date.

## 3. HTTP contract

All under `/api/builder`, `requireAuth`, rights as today (`getEditablePlan` / `getCopySource`); a plan the caller may
not open is the same 404 as a missing one.

| Route | What |
|---|---|
| `POST /plans` `{ planType: "program", templateKind: "weekly", weeks?: 1..52, name }` | a weekly template, draft, `7 × weeks` days |
| `POST /plans/:id/weeks` `{ copyFrom?: w }` | adds a week at the end (empty, or a copy of week `w` = *Duplicate week*) |
| `POST /plans/:id/weeks/:w/move` `{ to }` | reorders weeks (renumbers `block_index` in two passes under the plan lock) |
| `DELETE /plans/:id/weeks/:w` | removes a week (never the last one) |
| `POST /plans/:id/assign-weekly` | part B, below |
| `POST /weekly-templates` `{ name, planIds: [...] }` | part C, below |

`POST /plans/:id/blocks` and `DELETE /blocks/:id` answer `400 weekly_template_weeks_only` on a weekly template, so a
template always stays whole weeks. Week routes on a non-weekly plan: `400 not_weekly_template`. Weekly templates have
no RPE or calendar links (program sessions never get them), so week routes need no session guard.

`GET /api/templates` adds per row `templateKind: "weekly" | "blocks"` and `weekCount`, and accepts `kind=weekly|blocks`
(default all). The screen filters in the browser like every other library filter (one cached list per scope).

### 3.1 Assign (part B)

`POST /plans/:templateId/assign-weekly`
`{ athleteIds: [...], startDate: "YYYY-MM-DD", assignmentRequestId: uuid, choice?: "replace" | "skip", choiceToken? }`

1. Checks before any lock: template is a weekly template the caller may copy (`getCopySource`, `can_copy` /
   `can_assign_to_athlete` as `/duplicate`'s assign); athletes exist and are active; the active workspace scope and
   every athlete inside it (`resolveWeeklyPlanOwnerScope`, `findAthleteOutsideScope`).
2. Day `k` (0-based, in week order) lands on `startDate + k`; its calendar week is that date's Monday. N weeks touch
   N calendar weeks (start on a Monday) or N + 1.
3. Transaction: `lockExerciseReuse`; the template row `FOR NO KEY UPDATE` (`lockCopyTargetPlan`, as `/duplicate`); the
   idempotency claim in `builder_assignment_requests` (payload key = template, sorted athletes, start date, choice);
   then every **existing** weekly plan of those athletes in the touched weeks `FOR UPDATE` in ascending id (the
   multi-plan order of `lockBatchPlansForUpdate`); `ensureWeeklySlot`'s rule (an empty builder plan of the same coach
   is removed and counts as free).
4. Classify each (athlete, calendar week): **free** (no plan) / **existing** (a plan with content). For an existing
   one: not editable by the caller (`getEditablePlan` on the transaction's connection) → `not_editable` (counted, not
   named beyond the athlete the coach chose); an open edit draft → `being_edited`; else the days it would touch with
   content, and — under `blockedSessionsOf` (session rows `FOR UPDATE` ascending, after all plan rows) — the sessions
   that would be removed but must stay (`has_results` / `linked_to_event`).
5. If anything is **existing** and no `choice` matches the current `choiceToken` (hash of the classification) →
   `409 weekly_assign_conflicts`, nothing written:
   `{ choiceToken, athletes: [{ athleteId, name, weeks: [{ weekStart, days: ["2026-11-24", …], kept: [{ name, day,
   reasons }], cannot?: "not_editable" | "being_edited" }] }] }`.
6. With the choice: free weeks get a **new weekly plan**; *Replace* writes the template's days into the existing plan
   (on each touched day the sessions are removed except the kept ones, then the template's sessions are added after
   them; days the template does not touch are not changed); *Skip* leaves every existing week untouched.
   `not_editable` / `being_edited` weeks are skipped in both and named in the answer.
7. Written plans: new ones `status = 'active'`, ownership snapshot from the active workspace, `builder_batch_id` shared
   per calendar week when ≥ 2 new plans; existing ones keep their status and batch id. Session content copied with
   **fresh** logical ids; RPE / Training Load switches copied as content (as every copy path). Notified with
   `notifyPlanAssignments` (active plans only), realtime after COMMIT. The request row stores the result; a retry with
   the same `assignmentRequestId` and payload replays it, another payload is `409`.
8. Answer `201 { created: [...], replaced: [...], skipped: [{ athleteId, weekStart, reason }], kept: n }`.

### 3.2 Save as template (part C)

`POST /weekly-templates { name, planIds }`: 1–52 weekly plans the caller may open (`getEditablePlan`), not edit
drafts. Ordered by `week_start`, each becomes one template week (Monday = Day 1). Only content is copied: days' notes,
sessions (name, half, phase, order, time, switches) and their node / item trees; never results, RPE, event links or
logical ids. The new template is a draft (opens in the Builder).

## 4. Parts and tiers

| Part | What | Tier |
|---|---|---|
| A | weekly template in the Builder (create, week strip, add / duplicate / move / delete week), library mark + filter | frontend + plain backend writes: `code-reviewer`, `mobile-qa`, `ux-design-reviewer` |
| B | assign from a date to many athletes, the conflict question | ★★: `db-reviewer` (transactions, no schema), `security-reviewer` (scope, names), `code-reviewer`, `ux-design-reviewer`, `mobile-qa`; *Nezavisni revizor* |
| C | save as template from chosen weeks | copy: `code-reviewer`, `security-reviewer`, `ux-design-reviewer`; *Nezavisni revizor* (trigger 3) |

Delivery: A + B in one PR if review size allows, C as its own (smaller) PR. **Migration: none.**

## 5. Owner questions (each with the default this build uses)

- **Q1 Replace scope.** *Replace* replaces only the days the template covers in that week; other days of the week stay.
  Recommended (a partial first / last week never wipes days outside the program).
- **Q2 An existing week that is a draft** (the coach's own unfinished plan): written in place and stays a draft (not
  visible to the athlete until published); the question says so. Recommended over publishing someone's unfinished
  week.
- **Q3 Old "Assign" paths.** Builder *Assign to athlete* on a weekly template goes to the new dated assign; for block
  templates nothing changes. Library *Assign* (access grant) stays for block templates; on a weekly template the
  library offers *Assign to athletes* (the dated assign) instead. Recommended: a weekly template is never granted as
  library access.
- **Q4 Kept sessions.** A kept session stays in its slot; the template's sessions of that day follow it in order. The
  question names each kept session ("Main · Tue 24.11 — has results, it stays"). Recommended.

## 6. Tests

Backend (disposable database, real routes): create / weeks add, duplicate, move, delete and the block-route refusals;
assign to 2 athletes from a Wednesday (N weeks → N + 1 calendar weeks, day k on start + k); the 409 with per-athlete
weeks; replace with a kept session (RPE, event link) and skip; not-editable and being-edited weeks; idempotent retry and
reused id with another payload; stale `choiceToken`; ownership snapshot and workspace refusal; no logical id shared
with the template; save-as-template from non-consecutive weeks (no results / links / logical ids carried). Mutations on
the kept-session check, the ascending lock and the choice token. Frontend: week strip actions, assign dialog and its
conflict question, library mark and filter; e2e of the changed screens at 1280 / 390 / 375 / 360.
