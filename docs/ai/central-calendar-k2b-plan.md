# Central calendar — K2b-1 plan: Settings → Calendar (types, details, places, colours)

Status: **the structure and the slices 1a → 1c → 1d (→ 1e) accepted by the manager on 2026-11-01, with T1–T5 decided as
recommended (section 15); the owner's answers to Q1–Q12 are pending, and v51 and the code wait for them** (Q3, Q5, Q7,
Q10 and Q11 change the schema). Written against the checked-out code at `17dc46d` (merge of PR #313, `main`). No
database was touched.

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
| 5 | Athlete-filled details (D26) | **not in K2b-1, not even as definitions** — they are Training Load measurements and belong to Metrics Core (ADR-007); the column `filled_by` exists with `coach` only, K2b-2 widens it (section 10) |
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
- Child rows (`event_field_options`, `event_type_fields`): a write needs, at COMMIT, its parent's change row **written
  in the same transaction** (`xmin = pg_current_xact_id()::xid` on the change row) — so the parent's revision is bumped
  and audited.
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
| club C — platform admin (support, D24) | yes, basis `platform_admin`, audited | C's live set | the same |
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
| `GET /` | — | the active club's whole catalog: types (live and archived, each with `revision`, icon, colour, default expects, detail ids, `seeded`), details (with options, `answered`, `inUse`), places, the club's active teams with `colorKey`, `defaultLocationId`, `revision` (0 when no row yet) |
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
race and `verifiedAfterCommitError` / `503 outcome_unknown` are `runEventCommand`'s (`backend/src/calendarEventService.js:587-765`),
extracted into one shared runner the settings service uses too (no second copy of it). `55P03` / `40P01` → `409
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
- So K2b-1 builds only coach details; `filled_by` exists with the one value `coach` and is shown on the screen, so
  the model's word is in place; **K2b-2** decides the shape (most likely an event detail that *refers to* a Metrics
  Core variable, collected through the RPE request) and widens the CHECK in its own migration.
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
| platform admin, club workspace | as the club admin, audited with basis `platform_admin` |
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
- **Preflight** (`…-preflight.sql`, SELECT only, `begin transaction read only`): PostgreSQL version; v50 the last
  migration with its checksum, v51 absent; the `calendar` objects as v49 left them; the type rows exactly the v49 seed
  (no edit possible before v51); the active clubs (the seed's expected counts); no lock or idle transaction on the
  `calendar` tables.
- **Post-check** (`…-postcheck.sql`, SELECT only): v51 recorded once with its checksum and last; the objects; every
  trigger enabled; the seed counts per club; no non-seed row.

## 14. Risks and what K2b-1 leaves out

- **Risks:** an address correction shows on past events too (Q7); a catalog that only grows (archive, never delete;
  *Show archived* keeps the lists short); the seven seeded types' new icons change what a club sees on day one (the same
  icons as today, so nothing visible moves); `filled_by` widened later by a migration (K2b-2); a coach in a team
  workspace cannot edit the club's catalog by design (D24); the colours are one palette for light and dark.
- **Out of K2b-1:** athlete questions and their collection (K2b-2), notifications of a change of place or time, a
  private coach's own places and details (Q6), groups of athletes (Q-C), absence reasons (D10), recurring events and
  copying, a club's edit of the `system` set, analytics over the details, the K2c roster rule, external schedules.

## 15. Open questions

**For the owner** (each with a recommendation):

1. **The athlete's screen** — build *Upcoming events* on Athlete Home (14 days, place, note, *Open in maps*) as K2b-1e
   now (recommended: the owner asked for the athlete's maps button, and today the athlete sees no event anywhere), or
   with K2b-2.
2. **The boundary of D26** — coach details are event context kept in the calendar; anything an athlete answers is a
   Metrics Core variable collected in K2b-2; no `filled_by = athlete` row in K2b-1 (recommended, section 10).
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
