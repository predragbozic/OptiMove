# Central calendar — K5 plan: the calendar as the hub of the app's activities

Status: **Direction accepted by the owner (H1–H3) and agreed by the OptiMove manager** (2026-11-19, written against `main` `1a5cdb79`). This plan contains no code. Each part needs a
UI contract and the manager's GO. The part that touches Imports (K5-4) is agreed with the OptiMove manager first,
because Imports belongs to his mapping stream.

## 0. The owner's direction (2026-11-19, in the calendar stream's chat)

| | The owner's words | Read as |
|---|---|---|
| **H1** | „Mi sada sa ovim u stvari hoćemo na neki način i da centralizujemo u kalendaru aktivnosti aplikacije. Sve što ima neki vid nedeljne kalendarske opcije npr testiranja, gps uvozi trebalo bi da budu deo nekog događaja ili ako nisu deo događaja da se nekako obeleže na kalendaru na neki prostor i jednostavan način da kroz klik možemo otići tamo gde treba....razmisli i o tome" | The central calendar becomes the hub. Everything with a date (trainings, tests, RPE requests, GPS imports) is part of an event. If it is not, it is marked on the calendar in a small, simple way, and one click takes you where its work is done. |
| **H2** | „Npr gps uvoz mi bismo trebali i na glavnom kalendaru da vidimo neki gps ikonicu ili nesto preko čega bismo mogli ući dalje" | GPS is visible on the main calendar with a GPS icon, and a click goes on from there. |
| **H3** | „U filteru moze da se izabere samo gps uvozi... zatim nesto drugo.... Da možemo lako naci" | The calendar's filter has a choice for each kind of activity: GPS imports, tests, RPE requests, trainings and events by type. Choosing one shows only that kind, so it is easy to find. |
| **H4** | „Događaj na kalendaru glavnom mogao bi da sadrži na sebi već ikonice rpe, gps ili testa čisto kao oznaka da on sadrži to u sebi ako sadrzi" | An event card shows small RPE, GPS and test icons, only as a mark that the event holds that kind of item. |

The rule of the K4 plan carries over (O13): there is no big change of the current state. Each part reuses existing
routes and links.

## 1. What exists today (`main` `1a5cdb79`)

**What the calendar already shows** (`GET /api/calendar`, `backend/src/calendarQuery.js`):
- events (K2a);
- planned groups, which are Builder trainings;
- external RPE schedules;
- Tests schedules;
- activities. An activity is a GPEXE import, a coach-made activity, or an RPE activity that folded nowhere.

**What already folds into an event:**
- a referenced RPE schedule or test schedule (D16);
- linked Builder sessions (K2a-1b, K2c);
- linked activities (`POST /api/calendar/events/:eventId/activities`).

**Where a click goes today:**
- an activity has *Open in Training Load* or *Open the day in Training Load*;
- an athlete row opens that athlete's weekly plan;
- there is no way into Tests, into the Builder, into Training Load's Schedule or into Imports.

**Icons:**
- every activity, imported or not, has the same generic icon (`centralCalendarItemIconKey`);
- the icon library already has `gps`, `satellite` and `route` (`frontend/icon-library.js`).

**GPS sessions that wait for import** (Imports candidates) are not on the calendar. The list exists as
`GET /api/training-load/gpexe/teams/:teamId/candidates`, a team route of the mapping stream.

## 2. The parts

### K5-1 — "Go there" from every card (frontend only)

The panel of each kind gets one clear button to where its work is done. Back returns to the same day (K4-0).

| Kind | Button | Opens |
|---|---|---|
| A Builder training (planned group) | *Open in Builder* (coach) | The Builder on that plan's week and day |
| A Tests schedule | *Open in Tests* | Tests on that schedule's day, to enter results |
| An RPE schedule | *Open in Training Load* | Training Load › Schedule on that schedule |
| An activity | *Open in Training Load* (exists) | The activity; *Roster* when someone still needs an attendance state |
| An event | its folded items' buttons, in the order above | — |

### K5-2 — GPS visible, and small marks for what is not in an event (frontend only)

- **The GPS icon.** An imported activity (device data) gets the `gps` icon. An event with a folded import shows a
  small GPS mark on its card, for example "📡 GPS · 18". The click opens the import's activity in Training Load (K5-1).
