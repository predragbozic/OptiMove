# Central calendar — K5-4: GPS sessions waiting for import, and Imports opened on a day (UI contract)

Status: **Proposed** (2026-11-20), for the stream manager, then the OptiMove manager (Imports is his mapping stream).
Documents only: no code, no route, no migration. Written against `main` `66cae9fc`.

Sources:
- `docs/ai/central-calendar-k5-plan.md`, K5-4 (a) and (b): the OptiMove manager's answers of 2026-11-19;
- the approved mockup `docs/design/calendar-k5/04-k5-4-gps-to-review.html` and README section 4;
- `docs/ai/central-calendar-k5-12-contract.md`: the day chips (2.4) and *Show only · GPS imports* (2.5), into which
  K5-4's mark fits.

The rule over both parts (the manager's condition): the calendar **writes nothing into another module and duplicates
none of its rules**. It only reads, and leads there.

## 0. What the code says today, against the plan

The plan was written against `1a5cdb79`. Since then the mapping stream has changed Imports. **The code wins**
(`CLAUDE.md`), so this contract starts from what is checked out.

| The plan assumed | The code on `66cae9fc` |
|---|---|
| `GET …/gpexe/teams/:teamId/candidates` is the only list: capped at 200 rows, not filtered by date. | It now takes an optional `from` / `to` window (at most 31 UTC days) and answers `truncated` (`backend/src/routes/gpexeImport.js:304-312`, `gpexeImportService.js` `readCandidateList`). |
| An exact count per day would need "a small new read route (`from` / `to`, numbers only), built by the mapping stream". | **It exists:** `GET …/gpexe/teams/:teamId/calendar?from&to` (`gpexeImport.js:316-321`, `readCandidateCalendar` `gpexeImportService.js:1578-1602`). Per UTC day it returns its sessions' state counts `{ needs, ready, imported, out }` and up to three state chips. The window is at most 42 days, capped at 500 rows with `truncated`. It has the same audience and the same 404 as the candidates. Replaced and withdrawn versions and undone imports are never read. Imports' own period chooser reads it (`gpexe-import-data.js:326`). |
| *Ready* and *Needs attention* are told apart in the browser, by importing `frontend/gpexe-import-*.js`. | The state is now decided **on the server** by one shared rule, `candidateState` (`backend/src/gpexeImportState.js`): `hidden` / `imported` / `out` / `needs` / `ready`. A parity test runs it against the frontend's `inboxBucket` over the same summaries. Each candidate summary carries `state` (`gpexeImportService.js` `candidateSummary`). |
| The session's day is "a naive day, with no time zone, as in the Imports calendar". | The server's day is **the UTC day of `session_started_at`**: the GPEXE wall clock, stored as UTC. It is the day the check window, the withdrawal and the `/calendar` read use. The frontend's equivalent is `sessionDay` (`frontend/gpexe-period-data.js:25-29`). This is the plan's "naive day". |
| Imports has a local day filter in its sessions calendar (Phase 4b) with *Show all dates*. | That filter is gone. Imports now has tabs (IMP1: attention, ready, imported, out, athletes, search). It also has **the period chooser** (P4, `frontend/gpexe-period-{data,view,drag}.js`): choosing days lists "Already found on these days", each session with *Open*, and offers *Find new sessions for* those days. On a phone it is a full-screen sheet; on a computer it is always on the page, after the work list. |

So (a) recommends the `/calendar` read (Q1), and (b) opens the period chooser on day D (Q4).

## 1. (a) The read

### 1.1 Which route (Q1)

**Recommended: `GET /api/training-load/gpexe/teams/:teamId/calendar?from=<first shown day>&to=<last shown day>`.**
- **Numbers and state words only:** `{ from, to, days: [{ day, chips: [state…≤3], counts: { needs, ready, imported, out } }], truncated }`.
  There is no label, no candidate id, no GPEXE id, no athlete and no value. The calendar cannot show what it never
  receives.
- **Counted as in Imports, with nothing rewritten:** the state is the server's `candidateState`, the rule Imports'
  own calendar shows and the parity test pins. The calendar imports no counting logic at all.
- **Dated:** the shown week (7 days) and the shown month (at most 42 days, the 6-week grid) both fit the route's
  limit. The 200-row cap of the list does not apply, so a mark is exact unless `truncated`.
- **No GPEXE request:** the route reads stored candidates only. *Find new sessions* (`POST …/checks`) stays in
  Imports, on a click.

**The alternative** is the manager's literal (a): `/candidates?from&to` plus `inboxBucket` imported from
`gpexe-import-data.js`. It would send every row's label, ids and preview facts to the calendar so that it can count
them. The window is also 31 days, too short for a month grid. Not recommended. It is kept as Q1's other answer
because the message named it.

**What the browser-only facts change.** Imports may move a *ready* row to its attention group on two facts the
server cannot know: an approval whose answer was lost in that tab, and a link made after the last search. Neither
changes the calendar's number, which is `needs + ready` (1.4).

### 1.2 Who reads, and when

- **Only in a team workspace, for that team:** `cal.data.workspace.type === "team"`, team id `workspace.scopeId`. The
  calendar's own answer names the workspace.
- **Nowhere else:**
  - not in a club workspace, which would need one read per team (Q2);
  - not in the platform workspace or a private coach's;
  - never in the athlete workspace. The athlete's Calendar (K4a) is another module and never calls it.
- **A refusal is silent.** A 404 or 403 means the account is not the team's coach, the club's admin or a platform
  admin in the right workspace (`teamAccess`, `resolveGpexeTeamAccess`). That, any other error and a lost answer all
  give no mark and no message. The calendar is never blocked by it.
- **One read per team per shown range.**
  - The range is the week (week and day views read their week) or the month grid.
  - It is cached in memory under a key of team + from + to.
  - It is dropped on a workspace change, on the calendar's realtime refresh, and on its manual refresh (*Try again*,
    `invalidateCentralCalendarCache`).
  - Turning the week reads the new week once; turning back uses the cache.
  - **No polling.**
  - A late answer for a range or workspace no longer shown is dropped (the calendar's generation pattern).
- **It never holds up the cards.** It goes out after the calendar's own answer is drawn, and the marks appear when it
  lands.

### 1.3 The day

A mark sits on the calendar day whose ISO date equals the answer's `day` string. That is the UTC day of the session's
start, as Imports and the search use it. No time-zone conversion happens in the calendar. The cards' days and the
mark's day can differ only for a session started near midnight UTC. Even then it is the day Imports lists the session
under, and the click lands on that same day (2.2).

### 1.4 What is counted and shown

- **Counted: `needs + ready`.** That is sessions that are neither imported nor *Stays out*; replaced, withdrawn and
  undone ones are never in the answer.
- **Shown: the `gps` icon and the number**, in the words of the mockup: "2 GPS sessions to review" ("1 GPS session to
  review"). Never a name, an id, a time or a value.
  - Whether *needs* is told apart in the words ("2 GPS sessions to review · 1 needs you") is Q3.
- **No mark** on a day with `needs + ready = 0`. *Imported* and *Stays out* never make a mark; the imported activity
  has its own card or chip (K5-2).
- **`truncated`:** the read was cut at 500 rows, which are ordered by start, so the cut falls in the window's later
  days. Then:
  - every mark of that answer shows its number with "+" ("12+ GPS sessions to review");
  - no day after the last day in the answer gets a mark.

  The plan's "not shown as final" is kept. In practice one team's week does not reach 500 sessions.

## 2. The mark on the calendar

### 2.1 Where and how it looks (mockup 04, the K5-2 day chips)

- **A day mark**, after the day's cards and K5-2's chips, in every list layout: the week columns, the phone's selected
  day and the Day view.
  - In the wide time grid it sits in the "No set time" row: it has no hour.
  - In the month grid it is a mini mark: the icon and the number.
- **A `<button class="cc-daymark cc-daymark-gps">`**, dashed amber: "waiting for you" (design README section 1).
  - The `gps` icon and the words.
  - At least 44 px tall on touch, one line, wrapping at 360 px.
  - Its `aria-label` reads "2 GPS sessions to review on Wednesday 14 October, open Imports".
- **It is not an item.** It has no panel, is never in `centralCalendarVisibleItems` and has no key. A click goes
  straight to Imports (2.2), as README section 4 shows.
- ***Show only · GPS imports*** (K5-2 2.5) keeps the marks; every other *Show only* choice hides them. The **GPS
  imports** count adds each mark's number, so the pill says how many are waiting.
- **Order and dependency:** K5-4's frontend comes **after K5-1/K5-2's frontend**, whose chips and pills it extends.
  If K5-2 is not merged first, K5-4 draws its mark after the day's cards and adds nothing to a filter that does not
  exist yet.

### 2.2 The click: Imports opened on day D (part (b))

The mark is the entry of (b).

## 3. (b) Imports opened on day D

### 3.1 What the entry does

`openImportsOnDay({ teamId, day })`, in `app.js` beside `openTrainingLoadFromCalendar`:
1. **Training Load's own leave question first** (`confirmLeaveTrainingLoad`), as the activity hand-off does today. A
   "No" leaves the calendar as it was.
2. **Push one app-history step** (`pushAppHistory`) and remember a return marker for it, as K4a does
   (`setAthleteCalendarReturn` / `claim…` / `…ReturnFor`, `athlete-calendar-data.js:60-74`). The marker holds the day
   and the calendar's place (`captureCentralCalendarView`).
3. **Training Load, section Imports:** `setTrainingLoadSection("imports")`, then `loadTrainingLoadSectionData`, which
   calls Imports' own `loadGpexeImports`.
   - The team is the team workspace's own: `gpexeTeamOptions` offers only that team there, and `defaultTeamId`
     chooses it. So the entry sets no team and never calls `selectGpexeTeam`.
   - If Imports' team could ever differ, the entry stops at Imports as it is, never switching teams.
4. **Day D chosen in the period chooser,** through one new exported function of the mapping stream's file (3.3). The
   chooser then lists "Already found on these days" for D, with each session's *Open* and *Find new sessions for* D.
   - On a phone it opens the chooser's sheet.
   - On a computer, where the chooser is always on the page, the screen scrolls to `#imports-period`.
5. **Nothing else of Imports is touched.** No tab, review, batch, identity or link state is changed and no write is
   sent. *Find new sessions* stays a click in Imports.
   - **Imports' guards:**
     - a batch in flight (`gx.batch.sending`), an unconfirmed outcome, or a search running → the entry opens Imports
       **as it is** and chooses no day. Only *Back to calendar* is added;
     - Imports' own leave guards (`importsUnloadShouldWarn`, the section switch's questions) are unchanged.

### 3.2 *Back to calendar* (K4-0)

- A band "‹ Back to calendar · Wednesday 14.10" sits **in the shell's toolbar** (`els.toolbar`, set by `app.js`), not
  inside Imports' view. It is shown only on the history step the entry pushed (the marker pattern of K4a). Another
  step at the same depth never shows it.
- Its click is the same step back as the phone's Back. The calendar comes back on its week and day with its scroll,
  and the marks are read again only if the cache was dropped.
- **Show all dates:** the chooser's own *Clear* (`training-load-gpexe-period-clear`) already does it. Q4 asks
  whether the band also says it.

### 3.3 The exact lines in the mapping stream's files

| File | Change | Lines |
|---|---|---|
| `frontend/gpexe-period-data.js` | One new export after `clearPeriod` (`:108-110`): `chooseDay(day, gx = g())`. It refuses a day that `dayOff` refuses. Otherwise it sets `{ anchor: "", from: day, to: day, month: day.slice(0, 7), open: true }` and returns `true`. These are the chooser's own fields, set as `pickDay` sets them. | +8, after line 110 |
| `frontend/gpexe-import-view.js` | **none** | — |
| `frontend/gpexe-import-actions.js` | **none** | — |
| `frontend/gpexe-import-data.js` | **none** (the entry reads `gx.batch.sending` and the search state; it writes nothing there) | — |

Everything else is in the calendar stream's files:
- `frontend/central-calendar-{data,view,actions}.js` (the read, the mark, the click);
- `frontend/app.js` (the entry, the band, the scroll);
- `frontend/styles.css` (`.cc-daymark`, the band).

## 4. Who sees what

| Viewer | Mark | Read |
|---|---|---|
| Team coach in the team workspace | yes | `/calendar` for the team, once per range |
| Club admin or platform admin in a **team** workspace (if offered) | as the route answers | the same; a 404 is silent |
| Anyone in a club, platform or private-coach workspace | no (Q2) | none |
| Athlete (K4a Calendar) | no | none |
| A reader of the team's events who may not open Imports | no | the route's 404 is silent |

## 5. Tests

**Frontend** (`frontend/tests/central-calendar-k5-4.actions.test.mjs`, real handlers, fake fetch):
- **R1, the read:**
  - one `/calendar` read per shown range in a team workspace, with `from` / `to` the shown days;
  - none in a club, platform, private-coach or athlete answer;
  - the cache across week turns;
  - dropped on a workspace change and on refresh;
  - no read while the calendar's own answer is missing.
- **R2, silence:** a 404, a 403, a 500, a lost answer and a malformed answer each give no mark and no message, and
  the cards are unchanged.
- **R3, counts:**
  - `needs + ready`; `imported` / `out` alone give no mark;
  - "1 GPS session" vs "2 GPS sessions";
  - `truncated` → "N+" on every mark and none after the answer's last day;
  - the mark's text and `aria-label` hold no name, id or time (a scan of the HTML for the fake answer's planted
    strings).
