# Calendar K3 / K2c-3 / K4: screen designs (mockups)

Status: **Proposed design** (2026-11-19), for the stream manager's review and the owner's approval. Documents and
mockups only: no product code, no route, no migration. Written against `main` `f406ee2d`, the K4 plan
(`claude/central-calendar-k4-plan`, head `89f26566`, O1–O16) and the K3 / K2c-3 plan (`claude/central-calendar-k3-plan`,
head `fb4f2c39`).

## What is here

| File | What it is |
|---|---|
| `01-k3-plan-the-training.html` | K3: calendar → event panel → *Plan the training* → Builder with the band → *Save and link* → outcome; the "some athletes already have a plan" sheet |
| `02-k2c3-builder-events-row.html` | K2c-3: the Builder's day with the events row, *Create event →*, *Whole day*, `Event: [▾]`, a time outside the event, the open list, the "not saved yet" question |
| `03-k2c3-event-form-from-builder.html` | K2c-3: the calendar's own form opened from the Builder, with its band; the return to the Builder |
| `04-k4a-athlete-calendar.html` | K4a: the athlete's Calendar (a week by days), one card for event + training, *Open training* → Weekly plan with *Back to calendar* |
| `05-k4b-change-rpe.html` | K4b: "Your RPE: 7 · Change" on the card and on Home, the filled-in form, the closed state |
| `06-coach-event-panel-answers.html` | The coach's event panel: summary, each athlete's RPE and duration, the *changed* mark, *Open in Training Load* |
| `screenshots/NN-…-390.png`, `…-1280.png` | Full-page Playwright screenshots, deviceScaleFactor 2 |
| `mockup.css` | Only the new pieces (`k4-` prefix); everything existing comes from `frontend/styles.css` |
| `build.mjs`, `shoot.mjs` | `node build.mjs` writes the six pages; `node shoot.mjs` takes the screenshots and prints, per shot, horizontal overflow and inputs under 16 px (all 0 on the pushed head) |

How to read them: each page is a sequence of steps (dark labels). A red dashed outline marked **NEW** is what this design
adds; the rest is today's look (the real `cc-card`, `cc-panel`, `cc-badge`, `plain-button`, `cc-primary`, `cc-event-form`
classes). Every name, place and number is invented. The Builder parts are an approximation of
`builder-structure.js`: in code the new pieces go into the Builder's own markup, not this mockup's.

The shared look (O13, "no big change"): one new pattern — **the band** (a coloured left bar, the event's icon, title,
day, time, place, count, and one way back) — used both ways; events keep the calendar's palette, icon and stripe; every
state has a glyph and words, never colour alone; 44 px targets, 16 px inputs; on a phone each one-line row stacks and
the main button goes full width.

---

## 1. K3 — Plan the training (the main path, O9)

**What the coach sees first:** in the open event panel, under the event's facts, a section *Training* with one sentence
"No training is planned for this event yet." and the full-width primary button **Plan the training**.

**One primary action per screen:** panel → *Plan the training*; Builder → *Save and link*; outcome → *Back to calendar*.

Design choices:
- The button lives in the panel's own body, above Edit / Cancel event, so it is the first thing after the facts. Once
  sessions are linked it becomes the secondary *Open the training* (see screen 06).
- The Builder opens with **the band** at the top: "Team training · Mon 12.10 · 10:00–11:30 · North field · 18 athletes",
  the line "Sessions on this day go into this event." and **Back to calendar**. On a phone the band is sticky, two lines,
  with *Back to calendar* full width under it.
- The event's day carries the event's colour as a left edge and an "In this event" mark; other days are visibly quieter.
- Each session of that day has an **In this event** toggle (pill with a dot); tapping turns it into a grey *Not in this
  event* with *Put back*. Nothing is written until Save (Q6: in by default).
- A session without its own time shows "10:00 · from the event" (O12); one with its own time shows it (O14).
- **Save and link** replaces the check button while the band is shown, with a line saying what it will do
  ("publishes the plan to the 18 athletes and links 2 sessions"). In the real Builder that bar stays where the check
  button is today (sticky on a phone); in the mockup it is drawn in place.
