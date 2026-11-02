# Central calendar — K2b-1 plan: Settings → Calendar (types, details, places, colours)

Status: **accepted (2026-11-01).** The manager accepted the structure and the slices 1a → 1c → 1d → 1e and decided
T1–T6; the owner accepted every recommendation of Q1–Q12, recorded as **D28–D39** (section 16), and on 2026-11-02 **D40** (questions to athletes only through the Tests module) and **D41** (a team with events may
move to another club; the new club sees only the kind's word). **K2b-1a is built in
this pull request.** Written against the checked-out code at `17dc46d` (merge of PR #313, `main`; `origin/main` moved to
`656cf88` with documents only, no migration). No persistent database was touched.

- Inputs: `docs/ai/central-calendar-k0-discovery.md` (D1–D14, the K2 sketch of its section 8),
  `docs/ai/central-calendar-k2a-plan.md` (the event model of section 1, the access rule of 4.1, the lock order of 4.3,
  the seed of section 6, D18–D23 and D16b), `docs/ai/central-calendar-k2a-2-plan.md` §8, migration v49
  (`migrations_v2/202610311000_calendar_v49_events.sql`) and its runbook, the owner's decisions of 2026-11-01 relayed
  by the manager (**D24–D27**, the "meaning is frozen" rule), ADR-002, ADR-006, ADR-007 and
  `.claude/rules/metrics-core-mapping.md`.
- **Migration number.** `main` holds v49 (`202610311000_calendar_v49_events.sql`) and v50
  (`202610311200_training_load_v50_source_instance_end.sql`, the last file); the K2b-1 migration is **v51**, named
  `2026110?????_calendar_v51_settings.sql` (the exact timestamp is chosen, and the number checked again against
  `origin/main`, right before the file is written). Every choice that touches it is marked ★ (external review:
  triggers 1, 2 and 4 — section 11).
- The UI words in this plan are English, as the screen's (*Event types*, *Details*, *Places*, *Team colours*); the
  word for a library field is the reviewers' and the owner's to settle (open question Q9).

## 0. The recommendations at a glance

| # | Question | Recommendation |
|---|---|---|
| 1 | Where the club's catalog lives | the `calendar` schema, beside v49; v49's file is never edited — v51 **alters** its objects (drops K2a's read-only guard on types, adds columns, widens two CHECKs) |
| 2 | Event types (D24) | the club's admin (and the platform admin in the club's workspace) adds types beside the seven, renames, sets icon, colour, default expectations (D19) and the default details; **archives, never deletes**; `kind` stays write-once |
| 3 | The library of details | `calendar.event_fields` (+ options), owned like the types (`system` set + a copy per club); five value kinds; optional by default, required only when the admin says so (D25) |
| 4 | "The meaning is frozen" | enforced **by the database whoever writes**: once a detail has a value, its label, kind, unit, bounds and option labels never change; options may be added (and hidden); anything else is archive + a new detail |
| 5 | Athlete-filled details (D26) | **not in K2b-1, not even as definitions** — they are measurements of the athlete; since **D40** an athlete's questions are asked only through the **Tests module** (K2b-2, "Ask athletes" on an event), their parameters mapped into Metrics Core; `filled_by` holds `coach` only (section 10) |
| 6 | Places (D27) | `calendar.locations` per club (name, address, note); a team's default place; an event takes a library place **or** a one-off text (today's `location`), never both; archive, never delete |
| 7 | Team colours (D11) and type colours | a closed palette of 12 keys (the 8 of today's automatic palette first), checked by the database; a team without a choice keeps the automatic colour, never one another team chose |
| 8 | The event's details | the event carries its own ordered list (copied from the type at create, editable per event — as `expects`), and the coach's values; a required detail without a value after the event's last day makes the card *Awaiting details* |
| 9 | Audit and idempotency | the K2a pattern: `requestKey` on every write, one transaction, `calendar.lock_event_writer` reused, a request record and an append-only change log for the catalog, the bounded COMMIT |
| 10 | Slices | **K2b-1a** v51 + the Settings API ★; **K2b-1b** the events use them (place, details, values, the read) ★; **K2b-1c** the Settings → Calendar screen; **K2b-1d** the event form and panel, colours and icons on the cards |

## 1. What exists, and what K2b-1 changes

- `calendar.event_types` (v49 `:98-192`): `owner_scope` `system` / `club`, `kind` (write-once), `key`, `label` (unique
  per owner among live rows), `default_expects`, `icon_key` (null; the icon library's key), `sort_order`, `seed_key`,
  `archived_at`; seven `system` rows and a copy per active club (`calendar.seed_club_event_types`, `:849-862`, also
  called by `POST /api/organization/clubs`, `backend/src/routes/organization.js:1022`). **Every `UPDATE` is refused**
  by `event_types_k2a_read_only` (`:164-175`), "until Settings → Calendar exists".
- `calendar.events.location` is free text ≤ 120 (`:219-220`); the athlete's card carries it (D21,
  `backend/src/calendarQuery.js` `publicCard`).
- The team colour is the **index** of the team in the workspace's team list (`centralCalendarTeamIndex`,
  `frontend/central-calendar-view.js:154-162`) over eight CSS colours `--cc-team-0..7` (`frontend/styles.css:19862-19870`);
  nothing is stored.
- A type's icon on the card comes from its `kind` (`CENTRAL_CALENDAR_EVENT_KIND_ICONS`, `central-calendar-view.js:30`),
  never from `icon_key`.
- Settings has its sub-tabs in `renderSettingsNavHtml` (`frontend/navigation.js:138-168`), each offered by a client
  context check that the server repeats (*Source connections*: `sourceConnectionsAdminContext`,
  `frontend/source-connections-data.js:74-85`).

## 2. The data model (★ v51)

### 2.1 v49's objects, altered by v51 (v49's file is never edited)

| Object | Change |
|---|---|
| `calendar.event_types` | **drop** the trigger `event_types_k2a_read_only` and its function (v49's own comment names K2b as the one that drops it); **add** `color_key text null` (the palette, 2.5) and `revision integer not null default 1` (existing rows: 1; `+1` on every update, trigger); a new update guard: `kind`, owner and `seed_key` stay write-once (v49 already), `key` becomes write-once too; an **archived type is never the last live type of its owner** (refused at archive, 2.6) |
| `calendar.events` | **add** `location_id uuid null → calendar.locations on delete restrict` (+ its index); CHECK: `location_id is null or location is null` — a library place **or** a one-off text; trigger (on insert, and when `location_id` changes, the v49 rule "validated when set or changed"): the place belongs to the event owner's club (a club event: its club; a team event: its team's club; a private coach's event: none) and is live, locked `FOR SHARE` |
| `calendar.event_requests.operation`, `calendar.event_changes.kind` | the two CHECKs are dropped and added again with two more values: **`set_fields`** (the values command, 5.3) and **`align_sessions`** (the standalone alignment, T1 — K2a-1b's open point 1) |
| `calendar.seed_club_event_types(club)` | `create or replace`: the same contract (idempotent by `seed_key`), now also copying the system **details**, their options and the system types' detail lists — so `POST /clubs` needs no change and the server that still runs during the deploy seeds a new club completely |

### 2.2 New tables

**`calendar.event_fields`** — the library (one "detail").

| Column | Rule |
|---|---|
| `owner_scope`, `owner_club_id` | `system` / `club`, the v49 type shape; a club's copy goes with its club (`on delete cascade`, as the types; a detail in use is kept by the values' `restrict`) |
| `key` | `^[a-z][a-z0-9_]{1,40}$`, unique per owner, **write-once**, made by the server from the label (never shown) |
| `label` | 1–60 (`source_metric_text_ok`), unique per owner among live rows (`lower`) |
| `description` | null or 1–200, one line — a hint for the coach ("Pitch the session was on") |
| `filled_by` | `coach` only in K2b-1 (CHECK); write-once (section 10) |
| `value_kind` | `choice`, `number`, `scale_1_5`, `yes_no`, `short_text`; **write-once** |
| `unit` | `number` only: null or a unit token (`source_metric_unit_token_ok`); else null (CHECK) |
| `min_value`, `max_value` | `number` only: null or `numeric`, `min ≤ max` (CHECK) |
| `required` | boolean, default **false** (D25); editable at any time |
| `sort_order`, `seed_key`, `archived_at` / `archived_by_user_id`, `created_by_user_id` (null for seeds), `revision`, timestamps | as the types |

**`calendar.event_field_options`** — the choices of a `choice` detail: `field_id → event_fields`, `label` 1–40 unique per
field among live options, `sort_order`, `seed_key`, `archived_at`, `created_at`. At most 20 live options; a `choice`
detail needs at least 2 at create. An option row is never deleted.

**`calendar.event_type_fields`** — a type's **default** details, ordered: `(event_type_id, field_id, position)`,
`unique (event_type_id, field_id)`; trigger: the detail has the type's owner and is live when added. Replaced as a
whole inside the type's command (the targets' pattern). At most 20 per type.

**`calendar.event_selected_fields`** — **one event's** details, ordered: `(event_id, field_id, position)`,
`unique (event_id, field_id)`; trigger: the event is planned; the detail is live when added and belongs to the
event's types' owner (a club / team event: the club's details; a private coach's event: the `system` set). Copied
from the type's live defaults at create when the body names none (as `expects`), replaced as a whole by `PATCH`. At
most 30.

