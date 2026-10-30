# Central calendar — K1b plan: the central calendar screen (frontend only, read-only)

Status: **accepted by the manager (GO of 2026-10-30, decisions in section 12); built in the K1b pull
request.** Read-only reading of the checked-out code at `70e9e2b` (merge of PR #287; K1a `GET /api/calendar`
merged as PR #281 `fb33918`).

- Inputs: `docs/ai/central-calendar-k0-discovery.md` (D1–D14, section 0; the menu-item consequences,
  section 3), `docs/ai/central-calendar-k1-plan.md` (D15, D16, the item model as built, section 2; the
  endpoint, section 1), `backend/src/routes/calendar.js` and `backend/src/calendarQuery.js` as merged.
- Scope: **frontend only.** One new domain (view / actions / data), one state slice, the shell glue in
  `app.js` / `navigation.js` / `index.html` / `menu-cache-policy.js`, CSS, tests. **No backend change:** if
  the API lacked something blocking, this plan stops there (section 9 — nothing blocking was found).

## 1. Where it lives (D1): the tab key, the menu entry, what stays reachable where

| | Decision |
|---|---|
| Tab key | **`central-calendar`** (new). `weekly` stays the athlete's weekly plan (D5); every one of its references stays. `calendar` is not used as a key: the athlete shell already maps `data-athlete-tab="calendar"` → `weekly` in four places (`app.js:447-457, 2707-2708`, `navigation.js:92`). |
| Menu entry | The rail button `#calendarToggle` (`index.html:37`, label *Calendar*, same icon) opens the central calendar: `openCentralCalendarFromRail()` in `app.js` replaces `openWeeklyCalendarFromRail` (`app.js:1675-1697`, the only caller of the month-picker-on-load path from the rail). `navigation.js:97` highlights the button when `state.activeTab === "central-calendar"`. |
| Loader | A new `if (state.activeTab === "central-calendar") return loadCentralCalendar();` branch in `loadActiveTab()` (`app.js:2180`), and the matching **`MENU_CACHE_POLICIES["central-calendar"]`** entry (`menu-cache-policy.js`; `menu-cache-policy-coverage.test.mjs` fails without it). |
| Back root (coach) | `handleAppBack`'s `rootTab` (`app.js:2075`) becomes **`coach-home`** for a coach (K0 §3: with no picked athlete `weekly` shows only *No athlete selected.*); the athlete shell keeps `athlete-home`. `renderLibraryNav`'s two fallbacks (`navigation.js:64-65`) go to `coach-home` for a coach and stay `weekly` for an athlete. A D1 consequence outside the calendar files — **open point E**. |
| Workspace switch | `onWorkspaceChanged` (`app.js:3041`) resets the slice and the namespace and, when the calendar is open, reloads it with `forceRefresh` (the Coach Home pattern) instead of leaving it. |
| Athlete shell | Untouched: no entry, no route, no state change for an athlete session (the athlete's own view waits for K2, D5). `isAthleteMode()` never reaches `central-calendar`. |
| Platform workspace | The API answers everything (K1 §3) with `teams: []`; the screen shows it as is, with no Groups chips. Recorded, not changed. |

Where the athlete's weekly plan stays reachable (K0 §3, unchanged code): **Athletes → athlete** (the rail
list, `app.js:3129-3139`), Coach Home's Training plan strip and day list (`coach-home-open-athlete`), every
existing deep link (`openWeeklyPlanOnDate`: notifications, TL Schedule, Athlete Home, the Builder's return),
and **from the central calendar**: an athlete in the item panel → their weekly plan on the item's day (D5).
The month picker that the rail button used to open stays inside the weekly plan (its week-title button).

## 2. Modules and the state slice

- `frontend/central-calendar-view.js` — pure template strings: toolbar, chips, month / week / day, the card,
  the panel, the empty / loading / error states. Exports `renderCentralCalendarHtml(state slice, ctx)` and
  the small pure helpers the tests read (`statusBadge(item)`, `cardCounts(item)`, `visibleItems(day, filters)`,
  `rangeForView(view, anchor)`).
- `frontend/central-calendar-actions.js` — `handleCentralCalendarAction(action, { render, openWeeklyPlanForAthleteOnDate, openTrainingLoadActivity })`
  for every `data-action="central-calendar-*"`: navigation, view and mode switches, chips, card → panel,
  panel close, the two drill-ins, Try again; `closeCentralCalendarPanel()` for Back / Escape;
  `resetCentralCalendarForWorkspaceChange()`.
- `frontend/central-calendar-data.js` — `loadCentralCalendar({ render, forceRefresh })` (the range read),
  `loadCentralCalendarDay(date, { render })` (the panel's names), the context keys, the namespace invalidation,
  the device preference of the week mode (`localStorage`, the `exercise-view-modes.js` pattern, read in a `try`).
- `state.js` — `emptyCentralCalendarState()` and `centralCalendar: emptyCentralCalendarState()`:

```js
{
  view: "week",            // "month" | "week" | "day" (D12)
  weekMode: "list",        // "list" | "grid" (D13), seeded from the device preference
  anchor: "",              // YYYY-MM-DD the views are built around ("" = today at first open)
  selectedDate: "",        // the day a phone's strip / the month grid points at
  filters: { teamIds: [], kinds: [] },   // empty = everything (section 3, open point A)
  range: { from: "", to: "" }, data: null, loading: false, error: "", errorCode: "",
  panel: { key: "", open: false, athletes: null, loading: false, error: "" },
}
```

- `app.js` glue only: the rail opener, the `loadActiveTab` branch, `loadCentralCalendar()` (title *Calendar*,
  context = the workspace label, toolbar emptied), the dispatch line in `handleContentClick`, the Back hook
  (`closeCentralCalendarPanel()` before the tab-level Back, next to the exercise layers), the workspace reset,
  and **`openTrainingLoadActivity(activityId, date)`**: `pushAppHistory()`, `activeTab = "training-load"`,
  then the existing `training-load-results-view-activity-in-calendar` branch of `handleTrainingLoadAction`
  (`training-load-actions.js:2315-2345`), which already lands Activities on the day with that activity open
  — the way Coach Home's load strip reuses `training-load-results-open-athlete`. No Training Load module changes.
- `styles.css` — one `.central-calendar` block (`cc-` prefixed classes), its `@media (max-width: 760px)` block,
  the ≥ 1024 px side-panel column. **No `data-tab` attribute on any element** (the `handleGlobalClick` trap,
  `app.js:1813`); a regression test greps the rendered markup for it.
- `builder-actions.js` — `invalidateCentralCalendarCache()` at the two exits that already invalidate weekly /
  programs / Coach Home (`exitBuilderToPlanContext`, `builder-delete-source-plan`), so a plan saved or deleted
  in the Builder is not shown stale on return (menu-cache-policy rule 4). Other writers (an athlete's RPE, a
  roster decision, a GPEXE import) run outside this session's frontend; the 30 s TTL covers them.

## 3. Data flow

- **One `GET /api/calendar?from=&to=&today=` per visible range**, `today` = `localDateIso()` (the browser's
  local date; a drift over 2 days answers `400 invalid_today`, section 7). Range per view, always ≤ 62 days:

| View | Range | Why |
|---|---|---|
| month | the grid's whole weeks, `monthWeeksIso(anchor month)`: 35 or 42 days | the K1 cap was sized for it |
| week | Monday–Sunday of the anchor (`weekMondayIso`) | |
| day | the **week** of the anchor | switching day ↔ week and the day arrows inside a week need no request |

- **Cache:** `loadCachedView` (`view-cache.js`), namespace **`central-calendar`**, context key
  `[...currentUserWorkspaceContextParts(), from, to, today]` — `today` is in the key because the server derives
  `status` from it (a tab left open past midnight reads again). Default TTL (30 s): an unchanged range within it
  sends nothing; after it the cached data paints first and refreshes in the background. The slice keeps a
  generation counter and `getCurrentContextKey` so a slower older answer never overwrites a newer range or
  another workspace (`training-load-calendar-data.js` pattern). An `invalidated-stale` outcome retries once.
- **Filters are client-side** over the one unfiltered answer (**decision A**): Groups hide every card whose
  `teamIds` holds none of the chosen teams; Types hide every card whose `kind` is not chosen. The chips' counts
  are counted over the loaded range, so every chip keeps its count while another is active; a toggle never
  sends a request; the server's grouping is never changed (D16: hiding a whole card is not regrouping). The
  Types chip mirrors the server's `kinds` semantics: a folded RPE activity lives inside its planned card, so
  *Activities* shows the own-card activities only and never unfolds a group. The `kinds` / `teamIds` /
  `athleteIds` parameters stay unused by K1b (available to K3 when a scope grows).
  Trade-off, stated: a Builder batch that spans two teams is one card under either team's chip with the whole
  group's numbers (a server-side `teamIds` would narrow the athletes). Private coach and platform: `teams: []`
  → no Groups row.
- **`include=athletes` only for the panel:** opening an item reads `GET /api/calendar?from=D&to=D&today=&include=athletes`
  (namespace `central-calendar-day`, key workspace + date + today, the same TTL) and takes the `athletes` of the
  item with the same `key`; the card's own facts stay those of the range answer. The panel opens at once with
  the card's counts and *Loading athletes…*; a failed read shows *Athlete names could not be loaded* with Try
  again; a key no longer in the day answer shows *This item has changed. Refresh the calendar.* The range answer
  never carries `athletes` (a month of a four-team club is about 500 cards × 20 athletes).
- **Honest numbers only:** the card shows what the item carries (section 5); nothing is summed across cards or
  days (K0 LOW-4 / ADR-001 stays with the activity detail).

## 4. Views, navigation, the two week modes (D12, D13)

- **Toolbar** (one row, wraps on phones): `‹` *period label* `›`, **Today**; a view switch **Month | Week | Day**
  (three buttons, `aria-pressed`); in Week on a computer the mode switch **List | Time grid** (`aria-pressed`,
  the choice kept per device). Below it the two chip rows **Groups** (the answer's `teams[]`, each `name ·
  count`) and **Types** (`Training · n`, `Activities · n`, `Events · n`, `Tests · n`, the four kinds), each chip a
  toggle button with its count, plus *Clear* when any is active. No year view (D12).
- **Anchor:** one date; `‹` `›` move it by a month / a week / a day; **Today** sets it to today; a view switch
  keeps it (Month shows its month, Week its week, Day the day). The period label: *October 2026* /
  *26 Oct – 1 Nov 2026* / *Thursday 30 October 2026*.
- **Month:** a Monday-first grid of the range's weeks; a cell shows up to three compact cards (team colour,
  title, status dot) and *+n more*; days of the neighbouring months are muted but populated (they are in the
  range). A compact card opens the panel; the day number or *+n more* opens **Day** on that date.
- **Week, list mode (default, D13):** seven columns Mon–Sun; each column lists its day's cards **in the
  server's order** (K1 §2.8: AM/PM, Before/Training/After, order, time, title) — the client never re-sorts in
  list mode. Today's column is marked; an empty day shows a quiet dash.
- **Week, time grid (D13 second mode):** rows by hour from 06:00 to 22:00, widened to the earliest / latest
  `startTime` in the week; a card with a `startTime` sits at its hour with a **fixed height** (start only — no
  end, no duration, K0 MEDIUM-3); cards without a time go in a *No time* band above the grid, in the list
  order. The grid is **offered at ≥ 1024 px only** (the manager's GO): below that seven hour-columns cannot
  be read, and a visible inert control is forbidden (`frontend.md`), so the mode switch is not rendered there
  and the list is used.
- **Day:** one column, the day's cards full width in the list order; `‹` `›` move a day.
- **Layouts:** the view takes one `layout` word computed from `window.matchMedia` by the actions module
  (`phone` ≤ 760 px, `medium` 761–1023 px, `wide` ≥ 1024 px) and the shell draws the calendar again when a
  breakpoint is crossed — the markup is never doubled for CSS to hide one half.
  **Phone (≤ 760 px):** Week = a seven-day strip (the Training Load weekly-strip pattern: day name, number,
  count) over the selected day's list; Month = the grid with counts over the selected day's list (the Coach
  Home calendar pattern); Day = the list. The first screen shows the selected day's cards at once (K0 LOW-10).
  Default on first open, computer and phone: **Week**, this week, today selected.

## 5. The card (D14, D15, D16)

| Part | Rule |
|---|---|
| Title | `title`; fallbacks *Training session* (planned), *Activity*, the external `eventType` or *Event*, *Test*. A small kind word under it (*Training · 20 athletes*, *GPEXE activity*, *Event*, *Test*); `origin` of an activity decides *Imported* / *Manual*. |
| Team colour | A left stripe in the colour of the card's first team; a card in two teams adds a dot per further team. **Automatic palette** (D11): eight fixed colours by the team's position in `teams[]` (stable for the session; the owner's colours come with K2's Settings). No team → neutral. |
| When | `startTime` (`17:30`) when present, else the slot words: *AM · Training*, *PM · Before* (`slot.amPm`, `slot.bta`; `order` is never shown); none → nothing. |
| Status badge | From `status` × `expects` (table below); nothing for `none` and nothing for `planned`. |
| Count | planned / external: **RPE x/y** (`rpe.submitted/asked`) when `rpe`; activity: **x/y present** (`attendance.present/roster`) when `attendance`, else RPE x/y when `rpe`; test: **Results x/y** (`results.completed/expected`) when `results`. Nothing else: no metrics, no duration (D14). |
| `cancelled` | The badge *Cancelled* and a struck title. `projected` adds nothing of its own (its status is `planned` or `not_opened`). |

Status badge wording (D14's words, D15 for what is awaited):

| `status` | Badge |
|---|---|
| `planned` | none (a future card is simply planned) — a default, section 12 |
| `done` | **Done** |
| `awaiting_entry` | by the first unmet expectation: `rpe` with `submitted < asked` → **Awaiting RPE**; `test_result` with `completed < expected` → **Awaiting result**; otherwise (an imported activity whose roster still needs a state) → **Awaiting attendance**; any other case → **Awaiting entry** |
| `missed` | **Missed** |
| `not_opened` | **Not opened** |
| `cancelled` | **Cancelled** |
| `none` | none |

## 6. The item panel

- **Computer (≥ 1024 px):** a 360 px panel beside the calendar (the Training Load drawer pattern); the grid
  keeps working behind it. **Phone (and 760–1023 px):** a bottom sheet, full width, at most 85 % of the height,
  scrollable, a 44 px Close, the page behind it does not scroll (the roster sheet pattern, 5a3b).
- Content, top to bottom: title and kind; date, time or slot; the teams (names, colours); the status badge with
  one sentence of what it means (*17 of 20 athletes have entered their RPE*; *The session day has passed and
  3 RPE entries are still missing*; *Every entry that could be made was missed*; *No one could enter anything:
  the day was never opened*); the count line; **Open in Training Load** — exactly one `links.activityIds` →
  that activity's detail (`openTrainingLoadActivity`), several (a planned group with folded RPE activities) →
  Activities on that **day** (the TL day list shows them all; the API gives no activity id per athlete, section
  9), none → no button; the **athletes** (section 3's day read): name, team(s), the per-athlete state as the API
  words it (*RPE entered* / *RPE missing* / *RPE missed* / *not asked*; *Result entered* / *missing* /
  *missed* / *not asked*), each row a button → **their weekly plan on the item's day** (D5,
  `openWeeklyPlanForAthleteOnDate`). The athlete id the weekly plan needs is the roster row's `athlete_id`
  (`state.athletes` carries `athlete_uuid` and `athlete_id`): the plan route's **query** matches the business
  id or the source external id only (`routes/athletes.js`, `athlete_source_external_id = $1 or athlete_id =
  $1`; `plans.v_weekly_plan_items` exposes the UUID as a separate `athlete_uuid`), so the calendar's UUID is never
  sent to it — only `canAccessAthlete` would have accepted it, and the coach would have landed on an empty plan.
  An athlete not in the roster (left the team, archived, a dual member of another club) is shown in the panel
  without a button, with *Not in this workspace's roster*; a `program-data` read by `athlete_uuid` is a K1a-API
  follow-up (section 12).
- Close: the Close button, Escape, Back (`handleAppBack` closes an open panel first), a view or range change.
- Nothing is written from the panel (D3). Roster decisions stay in the Training Load detail.

## 7. Empty, loading, error and 403 states

| State | What is shown |
|---|---|
| Loading | The toolbar paints at once; the grid area says *Loading calendar…*; chips are disabled until the data is there. A background refresh shows nothing extra. |
| Empty | *Nothing planned or recorded in this period.* (month / week / day); with active filters *Nothing matches these filters.* and **Clear filters**. |
| `400` | `invalid_today` → *Your device's date differs from the server's. Check the clock and try again.*; `range_too_long` / the others → *The calendar could not be read.* with the server's `message` under Technical details. |
| `401` | The app has no global sign-in redirect for an expired session; as every other loader, the error text (*Please sign in again.*) with **Try again**. |
| `403` | *No calendar for this workspace.* and *Choose a club, team or private coaching in the workspace menu.* (the Imports no-team sentence); the two API bodies (`Forbidden`, no athlete profile) read the same. |
| `503 database_busy` | *The server is busy. Try again in a moment.* |
| Network / other 5xx | *Could not reach the server.* / *The calendar could not be read.* |
| Refresh failed | The shown data stays (`setCacheError` keeps it); one quiet line *Could not refresh — showing the last loaded calendar.* with Try again. |

Every error state has **Try again** (`forceRefresh: true`).

## 8. Deliberately not in K1b

Creating or editing anything (K2, D3); the athlete's own central view (D5, waits for K2); metrics or durations
on cards (D14, K0 MEDIUM-3); a year view (D12); team colour settings (D11: the automatic palette only); an
athlete filter or the Training Load shell Filter; Settings → Calendar; roster decisions or any write from the
panel; an *Open in Tests* / *Open the schedule* button for test and external cards (a follow-up: the facts are
in the panel, the Tests module's `openTestsResults` / the TL Schedule could take them); per-athlete *Open the
activity* buttons on a group card (section 9); notifications; K3's re-homing of the other calendars; a time
grid on phones; a change to `GET /api/calendar`.

## 9. The API — what K1b needs against what the API has

| Need | API | Status |
|---|---|---|
| Range ≤ 62 days, `today` | `from`, `to`, `today` | has |
| Teams with names for the chips and colours | `teams[] { teamId, name, athleteCount }` | has (no `clubId` or colour — not needed in K1b) |
| One card per thing, in the slot order (D13, D16) | `days[].items[]` ordered by the server | has |
| Card facts: title, kind, slot, time, teams, counts, expects, status, cancelled, projected, origin, eventType | the item model (K1 §2.3) | has |
| Athlete names and per-athlete state for the panel | `include=athletes` → `athletes[] { athleteId, name, teamIds, rpe \| result }` | has, opt-in |
| The TL activity to open (D14) | `links.activityIds` | has at card level; **no activity id per athlete** on a planned group's `athletes[]` → the button opens the TL day when several (section 6, decision D). Non-blocking; **K1a-API follow-up, not this PR:** a per-athlete `activityId` in the `include=athletes` rows, so the panel can open the right activity per athlete |
| The weekly plan drill-in (D5) | `athletes[].athleteId` (UUID) | has; mapped to the roster row's `athlete_id` through `state.athletes` (section 6); an athlete outside the roster gets no drill-in — **K1a-API follow-up:** let `GET /api/athletes/:athleteId/program-data` also match `athlete_uuid` |
| Stable error codes | `400` codes, `403`, `503 database_busy` | has |

Nothing blocks K1b. No backend change is made.

## 10. Tests

`frontend/tests/central-calendar.actions.test.mjs` (node:test, `installFetchMock` from
`tests/support/fetch-mock.mjs`, JSDOM for the markup) through the **real** handlers and loaders:

1. Range → request: week = Monday–Sunday, month = the grid's weeks (35 or 42 days), day = its week; `today` =
   the local date; no `kinds` / `teamIds` / `include` on the range read.
2. The same range again inside the TTL sends nothing; another range sends one request; a slower older answer
   is dropped after a newer range (deferred fetch); a workspace switch resets the slice and never applies the
   old workspace's answer.
3. Chips: counts from the loaded range; a Group / Type toggle hides the right cards and **sends no request**;
   Clear; `kind` names.
4. List order kept exactly as the server's (never re-sorted); the time grid places timed cards by hour and the
   untimed ones in the *No time* band.
5. The status badge per `status` × `expects` (every row of section 5), the counts per kind, the title fallbacks,
   the team colour by `teams[]` position, two-team cards.
6. Navigation: `‹` `›` per view, Today, a view switch keeps the anchor; the mode switch writes and reads the
   device preference (a throwing `localStorage` is harmless).
7. The panel: opens with counts, reads the day with `include=athletes`, matches by `key`, a failed day read,
   a vanished key; the two drill-ins (one activity → `openTrainingLoadActivity(id, date)`; several → the day;
   an athlete → `openWeeklyPlanForAthleteOnDate(rosterAthleteId, date)`, the UUID fallback); Escape / Back
   closes it.
8. States: `400 invalid_today`, `401`, `403`, `503 database_busy`, a network error, a failed background
   refresh keeping the data; empty with and without filters.
9. Regression guards: no `data-tab` attribute in any rendered markup; every control is a `<button>`.
10. `menu-cache-policy-coverage.test.mjs` passes with the new entry; the Back-root change is pinned by a
    source-slice assertion (the `athlete-back-navigation.test.mjs` pattern).

Then the **frontend unit preset** (`node scripts/test-runner.mjs --preset frontend-fast`) once on the final HEAD,
and `npm --prefix frontend run build`.

**Browser QA (mandatory for every UI claim):** a static harness in this session's scratchpad (not in the
repository): a small node static server over `frontend/` plus one harness page that imports the real
`central-calendar-*.js`, `state.js` and `styles.css` and installs an in-page fake of `GET /api/calendar` (one
club, four teams, two weeks: every kind, every status, a two-team card, a cancelled and a projected day, an
`include=athletes` day answer, and switches for 400 / 401 / 403 / 503). Checked in the built-in browser at
**1280 px and 360 / 375 / 390 px**: no horizontal overflow in any view or state; every control ≥ 44 px; every
input ≥ 16 px (K1b renders no text input — chips, switches and arrows are buttons — recorded as such); the
panel on a phone opens, scrolls, closes by button, Escape and Back; the month / week / day switches, the time
grid, the chips, the drill-in actions firing. The record goes into the PR body.

## 11. Reviewers and triggers

`code-reviewer` + `mobile-qa` + `ux-design-reviewer` (a new coach screen; CSS, layout, touch). No
`security-reviewer` (no auth, access, ownership or info-hiding change; the only shell change is navigation),
no `db-reviewer` (no migration), none of the five external-review triggers. Not the light regime (§5a): a new
screen, several files.

## 12. The manager's decisions (GO of 2026-10-30; all inside D1–D16, no owner round)

- **A. Filters client-side** over one unfiltered answer per visible range — accepted. The chips' counts come
  from the unfiltered answer; the Types chip mirrors the server's `kinds` semantics (a folded RPE activity
  lives inside its planned card — *Activities* shows own-card activities and never unfolds them); no second
  request on a chip toggle; the server's `teamIds` / `kinds` / `athleteIds` stay unused in K1b (available for
  K3).
- **D. The group card's *Open in Training Load*:** one folded activity → the activity detail; several →
  Training Load → Activities for that day — accepted. Recorded as a **K1a-API follow-up** (not blocking, not
  this PR): a per-athlete `activityId` in the `include=athletes` rows, so the panel can open the right
  activity per athlete.
- **E. The coach's Back root `weekly` → `coach-home`, and the `navigation.js` fallback → `coach-home`** —
  accepted (D1: the calendar replaces the item; Home is the coach's natural root). The athlete shell keeps its
  own root untouched; both have a test.
- Also confirmed: the time grid only at ≥ 1024 px (a phone gets the seven-day strip and the selected day's
  list); the automatic team palette by position in `teams[]` (K2 lets the club choose, D11); the badge wording
  per `status × expects` of section 5, nothing for `none` / `planned`; the server's order is never re-sorted;
  no `data-tab` attribute anywhere (the regression test stays); the plan is committed with the code in the
  same pull request; reviewers `code-reviewer` + `mobile-qa` + `ux-design-reviewer`; the browser QA record at
  1280 / 360 / 375 / 390 px in the PR body.
- The other defaults of the proposal stand: Week is the first view; the awaiting wording of section 5;
  `today` in the cache key; the Builder-exit invalidation.

## 13. The internal review round (2026-10-30; `code-reviewer`, `mobile-qa`, `ux-design-reviewer`)

Fixed in the same pull request (every MEDIUM, and the LOW notes that were plain copy or one line):
- the weekly-plan drill-in sends the roster id only (section 6; the UUID is not what the plan route's query reads);
- the Training Load hand-off asks the Activities roster's own leave question before the tab changes and reuses
  Activities' day selection; `loadAthletes` (the roster reload after a Settings mutation) invalidates the calendar
  cache, and the cache-policy entry names what the TTL alone covers;
- an open item that a re-read no longer carries closes its panel with one line; a date rollover during a request
  reads once more; `kind` is escaped in class names like every other server value;
- copy: *Recorded athletes (N)* and the Roster-tab pointer for an imported activity; the attendance and
  not-opened sentences; a sentence for `none` / `planned` items in the panel; the singular "1 activity is
  recorded"; *No set time*; a phone's month tap scrolls the day's list into view.

Recorded for the owner, not changed: *RPE 0/20* on a future planned card (a D14 count nuance); the chip words
(*Planned training* / *Recorded activities*); the first team's name on Day-view cards; the *Not opened* badge word.
**K1a-API follow-ups:** a per-athlete `activityId` in `include=athletes` rows (decision D); `program-data` read by
`athlete_uuid` (section 6).