- Outcomes are one sentence plus one next step (K3 plan 2.5): green for done; amber for "saved, link not confirmed"
  (*Check result*) and "saved, link refused" (*Try linking again*); red for "not saved, nothing linked".
- Case (c) is a bottom sheet on a phone and a dialog on a computer: the counts first, names shortened ("and 2 more"),
  **Plan for the 12** as primary.

Open design questions:
- **D1. Band colour = the event type's colour, or always the accent?** Recommend the type's colour (the coach then sees
  the same colour as on the calendar card), with the icon so it is never colour alone.
- **D2. The "In this event" toggle on every session, or only a "Not in this event" link on hover?** Recommend the
  visible toggle: it is the only place the coach learns which sessions will be linked, and hover does not exist on a phone.

## 2. K2c-3 — the Builder's events row (O8, O10–O15)

**What the coach sees first:** under the day's label, a grey row "Events:" with the day's event chips and, at its end,
**Create event →**.

**One primary action:** none forced — this is a planning screen. The most important control per session is
`Event: [▾]`. *Create event →* is secondary on purpose (O9: the calendar is the main way in).

Design choices:
- Chips use the calendar's card language: colour stripe + type icon + title + time · place. An event the coach does not
  manage has a **lock** icon, dashed border and "Managed by the club"; in the list it is shown but not choosable, with
  "Linked by the club's admin from the calendar."
- `Event: [▾]` is a native select (16 px), right of the session's name on a computer and on its own line on a phone. A
  linked select carries the event's colour on its left edge.
- **Whole day:** one select above the sessions, "Choose an event for every session…".
- The list offers **only the same day and only the session's half of the day** (O11, O15). Screen 02 step 2 draws the
  open list for an AM session: the morning training (choosable), a locked club event, and *No event*.
- **Time doesn't fit** (O14): an amber line with a clock glyph — "Main session is at 08:00, outside the event
  (10:00–11:30). Change its time first." — and **Use the event's time**. **The event moved later**: "Outside the event's
  time (11:00–12:30)" with *Use the event's time* and *Open the event*. Never changed silently.
- **Not saved yet:** asked once, one question, two buttons: *Save and continue* / *Cancel*.

Open design questions:
- **D3. Hide or disable events of the other half of the day in the list?** Recommend **hide** (the coach can't choose
  them anyway; a disabled row needs an explanation). A locked event of the right half stays visible because the coach
  must learn why it can't be chosen.
- **D4. The events row on every day, or only on days with events?** Recommend: on every day of a weekly plan, with just
  *Create event →* when the day has none — the way in stays in the same place.
- **D5. "Whole day" always visible, or only when the day has 2+ sessions and 1+ event?** Recommend the latter (less
  noise on a light day).

## 3. K2c-3 — the calendar's form, from the Builder

**What the coach sees first:** an amber band "Creating an event for the Builder · Monday 12.10" with the line "After
Create event you go back to the Builder, with this event chosen for Main session." and **Back to the Builder**; under it
the calendar's own *New event* form, prefilled.