**`calendar.event_field_values`** — the coach's values: `(event_id, field_id)` unique; `option_id → event_field_options`
/ `number_value numeric` / `scale_value smallint 1..5` / `bool_value` / `text_value` (1–200, one line) — at most one
set, and the one that matches the detail's kind (trigger); all null = cleared. Rules, whoever writes: the event is
planned; the detail is in the event's selection when the value is written; a number within the detail's bounds; an
option of this detail and live when set or changed; **a value row is never deleted** (a clear sets the columns to
null). `updated_by_user_id`, timestamps. A value whose detail was later taken off the event stays (hidden, and
back if the detail is chosen again) — taking a detail off never loses a value.

**`calendar.locations`** — a club's places: `owner_club_id → public.clubs` (not null), `name` 1–80 unique per club
among live rows, `address` null or 1–200 (one line), `note` null or 1–500 (multi-line: entrance, parking, changing
room), `archived_at` / `_by`, `created_by_user_id`, `revision`, timestamps. Never deleted (trigger).

**`calendar.team_settings`** — one row per team, created on its first write: `team_id → public.teams` (primary key),
`color_key` (null = automatic), `default_location_id → calendar.locations` (null), `revision`, `updated_by_user_id`,
`updated_at`. Trigger: the default place is of the team's club and live when set or changed. Never deleted.

**`calendar.settings_requests`** and **`calendar.settings_changes`** — the catalog's request record and change log,
the v49 pair (`:647-738`) for subjects that are not events: a request `(request_key, request_hash, operation,
performed_by_user_id, club_id, result)`, `unique (performed_by_user_id, request_key)`, append-only; a change
`(request_id, subject_kind type / field / location / team, subject_id, revision, kind, basis platform_admin /
club_admin, performed_by_user_id, performed_at, details)` — flat `details` (`calendar.details_ok`), ids and the
before / after of scalars, **never a label, an address, a note or a text value**. One request may write several
changes (a re-order of the types); a request needs at least one change at COMMIT (deferred), as in v49.

### 2.3 The "meaning is frozen" rule (the owner's rule) — whoever writes

A detail **has values** when a row of `event_field_values` names it (a cleared one included — once answered, always
answered: fail-closed, and nothing can be "un-answered" to re-open the meaning). Then the database refuses, on
`event_fields`: a change of `label`, `unit`, `min_value`, `max_value` (`value_kind`, `filled_by`, `key` are write-once
anyway); on `event_field_options`: a change of an existing option's `label`. Still allowed: `required`, `description`,
`sort_order`, adding an option, hiding an option (`archived_at`; recommended, Q3 — old values keep showing its label),
archiving or restoring the detail. The service answers `409 field_answered` with the current detail.

The race (trigger 4): the value writer's trigger takes the detail's row `FOR SHARE`; the detail's editor takes it `FOR
UPDATE`, and its trigger checks `exists (value)` with a fresh snapshot (a volatile PL/pgSQL statement under READ
COMMITTED) — so a value committed while the editor waited is seen, and a value written after the edit is checked
against the new definition. A test holds each side.

### 2.4 Audit pairing, whoever writes

- `event_types`, `event_fields`, `locations`, `team_settings`: every update bumps `revision` by exactly one, and at
  COMMIT a `settings_changes` row names the subject at that revision (deferred) — the v49 `events_need_change` rule.
- Child rows (`event_field_options`, `event_type_fields`): a write needs, at COMMIT, its **parent written in the same
  transaction** (`xmin = pg_current_xact_id()::xid` on the parent row) — the parent's revision rule then requires its
  change row, so the child is audited through it.
- A **seed-shaped insert** (`seed_key` set, `created_by_user_id` null) needs no change row: the migration and
  `seed_club_event_types` write them (the v49 seed had none either). Any later update needs its change. Known limit,
  recorded in the runbook: a raw insert made in the seed's shape passes without a change row (no route writes one).
- Event-side rows (`event_selected_fields`, `event_field_values`, `events.location_id`) are event writes: the event's
  revision is bumped and v49's `events_need_change` already requires its change row.

### 2.5 The colour palette

Twelve keys, the first eight equal to today's automatic colours so nothing moves on screen: `teal` (#1f6f68), `rust`
(#b5542b), `indigo` (#4a5fc1), `plum` (#8a4c8f), `green` (#2f7d3a), `amber` (#b07a0a), `rose` (#c23a6b), `sky`
(#3b7f9c), plus `slate`, `olive`, `coral`, `violet` (values chosen with the contrast check of the light and dark themes,
`mobile-qa` / `ux-design-reviewer`). The database checks `calendar.color_key_ok(key)` (a closed list in an immutable
function; a new colour is a later migration's `create or replace`); the server's list and the frontend's are proven
equal by a test (the `iconKeys.js` pattern). Not a free hex: a stored hex cannot follow the dark theme and can be
unreadable. **Auto colour:** a team without a choice takes, in the workspace's team order, the first palette colour no
other team of the list chose — two teams never share a colour unless more than twelve are shown.

### 2.6 Archive, restore, delete

Nothing of the catalog is deleted by an application route (the change log's foreign keys keep it anyway): a type,
detail, option or place in use or not is **archived** (it leaves every picker, stays on the events that have it) and
can be **restored** (the live-label unique index refuses a restore whose label is taken again: `409 label_taken`). A
type cannot be archived when it is its owner's last live type (`409 last_type`). An archived detail stays in the type
lists (it is filtered out of the defaults on read and comes back on restore) and on the events that chose it (their
values can still be entered); an archived place stays on its events and as a team's default it no longer applies (the
read treats it as none). No cascade write: archiving changes one row.

## 3. The seed (★ v51; Q5 for the owner)

`system` details, copied per active club by v51 and for every new club by `seed_club_event_types` (2.1); club copies
of the seven types get the same lists. Seed keys make it idempotent; labels are English as the rest of the screen.

| Detail | Kind | Options / unit | On types |
|---|---|---|---|
| Weather | choice | Sunny, Cloudy, Rain, Snow, Windy | Training, Match |
| Temperature | number | °C, −40 to 50 | Training, Match |
| Surface | choice | Natural grass, Artificial grass, Indoor court, Track, Gym | Training, Match |
| Opponent | short text | — | Match |
| Home or away | choice | Home, Away, Neutral | Match |
| Our score | number | none, 0 to 999 | Match |
| Their score | number | none, 0 to 999 | Match |
| Travel time | number | min, 0 to 2880 | Travel |
| Transport | choice | Bus, Car, Plane, Train | Travel |
| Travel difficulty | scale 1–5 | — | Travel |

None is required (D25). **D23 through details:** the match fields (opponent, home / away, result) become seeded
details of the Match type, so no `is_match` column is needed — the owner confirms (Q5). The seed also sets the types'
`icon_key` to today's kind icons (training `run`, match `trophy`, test `clipboard`, travel `route`, meeting `team`,
day off `bed`, camp `mountain` — all in `backend/src/iconKeys.js`) and leaves `color_key` null. No place is seeded. A
fail-closed self-check at the end of v51 counts every seeded row (system and per club), as v49's.

## 4. Who may do what (D24, D27, ADR-002, ADR-006)

| Active workspace | Settings → Calendar (read the whole catalog, write it) | The event form's lists (types, details, places, team defaults) | Values of an event's details |
|---|---|---|---|
| club C — club admin of C | yes, basis `club_admin` | C's live set | events the account manages (K2a 4.1: C's and its teams', D18) |
| club C — platform admin (support, D24) | yes — but a club workspace is offered only for a club the account administers (`loadAvailableWorkspaces`, `backend/src/workspace.js:37-66`), so a platform admin there also holds C's `club_admin` role and writes on that basis (`eventWriteBasis` prefers it); the `platform_admin` basis is never reached through a club workspace (T6) | C's live set | the same |
| team T — team coach | no (`403`; the tab is not offered) | T's club's live set; T's default place | T's own events |
| private coach | no | the `system` types and details (read-only); **no places** (one-off text only, Q6) | own events |
| platform | no writes: `403 workspace_required` ("Open the club's workspace…", the events' answer); no read | — | support, as every event write (K2a-1b open point 9) |
| athlete, none | `403` | `403` | — |

- Every route resolves the workspace once (`resolveCalendarContext`) and threads it; the write basis is decided as
  `eventWriteBasis` decides a club-owned event's (`backend/src/calendarEventAccess.js`) and re-checked by
  `calendar.lock_event_writer(user, 'club', club, basis)` (catalog) or `(user, 'team', team, basis)` (a team's colour or
  default place) inside the transaction — the v49 function, unchanged; an archived club writes nothing (the one 404).
- **The identical 404** (`{error: "notFound", message: "Not found."}`, `no-store`) for an id in the path that is missing,
  of another club, of the `system` set (read-only), archived-club, or reached from the wrong workspace (an admin of two
  clubs in the other club's workspace). **The identical 400** for an id in a body (`field_not_available`,
  `location_not_available`, `type_not_available`): missing, foreign, archived and system-owned look the same.
- The `system` catalog is read-only through the API in K2b-1 (changes go by migration); Q8.

## 5. The API

### 5.1 Settings — a new router `backend/src/routes/calendarSettings.js` at `/api/calendar/settings`

Mounted with `requireAuth` before `/api/calendar` (as the events router, `backend/src/server.js:126-137`); service
`backend/src/calendarSettingsService.js`. Every write: `requestKey`, one transaction, stable codes, never SQL text.

| Route | Body | Notes |
|---|---|---|
| `GET /` | — | the active club's whole catalog: types (live and archived, each with `revision`, icon, colour, default expects, detail ids, `seeded`), details (with options, `answered`, `eventCount`), places, the club's active teams with `colorKey`, `defaultLocationId`, `revision` (0 when no row yet) |
| `POST /types` | `requestKey, label, kind, iconKey?, colorKey?, defaultExpects, fieldIds` | the key made from the label |
| `PATCH /types/:id` | `requestKey, expectedRevision, label?, iconKey?, colorKey?, defaultExpects?, fieldIds?` | `409 type_changed {current}` on a stale revision |
| `POST /types/:id/archive`, `/restore` | `requestKey, expectedRevision` | `409 last_type`, `label_taken` |
| `POST /types/order` | `requestKey, typeIds` (every live type once) | one change row per type whose position moved |
| `POST /fields` | `requestKey, label, valueKind, description?, unit?, minValue?, maxValue?, options?: [label], required` | |
| `PATCH /fields/:id` | `requestKey, expectedRevision, label?, description?, unit?, minValue?, maxValue?, required?, options?: {add: [label], rename: [{id, label}], hide: [id], show: [id]}` | `409 field_answered` for a frozen part (2.3), with what is frozen |
| `POST /fields/:id/archive`, `/restore` | `requestKey, expectedRevision` | |
| `POST /locations`, `PATCH /locations/:id`, `…/archive`, `…/restore` | `name, address?, note?` (+ `expectedRevision`) | an address correction shows on every event of that place (Q7) |
| `PUT /teams/:teamId` | `requestKey, expectedRevision (0 = no row yet), colorKey?, defaultLocationId?` | a team of the active club, active; else the one 404 |

The request hash binds the canonical body to the club and the subject (the K2a rule): a key reused on another subject
or in another club's workspace is `409 request_key_reused`, never another answer; a replay re-reads the current view
and re-checks the right first (`backend-security.md`, "idempotent retry paths re-evaluate authorization").

### 5.2 The event form's lists

`GET /api/calendar/events/types` keeps its `types` and adds, **additively** (one request for the form, as today):
each type's `colorKey`, `iconKey` and `defaultFieldIds` (live ones); `fields` (the live details the workspace's events
may use, with live options, `required`, `unit`, bounds); `locations` (the club's live places; `[]` for a private
coach); `teamDefaults` (`{teamId: locationId}` of the workspace's teams, only live places). The same 403 / 404 as today.

### 5.3 The event commands (★ K2b-1b)

- `POST /api/calendar/events` and `PATCH /:id` take `locationId` (`null` to clear) beside `location`, both never set
  (`400 invalid_location`), and `fieldIds` (ordered, ≤ 30; absent at create → the type's live defaults). The change
  row's details: `locationId` before / after, `locationTextChanged`, `fieldIdsBefore` / `After`.
- **`POST /api/calendar/events/:id/fields`** `{requestKey, expectedRevision, values: [{fieldId, value}]}` — `value` by
  kind (an option id, a number, 1–5, true / false, text; `null` clears). A K2a command (the writer lock, the event
  `FOR UPDATE`, the replay, the details `FOR SHARE` in ascending id, the values, the revision bump, the request and
  change rows with kind `set_fields` — details `fieldIds`, `cleared`, never a value — the bounded COMMIT). Refusals:
  `400 field_not_available` (not selected on the event, or foreign — one answer), `400 invalid_value`
  (`{fieldId}`), `409 event_changed` / `event_cancelled`. Who: the event's managers (the `canManage` of K2a 4.1).

### 5.4 The calendar read

- `teams[]` of `GET /api/calendar` gains `colorKey` (coach workspaces; `loadWorkspaceTeams`,
  `backend/src/calendarAccess.js:252-266`, one more left join).
- An event item gains `place` (`{source: "library", locationId, name, address, note}` or `{source: "one_off", text}`
  or `null`), keeps `location` (the name or the text — the K2a-2 screen keeps working until K2b-1d), and
  `eventTypeIconKey`, `eventTypeColorKey`. A **manager's** card also gains `details: {selected, filled, required,
  filledRequired}`; the panel's `GET /:id` gains `fields` (each selected detail with its definition and value).
- **Status (Q4):** after the event's last day, a selected **required** detail without a value adds an unmet check to
  `deriveEventStatus` (`backend/src/calendarQuery.js:605-640`) — the card reads *Awaiting details* (a coach can always
  answer, so the K2a principle "never awaiting what nobody can answer" holds); optional details never change the
  status, the panel shows "2 of 3 details filled". The reduced view of another coach shows the details read-only.
- The statement count stays independent of the number of items: the place is a join of the events statement, the
  details one statement when the window holds an event and `event` is asked for.

## 6. Lock order, idempotency, the COMMIT (trigger 4)

```
Settings command (catalog):    lock_event_writer(user, 'club', C, basis)        club → role → user, FOR SHARE
Settings command (a team):     lock_event_writer(user, 'team', T, basis)        team → club → role → user
then:                          the subject row FOR UPDATE (type / detail / place / team_settings; a first
                               team_settings row is inserted — a concurrent first insert → 409 team_changed)
                               lock_timeout 15 s → 409 try_again
                               the requestKey replay (after the locks, so the caller is authorized again)
                               referenced rows FOR SHARE in ascending id (a type's details; a team's place)
                               checks → writes → the request row → its change rows → the bounded COMMIT
