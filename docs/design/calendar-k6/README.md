# Calendar K6: moving between teams and athletes quickly (mockups)

Status: **Proposed design** (2026-11-19), for the stream manager's review and the owner's approval. Documents and
mockups only: no product code, no route, no migration. Written against `main` `920459c0` and the K6 plan
(`claude/central-calendar-k6-plan`, head `6223897c`, the owner's S1 and S2), with the owner's later notes S3, S4 and
S5 as relayed by the stream manager. It follows the approved K4 mockups and the K5 mockups. `base-k5.css` is a copy of
the K5 mockup base, so this folder stands alone.

| File | What it is |
|---|---|
| `01-k6-1-calendar-by-athlete.html` | K6-1 in a club workspace: Groups (the existing chips) next to the athlete strip; one athlete chosen; combined with K5's *Show only* (only GPS for one athlete) |
| `02-k6-1-team-coach.html` | S5: a team coach sees only their own team: the same strip, arrows and search, no Groups, and a calm empty search result |
| `03-s4-club-admin-search.html` | S4: a club admin with *All groups*: every athlete of the club, grouped by team; the search across teams; an athlete of another team chosen, then their week |
| `04-k6-2-weekly-plan-header.html` | K6-2: the Weekly plan header "‹ Ana Kovač ›" plus the strip; › keeps the same week, day and open session (Ana, then Ben) |
| `05-k6-3-event-each-athlete.html` | K6-3: *See each athlete* in an event's panel, opening that session with only the event's athletes and *Back to calendar* |
| `screenshots/NN-…-390.png`, `…-1280.png` | Full-page Playwright screenshots, deviceScaleFactor 2 |
| `build.mjs`, `shoot.mjs` | `node build.mjs` writes the pages; `node shoot.mjs` (no environment prefix) shoots them and prints the overflow and the inputs under 16 px (all 0 on the pushed head) |

As before, the dark labels are steps, a red dashed outline marked **NEW** is what this design adds, and every name and
number is invented.

## One component, already in the app

- **The athlete strip is the Builder's switcher** (`builder-batch-pills` / `-pill` / `-avatar` / `-caption` in
  `frontend/styles.css`, drawn by `frontend/builder-view.js`). The mockups use those real classes: photo or initials,
  a short caption ("Ana K."), the chosen pill tinted, ‹ › arrows of 44 px, and a "3 / 18" count. Additions:
  - an **All** pill first ("Everyone"), so the strip also undoes a choice;
  - a small **team-colour dot** on each avatar;
  - a **search** field above it (16 px).
- **The team choice is the calendar's existing Groups chips** (`cc-chip-row` / `cc-chip`,
  `central-calendar-toggle-team`; the owner's S3). It is not a second team control. The design only moves the Groups
  row into the switcher's box, right above the strip, so a team is one tap away. Choosing a group re-fills the strip.
- **Phones:** the Groups row and the strip scroll sideways; the arrows stay fixed at both ends of the strip; the chosen
  pill is always scrolled into view (the mockup does this with a few lines of script; the code does the same); every
  target is 44 px.

## K6-1 — the calendar

**First thing seen:** the switcher box under the week's navigation, with the Groups chips, the search, and the strip
of the chosen team starting with *All*.

- Choosing an athlete makes the week show only that athlete (the calendar's read with `athleteIds`). A green line
  says "Showing **Ana Kovač** · U19 · *Show everyone*".
- **Combined with K5's *Show only*:** the two choices stack: "Showing Ana Kovač · U19 · only GPS imports".
- **A team coach (S5):** no Groups row and no *All groups*. The strip, the arrows and the search hold only the
  athletes of the active team. A search that finds nobody says "No athlete in this team matches ‘marko’.", with
  nothing about other teams. The Builder's hidden-count sentence (#664) is reused when some members are not shown.

## S4 — a club admin sees every team and every athlete

- **All groups:** the strip holds every athlete of the club, ordered by team and then by name. A thin, vertical team
  label separates the teams, and each avatar carries its team's colour.
- **The search is the main way in for a big club (100+).** A few letters find any athlete of the club, across teams.
  Each result shows the team's name and colour, the matching letters are marked, and ↑ ↓ / Enter work.
- **Choosing an athlete from another team sets the team too.** In the mockup, Marko P. of the First team is chosen:
  Groups switches to First team, the strip becomes First team with Marko in view, and the week is his. ‹ › then steps
  through the First team.

## K6-2 — the Weekly plan header

**First thing seen:** "‹ (avatar) Ana Kovač ›" with "U19 · 1 / 18", the strip under it, then the plan.

- **› moves to the next athlete and keeps the same week, day and open session.** A quiet line says what is kept
  ("Monday 12.10 · Training · Main session"). Only the athlete's own content changes ("Ana: max 60 min (knee)" →
  "Ben: +2 sprints 30 m").
- In a club workspace the Groups row appears above the strip, as in K6-1 (not drawn again here).

## K6-3 — from an event through its athletes

- The event's panel gets **See each athlete →** (primary): "Opens Main session, one athlete at a time, only the 5 of
  this event."
- It opens the Weekly plan on that session. The switcher holds **only the event's athletes** ("3 / 5 in this
  event"), and *Back to calendar* sits above it. Back returns to the event's panel (K4-0).

## Event cards follow H4

As in K5 (E12, decided 2026-11-19): an event card shows what it holds as icons only (RPE, GPS, test), with no number.
The count stays in the panel. A day chip of something in no event ("RPE · Gym", "CMJ test", "GPS 10:05") stays as it
is (H5). In one athlete's week, the event's own RPE or test is therefore an icon on the card, not a chip.
`base-k5.css` is re-copied from the K5 branch to carry the `k5-holds` style.

## Open questions (each with a recommendation)

F1–F6 were accepted as recommended by the stream manager on 2026-11-19, pending the owner.


- **F1. Where does the switcher live on the calendar: always open, or folded behind a button?** Recommend always open
  on a computer, and folded to one line on a phone ("Everyone · U19 ▾") that opens the box. On a phone the box takes
  about a third of the screen.
- **F2. Remember the chosen athlete?** Recommend keeping it for the session, and showing the green "Showing …" line
  whenever it is not *Everyone*, as with K5's filter, so nobody forgets that the week is filtered.
- **F3. All groups for a club admin: the full strip, or the search only?** Recommend the full strip up to about 60
  athletes. Above that, the strip shows only the chosen team, and the search is the way in (S4).
- **F4. The vertical team label in the mixed strip, or a gap only?** Recommend the label: with three teams in one strip,
  a gap alone doesn't say whose athletes these are.
- **F5. In the Weekly plan, does › skip athletes who have no plan this week?** Recommend no skip. Show them with "No
  plan this week" and *Plan it in the Builder*, so the order stays the same as on the strip.
- **F6. Does the event's switcher (K6-3) include athletes the event targets who have no linked session?** Recommend
  yes, with "Not in this session". The coach then sees the gap instead of a shorter list.

## Not in these mockups

- No change to the Builder's own switcher. K6 reuses it as it is, plus the *All* pill, the dot and the search, which
  the Builder can take later.
- The phone panels are drawn in page flow; in the app the panel is the calendar's existing bottom sheet.
- Reviewers (`ux-design-reviewer`, `mobile-qa`) were not run, and nothing was checked on a physical device.