- **R4, late answers:** an answer for an earlier week or workspace is dropped.
- **R5, the filter:** *Show only · GPS imports* keeps the marks and counts them; other choices hide them (with K5-2).
- **B1, the entry:**
  - the click pushes one history step, sets section Imports and calls `chooseDay(D)`;
  - the phone opens the sheet; the computer scrolls to the chooser.
- **B2, the guards:** a batch in flight, an unconfirmed outcome or a search running → no day chosen, Imports as it is.
  The leave question's "No" → nothing changes.
- **B3, the band:**
  - only on the pushed step;
  - Back returns to the calendar's week, day and scroll;
  - another step at the same depth shows no band.
- **`gpexe-period-data`:** `chooseDay` sets exactly the five fields, and refuses a future day and a non-date. This is
  added to the mapping stream's existing period suite, with its owner's word.

**Mutations:**
- the workspace gate removed (a club or athlete answer reads);
- `imported` / `out` counted;
- `truncated` ignored;
- the cache key without the team;
- a late answer kept;
- the 404 shown as a message;
- the entry choosing a day during a batch;
- the band on every step.

**Backend:** no change. A **contract pin** in the calendar stream's suite reads `/calendar` as a team coach on a
disposable world and asserts its keys: `days[].{day, chips, counts}` and `counts` exactly `needs, ready, imported, out`.
So a later widening of that answer (a label, an id) fails a calendar test first. Q5 asks whether the pin goes there
or in the mapping stream's suite.