- **What an event holds (H4).** An event card carries a small icon for each kind of item it really holds: RPE, GPS,
  test. The icons are the same as on the chips and in the filter. They are only a mark: no number and no state on the
  card; the state stays in the card's status line and in the panel, as today.
  - What the answer already says (`backend/src/calendarQuery.js`, the card's output):
    - RPE: the event collects RPE when `expects` contains `rpe`, or `scheduleFold.external` is `folded`;
    - test: `expects` contains `test_result`, or `scheduleFold.test` is `folded`;
    - GPS: **not exact today.** `expects` with `device_data` says only that the event waits for device data, and
      `links.activityIds` does not tell an import from a coach-made activity. The card already knows it inside the read
      (`fold.activities[].imported`); K5-2 adds it to the output as one boolean, `holdsImport`. It is a small backend
      change with no migration, and the reader who sees the event's activities already sees their ids.
  - The GPS icon means an import is linked. An event that waits for device data with none linked yet gets no GPS icon;
    its status line says what is missing, as today.
  - No icon for a kind the event does not hold. A schedule shown beside the event (`separate`) keeps its own chip and
    gives the event no icon.
  - An athlete's reduced card gets no icons: her RPE request and her test stay their own cards beside the event, as
    today (an athlete's view folds no schedule), and she sees no mark about the team.
  - On a phone the icons sit in one row with the event type's icon, at most three, and never push the title out of
    view.
- **Small marks.** A test, an RPE request or an activity that is in no event is a compact chip under its day, not a
  full card. Examples: "🧪 CMJ test", "📡 GPS 10:05", "RPE request". A click opens its panel, and from there *Go
  there*. The filters (FE-D16) keep working.

- **Find it fast (H3).** The filter, which today has the kind chips Events, Planned training, Activities, RPE
  requests and Scheduled tests, plus the event types, gains **GPS imports**.
  - What GPS imports shows:
    - activities whose origin is an import (the card's `origin` / `measuredSource`, already in the answer);
    - events with a folded import;
    - after K5-4, the "waiting for import" day marks.
  - This filtering happens on the client over the answer the calendar already reads; no backend change.
  - Each chip can be chosen alone, as *Only GPS imports* and then something else, so one kind can be found in one tap.
    The designer decides how *only this* reads on a phone.
  - It must work together with FE-D16: when only kinds other than events are chosen, the read asks for exactly those
    kinds.

### K5-3 — "Add to the event?" (frontend over existing routes; to be verified in the contract)

When a test schedule, an RPE schedule or an activity stands alone on a day that has a training or match event in the
same half of the day (O15 of the K4 plan), with athletes in common, its panel offers: "Add to ‘Training 10:00’?",
with [Add] and [Leave].
- It is a suggestion and is never done automatically.
- Activities use the existing `POST /api/calendar/events/:eventId/activities`.
- For tests and RPE schedules, the contract checks how an existing event takes a schedule (the event's
  `external_schedule_id` / `test_schedule_id`, through `PATCH /api/calendar/events/:eventId`), and whether a route
  change is needed.
- The rule of one RPE channel per event holds, and its refusals read as the sentences of #643.

### K5-4 — GPS sessions waiting for import (the OptiMove manager's answers, 2026-11-19)

The manager agrees with the direction, on one condition: the calendar **writes nothing into another module and
duplicates none of its rules**. It only reads, and leads there.

**(a) The calendar may read `GET /api/training-load/gpexe/teams/:teamId/candidates`, within these limits:**

- **No GPEXE request.** The route reads only the stored candidates and never sends a request to GPEXE. The calendar
  never starts *Find new sessions* (`POST …/checks`); that stays in Imports, on a click.
- **Who reads it.** The route answers the same 404 to anyone who is not the team's coach, the club's admin or a
  platform admin in the right workspace.
  - The calendar calls it only for the active workspace's team, and treats a 404 or 403 silently: no mark and no
    message.
  - An athlete never calls it.
- **How often.** One read per team per week shown. It is cached in memory until the week or the workspace changes,
  or until a realtime or manual refresh. There is no polling.
- **How accurate the mark can be.**
  - The list is capped at 200 rows, is not filtered by date, and does not return replaced versions. So a mark says
    only that GPS sessions are waiting, for a day the answer shows.
  - If exactly 200 rows arrive, the number is not shown as final.
  - The day is the session's date from the candidate (a naive day, with no time zone), as in the Imports calendar.
- **What is counted.**
  - Only candidates that are neither imported nor *Stays out*.
  - *Ready to import* is told apart from *Needs attention* by the same fields Imports uses (`approvalBlockers`,
    `reasons`, `blockedCode`). That logic is imported from `frontend/gpexe-import-*.js`, never rewritten.
- **What is shown.** Only the GPS icon and the number of sessions. Never an athlete's name, a GPEXE id or a value.
- **A longer period.** If an exact count per day over a longer period is ever needed, it is a small new read route
  (`from` / `to`, numbers only), built by the mapping stream. The existing route is not widened from the calendar
  stream.

**(b) Imports opening on a given day: yes.** The calendar stream builds it, with the manager's GO, as its own small
frontend PR (★, his gate).

- Imports already has a local day filter in its sessions calendar (Phase 4b). Only an entry "open on day D" is
  needed, which sets that filter (and the team), plus a *Back to calendar* band in the K4-0 pattern.
- **Conditions:**
  - no backend change;
  - Imports' guards (a batch in flight, an unconfirmed outcome) are untouched;
  - `frontend/gpexe-import-{view,actions,data}.js` otherwise belong to the mapping stream, so the calendar stream
    tells the manager before it starts, to avoid a clash with his pull requests.

### K5-5 — the way back to the hub from the module calendars (frontend only)

- Tests' week, the Training Load calendar and Coach Home's day each get *Open in calendar*, which opens that day in
  the central calendar.
- They stay as they are otherwise. Whether any of them is retired later is the owner's decision after the pilot.

## 3. Order and reviews

1. **K5-1 and K5-2:** one small package after K3 / K2c-3 and K4a-F, frontend except H4's one output field
   (`holdsImport`). The reviews are `code-reviewer`, `mobile-qa` and `ux-design-reviewer`, plus a browser check at
   1280 / 390 / 375 / 360 px, the Frontend PR gate, and the whole disposable backend run for the calendar reader.
2. **K5-3:** its own contract first. If a route changes, add `security-reviewer`.
3. **K5-4:** the manager answered (a) and (b) (section K5-4). Its contract comes next, and the Imports entry is its own
   small PR, announced to the manager before it starts.
4. **K5-5:** a small frontend change; it may go with K5-1.

The designer makes mockups of K5-1 and K5-2 (the GPS icon, the event's icons of H4, the chips and *Go there*) before any code, and the owner
approves them, as for K4.
