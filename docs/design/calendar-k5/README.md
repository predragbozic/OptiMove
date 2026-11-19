# Calendar K5: the calendar as the hub (mockups)

Status: **Proposed design** (2026-11-19), for the stream manager's review and the owner's approval. Documents and
mockups only: no product code, no route, no migration. Written against `main` `1a5cdb79` and the K5 plan
(`claude/central-calendar-k5-plan`, PR #658: head `7e2d0220`, with the owner's H3 relayed from head `c1b8d210`).
It follows the approved K4 mockups (`docs/design/calendar-k4/`, PR #651); `mockup.css` here starts with a copy of
the K4 base, so this folder stands alone.

| File | What it is |
|---|---|
| `01-k5-1-go-there.html` | K5-1: one "Go there" button in the panel of each kind, and an event's buttons in order |
| `02-k5-2-gps-and-marks.html` | K5-2: the `gps` icon, the GPS mark on an event card, small chips under a day; week and month |
| `03-k5-3-add-to-event.html` | K5-3: "Add to ‘Tactical session 10:00’?" with [Add] [Leave], and its outcomes |
| `04-k5-4-gps-to-review.html` | K5-4: the day mark "2 GPS sessions to review" and Imports opened on that day |
| `05-k5-5-open-in-calendar.html` | K5-5: *Open in calendar* on Tests' week and Coach Home's day |
| `06-h3-filter-only-this.html` | H3 (the owner): the filter's *GPS imports* chip and a one-tap "Show only" |
| `screenshots/NN-…-390.png`, `…-1280.png` | Full-page Playwright screenshots, deviceScaleFactor 2 |
| `build.mjs`, `shoot.mjs` | `node build.mjs` writes the pages; `node shoot.mjs` shoots them and prints overflow and inputs under 16 px (all 0 on the pushed head) |

As in K4: the dark labels are steps, a red dashed outline marked **NEW** is what this design adds, and the rest is
today's look (`cc-card`, `cc-panel`, `cc-badge`, `cc-chip`, `plain-button`, `cc-primary`). Every name, place and
number is invented. The icons `gps`, `clipboard` (tests) and `gauge` (RPE) are the paths of `frontend/icon-library.js`.

**One visual vocabulary for K5:**
- **A card** is an event or a Builder training: what you plan.
- **A chip** (a small pill with a coloured left edge and its kind's icon) is something that is in no event: a test,
  an RPE request or a GPS activity. It is a third of a card's height, so a day stays readable.
- **A mark** inside a card ("GPS · 18") says what the event holds.
- **A dashed amber** shape means "waiting for you" (the GPS to review). Everything has an icon and words, never
  colour alone.
- **Colours** (from the calendar's closed palette): tests violet, RPE amber, GPS blue, as fixed kind colours, so
  they never compete with the team colours of the cards.

---

## 1. K5-1 — "Go there"

**First thing seen:** the panel's facts, then, below a thin line, one full-width primary button with its
destination: *Open in Builder*, *Open in Tests*, *Open in Training Load*. A one-line hint under it says where it
lands ("Opens Tests on Tuesday, to enter results.").

- A GPS activity with missing attendance states shows an amber line "3 athletes need an attendance state." and a
  second button, *Roster · 3 need a state*.
- An **event** lists what it holds ("In this event"), one row per item with its own button, in the plan's order:
  Builder, RPE / Tests, GPS.

Open questions:
- **E1. A trailing arrow (→) on "Go there" buttons?** Recommend yes: it is the only button in the panel that
  *leaves* the calendar, and the arrow says so. Back returns to the same day (K4-0).
- **E2. In an event panel: one button per item, or one "Open…" menu?** Recommend one button per item (at most 3–4
  rows; a menu hides where each one leads).

## 2. K5-2 — GPS and small marks

**First thing seen:** the week as today, plus a blue **GPS · 18** pill on events that hold an import, and small
chips under a day for what stands alone ("CMJ test", "RPE · Gym", "GPS 10:05").

- An imported activity uses the `gps` icon everywhere (chip, panel, month line).
- The month shows one line per item (icon + short text); on a phone only the icon and the day's dot, as the month
  does today.
- A chip's click opens its panel (K5-1), never the module directly, so the coach sees what it is first.

Open questions:
- **E3. "GPS · 18" or "📡 18"?** Recommend the `gps` icon + "GPS · 18" (a word reads at a glance; an emoji renders
  differently on each phone).
- **E4. Chips under the cards, or mixed in by time?** Recommend under the cards: the planned day stays on top, and a
  chip never splits two trainings.

## 3. K5-3 — "Add to the event?"

**First thing seen:** in the lone item's panel, a soft green box: "Add to ‘Tactical session 10:00’?", the reason in
one quiet line ("Same morning, 17 of its 18 athletes are in the event."), and **[Add] [Leave]**.

- Offered only when the day has a training or match in the same half of the day with athletes in common (O15).
- Never automatic. After *Leave* the question is not asked again for that item; its chip stays.
- Outcomes are one sentence: "Added. GPS session 10:05 is now in Tactical session 10:00."; a refusal reads as the
  #643 sentences (e.g. one RPE channel per event).

Open questions:
- **E5. Should the chip on the week hint at the suggestion (a small "+" badge)?** Recommend no for the first step:
  the question lives in the panel only, so the week stays calm.
- **E6. Where is "Leave" remembered?** Recommend per user and item in the browser for the first step (nothing on the
  server); if the pilot wants it shared, the contract adds it.

## 4. K5-4 — GPS sessions to review

**First thing seen:** under the day's cards, a dashed amber row "2 GPS sessions to review" with the `gps` icon.

- Its click opens **Imports filtered to that day**, with *Back to calendar* and *Show all dates*.
- Only for those who see Imports today; everyone else sees nothing (the OptiMove manager's questions (a) and (b) of
  the plan come first).

Open question:
- **E7. Show the count for the whole week in the toolbar too ("5 GPS to review this week")?** Recommend no: one mark
  per day is enough, and the filter of H3 already finds them.

## 5. K5-5 — Open in calendar

- **Tests' week:** *Open in calendar* in the week's bar (the same week), and a quiet *Open this day in calendar* on
  each day.
- **Coach Home's day:** *Open in calendar* on the day's header (today); the day's rows show the same GPS mark.

Open question:
- **E8. A per-day link on Tests, or only the week button?** Recommend both: the week button for planning, the day
  link for "what else happens that day".

## 6. H3 — the filter: GPS imports and "Show only" (the owner)

The owner: „U filteru može da se izabere samo GPS uvozi… zatim nešto drugo… da možemo lako naći."

**First thing seen:** one row of pills above the week: **All · Events · Planned training · GPS imports · Other
activities · RPE requests · Scheduled tests**, each with its icon and this week's count.

- **One tap = only that kind** (the row is a radio group): the week shows only it, and a green line says "Showing
  only **GPS imports** · 5 this week · *Show all*".
- **Another tap switches straight over** (GPS → Scheduled tests), with no clearing first. *All* or *Show all* brings
  everything back.
- The existing multi-choice chips (groups, event types) stay, folded under **More filters**, and combine with the
  choice (for example only GPS of U19).
- **GPS imports** is the new kind: imported activities (device data), events that hold one (with their GPS mark), and
  the "to review" marks. *Other activities* are the rest of today's Activities.
- On a phone the row scrolls sideways and the chosen pill is always scrolled into view (the mockup does this with
  a few lines of script; the code does the same).

Open questions:
- **E9. Keep "Show only" and the old multi-choice kind chips both?** Recommend: "Show only" for kinds (the owner's
  "easy to find"), multi-choice only for groups and event types under *More filters*. Choosing several kinds at once
  is rare; when needed, *All* plus the groups covers it.
- **E10. Remember the choice?** Recommend remembering it for the session (as the filters do today), and showing the
  green line whenever it is not *All*, so nobody forgets that the week is filtered.
- **E11. Does "GPS imports" include events that hold an import?** Recommend yes (as drawn): the owner looks for GPS
  sessions, and many are folded into a training.

---

## Not in these mockups

- Imports, Source fields and the mapping board themselves are not redesigned; screen 04 only sketches the day
  filter at Imports' top, for the OptiMove manager to decide (K5-4 (b)).
- The phone panels are drawn in page flow; in the app the panel is the calendar's existing bottom sheet.
- No browser check on a physical device; reviewers (`ux-design-reviewer`, `mobile-qa`) not run.