**e2e** (`e2e/tests/central-calendar-k5-4.test.mjs`, the imports fixture's fake source):
- a team with two waiting sessions on one day and one imported;
- at 1280 / 390 / 375 / 360:
  - the mark "2 GPS sessions to review" on that day only;
  - its click opens Imports with that day chosen, listing those sessions;
  - *Back to calendar* returns to the day;
  - no horizontal overflow;
- the club admin's club workspace shows no mark;
- the athlete's Calendar shows none.

**Reviews:** `code-reviewer`, `mobile-qa`, `ux-design-reviewer`; `security-reviewer` narrow on the read's gating and
the pin (a new reader of a team route). The OptiMove manager's gate for the `gpexe-period-data.js` lines.

## 6. Open questions, with recommendations

| | Question | Recommendation |
|---|---|---|
| **Q1** | Read `/calendar` (numbers only, server state, 42 days) or `/candidates` + `inboxBucket` (as the message names it)? | **`/calendar`.** It is the "small new read route, numbers only" the plan foresaw, and it now exists, built by the mapping stream. The calendar then receives no label, id or value, and duplicates no rule. The OptiMove manager decides, since it is his route. |
| **Q2** | A club workspace: read every team's calendar and mark per team? | **No for now.** It would be one read per team per range. Only the team workspace, as the manager's limit "the active workspace's team" says. If the pilot asks for it, a club read is the mapping stream's to build (one route, `clubId`). |
| **Q3** | Tell *needs you* apart in the mark ("2 GPS sessions to review · 1 needs you")? | **No:** one number and the icon (the manager's "the GPS icon and a number only"). Imports says which need what. |
| **Q4** | (b) opens the period chooser on D (today's Imports) or a new "only day D" filter on Imports' tabs? | **The period chooser.** It already lists a day's sessions with *Open* and offers *Find new sessions for* D, and needs one 8-line function. A filter of the tabs is a new Imports feature for the mapping stream to design, not the calendar's. The band does not repeat *Show all dates*: the chooser's *Clear* is it. |
| **Q5** | Where does the `/calendar` key pin live? | **In the calendar stream's suite** (`backend/tests/central-calendar-k5-4-read.test.mjs`), since it pins what the calendar relies on. It is read-only and changes nothing of the route. |
| **Q6** | The week toolbar's total ("5 GPS to review this week", design E7)? | **No** (design E7): one mark per day, and *Show only · GPS imports* counts them. |

## 7. Not in this contract

- Any backend or route change; any change to Imports' tabs, review, batch, identity, links or guards.
- *Find new sessions* from the calendar: never.
- K5-1/K5-2 themselves (their contract), K5-3, K5-5.
- A club-wide or longer-period count (Q2): the mapping stream's, if ever.