Event command (K2a, extended): lock_event_writer → the event FOR UPDATE → replay → (links as K2a-1b) →
                               the place FOR SHARE → the details FOR SHARE ascending → writes → request → change
```

No cycle: a holder of a detail's or a place's `FOR UPDATE` (their own editor) waits on nothing after it; every other
command takes them `FOR SHARE`, after its own subject. The bounded COMMIT, the replay after the locks, the same-key
race and `verifiedAfterCommitError` / `503 outcome_unknown` were K2a's `runEventCommand`; they are now one shared runner,
`runCalendarCommand` in `backend/src/calendarCommandRunner.js`, that both services use (no second copy of it). A second
request with the same key waits on a transaction-scoped advisory lock of (table, user, key) taken right after the
caller's locks, then replays the first one's saved answer (17). `55P03` / `40P01` → `409
try_again`; a live-label unique violation → `409 label_taken`.

## 7. The event form, the panel and the card (K2b-1d)

- **Place:** two choices, *From the club's places* (a picker of live places, each with its address underneath) and
  *Another place* (the one-off text). A new team event, or a club event that targets exactly one team, pre-selects
  that team's default place until the coach touches the field. A private coach sees the text only.
- **Details to fill in after the event:** the type's defaults pre-chosen and re-chosen on a type change until the
  coach touched them (the D19 behaviour of `expects`, `frontend/central-calendar-event-form.js`); *Add a detail* from the
  library; remove; each with its kind and *required* mark. The form says once that RPE, GPS and test results are
  under *What is expected* and the details are filled in by a coach.
- **The panel:** *Details* with each value, *Enter details* for a manager (one small form, inputs by kind, a lost
  answer is *Result not confirmed* · *Check result* with the same `requestKey`, the K2a-2 pattern), the place with
  its address and note and **Open in maps**.
- **Open in maps:** a link built in the browser from the address alone
  (`https://www.google.com/maps/search/?api=1&query=<encodeURIComponent(address)>`, `rel="noopener noreferrer"`,
  a new tab); no server sends an address anywhere; no link without an address.
- **The card:** the type's own icon (`icon_key`, else the kind's) tinted with the type's colour; the stripe stays the
  team's colour (the chosen one, else the automatic one of 2.5); *Awaiting details*.

## 8. Settings → Calendar (K2b-1c)

