# Central calendar — K5 plan: the calendar as the hub of the app's activities

Status: **Proposed** (2026-11-19, written against `main` `1a5cdb79`). This plan contains no code. Each part needs a
UI contract and the manager's GO. The part that touches Imports (K5-4) is agreed with the OptiMove manager first,
because Imports belongs to his mapping stream.

## 0. The owner's direction (2026-11-19, in the calendar stream's chat)

| | The owner's words | Read as |
|---|---|---|
| **H1** | „Mi sada sa ovim u stvari hoćemo na neki način i da centralizujemo u kalendaru aktivnosti aplikacije. Sve što ima neki vid nedeljne kalendarske opcije npr testiranja, gps uvozi trebalo bi da budu deo nekog događaja ili ako nisu deo događaja da se nekako obeleže na kalendaru na neki prostor i jednostavan način da kroz klik možemo otići tamo gde treba....razmisli i o tome" | The central calendar becomes the hub. Everything with a date (trainings, tests, RPE requests, GPS imports) is part of an event. If it is not, it is marked on the calendar in a small, simple way, and one click takes you where its work is done. |
| **H2** | „Npr gps uvoz mi bismo trebali i na glavnom kalendaru da vidimo neki gps ikonicu ili nesto preko čega bismo mogli ući dalje" | GPS is visible on the main calendar with a GPS icon, and a click goes on from there. |
| **H3** | „U filteru moze da se izabere samo gps uvozi... zatim nesto drugo.... Da možemo lako naci" | The calendar's filter has a choice for each kind of activity: GPS imports, tests, RPE requests, trainings and events by type. Choosing one shows only that kind, so it is easy to find. |

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

### K5-4 — GPS sessions waiting for import (with the OptiMove manager's mapping stream)

- **The mark.** A day mark such as "📡 2 GPS sessions to review". Its click opens Imports on that day.
- **The data.** The count comes from the existing candidates route of the workspace's team or teams, so there is no
  new backend in the calendar stream. Two questions are for the OptiMove manager:
  - (a) whether the calendar may read that route, and how often (cache, one read per week shown);
  - (b) whether Imports takes a day to open on, which is a small change in his screen.
- **Who sees it.** Only those who see Imports today (the team's coach and the identity administrators). Everyone else
  sees nothing.

### K5-5 — the way back to the hub from the module calendars (frontend only)

- Tests' week, the Training Load calendar and Coach Home's day each get *Open in calendar*, which opens that day in
  the central calendar.
- They stay as they are otherwise. Whether any of them is retired later is the owner's decision after the pilot.

## 3. Order and reviews

1. **K5-1 and K5-2:** one small frontend package after K3 / K2c-3 and K4a-F. The reviews are `code-reviewer`,
   `mobile-qa` and `ux-design-reviewer`, plus a browser check at 1280 / 390 / 375 / 360 px and the Frontend PR gate.
2. **K5-3:** its own contract first. If a route changes, add `security-reviewer`.
3. **K5-4:** first the OptiMove manager's answers to (a) and (b), then the contract.
4. **K5-5:** a small frontend change; it may go with K5-1.

The designer makes mockups of K5-1 and K5-2 (the GPS icon, the chips and *Go there*) before any code, and the owner
approves them, as for K4.
