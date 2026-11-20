# Central calendar — K7: the time grid like a professional calendar (UI contract)

Status: **Decided by the stream manager** (2026-11-20): Q1–Q7 as recommended (section 7). Written against `main`
`39b1ecef`; the facts of section 1 re-checked on `de16eccf`, after #688 (K5-2) merged. Built in the same pull request
(section 9, "As built").

**The owner's words** (2026-11-20, about the week's time grid, where two overlapping trainings 00:00–01:00 and
00:30–01:29 both sit stacked in the 00:00 row): „Kada imamo neke sesije koje se preklapaju kako si to smislio da se
ogleda na kalendaru … kako bi bilo to na nekom klupskom kalendaru ok za prikaz?" and „Ne mora da crta slike samo da se
to uskladi kako bi profi kalendar to prikazivao". So: no mockups; the grid behaves like Google Calendar or Outlook.

**Tier:** ordinary (frontend only, a screen, no access change). Reviews: `code-reviewer`, `mobile-qa`,
`ux-design-reviewer` in one round; a real browser at 1280 and 1024 px with overlapping cards; the Frontend PR gate.
K5-4 merged first (#695): the build merges `main` and places its mark (section 9).

## 1. Facts before K7 (file:line on `de16eccf`)

- **The grid is wide-only and week-only.** `renderBodyHtml` draws it only for `layout === "wide"` (≥ 1024 px) and
  `cal.weekMode === "grid"` (the List / Time grid switch, shown only on the wide week, `:713-718`); every other case is
  a list (`frontend/central-calendar-view.js:954-955`). The Day view is always the selected-day list (`:949`).
- **Rows by hour, one fixed card height.** `hourOf()` reads only the hour of `startTime` (`:785-788`). A card sits in
  its start hour's cell, whatever its minute or length (`:811-816`); two overlapping cards stack in that cell. The rows
  run 06:00–21:00 (`DAY_GRID_START_HOUR` / `_END_HOUR`, `:98-99`), widened to the earliest and latest start hour
  (`:795-804`); an end time never widens them.
- **"No set time" band** (`:807-810`, `:821`): every visible item without a `startTime`, e.g. a planned training that
  has only its slot.
- **What the answer carries** (`backend/src/calendarQuery.js`):
  - an **event** has `startTime` and `endTime` (`:1246`) and a `span { from, to }` (`:1255`). A single-day event's end
    is always after its start (`migrations_v2/202610311000_calendar_v49_events.sql:254`), so a one-day event never
    crosses midnight. A multi-day event (`end_day > day`) gives one card per day, each with the event's own start and
    end times;
  - a **planned** training, an **activity**, an **RPE request** and a **test** have a `startTime` at most (the
    session's time, the activity's start, the window's opening time: `:1044`, `:1110`, `:1214`), never an end or a
    duration.
- **The team colour** is on the card itself (`renderCentralCalendarCardHtml`, unchanged here).
- **K5-2 (#688, merged)** draws every `test`, `external` and `activity` item as a day **chip** (`DAY_CHIP_KINDS`,
  `:84`), about a third of a card high. In the time grid a chip sits in its hour's cell like a card, and a chip with no
  time in the No set time row (`renderDayItemHtml` in `:809` and `:815`; `docs/ai/central-calendar-k5-12-contract.md`
  2.4).
- **K5-4** (#695, merged after these facts were taken, at `5a36b057`) draws a day **mark** for GPS sessions waiting;
  "in the wide time grid it sits in the No set time row: it has no hour" (`docs/ai/central-calendar-k5-4-contract.md`
  2.1).

## 2. The layout rule

One pure function lays out one column's items; the view only draws what it returns:

```
centralCalendarTimeLayout(items, { startHour, endHour, maxColumns }) →
  { placed: [{ item, top, height, column, columns }], more: [{ top, height, column, columns, items }] }
```

`top` and `height` are in minutes from `startHour`; the CSS turns them into pixels (`--cc-hour-px`, 48 px today,
one custom property). The function lays out a column, not a day, so it is tested on its own.

### 2.1 Minute position and length

- **Top** = the start's minutes from `startHour` (09:30 with the grid at 06:00 → 210 minutes).
- **Height** = `endTime − startTime` when the item has an end (an event).
- **No end** (a planned training, an activity, a chip): a **nominal 30 minutes** for the layout. It is drawn with an
  open lower edge (a fading bottom, no line), and its label shows the start alone ("10:00"), so the grid never claims a
  length it does not know (Q2).
- **A short event** (under 30 minutes, e.g. 10:00–10:10) is drawn **30 minutes high**: one line, "10:00 Title", the
  rest in its title tooltip and `aria-label`. Overlap is computed on the **drawn** extent, not the real one, so two
  short events 10 minutes apart never draw over each other (Google does the same).
- **The grid's hours:** 06:00–21:00 as before, widened to the earliest start and to the latest **drawn end**, rounded
  up to the next hour, never past 24:00. The owner's example (00:00–01:00 and 00:30–01:29) opens the grid at 00:00.
- **Past the last hour:** a drawn end is never past 24:00, because the grid then ends at 24:00; a single-day event
  cannot end after midnight (v49 `:254`).
- **Midnight-crossing and multi-day events** (`span.from < span.to`) do **not** go in the timed part: they go in the
  band (2.4), on each of their days, with "Day 2 of 3" (`centralCalendarSpanLabel`, `:356`) and their times on the
  first and last day ("from 10:00", "until 16:00"). A multi-day event drawn at 10:00 on every day of a camp, as before,
  would claim three trainings.

### 2.2 Overlaps side by side (Google's rule)

1. Sort the column's timed items by drawn start, then the **longer first**, then the server's order (stable).
2. **Clusters:** walk the sorted items; an item starts a new cluster when its start is at or after the drawn end of
   every item in the current cluster (the cluster's running maximum end). Overlap is transitive inside a cluster: if A
   overlaps B and B overlaps C, all three share the cluster's columns even when A and C do not touch.
3. **Columns:** inside a cluster, each item takes the **first column** whose last item has already ended (drawn end ≤
   this start); otherwise a new column. `columns` = the cluster's column count; each item is `1/columns` wide, at
   `column/columns`. Touching is not overlapping: 10:00–11:00 and 11:00–12:00 stay full width.
4. **Width to the right (Google's expansion):** an item spreads over the columns to its right that are free for its
   whole drawn extent (e.g. one long item beside two short ones that follow each other). It never covers another
   item.
5. **The team colour** stays on each card; a narrow card keeps its colour stripe and its start time first, its title
   cut with an ellipsis, the whole in the tooltip and `aria-label`.

### 2.3 Too many at once: "+N more"

- **Week view:** at most **3 columns** per cluster (`maxColumns: 3`). When a cluster needs more, columns 1 and 2 are
  drawn as above and the **third column** is one button, **"+N more"**, from the earliest start to the latest drawn end
  of the items that did not fit (N = their count). Which items fit: the ones placed in columns 1 and 2 by 2.2, so the
  earliest and the longest stay visible.
- **Day view (wide):** one column is about seven times wider, so `maxColumns: 6`.
- **The click** opens that day in the **Day view list** (`data-action="central-calendar-open-day"`, the day head's own
  action, `:769`), where every item of the day is listed in the server's order; no new panel (Q3).
- `aria-label`: "3 more items, Monday 12 October, from 10:00: open the day".

### 2.4 The band above the hours

The band keeps its name, **"No set time"** (Q4). It holds, per day, in this order:
1. multi-day events (2.1);
2. cards without a `startTime` (a slot-only planned training, as before);
3. K5-2's chips without a time;
4. K5-4's GPS mark, last (its contract 2.1).

A band cell that holds more than **3** of these shows 3 and "+N more", which opens the day like 2.3. The band's
height is the tallest day's, so the hours below stay aligned across the week.

### 2.5 K5's chips and K5-4's mark in the grid

- **A chip with a time** is a timed item: drawn at its minute, one chip high (about a third of a card, at least
  24 px), laid out with a nominal 30 minutes like any item without an end, so it takes part in clusters and columns
  and never draws over a card. A chip never makes the "+N" button by itself: if a cluster is full, chips are the
  first to move into "+N" (cards keep their columns), because a chip only links to its own panel.
- **A chip without a time** and **the K5-4 mark** stay in the band (2.4).
- **Whichever merges second** (K7 or K5-4) adapts its own part; the layout function does not know chips or marks by
  name, only `{ start, end, kind }`.

## 3. The views

| View | Phone (< 640) | Medium (640–1023) | Wide (≥ 1024) |
|---|---|---|---|
| Week | the strip and the day list, **unchanged** | columns (list), unchanged | List (unchanged) or **Time grid (this contract)** |
| Day | the list, unchanged | the list, unchanged | List, or the **Day time grid** when the switch says Time grid (Q1) |
| Month | unchanged | unchanged | unchanged |

- **The Day time grid:** one column across the width, the same hours, band and rules, `maxColumns: 6`. The List /
  Time grid switch (`:713-718`, stored by `readCentralCalendarWeekMode`) is shown on the Day view too and keeps one
  choice for both.
- **The panel open at 1024 px:** the grid scrolls sideways inside its box, as before (`min-width: 826px`); a column is
  never narrower than ~110 px, so a third of it (~36 px) still shows a time and a colour stripe.

## 4. Drawing (CSS, for the build)

- The body is one row: the hour gutter and the day columns. Each day column is `position: relative` with
  `height = hours × --cc-hour-px`; its hour lines are a repeating background, not one element per hour.
- An item is `position: absolute` with `top`, `height`, `left: column/columns`, `width: span/columns` (as
  `calc(%)`, with a 2 px gap). The band and the head stay CSS-grid rows over the same columns, so heads, band and
  columns line up.
- Today's column keeps its tint. **No "now" line** in K7 (Q5).

## 5. Keyboard and screen reader

- **DOM order is reading order:** the heads, then the band (day by day), then **day by day** the column's items in
  the layout order (start, longer first, server order), each day's "+N more" after its items. Before K7 the order was
  hour by hour across the week (row-major); a screen reader then mixed days. Google and Outlook read day by day.
- Each day column is a `role="list"` with `aria-label` = the long date and its count ("Monday 12 October, 5 items");
  each item keeps its button and its current `aria-label`, which already says the time ("10:00–11:30") and the team.
- No absolute position changes the order: focus moves by Tab in DOM order; the visible order inside a cluster is the
  same (left to right is the column order, which follows the start order).
- The hour gutter is `aria-hidden`; hours are in every item's label.

## 6. Tests

**Unit, the layout function** (`frontend/tests/central-calendar-timegrid.test.mjs`, new):
1. minute position (09:30 at 06:00 → 210) and height from the end;
2. an item without an end: 30 minutes, the open-end flag;
3. a short event (10:00–10:10) drawn 30 minutes; two short events 10 minutes apart: two columns, not drawn over;
4. touching (10–11, 11–12): one column each, full width;
5. the owner's pair (00:00–01:00, 00:30–01:29): two columns, side by side; the grid starts at 00:00;
6. transitive cluster (A–B, B–C overlap, A–C not): one cluster, two columns, C reuses A's column;
7. expansion to the right (one long beside two that follow each other): the long one spreads only where free;
8. four overlapping in the week: two columns and "+2 more" with the right N, top and height; six in the Day view:
   six columns, no "+N"; seven: five and "+2";
9. chips move to "+N" before cards;
10. the grid's hours widen to the latest drawn end, never past 24:00;
11. a multi-day event goes to the band on each of its days, with "Day 2 of 3"; never timed;
12. stable order: equal starts and lengths keep the server's order.

**DOM** (the same file): DOM order day by day; each day column a list with its label; "+N more" opens the day
(`central-calendar-open-day` with the date); the band's order (2.4) and its own "+N"; the team colour on a narrow
card; the Day time grid only on wide with the switch on Time grid; the phone and the medium layouts byte-for-byte as
before (snapshot of the HTML before K7 for a fixed answer).

**Mutations** (each must fail a test): the "longer first" tie-break; `>=` for "touching is not overlapping"; the
cluster's running maximum end (use only the previous item's end); the first free column (always a new column);
`maxColumns` ignored; drawn end vs real end in the overlap test; the band's rule for a multi-day event.

**e2e, a real browser** (`e2e/tests/central-calendar-timegrid.test.mjs`, new; coach, real server): at 1280 and
1024 px, the owner's two trainings and a cluster of five:
- the two cards' boxes side by side (no overlapping rectangles), each starting at its minute (top difference = 30 min
  × px), heights proportional;
- "+N more" with the right N; its click shows the Day list with all five;
- the team colour on each card; no horizontal page scroll; with the panel open at 1024 px the grid scrolls in its box;
- Tab order day by day; the phone (390) unchanged: the strip and the day list.

## 7. Questions and decisions

The stream manager decided all seven as recommended (2026-11-20).

- **Q1. The Day view as a time grid.** **Yes on wide**, behind the same List / Time grid switch, so a day with
  overlaps reads as the week does; phone and medium keep the list.
- **Q2. An item without an end time.** **30 minutes drawn, with an open lower edge** and the start time alone.
  Alternatives were the planned session's real length (not in the answer) or 60 minutes (claims more than we know).
- **Q3. Where "+N more" goes.** **The Day view list** of that day, which already lists everything in order; a popover
  would be a second list to maintain.
- **Q4. The band's name.** **Keep "No set time"**: the band also holds multi-day events, but every user already reads
  it; "All day" would be wrong for a slot-only training.
- **Q5. A "now" line on today.** **Not in K7.**
- **Q6. Multi-day events as one bar across the days** (Google's spanning bar). **Not in K7**: one entry per day in
  the band with "Day 2 of 3".
- **Q7. The threshold.** **3 columns in the week, 6 in the Day view** (at 1024 px a week column is ~110 px; a fourth
  column would be ~25 px, below a readable time).

## 8. Not in K7

The phone and medium layouts; the Month view; any backend field (a planned session's length); the Day view by team;
a "now" line; spanning multi-day bars; dragging to move or resize.

## 9. As built

- **The layout:** `frontend/central-calendar-timegrid.js` — `centralCalendarTimeLayout` (2.1–2.3) and
  `centralCalendarGridHours` (the hours: the default runs 06:00 to 22:00, its last row the 21:00 hour as before). An
  entry is `{ item, start, end, minor }`, `minor` for a chip.
- **The view:** `renderTimeGridHtml` in `frontend/central-calendar-view.js` draws the week and the Day time grid; the
  band (2.4) shows multi-day events with "from 10:00" / "until 16:00" (`centralCalendarSpanWhenLabel`).
- **"+N more" opens the Day list even with the switch on Time grid:** the button carries `data-day-list="1"`, which
  sets `cal.dayList`; the Day view then draws its list and the switch shows List, until the next view, day or mode
  change. Without it, the Day time grid's own "+N more" would open itself.
- **K5-4's mark** (#695) merged first, so K7 adapted (2.5): the mark is the band's last entry and counts toward its
  3 (a fourth entry goes into the band's "+N more", and the Day list shows the mark).
- **Unchanged layouts:** `frontend/tests/support/central-calendar-k7-unchanged.json` is the HTML of 15 cases (phone and
  medium in every view and mode, the wide week as a List, the wide Month) rendered on `5a36b057` (main with K5-2 and
  K5-4) before K7, from the fixed answer of `central-calendar-k7-scenario.mjs`; the suite compares the head's HTML with
  it byte for byte.
