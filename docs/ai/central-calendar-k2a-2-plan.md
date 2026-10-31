# Central calendar — K2a-2 plan: events in the screen (frontend only)

Status: **built in the K2a-2 pull request**, on the K2a-1a API (PR #298: `backend/src/routes/calendarEvents.js`,
`calendarEventService.js`, `calendarEventAccess.js`, the `kind: "event"` items of `GET /api/calendar`). The
product decisions are D18–D23 of `docs/ai/central-calendar-k2a-plan.md` section 10 and the owner's design request of
2026-10-30 (relayed by the manager); the screen is K1b's (`docs/ai/central-calendar-k1b-plan.md`). **No backend
change.** Not in it: the Builder ↔ event attach (K2a-1b's routes — the hook is section 6), Settings → Calendar and
the type icons as data (K2b), the athlete's *Upcoming events* list (K2b).

## 1. First item (the independent review of #298, LOW-8)

- `CENTRAL_CALENDAR_KINDS` gains `event`; the Types chips are **Events**, **Planned training**, **Activities**,
  **RPE requests** (choice 9.10: `external` is no longer called "Events"), **Tests**.
- An event card says what it is: `Event · <type label>` (`Event · Match · 18 athletes`); an external card says
  `RPE request · …`; a planned card `Planned training · …` (the K1b §13 option, needed now that an event of kind
  *training* has its own chip *Training*).
- Recorded, by design: with **`kinds=external` alone** a referenced schedule's card that the server folds under its
  event is **not** shown on that day — the fold is the server's (K2a plan 1.4) and the chips only hide whole cards
  (K1b decision A). The screen never sends `kinds`, so this concerns API callers only; on the screen the folded
  schedule's facts are on the event card.

## 2. The filters panel (the owner's design request)

- One **Filters** button (`aria-expanded`) over the chips; collapsed by default, with one summary line —
  *All groups · all types*, or the chosen names (two at most, then "3 groups" / "4 types"). The chips stay in the
  markup (`hidden`) so their sideways scroll and the focus survive a repaint (K1b's capture / restore).
- **Groups**: *All groups N* (pressed when nothing is chosen; a tap clears the choice) and one chip per team with its
  colour dot and count. **Types**: *All types N*, then the five kinds above with an icon and a count. **Event
  types** (a third row, only while an event is on the displayed days or a type is chosen): one chip per event kind
  with its icon and count — *Training, Match, Test, Travel, Meeting, Day off, Camp*.
- Semantics (still decision A — whole cards, no request): a card passes the type filter when its kind is chosen, or
  it is an event whose kind is chosen. *Events* + *Match* = every event; *Match* alone = the matches only.
- Counts: over the displayed days of the unfiltered answer, as K1b; *All groups* / *All types* count every card.
- The chip text is 13 px (11 px counts), as the panel's team pills; a chip is 44 px tall on a phone, a tablet and a
  touch screen, 36 px on a pointer screen of 1024 px and up (K1b's compact-card rule).

## 3. The card, the day, the strip

- **Icons** by type — events by their kind (training `run`, match `trophy`, test `clipboard`, travel `route`,
  meeting `team`, day off `bed`, camp `mountain`), the other kinds by theirs (planned `barbell`, activity `activity`,
  RPE request `gauge`, test `clipboard`) — from `icon-library.js` through `renderIconSvg`, never a stored value
  (K2b makes a type's icon editable).
- A **team pill** (the first team's colour and name) on every card that names a team; further teams stay dots.
- A **status pill**: *Planned* now shows (K1b showed nothing), and an event that expects nothing reads *Planned*
  until its day; *Cancelled*, *Done*, *Awaiting RPE / result / attendance / device data*, *Missed* as before.
- An event card also shows its end time (`17:30–19:00`), its place, and *Day 2 of 3* on a multi-day event.
- The selected day's list (a phone's week and month, the Day view): the cards with a time or a slot in the
  server's order, then a **No time** section with the cards that have neither (a stable split — nothing is
  re-sorted). Above it, a **per-team row**: *U19 · 1 item*, *U13 · 0 items* (the visible cards of that day; the
  screen's word is *item*, as its aria-labels — the owner's screenshot said *event*, recorded in section 8).
- The phone's **week strip**: one team-colour dot per team with a visible card that day (four at most).

## 4. Create, edit, cancel

- **New event** (toolbar) only in a club, team or private-coach workspace (the server's verdict decides again;
  the platform workspace and the athlete never see it). It opens the form in the panel's place (side column ≥ 1024
  px, bottom sheet below), on the selected day.
- **Edit** and **Cancel event** in an event's panel only when the card says `canManage` and it is not cancelled
  (D18: the club admin also on its teams' events). Edit reads `GET /api/calendar/events/:id` first.
- Fields: type (`GET /api/calendar/events/types`), title, day + optional last day (D22), optional start / end time,
  place, targets, what is expected after it, notes (coaches only). The type's `defaultExpects` come pre-ticked and
  stay editable (D19: *RPE*, *GPS / device data*, *Test result — a wellness check-in counts as a test*); a type
  change re-ticks them until the coach touched them. The time zone is the browser's.
- **Targets** by the owner: a club event — the whole club, its teams, athletes; a team event — the team, athletes;
  a private coach's — athletes, with *Choose all my athletes* (choice 9.17). Athletes come from the workspace roster
  (`state.athletes`) behind a search. On edit, a target the lists do not hold stays with its name and can be
  unticked. In the **platform** workspace (support) the type and the targets are read-only.
- Edit sends only what changed (`PATCH`, `expectedRevision`); cancel (`POST …/cancel`) is behind a confirmation in
  the panel that names the event and its day, with an optional reason.
- Every write has a `requestKey` made when it is sent. **Answers**: a success closes the form, reloads the
  calendar and opens the event's panel; a **stated refusal** (a 4xx with a code, `500 internal_error`) shows its
  sentence and nothing changed; the identical **404** → "This event is no longer available in this workspace." and
  a reload; `event_changed` / `event_cancelled` close the form with their sentence and reload. **No answer**, `503
  outcome_unknown` or an uncoded 5xx → *Result not confirmed* with **Check result**, which sends the SAME body with
  the SAME key (never by itself); only an answer given after the server read its request record settles a check
  (the success, `event_changed`, `event_cancelled`, `type_not_available`, `target_not_available`, a 400 of the same
  body); any other leaves it not confirmed with one line why. The form is locked while a write is in flight or
  not confirmed.
- **Leaving**: closing the form, another item, Escape / Back, a workspace switch (app.js `askLeaveTrainingLoad`)
  and the page's unload ask first while a write is in flight, not confirmed, or the form holds unsaved values. A
  move to another menu keeps the form (the slice is kept).

## 5. Modules

`central-calendar-view.js` (chips, card, day, strip, the event panel), `central-calendar-event-form.js` (new: the
form's state and its template — the K1b view stays readable), `central-calendar-actions.js` (the handlers, the
writes' outcomes, the leave guards), `central-calendar-data.js` (the event reads and writes), `state.js`
(`filters.eventKinds`, `filtersOpen`, `eventTypes`, `form`), `app.js` glue (input / change / submit routing, the
leave guards), CSS `cc-*`. Tests: `central-calendar-events.actions.test.mjs` (new) and the K1b suite updated for the
renamed words and the *Planned* pill.

## 6. The hook left for K2a-1b

The event panel's action row has one place for *Attach a training* / *Attach an activity*
(`renderEventActionsHtml` in the view, marked `K2a-1b`), and the planned card's panel has none yet; the attach
command, its `alignSessions` choice and the orphaned-link note come with K2a-1b's routes.

## 7. Tests and QA

Through the real handlers with the fetch mock: the create / edit / cancel bodies; `requestKey` reuse on *Check
result*; a stated refusal leaves the calendar and the form as they were; a stranger's 404 → the neutral sentence;
the controls only for `canManage`; the chips' counts and the collapsible panel; the event-type chips; the per-team
row and the strip's dots; the No time section; no `data-tab` anywhere; inputs ≥ 16 px. Browser QA on the K1b
harness extended with the event routes, at 1280 and 375 px. Reviewers: `code-reviewer`, `mobile-qa`,
`ux-design-reviewer`.

## 8. For the owner (recorded, not blocking)

- The per-team row's word: *item* (the screen's own word) instead of the screenshot's *event*, because a day also
  holds planned trainings, activities, RPE requests and tests.
- *Planned training* for the Builder's cards (to tell them from an event of type *Training*).
- The panel starts collapsed on every screen; whether a computer should start it open is a one-line change.