A **Calendar** sub-tab in `renderSettingsNavHtml`, offered by a client context like *Source connections* (a club
workspace and the club's admin, or a platform admin in a club workspace); the server decides again. Four sections:

- **Event types:** the list in its order (*Move up* / *Move down*), each with icon, colour dot, label, base kind and
  "used by N events"; *Add a type* (label, base kind — fixed afterwards, icon through the shared icon picker
  `frontend/icon-picker.js`, colour swatches, *Expected after it* RPE / GPS / test result, the default details with add /
  remove / order); *Edit*; *Archive* / *Restore*; archived ones folded under *Show archived*.
- **Details** (the library): label, kind, unit, *Required* with D25's sentence ("Optional details only remind the
  coach; a required one makes the event wait until it is filled"), options; a detail with values says so and offers
  only what 2.3 allows ("This detail already has answers: its meaning can't change. Add options, or archive it and
  create a new one."); *Filled by: coach* is shown, with one line that athlete questions come with the RPE request.
- **Places:** name, address, note; *Open in maps* as a preview; archive / restore.
- **Team colours and default places:** each active team with the colour swatches (*Automatic* first) and a default
  place picker.

Every write is the K2a-2 discipline: the form locked while in flight, *Result not confirmed* · *Check result* with the
same key, `type_changed` / `field_changed` / … reload the item with their sentence, the leave guard on a section
switch with unsaved values. Phones: 360 / 375 / 390 px, every control 44 px, every input 16 px.

## 9. What the athlete sees (D21, D27)

- `GET /api/calendar` (athlete workspace): the event card's allowlist gains **`place`** (a library place's name,
  address and note, or the one-off text) and the type's `eventTypeIconKey` / `eventTypeColorKey`; never a detail or a
  value, a team default, another place, a count or a teammate. The allowlist test is updated key by key.
- **The screen (Q1):** the athlete has no calendar screen today (K2a plan section 5); the owner's *Open in maps* for
  athletes needs the *Upcoming events* list on Athlete Home that D21 put in K2b. Recommended as a small slice of its
  own (K2b-1e: the next 14 days through `GET /api/calendar`, name, type, day, time, place, note, *Open in maps*).

## 10. Why no athlete-filled details in K2b-1 (D26)

- An athlete's answer per event is a **measurement of the athlete** (sleep, soreness, a match rating): by ADR-007 and
  `.claude/rules/metrics-core-mapping.md` the only registry of such variables is Metrics Core, and "a new table of
  variables or parameters for Training Load needs a new owner decision first". A `filled_by = athlete` row in
  `calendar.event_fields` would be exactly that parallel registry, and K2b-2 would have to migrate or map it.
- A definition without collection misleads: a coach would add *Sleep quality* to an event and wait for answers that
  nothing asks for (the K2a principle: never expect what nobody can answer).
- So K2b-1 builds only coach details; `filled_by` exists with the one value `coach` and is shown on the screen.
  **Superseded by D40 (2026-11-02):** questions to athletes go only through the **Tests module** (a questionnaire is a
  test; its `test_parameters` — numeric, integer, boolean, ordinal, text, `athlete_self` — the schedules and the
  reminders exist). **K2b-2 is "Ask athletes" on an event:** choose a questionnaire from the Tests library and, in one
  click, schedule that test for the event's athletes on that day with a window after it; the notifications are Tests';
  the results live in Tests and show on the event's card; and the Tests parameters are **mapped into Metrics Core** so the
  answers reach the Training Load dashboards (no new registry, the metrics flow of
  `.claude/rules/metrics-core-mapping.md`). The calendar's `filled_by` therefore stays `coach`; the earlier idea of
  athlete fields through the RPE channel as new variables (D26's first reading) is dropped. The split: coach fields =
  Details in the calendar (K2b-1); RPE = Training Load; every other question to athletes = Tests (+ the mapping).
- The coach's details are **event context**, not athlete metrics (weather, surface, opponent, score): they stay in the
  calendar and never reach Training Load or a dashboard in K2b-1. The owner confirms the boundary (Q2).

## 11. Slices, reviewers, external review

| Slice | Content | Reviewers | External review |
|---|---|---|---|
| **K2b-1a** ★ | v51 (every object of section 2, the seed of section 3, the guards, the self-check) with its rollback and the read-only preflight / post-check in `docs/runbooks/calendar-settings-v51*.{md,sql}`; the settings router and service; the shared command runner; the additive `GET /events/types`; `teams[].colorKey` | `db-reviewer` + `security-reviewer` + `code-reviewer` | **yes**: triggers 1, 2, 4 |
| **K2b-1b** ★ | the events use them: `locationId`, `fieldIds`, the values command, the read (place, details, status), the athlete's allowlist | `security-reviewer` + `code-reviewer` (+ `db-reviewer` only if a trigger changes) | **yes**: triggers 2, 4 |
| **K2b-1c** | the Settings → Calendar screen | `code-reviewer` + `mobile-qa` + `ux-design-reviewer`; browser QA at 1280 / 390 / 375 / 360 px | no |
| **K2b-1d** | the event form, panel and cards (section 7) | the same three; browser QA | no |
| (K2b-1e) | the athlete's *Upcoming events* (Q1) | the same three | no |

One migration for 1a and 1b (the K2a precedent: v49 held the link tables before their routes); 1c can be built on
1a's API while 1b is reviewed. Each PR stops before merge; 1a and 1b go to the owner's external review through the
manager with the full packet (`CLAUDE.md`, "Agent input contract").

## 12. Tests and mutations

All on disposable `optimove_tests_*` databases through the real routes (`node scripts/test-runner.mjs --project
backend --kind disposable --file …`); v51 appended to `GPEXE_TEST_MIGRATIONS` (`backend/tests/_gpexe-disposable-db.mjs:75-76`).
New suites `central-calendar-k2b-settings.test.mjs` (1a) and `central-calendar-k2b-event-details.test.mjs` (1b); the
K2a suites run as regression (`central-calendar-k2a-events`, `-k2a-1b`, `-k1a`), with the backend fast preset.

**Black-box scenarios by role** (each through every settings route and the event commands; expected answers fixed in
the test, bodies compared byte for byte):

| Who | Expected |
|---|---|
| club admin of C, workspace C | reads and writes C's catalog; C's team colours and defaults; fills details of C's and its teams' events |
| admin of C1 and C2, workspace C1 | every C2 id in a path → the identical 404 (= a random id); in a body → the identical 400; a C1 key reused in C2's workspace → `409 request_key_reused`; `GET /settings` lists C1 only |
| team coach of T (club C) | `GET /settings` and every settings write → 403 / the 404; the form's lists = C's live set + T's default; a place of another club in `locationId` → the 400; fills T's events only, a club event's details → the 404 |
| private coach | settings → 403; the form: system types and details, `locations: []`; `locationId` → the 400; a system detail on own event works; a club's detail → the 400 |
| athlete | every settings route 403 / 404; the calendar card holds `place` and nothing of the details (allowlist test); another club's event never appears |
| platform admin, platform workspace | settings writes `403 workspace_required`; reads 403 |
| platform admin who also administers C, club workspace | as the club admin, basis `club_admin` (T6) |
| stranger (a coach of another club; a revoked admin) | the 404 / 403 everywhere; a role revoked between the route's check and the lock → the 404 body (the K2a seam) |
| archived club / archived team | every write the 404; an archived team's colour route the 404 |

**Invariants**, each a test: the read's `canEdit` / `canManage` equals the write verdict for every caller; the meaning
freeze holds through a raw SQL `UPDATE` (not only the route); a type's list and an event's selection hold only the
owner's details (raw insert refused); a place on an event is of the owner's club (raw insert refused); an archived
detail / place / type is refused when **newly** chosen and kept where it is; a value never lands on an unselected
detail or a cancelled event; no row of the catalog or a value is deleted (raw `DELETE` refused); every catalog update
has its change row at COMMIT (a raw update without one cannot commit); a seeded insert needs none, a seeded update does;
`requestKey` replays exactly once and binds club and subject; the athlete's allowlist; the statement count for 1 and
12 events; "a wide range is the union of its days" unchanged with places and details.

**Migration:** apply → objects, the seed exactly (counts per club), every trigger enabled → rollback → the v50 catalog
digest identical → re-apply; every rollback refusal; preflight and post-check blocks against their expected values.

**Concurrency:** a value racing a detail's edit (each side held, both orders); a type archive racing an event create; a
place archive racing an event that sets it; two first `PUT /teams/:id`; two edits of one type (`type_changed`); the
lost-COMMIT seam (`verifiedAfterCommitError`, `outcome_unknown`).

**Mutations** (each killed by a named test): the freeze trigger's label / option / bounds checks removed; the owner
match of `event_type_fields` and `event_selected_fields`; the place's club check; `team_coach` let into a settings
write; the request hash without the club; the replay before the locks; the athlete's allowlist widened with `fields`;
an archived detail accepted as new; the required-detail status check; the `FOR SHARE` on the detail in the value
trigger (the race test); `color_key_ok` emptied; the seed function without the details (a new club's copies).

Frontend (1c, 1d): through the real handlers with the fetch mock — the bodies, `requestKey` reuse on *Check result*, no
control without `canEdit` / `canManage`, the frozen detail's form, the place picker and its default, *Open in maps*
built from the address only (and absent without one), the auto-colour rule, no `data-tab` attribute, inputs ≥ 16 px.

## 13. Rollback, preflight, post-check (★)

- **Rollback** `docs/runbooks/calendar-settings-v51-rollback.sql`, on an explicit owner order only; refuses (nothing
  dropped) while the migrator holds its lock, when v51 is not recorded, when a later migration is recorded, and when
  any data depends on v51: a settings request or change, a club-made type / detail / option / place, a
  `team_settings` row, a value, a selection, an event with `location_id`, a request or change of kind `set_fields` or
  `align_sessions`, a
  type whose `revision > 1` or whose `color_key` / `icon_key` differ from v51's seed. It then locks the tables in the
  writers' order, drops v51's tables, columns and functions, restores v49's two CHECKs, its `seed_club_event_types`
  body and its read-only trigger verbatim, puts `icon_key` back to null, and deletes v51's record. Rehearsed in the
  suite: apply → rollback → the v50 catalog digest identical → re-apply.
- **Preflight** (`…-preflight.sql`, plain SELECTs run one block at a time, no transaction and nothing written): PostgreSQL version; v50 the last
  migration with its checksum, v51 absent; the `calendar` objects as v49 left them; the type rows exactly the v49 seed
  (no edit possible before v51); the active clubs (the seed's expected counts); no lock or idle transaction on the
  `calendar` tables.
- **Post-check** (`…-postcheck.sql`, SELECT only): v51 recorded once with its checksum and last; the objects; every
  trigger enabled; the seed counts per club; no non-seed row.

## 14. Risks and what K2b-1 leaves out

- **Risks:** an address correction shows on past events too (Q7); a catalog that only grows (archive, never delete;
  *Show archived* keeps the lists short); the seven seeded types' new icons change what a club sees on day one (the same
  icons as today, so nothing visible moves); a coach in a team
  workspace cannot edit the club's catalog by design (D24); the colours are one palette for light and dark.
- **Out of K2b-1:** questions to athletes (K2b-2 through the Tests module and its mapping into Metrics Core, D40), notifications of a change of place or time, a
  private coach's own places and details (Q6), groups of athletes (Q-C), absence reasons (D10), recurring events and
  copying, a club's edit of the `system` set, analytics over the details, the K2c roster rule, external schedules.

## 15. Open questions

**For the owner** (each with a recommendation):

1. **The athlete's screen** — build *Upcoming events* on Athlete Home (14 days, place, note, *Open in maps*) as K2b-1e
   now (recommended: the owner asked for the athlete's maps button, and today the athlete sees no event anywhere), or
   with K2b-2.
2. **The boundary of D26** — coach details are event context kept in the calendar; anything an athlete answers is a
   Metrics Core variable collected in K2b-2; no `filled_by = athlete` row in K2b-1 (recommended, section 10). *Answered:
   D29, then refined by D40 — the questions go through the Tests module.*
3. **Hiding an option of an answered detail** — allowed (recommended: old answers keep their label, new events cannot
   choose it), or never.
4. **Required details and the status** — a required detail left empty after the event makes the card *Awaiting details*
   (recommended); optional ones only show "n of m filled" in the panel. Also: no reminder notification in K2b-1.
5. **The seed** — the table of section 3, with D23's match fields as seeded details of *Match* (opponent, home / away,
   our score, their score) instead of an `is_match` flag (recommended); or a shorter list.
6. **A private coach's places and details** — none in K2b-1 (recommended: one-off text, system details); a library of
   their own later.
7. **An address correction** — the event shows the place as it is now, past events included (recommended: simple; a
   venue that moved is a new place); or past events keep the old address (a snapshot column).
8. **The `system` set** — read-only through the API, changed by migration (recommended); or editable by the platform
   admin from the platform workspace.
9. **The word** for a library field on the screen — *Details* (recommended: "Details to fill in after the event"); or
   *Fields*, *Questions*.
10. **Archive, never delete** for types, details and places, even unused ones (recommended: one rule, the audit kept);
    D4's "can be deleted" for an unused type would need a delete path the audit's foreign keys refuse.
11. **Colours** — a palette of 12 (recommended), or free colours.
12. **Who fills the details** — the event's managers only (recommended: a team coach fills the team's events, the club's
    admin the club's); or also a team coach on a club event that targets the team.

**For the manager** (technical) — **decided on 2026-11-01, all as recommended:**

- T1. **Yes:** v51 adds `align_sessions` to the two v49 CHECKs (`event_requests.operation`, `event_changes.kind`), and
  the standalone alignment (`POST /api/calendar/events/:id/sessions/align`) is audited with that kind instead of
  `update` + `details.align` — K2a-1b's open point 1 is closed in 1a, with its code and its tests
  (`central-calendar-k2a-1b.test.mjs`) changed in the same pull request; the attach's own alignment stays
  `attach_sessions` with `details.aligned`.
- T2. **Yes:** the additive `GET /events/types` (one request for the form), no new read route for the form.
- T3. **Yes:** one shared command runner extracted from `runEventCommand` for both services (no second copy of the
  bounded COMMIT); the K2a suites (`central-calendar-k2a-events`, `-k2a-1b`, `-k1a`) run as regression in 1a.
- T4. **Yes:** K2a-1b's open point 2 (a raw link write without a revision bump) stays open, not in v51.
- T5. **Yes:** 1a → 1c on 1a's API while 1b is reviewed → 1d → (1e).

**Found while building the test skeleton (2026-11-01); decided by the manager the same day:**

- T6. A platform admin reaches a club's workspace only through a `club_admin` role of that club
  (`loadAvailableWorkspaces`, `backend/src/workspace.js:37-66`; the skeleton's test 0a saw the fallback to the platform
  workspace without it), and `eventWriteBasis` then answers `club_admin` first — so D24's "platform admin from the club's
  workspace as support" is, today, a platform admin who is also the club's admin, audited as `club_admin`. **Decided:
  K2b-1 keeps it so** — a club workspace belongs to whoever holds that club's `club_admin` role, and a platform admin
  writes there on the `club_admin` basis; no new path. Choosing a club from the platform workspace (the *Source
  connections* pattern, `sourceConnectionsAdminContext`, `frontend/source-connections-data.js:74-85`, which would add a
  club id to every settings request and its own access tests) is a later addition, only if the owner asks for it.

## 16. Decisions (2026-11-01)

The owner accepted every recommendation of section 15 (relayed by the manager the same day); the manager decided T1–T6
(section 15). Recorded as decisions:

| | Question | Decision |
|---|---|---|
| **D28** | Q1 | The athlete's *Upcoming events* on Athlete Home (14 days, name, type, day, time, place with its address and note, *Open in maps*) is built now, as the fifth slice **K2b-1e**. |
| **D29** | Q2 | No athlete-filled details in K2b-1, not even as definitions: the coach's details are event context kept in the calendar; anything an athlete answers is a Metrics Core variable collected in K2b-2 (section 10). `filled_by` holds `coach` only. *How K2b-2 collects them: D40.* |
| **D30** | Q3 | An option of a detail that already has answers may be hidden: old answers keep its label, new events cannot choose it; it may be shown again. |
| **D31** | Q4 | A required detail left empty after the event's last day makes the card *Awaiting details*; optional details only show "n of m filled" in the panel. No reminder notification in K2b-1. |
| **D32** | Q5 | The seed of section 3, with D23's match fields as seeded details of the *Match* type (opponent, home or away, our score, their score); no `is_match` column. |
| **D33** | Q6 | A private coach has no places and no details of their own in K2b-1: a one-off place text, the `system` details. |
| **D34** | Q7 | An event shows its library place as it is now, past events included; a venue that moved is a new place. |
| **D35** | Q8 | The `system` set (types, details, options) is read-only through the API; it changes by migration. |
| **D36** | Q9 | The screen's word for a library field is **Details** ("Details to fill in after the event"). |
| **D37** | Q10 | Types, details, options and places are archived, never deleted — used or not. |
| **D38** | Q11 | Colours come from the closed palette of 12 (section 2.5). |
| **D39** | Q12 | A detail's value is filled in only by the event's managers (the `canManage` of K2a 4.1). |
| **D40** | (2026-11-02, the owner through the manager) | Questions to athletes go **only through the Tests module** (a questionnaire is a test; `test_parameters` numeric / integer / boolean / ordinal / text, `athlete_self`, its schedules and reminders). **K2b-2 = "Ask athletes"** on an event: a questionnaire from the Tests library, scheduled in one click for the event's athletes on its day with a window after it; Tests' notifications; the results in Tests and on the event's card; plus the **mapping of Tests parameters into Metrics Core** so the answers reach the Training Load dashboards (no new registry; `.claude/rules/metrics-core-mapping.md`). Replaces the earlier idea of athlete fields through the RPE channel as new variables. The split: coach fields = Details (K2b-1); RPE = Training Load; other questions to athletes = Tests (+ the mapping). |
| **D41** | (2026-11-02, the owner through the manager) | A team that has calendar events **may** move to another club (`PUT /api/organization/teams/:id`); its events go with it. The new club sees only the kind's word — never the old club's type label or id, place or details — and its admin chooses the club's own. Answers the open question of section 17. |
| **D43** | (2026-11-02, the owner through the manager) | Teams do **not** move between clubs: a team's club is fixed after creation. Athletes still move from team to team and club to club through their memberships. Supersedes D41's premise and suspends D42 (section 19). |
| **D44** | (2026-11-02, the owner through the manager) | A club may stop a team one season and bring it back the next: a club's admin (or a platform admin, never the team's coach) restores an archived team; a name taken in the club, an archived team's included, is a clear refusal that offers the archived team for restoring (section 19). |

## 17. K2b-1a as built (2026-11-01)

On the manager's GO of 2026-11-01 (D28–D39, T1–T6). Migration **v51**
(`migrations_v2/202611011900_calendar_v51_settings.sql`; runbook `docs/runbooks/calendar-settings-v51.md` with its
preflight, post-check and rollback SQL) and the Settings API; no frontend change.

- **The schema** is section 2's, with three refinements found while building it:
  - a type's list and an event's selection are rewritten by difference (entries removed, moved, added): an entry may
    change its `position`, never its type, event or detail, so an archived detail already listed stays on an edit
    (plan 2.6) while v51 refuses it as a **new** entry;
  - a child row's pairing reads its parent's `xmin` (the parent written in this transaction), with the seed's one
    exception (an option or a list entry of a copy still exactly as seeded) — recorded as a known limit in the
    runbook;
  - a club's type, detail or option is deleted only together with its club (the hard delete of maintenance and of the
    shared suites' cleanup, v49's rule); a direct `DELETE` is refused; a place, a team setting and a value never.
- **The API** (`backend/src/routes/calendarSettings.js`, `backend/src/calendarSettingsService.js`): section 5.1's
  routes; the club workspace and its admin only (T6: a platform admin there also holds the club's `club_admin` role and
  writes on that basis); every write through **one command runner** extracted from K2a's (`backend/src/calendarCommandRunner.js`,
  T3) — the event commands use it too, their behaviour unchanged (the K2a suites pass); the routers share one error
  answer (`backend/src/routes/calendarRouteErrors.js`).