**One primary action:** *Create event* (the form's own button). *Back to the Builder* / *Close* make nothing.

Design choices:
- One event form in the app (O10): only the band is new. The band is amber (a "you are on a detour" colour), not the
  event's colour, because the event doesn't exist yet.
- Prefilled: Type Training, Title = the session's name, Day, Starts / Ends, Who = the team chip "U19 · 18 athletes ·
  from the plan" (K3 plan Q8: the team when every athlete is the team's), Place = the team's default place.
- After *Create event*: back in the Builder, a green line naming the new event, the chip in the events row, and the
  session's `Event:` already set to it.

Open design question:
- **D6. Should the band name the session ("…for Main session") or only the day?** Recommend naming the session when the
  coach started from one, otherwise the day only.

## 4. K4a — the athlete's Calendar

**What the athlete sees first:** the week strip (phone) with today highlighted and dots on days that have something,
then **today's card**.

**One primary action:** on a card with an open question, **Rate RPE** (primary, green); otherwise **Open training**.

Design choices:
- A list by day, empty days left out (K4 plan section 2). On a phone a 7-day strip on top; tapping a day scrolls to it.
- **Card:** colour stripe + type icon + time + type word; title; place with *Open in maps*; for a linked event the
  sessions inside as a small grey list ("Before · Mobility & activation · 15 min", "Training · Main session · 10:30");
  then the buttons. Event + training is **one card** (O3).
- A plan session with no event is its own card ("My training", the plan colour).
- *Cancelled* uses the calendar's existing ✕ badge, title struck through, no place, no buttons.
- **Open training** opens the Weekly plan on that day; the Weekly plan shows **Back to calendar** at the top, beside the
  day and event name. Back (button or the phone's) returns to the same week, day and scroll (O1).

Open design questions:
- **D7. Show the sessions inside the card, or only "Open training"?** Recommend the short list (names and times only, no
  exercises): the athlete sees what the day holds without a tap; exercises stay in the Weekly plan (K4 plan: option B later).
- **D8. Calendar tab first in the athlete rail?** As the plan says (K4a-1), with *Weekly plan* kept beside it.

## 5. K4b — changing an RPE answer (O4)

**What the athlete sees first:** a green line on the card "✓ Your RPE: 7" with **Change** and "You can change it until
22:00." — the same line on Home's today card.

**One primary action:** in the form, **Save change**.

Design choices:
- The line replaces *Rate RPE* once answered; *Change* is a secondary button, so *Open training* stays the card's main
  path.
- The form opens filled in: the 0–10 scale with 7 selected (48 px buttons, 6 per row on a phone), the note, the deadline
  and "Your coach sees that it was changed." (honest: the coach does).
- **Duration** is shown read-only with "Set by your coach; it can't be changed here." This follows the OptiMove manager's
  condition 4 (only what the athlete entered may change). If the contract finds the external form's duration is the
  athlete's own entry, the field simply becomes editable.
- **Closed:** a grey line with a lock: "Your RPE: 7 · Answers closed at 22:00." No *Change* button, no dead control.

Open design question:
- **D9. Duration: read-only, or hidden?** Recommend read-only and visible (the athlete sees what was recorded), pending
  the contract's answer on whose entry it is.

## 6. The coach's event panel with answers (package 5)

**What the coach sees first:** in the panel, three numbers: **Answered 12/15 · Average RPE 6.8 · Avg duration 89 min**,
then one line "3 waiting (listed first) · answers close at 22:00 · 1 changed. 15 of the 18 were asked: 3 are marked Did
not participate."

**One primary action:** **Open in Training Load** (full width). *Open the training* moves below as secondary.

Design choices:
- A compact table: athlete / RPE / duration. **Waiting athletes first** (the coach's next step is to chase them), with
  "—" and "waiting" in words.
- A changed answer gets an amber **✎ changed** badge on the athlete; the panel lists the change in plain words ("Ana K.
  changed RPE 6 → 7 at 20:41."). Glyph + word + colour (condition 3 of K4b).
- 10 rows, then *Show all*. The athlete's name is a link to that athlete ("a clearer athlete click", K4 plan section 6).
- On a phone the panel is the calendar's existing bottom sheet; columns stay three, narrower.

Open design questions:
- **D10. Waiting first, or alphabetical?** Recommend waiting first.
- **D11. Show the change history in the panel, or only the badge with a tooltip?** Recommend one line per changed athlete
  in the panel (tooltips don't exist on a phone), capped at 3 lines with *Show all*.

---

## Not in these mockups (by design)

- Imports, Source fields, the mapping board: untouched.
- Exercise detail inside the athlete's calendar (K4 plan option B, later).
- The phone panels are drawn in page flow; in the app the calendar panel is its existing bottom sheet.
- Dates in screenshots follow the headless browser's locale (e.g. `10/12/2026`); the app shows DD.MM.YYYY where it formats
  dates itself.