- **T1:** `POST /api/calendar/events/:id/sessions/align` is audited with kind `align_sessions`.
- **T2:** `GET /api/calendar/events/types` answers `{ types, fields, locations, teamDefaults }`; each type gains
  `colorKey` and its live `defaultFieldIds`. `GET /api/calendar`'s `teams[]` gain `colorKey`.
- **Found by a race test (4b):** an event created while its type is being archived failed with a 500 (v49's trigger
  saw the archive). The event commands now read the type `FOR SHARE`: the create waits for the archive and answers
  `400 type_not_available`.
- **The K2a suites,** as regression (T3): `central-calendar-k2a-events` now runs its own routes on a database through
  every migration and its v49 checks (post-check, objects, rollback rehearsal, the "an event exists" refusal) on
  databases that stop at v49; `central-calendar-k2a-1b`'s test 7 expects `align_sessions`; `source-instance-end-7g`'s
  database stops at v50 (it asserted v50 was the last test migration).
- **Tests:** `backend/tests/central-calendar-k2b-settings.test.mjs` (24 tests: the role matrix and the form's read,
  the migration and its rollback rehearsal, the black-box scenarios of section 12, the invariants raw and through the
  routes, the races, the bounded COMMIT); the shared fixture `backend/tests/support/calendar-fixture.mjs`.

**The internal review round** (`db-reviewer`, `security-reviewer`, `code-reviewer` on `b78f95f`; the db and security
reviews READY WITH NON-BLOCKING NOTES, the code review NOT READY on one HIGH that the security review rated MEDIUM):

| Finding | Fix | Test (mutation) |
|---|---|---|
| Code HIGH / security M2: two requests with the same key at once (a double submit, a retry during the first COMMIT) — the second met the first's own write (a taken name, the team's first row, the new order) and answered `label_taken` / `team_changed` / `nothing_to_change` although its request was saved | the runner takes a transaction-scoped advisory lock on (requests table, user, key) right after the caller's locks: the second waits, then replays the saved answer (the event commands get it too) | 4e (M26) |
| Security M1: a team moved to another club (`PUT /api/organization/teams/:id` changes `club_id`) keeps its events and their type id — club A's now editable type label showed on club B's events, and A's counts included B's events | the reads show a club's type label only on that club's events (`event_type_label` null otherwise, the screen falls back to the kind's word); every `eventCount` counts only the club's own events (owned by it or by one of its teams now) | 3k (M28, M29, M30) |
| Security L1: the moved team's default place (club A's) read back in club B and A's place named the team | a default place of another club reads as none; a place names only its club's teams; B's next write clears it | 3k (M31, M32) |
| Security L2: `GET /events/types` derived the club twice | one owner (`eventCatalogOwner`) for the types and the form's lists | 0c, 2c |
| Security L3: a saved request whose view could not be read answered "Nothing was saved" | `savedAnswer`: 503 `outcome_unknown` (Check result replays), the one 404 passes through | — (no seam reaches it; recorded) |
| Security L4: the alignment's canonical body changed (`align_sessions`), so a same-key retry of an alignment saved before this deploy is `request_key_reused` | recorded (a window of minutes; accepted) | — |
| DB F1: `public.clubs` was locked after the DDL and the icon update — a `POST /clubs` of the old server could deadlock with v51 or land a club without icons (the self-check then aborts) | the clubs lock is the migration's first statement | — (concurrency of the deploy; M33 recorded as not testable here) |
| DB F2: no test of the last-live-type guard's advisory lock | two archives of the last two types at once: one passes, the other `last_type` | 4f (M27) |
| DB F3: the rollback locked the types before the events (the event commands' order is the reverse) | events first; the runbook says to run it with the previous release serving | 1b |
| DB F4, F5: the seed exception's consequences, the READ COMMITTED assumption and the lock footprint were not in the runbook | added to `docs/runbooks/calendar-settings-v51.md` | — |
| Code LOW: k2a-events test 1a accepted 23503 or 23514 | exactly v51's refusal | k2a-events 1a |
| Code LOW: 4d never resent the lost request's key | the same body with the same key writes as a first request | 4d |
| Code LOW: the plan's §2.4, §5.1 and §6 disagreed with the code; an unused `LOCK_TIMEOUT` | corrected; removed | — |
| Notes: `settingsClub` accepted the unreachable `platform_admin` basis; `eventWriteBasis`'s comment contradicted T6 | `club_admin` only (T6 enforced); the comment aligned | 2g |

**The narrow re-reviews of the fixes** (`b78f95f..038fbd8`): `code-reviewer` READY WITH NON-BLOCKING NOTES (three LOW),
`security-reviewer` READY, `db-reviewer` READY (one nit). Applied on the manager's order, without a new round:

| Finding | Fix | Test |
|---|---|---|
| Code LOW: club B's first write on a moved team cleared club A's stored default without a trace in the change row | `details.staleDefaultCleared = true` (never A's place id) | 3k |
| Code LOW: `savedAnswer` had no test | a test seam (`testHooks.answerFault`): a replay whose view cannot be read is `503 outcome_unknown`, then the plain replay | 4d |
| DB nit: the rollback's "in the writers' order" overclaimed; a garbled phrase in the runbook | "best effort; a deadlock aborts one side (lock_timeout / deadlock detection)"; the phrase fixed | 1b |
| DB note: M33 (the clubs lock's place) survived | a text assertion: the migration's first two statements are the lock_timeout and the clubs lock | 1a |

**Mutations** (a scratch script outside the repository: each edits one source file, runs the K2b suite on a disposable
database through the T1 runner, restores the file byte for byte): 33 run on `038fbd8`, **28 killed**, each by a named
test of the suite (the freeze, the owner match, the place's club, a lost right at the lock, an archived detail as a new
entry, the value's FOR SHARE, the palette, the seed, the last live type and its lock, the change log's club, the audit
pair, the type FOR SHARE, a foreign subject or body id, a foreign or hidden option, the freeze pre-check, a direct
delete, the same-key lock, the moved team's label, counts and default); **4 equivalent** — M6 (a team workspace let into
`settingsClub`: the basis check still refuses), M7 / M7b (the hash without the club, the replay check without the
club: each is the other's double guard), M24 (the team's club checked before the lock: the check after it still
refuses); M33 (the clubs lock moved) survived then and is killed since by test 1a's text assertion. Two more on the
final head: M34 (a saved answer's read failure answered as "nothing saved") killed by 4d, M35 (the stale default's
clearing not audited) killed by 3k. **In all 35: 31 killed, 4 equivalent.**

**The Independent review of PR #325** (on `dac5bd3`): READY WITH NON-BLOCKING NOTES, no BLOCKER, HIGH or MEDIUM. Applied
in one small round on the manager's order, without a new internal round (the manager checks the delta):

| Finding | Fix | Test (mutation) |
|---|---|---|
| LOW-1 (D41): after a move club B still received club A's type id on the card and in `GET /:id` | the id is masked with the label's predicate (`calendarQuery.js` readEventRows, `EVENT_VIEW_SQL`); an edit without a type keeps the stored type (`EVENT_ROW_FOR_WRITE_SQL` reads it unmasked) | 3k (M36, M36b) |
| LOW-2: a mutation dropping the subject from the hash survived | test 3l (the same key and body on another type: `request_key_reused`); `sameRequest` also compares the saved subject id | 3l (M37: both guards removed) |
| LOW-3: a lost ROLLBACK closing a replay answered "Nothing was saved" for a saved request | the replay's ROLLBACK failure destroys the connection and the saved answer stands (settings and events) | 4g (M38) |
| N2: section 13 said the preflight runs in a read-only transaction | the text follows the file (plain SELECTs, block by block) | — |
| N1: the same-key advisory lock comes after the row locks | not changed (the manager's order): a key reused across two subjects that wait on each other ends as `409 try_again` / `request_key_reused`, never a 500 | — |

Mutations of this round: 4 run, 4 killed. **In all 39: 35 killed, 4 equivalent** (M6, M7, M7b, M24).

**Follow-ups recorded for the next slices (not done here):**
- **K2b-1d:** the event form's static *Type* line falls back to the kind's word when `eventTypeLabel` is null (a moved
  team's event), as the calendar card already does (`frontend/central-calendar-event-form.js`; the code and security
  re-reviews).
- **K2b-1b:** a moved team's events keep their old club's `location_id` and chosen details (the database judges them
  only when set or changed); every read of an event's place, details and values shows them only when they belong to the
  event owner's current club — otherwise club B would see club A's place, address and detail labels (the db and
  security re-reviews' forward note). Whether such a team may move at all is decided: yes (D41).
- **K2b-1b, from the Independent review of PR #325 (finding 6):** a detail of club A answered through an event of a team
  that later moved to club B stays answered (its meaning frozen) for good while club A's `eventCount` shows 0 for it;
  K2b-1b decides what happens to another club's chosen details and values on a moved team's events. The team keeps the
  colour club A gave it (test 3k asserts it on purpose); club B's admin chooses its own.
- **K2b-1d:** the event form treats a null `eventTypeId` (a moved team's event, D41) as "choose a type"; an edit that
  does not send a type keeps the stored one (test 3k).

## 18. K2b-1b — plan-delta (accepted 2026-11-02 with the decisions of 18.7)

K2b-1a is merged and deployed (PR #325, `a01a116`, v51 directly confirmed by its post-check, per the stream manager).
K2b-1b makes the events **use** the catalog: a library place, the chosen details and their values, on create, on edit,
in a new values command, and in every read. Branch `central-calendar-k2b-1b` from `origin/main` `64f6640` (documents
only above `a01a116`).

### 18.1 No migration

v51 already holds everything K2b-1b writes: `events.location_id` with `events_location_guard`,
`event_selected_fields`, `event_field_values` with their guards and pairing, and the `set_fields` operation and kind.
**K2b-1b has no migration** (so v52 / v53 stay the metrics stream's). One rule stays the service's, not the
database's: a value is written only for a detail of the event owner's **current** club (v51's value guard checks that
the detail is chosen on the event, not its club — after a team moved, D41, an old club's choice may still be there
until club B's next edit, 18.4). Recorded as a known limit; a later calendar migration may add it.

### 18.2 The commands

- **`POST /api/calendar/events`** gains `locationId` (a live place of the event owner's club — a club event: its
  club; a team event: its team's club; a private coach: none, D33) beside `location` (never both: `400
  invalid_location`), and `fieldIds` (ordered, at most 30; absent → the type's live default details, D19's sibling;
  each a live detail of the owner's club — the `system` set for a private coach). Refusals, one answer for a missing,
  foreign, archived or system id: `400 location_not_available`, `400 field_not_available`.
- **`PATCH /api/calendar/events/:id`** gains `locationId` (`null` clears) and `fieldIds` (the list rewritten by
  difference, as a type's list in 1a: entries kept may be archived, a NEW entry is a live detail of the owner's current
  club). A detail taken off keeps its values (never deleted, v51); choosing it again shows them again.
- **New: `POST /api/calendar/events/:id/fields`** `{ requestKey, expectedRevision, values: [{ fieldId, value }] }` (1–30
  entries, each detail once) — D39: the event's managers only (`canManage` of K2a 4.1; the club's admin also on its
  teams' events, D18). By kind: `choice` → an option id (a live option of that detail, D30), `number` → a number with
  at most three decimals inside the detail's bounds, `scale_1_5` → an integer 1–5, `yes_no` → a boolean,
  `short_text` → 1–200 visible characters on one line; `null` clears (the row stays, all columns null). Refusals:
  `400 field_not_available` (not chosen on the event, or not of the owner's current club — one answer), `400
  invalid_value { fieldId }`, `409 event_changed { current }`, `409 event_cancelled`, the one 404. One K2a command
  through the shared runner: the writer lock → the event `FOR UPDATE` → the same-key lock → the replay → the details
  `FOR SHARE` in ascending id (a detail's edit takes `FOR UPDATE`, 1a) → upsert of the values → the event's revision
  bumped → the request and change rows, kind `set_fields`, details `{ fieldIds, cleared }` — never a value.
- The writes of the edit go through the existing event command (the change row's details gain `locationId` before /
  after when it is the owner's club's, `locationTextChanged`, `fieldIdsBefore` / `After`).

### 18.3 The reads (D41 on every one)

A place, a chosen detail or a value is shown **only when it belongs to the event owner's current club** (the event's
club, or its team's club now; the `system` details for a private coach's event). Otherwise it is not there at all: no
name, address, note, label, value, id or count. One SQL predicate, shared by every read:
`<the row's club> = coalesce(e.owner_club_id, t.club_id)` (`t` the owner team), as the type label and id in 1a.

- **The calendar card** (`GET /api/calendar`): `place` (`{ source: "library", locationId, name, address, note }`, `{
  source: "one_off", text }` or `null`) and `location` (the place's name or the text, for the K2a-2 screen); a
  manager's card also `details: { selected, filled, required, filledRequired }`. Two more statements when the window
  holds an event and `event` is asked for (the places join the events statement; the details are one statement), so
  the count stays independent of the number of events.
- **The status (D31):** after the event's last day, a chosen **required** detail of the owner's club without a value
  is an unmet check: `awaiting_entry` (the screen's word, K2b-1d: *Awaiting details*); optional details never change the
  status; a cancelled event stays cancelled. An event that expects nothing but has a required detail waits for it.
- **`GET /api/calendar/events/:id`:** the manager's view gains `place`, `locationId` and `fields` (each chosen detail of
  the owner's club in its order: label, description, kind, unit, bounds, required, archived, its live options plus the
  one a value names even if hidden, and the value or null). The reduced view (another coach) gains `place` only — **no
  details** (T7, below).
- **The command answers** (create, edit, values, a replay, a verified COMMIT) return the same manager's view.
- **The athlete** (D21 + D27): the event card gains `place` (a library place's name, address and note, or the one-off
  text) — never a detail, a value, a team default or another place. The allowlist test is extended key by key.

### 18.4 Finding 6 — another club's place, choices and values on a moved team's events (options; the manager decides)

After a team moves (D41) its events keep club A's `location_id`, chosen details and values: v51 judges them only when
they are set or changed, and a value is never deleted.

| Option | Reads | Writes | Cost / risk |
|---|---|---|---|
| **A (recommended; the manager's starting point)** | hidden (18.3) | club B's **next edit** of the event (any PATCH by its manager) detaches club A's choices and clears club A's place, in the same transaction, audited as `foreignFieldsDetached: n` and `foreignPlaceCleared: true` (never A's ids); club A's values stay (never deleted); the values command refuses A's details (`field_not_available`) | one more step in the edit; nothing outside the calendar; A's answered details stay frozen for good (their meaning was answered — fail-closed) |
| B | hidden | nothing is ever detached: A's rows stay inert under the event | simplest; A's choices keep counting against the event's 30 (the trigger counts them), and a later re-move to club A would show them again |
| C | — | the team move (`PUT /api/organization/teams/:id`) detaches and clears in its own transaction | a cross-domain write in the organization route, outside the calendar's command and audit (the change row needs a request row of a calendar command) — not recommended |

Recommendation: **A**. Also recorded: a cancelled event is final, so a moved team's cancelled event keeps A's rows
(hidden on every read); club A's `eventCount` for its detail stays 0 (1a).

### 18.5 Open technical points (for the manager)

- **T7 — details in the reduced view.** Recommended: **managers only** (as the notes, K2a): a coach who reads an event
  without managing it (a team coach on a club event, a coach who reaches it through a targeted athlete) sees its place
  but not its details. Section 5.4 said "read-only"; the narrower rule is the fail-closed one. The alternative is
  read-only details for every coach of the owner's club.
- **T8 — what the edit normalizes.** Under option A, any PATCH by club B detaches A's rows, even an edit of the title
  alone (the event is then clean whatever B changed). The alternative is to detach only when the PATCH sends `fieldIds`
  or `locationId` (A's rows would linger otherwise).

### 18.6 Tests and reviews

New suite `backend/tests/central-calendar-k2b-event-details.test.mjs` (the shared fixture; disposable databases, the
real routes):

1. **Create:** `locationId` / the one-off text / both (400); a place of another club, an archived place, a random id —
   the byte-identical 400; a private coach's `locationId` (400); `fieldIds` absent → the type's live defaults in order;
   an explicit list; a detail of another club, an archived one, a `system` one on a club event — the identical 400.
2. **Edit:** the place changed, cleared, the text swapped for a place; the list rewritten (an archived kept entry
   stays, an archived new one is refused, positions follow); stale revision; a cancelled event; the change row's
   details carry ids of the owner's club only.
3. **Values:** each kind accepted and refused by its rule (bounds, scale, a hidden option, a foreign option); `null`
   clears and the row stays; a detail not chosen, or another club's → the identical 400; replay, `request_key_reused`,
   stale revision; who may (the club admin on its team's event, D18; the team coach on its own team's; never on a club
   event; a private coach on their own; the platform admin from the platform workspace as support); the one 404 for
   strangers; the change row holds no value.
4. **Reads:** the card's `place` and `location`, the manager's `details` counts (absent for a non-manager and the
   athlete), the status (*Awaiting details* after the last day for a required detail, not for an optional one, not
   before the day, cancelled stays cancelled, an event expecting nothing waits for its required detail), `GET /:id`
   fields with values and a hidden option still named, the reduced view (place, no details, T7), the athlete's
   allowlist (`place` added, nothing of the details).
5. **D41 and finding 6:** a team moves from club A to club B: club B's card, panel, `GET /:id`, edit answer and the
   athlete's card show no place, detail, value, id or count of club A (texts scanned for A's ids and labels); B's
   values command on A's detail → 400; B's next edit detaches and clears (audited by flags, no A id); A's values remain
   and A's detail stays answered; B then chooses its own.
6. **Races:** a value racing a detail's edit through the routes (both orders); a place archived while an edit sets it →
   400; the same key twice at once → one write and a replay.
7. **No write on read** (the K1a digest guard extended to the new tables), the statement count for 1 and 12 events.
8. **Regression:** the K2b-1a, K2a and K1a suites; `--preset backend-fast`.
9. **Mutations** on: the D41 predicate in each read (card place, card details, view fields, athlete place, edit
   answer), the values command's club check, the detach-on-edit, the status check for required details, the kind
   rules, the managers-only details (T7), the default list copy at create.

Reviewers: `code-reviewer` + `security-reviewer` (no migration, so no `db-reviewer`); then the Independent review and the
owner's external review (triggers 2 and 4). `docs/ai/CURRENT_STATE.md` gains a short record of the calendar stream in
the same pull request (the merges and deploys K1a → K2b-1a as the manager listed them, what the repository cannot
prove marked "per the stream manager").

### 18.7 The manager's decisions (2026-11-02) — GO for K2b-1b

- **Finding 6 → option A.** The reads hide club A's place, choices and values. The next edit of the event by a manager
  of the new club — the platform admin as support included — detaches club A's choices and clears club A's place in the
  same transaction, audited by flags only (`foreignFieldsDetached: n`, `foreignPlaceCleared: true`), never by A's ids.
  Club A's values stay; the values command refuses A's details. A cancelled event stays as it is (hidden on every
  read).
- **T7 → managers only** see the details; the reduced view gets `place` only.
- **T8 → every PATCH** by the new club normalizes the event, a change of the title alone included: the event is clean
  afterwards whatever was changed, and the behaviour is deterministic.
- **18.1 accepted as a known limit:** "a value only for a detail of the owner's current club" is the service's rule,
  not the database's; recorded for the next calendar migration (runbook `docs/runbooks/calendar-settings-v51.md`).
- **A change of the event's type** (`PATCH` with `eventTypeId`) changes nothing in the event's list of details: the list
  changes only through `fieldIds`. The event form of K2b-1d offers to replace the list by the new type's default
  details. (The server already behaves so: `updateEvent` writes no selection.)

### 18.8 As built (K2b-1b)

- **Code:** `backend/src/calendarEventService.js` (`locationId` and `fieldIds` on create and edit, the normalization of
  finding 6, the values command `setEventFields`, the manager's view with `place`, `locationId` and `fields`, the
  reduced view with `place`), `backend/src/routes/calendarEvents.js` (`POST /:eventId/fields`),
  `backend/src/calendarQuery.js` (the card's `place`, `location` and the manager's `details`, the status rule of 18.3,
  the athlete's `place`), `backend/src/calendarEventAccess.js` (the D41 predicates `eventShowsTypeSql`,
  `eventShowsPlaceSql`, `eventShowsFieldSql` and `eventPlaceOf`, shared by every read). No migration.
- **The calendar's statements:** one more, not two — the place joins the events statement, and the details' counts are
  one statement for the events the coach manages (asked only when `event` is in `kinds`).
- **The status:** the required details are one more check on a manager's card, judged when `span.to` is before today;
  before that an event that expects nothing but has a required detail reads `planned`, and the K2a checks decide as
  before. A cleared value is no value; `false` is a value.
- **The request hash** of a create without `locationId` or `fieldIds` is the one K2a computed (the keys enter the
  canonical body only when sent), so a create retried across the deploy replays.
- **A place sent on an edit** is judged against the place the event shows: club A's id that a moved team's event still
  holds is a new place for club B and refused (`location_not_available`), so nothing of A comes back through an edit.
- **v51's guards behind the service's checks** (reached only by a race the locks do not order) answer as the service
  does: `event_field_values_kind` / `_bounds` / `_option` → `400 invalid_value`, `events_location_usable` → `400
  location_not_available`, `event_selected_fields_max` → `400 invalid_fields`.
- **The athlete and a moved team:** only a team without memberships can move (a membership's `(team, club)` key and its
  immutability), so no athlete reads a moved team's events today; the athlete's card takes the place from the coach
  card's statement, under the same predicate.
- **The edit's change row** carries the one-off text before / after under `location` (as K2a did), `locationId` before /
  after (only a place the event shows, so only of the club now), `fieldIdsBefore` / `fieldIdsAfter` and the flags
  `foreignFieldsDetached` / `foreignPlaceCleared` — not the `locationTextChanged` 18.2 named. The values command's
  `cleared` names only a detail whose value held something and is now cleared (a value already null is not cleared
  again).
- **The owner after the writer lock** (the independent review's LOW): an edit, a values command and every other event
  command take the owner from the event row read `FOR UPDATE` after `lock_event_writer`, which holds a team owner's
  team `FOR SHARE`; a new team event reads its team's club again under that lock. So a team that moved between the
  first read and the lock is judged by its club of that moment: club A's detail, place or type is the one 400
  (`field_not_available`, `location_not_available`, `type_not_available`), never a refusal of the database's guard (a
  500), and nothing is written (test 11).
- **The status, two edge cases** (the manager's decisions, 2026-11-02): an archived detail still chosen on an event never
  keeps it awaiting, even when required — it is out of the choice, so the event does not wait for it, and its value can
  still be written; an event that declares RPE without a channel (a gap, the note only) and has its required detail
  filled reads `done` (test 7).
- **The guard of a place sent back** (the review's observation on M19): `events_location_guard` judges a place only when
  `location_id` changes, so for club A's place sent back on a moved team's event the service's `lockOwnPlace` — against
  the place the event shows — is the only guard.
- **Release order:** the "required" switch of K2b-1c ships with K2b-1d or after it (the event form where a coach enters
  the values); before that, an event could wait for a detail nobody has a place to fill.
- **Known limit — settled by D43** (section 19; the independent review's MEDIUM, recorded without a change): an event of club
  A that targets its team T stays visible after T moves to club B — club B's admin and T's coach see its title and time
  and, since K2b-1b, the address and note of A's library place. The cause is K2a's reader rule
  (`backend/src/calendarAccess.js`, the club and team branches of `calendarScheduleCandidateSql`: a team target of
  the scope's club or team makes the event visible), not this slice. Options for the owner: (a) a club event's team
  target counts only while the team belongs to the event's owner club; (b) a stopgap — a library place shown only to a
  reader of the owner's club.
- **The type's default details** are read `FOR SHARE` in ascending id at create: a default archived meanwhile is waited
  for and left out.
- **Tests:** `backend/tests/central-calendar-k2b-event-details.test.mjs` (18.6, items 1–7 and 9; the regression of
  item 8 is the four earlier calendar suites, where the athlete's allowlist gained `place` and the settings suite's
  helper event chooses no details so its raw writes choose them).

## 19. D43 — a team's club is fixed after creation (D42 suspended)

**D43** (the owner, 2026-11-02, through the manager): moving a team between clubs is not an intended option.
- **The rule:** a team's club is fixed after creation. `PUT /api/organization/teams/:teamId`:
  - takes the same `clubId` as before, or none (the edit form no longer sends it);
  - answers another `clubId` with `409 team_club_fixed` ("A team's club cannot be changed.") and writes nothing;
  - decides the rights first (the team's, then its own club's, as before), so a caller who may not edit the team
    learns nothing of its club.
- **The edit form** (`renderOrganizationTeamEditForm`) shows the club as text. Creating a team still chooses the club.
- **Athletes** still move between teams and clubs through their memberships, as before.
- **D42 is suspended.** The plan-delta and the code of D42 (a club event's team target only while the team is the club's) stay on the local branch `central-calendar-k2b-team-target` (head `e093777`), not pushed and not released.
- **D41's masking** (K2b-1a and K2b-1b) stays as an extra guard against a raw database write, unchanged. The calendar
  suites that move a team by a raw `update public.teams set club_id` say so in a comment.
- **Known limits:**
  - the database still takes a raw `update` of a team's club. A trigger that refuses it may come with a later
    migration; v27 (section 2b, trigger `teams_source_binding_guard_move`) already refuses moving a team while it has an active
  binding through its club's connection; an unbound team can still be moved by a raw write.
  - a team without a club (possible only after a club's hard delete, `on delete set null`) cannot be given one through
    the app: any `clubId` is the 409 (code review of D43; accepted as D43 reads).
- **D44, in the same pull request** (the owner, 2026-11-02): a club may stop a team one season and bring it back the next.
  - `PUT /api/organization/teams/:teamId/restore`, for the club's admin or a platform admin, never the team's coach
    (restoring is the club's decision, as assigning the coach role). The team's club is read from the database,
    archived teams included (the request's authorization context holds active teams only). Answers:
    - a team the caller may not restore, or an unknown id, gets the answer of a foreign team today
      (`403 Team is outside your access.`; a platform admin's unknown id `404`);
    - a team of an archived club gets `409 club_archived` (no route restores a club today). The club's state is checked
      in the restoring statement itself, so a club archived after the rights check never gets an active team back;
    - an active team gets `200` as it is (`restored: false`);
    - a team whose club changed between the check and the write (only a raw database write can do that, D43) gets
      `409 team_changed`.
  - Only the team row changes. An archive changes nothing but that row either (`DELETE /teams/:teamId`), so a restore
    brings the team back as it was archived: its coaches' roles, its athletes' memberships and an active GPEXE binding
    work again, each checked again at use. A membership archived on its own stays archived (a new season adds new
    memberships). The GPEXE identities, dropped at the archive (`teams_drop_gpexe_athlete_identities`), are loaded
    again on demand. The team triggers are safe for it: the identity trigger acts only when `is_active` becomes false,
    and the move guard only on a change of `club_id`.
  - Neither an archive nor a restore writes an audit row, as before D44.
  - **A name taken in the club** (`teams_club_name_unique (club_id, name)`, the legacy schema, archived teams included)
    is `409 { error: "team_name_taken", archived, teamId?, message }` on `POST /teams` and on a rename. `teamId` is
    given only for an archived team ("An archived team with this name exists in this club — restore it instead."). The
    club's right is decided before the write, so the id reaches only someone who manages that club. Any unique
    violation of a team write is confirmed by reading the team that holds the name; the constraint's name is not relied
    on, since no migration in the repository creates it.
  - **Settings → Organization → Teams:**
    - *Show archived* lists the archived teams. `GET /api/organization` gives them (`archivedTeams`) only to a
      platform admin (every team, with its club's state) and a club's admin (its active clubs'), narrowed to the
      workspace.
    - *Restore* is offered except for a team of an archived club.
    - The create form answers an archived team's name with the message and a *Restore* for it.
  - Tests: `backend/tests/organization-team-club-fixed.test.mjs` (tests 4–9) and
    `frontend/tests/organization-teams-archive.test.mjs`.
- **An open question for the owner** (D44's work, no code change): a team's coach can archive (*Delete*) their own team
  today, since `DELETE /teams/:teamId` takes `canManageTeamById`, which includes `team_coach`; restoring it is the
  club's. Is the coach's archive intended?
- **No migration.** Tests: `backend/tests/organization-team-club-fixed.test.mjs`, `frontend/tests/organization-view.render.test.mjs`
  (the edit form) and `frontend/tests/organization-teams-archive.test.mjs`.
