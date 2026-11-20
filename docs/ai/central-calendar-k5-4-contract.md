# Central calendar — K5-4: GPS sessions waiting for import, and Imports opened on a day (UI contract)

Status: **Decided** (2026-11-20).
- The stream manager decided Q1–Q6 as recommended (section 6).
- The OptiMove manager (Imports and its routes are his mapping stream) said **yes** to Q1 (`/calendar`) and to the
  `gpexe-period-data.js` touch (3.3), on the conditions written in as section 8.

**Tier:** this contract is documents only. The build is ★★-lite: a narrow `security-reviewer`, plus the *Nezavisni
revizor* and the OptiMove manager's gate.
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
  - It is dropped on a workspace change, on sign-out or another user's sign-in in the same page, on the calendar's
    realtime refresh, and on its manual refresh (*Try again*, `invalidateCentralCalendarCache`). The cache holds
    counts only, never an authorization decision: every read is decided again by the route.
  - Turning the week reads the new week once; turning back uses the cache.
  - **No polling.**
  - A late answer for a range or workspace no longer shown is dropped (the calendar's generation pattern).
- **It never holds up the cards.** It goes out after the calendar's own answer is drawn, and the marks appear when it
  lands.

### 1.3 The day

The server's day is the **UTC day** of the session's start. The calendar draws **local days**. They map like this
(the OptiMove manager's condition):
- **The read:** `from` / `to` are the shown local days' ISO dates, sent as they are. The server reads them as UTC days,
  so the answer covers the same date strings the grid shows.
- **The mark:** it sits on the calendar column whose ISO date **equals** the answer's `day` string. No time-zone
  arithmetic happens in the calendar.
- **So a session's mark is on its UTC date**, the date Imports lists it under, its search covers and the click
  chooses (3.1).
- **Where it can differ from the device's clock:** a session started near midnight UTC.
  - **Example 1:** a session at 23:30 UTC on 14.10, seen on a device at UTC+1 (00:30 local on 15.10). The mark is
    on **Wed 14.10**, and the click opens Imports on 14.10, where it is listed.
  - **Example 2:** a session at 00:30 UTC on 15.10 (01:30 local on 15.10). The mark is on **Thu 15.10**.
  - **Example 3:** at UTC−5, a session at 02:00 UTC on 15.10 (21:00 local on 14.10). The mark is on **15.10**.
  - The imported activity's own card, after the import, sits on the device's local day, as it does today. Near
    midnight the two can be one day apart. This is accepted: the mark points to where Imports has the session, and
    the card to where the activity is.
- **Test R6** pins all three examples (section 5).

### 1.4 What is counted and shown

- **Counted: `needs + ready`.** That is sessions that are neither imported nor *Stays out*; replaced, withdrawn and
  undone ones are never in the answer.
- **Shown: the `gps` icon and the number**, in the words of the mockup: "2 GPS sessions to review" ("1 GPS session to
  review"). Never a name, an id, a time or a value.
  - Whether *needs* is told apart in the words ("2 GPS sessions to review · 1 needs you") is Q3.
- **No mark** on a day with `needs + ready = 0`. *Imported* and *Stays out* never make a mark; the imported activity
  has its own card or chip (K5-2).
- **`truncated: true` never looks like "nothing"** (the OptiMove manager's condition). The read was cut at 500 rows,
  ordered by start (`readCandidateCalendar`: `order by session_started_at …`), so the cut falls in the window's
  later days. The rule:
  - **Days the answer holds:**
    - Every day **before** its last day was read whole, because the rows come in start order. It keeps its exact mark
      ("2 GPS sessions to review", or none at 0).
    - The answer's **last day** may be split, so its number gets a "+" ("12+ GPS sessions to review"). At 0 it gets
      the uncertain mark below.
    - This refines the stream manager's "the shown days keep N+": the earlier days are exact, and only the day that
      can be cut says "+".
  - **Every shown day after the answer's last day**, up to today (the later of the local and the UTC day, as
    `todayDay` in `gpexe-period-data.js`), gets a mark **without a number**: the icon and "GPS sessions may be
    waiting". Future days get nothing, since no session can start there.
  - **If the answer holds no day at all** while `truncated` is true, every shown day up to today gets that uncertain
    mark.
  - Its click opens Imports on that day, like any mark.

  In practice one team's week does not reach 500 sessions. The rule exists so that the edge never reads as "nothing
  waiting".

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
   - **Then the read Imports' own day pick makes:** the entry calls the exported `ensurePeriodData(render)`, as
     Imports' `pickDay` handler does (`gpexe-import-actions.js:888-892`). For a team whose list was cut at 200 rows
     and a day older than the list, this reads that day's sessions (`/candidates?from=D&to=D`), so the listing
     matches the mark. It is GET only, and nothing changes in `gpexe-import-data.js`.
   - **On a phone** (`matchMedia("(max-width: 760px)")`, the width at which Imports draws the chooser as a sheet and
     closes it when the layout widens, `app.js:635-637`), the entry opens the sheet with the existing
     `setPeriodOpen(true)`.
   - **On a computer** the chooser is always on the page. `open` is never set there, because it means "the phone's
     sheet": Back and Escape close an open sheet first (`app.js:2324-2328`), and the view would announce the inline
     chooser as a modal dialog. The screen scrolls to `#imports-period`.
5. **Nothing else of Imports is touched.** No tab, review, batch, identity or link state is changed and no write is
   sent. *Find new sessions* stays a click in Imports.
   - **The entry's own guard** (Imports' `pickDay` has none, so this one is the calendar's). With
     `gx.batch?.sending || importsUnloadShouldWarn(gx) || gx.checkStarting || gx.check?.status === "running"` (the
     same search test Imports' own fix step uses, `gpexe-import-actions.js:328`), the entry opens Imports
     **as it is**, chooses no day and opens no sheet; only *Back to calendar* is added.
     - `importsUnloadShouldWarn` (`gpexe-import-data.js:1611`) is Imports' own test for any write in flight or
       unconfirmed: a batch, the guide's write, an undo, a time zone save and the rest.
     - `gx.checkStarting` and `gx.check?.status === "running"` are a search starting or in progress.
   - Imports' own leave guards (`importsUnloadShouldWarn` for the page, the section switch's questions) are
     unchanged.

### 3.2 *Back to calendar* (K4-0)

- A band "‹ Back to calendar · Wednesday 14.10" sits **in the shell's toolbar** (`els.toolbar`), not inside Imports'
  view.
  - It is shown only on the history step the entry pushed (the marker pattern of K4a). Another step at the same
    depth never shows it.
  - **Who draws it:** `renderTrainingLoad` (`app.js`) sets the toolbar on every render, from
    `…ReturnFor(appHistoryTopEntry())`, as K4a draws its band on every render (`app.js:3933`). So a reload of Training
    Load (`loadTrainingLoad`, which clears the toolbar) draws it again, and a later step never keeps a stale band.
- Its click is the same step back as the phone's Back. The calendar comes back on its week and day with its scroll,
  and the marks are read again only if the cache was dropped.
- **Show all dates:** the chooser's own *Clear* (`training-load-gpexe-period-clear`) already does it. The band does
  not repeat it (Q4).

### 3.3 The exact lines in the mapping stream's files

| File | Change | Lines |
|---|---|---|
| `frontend/gpexe-period-data.js` | **One internal function both entries share** (the OptiMove manager's condition: shared, never a copy): `setDays(s, { anchor, from, to })`. It assigns the chooser's own fields. `pickDay` (`:79-89`) calls it on both of its branches instead of its two `Object.assign` calls (`:84`, `:86`); its behaviour is unchanged. **`dayOff`** (`:70-75`) gains an optional fourth argument, `{ anchor = true } = {}`. With `anchor: false` it skips only the clause "more than 31 days from a waiting first tap". It is the same function: no copy, and every existing call is unchanged. **One new export** after `clearPeriod` (`:108-110`): `chooseDay(day, gx = g(), now = new Date())`. It returns `false` for a day that `dayOff(day, gx, now, { anchor: false })` refuses (a future day or a non-date). A stale first tap left from an earlier visit therefore never blocks the calendar's day, since the chosen day replaces it. Otherwise it calls `setDays(s, { anchor: "", from: day, to: day })`, sets `s.month = day.slice(0, 7)`, and returns `true`. **It never sets `open`**: the entry opens the sheet on a phone with the existing `setPeriodOpen` (3.1, step 4). | about +12, −3 |
| `frontend/gpexe-import-view.js` | **none** | — |
| `frontend/gpexe-import-actions.js` | **none** | — |
| `frontend/gpexe-import-data.js` | **none**. The entry reads `gx.batch`, `gx.check` and `importsUnloadShouldWarn` and calls the exported `ensurePeriodData`; it writes nothing there. | — |

Everything else is in the calendar stream's files:
- `frontend/central-calendar-{data,view,actions}.js` (the read, the mark, the click);
- `frontend/app.js` (the entry, the band, the scroll);
- `frontend/styles.css` (`.cc-daymark`, the band).

## 4. Who sees what

| Viewer | Mark | Read |
|---|---|---|
| Team coach in the team workspace | yes | `/calendar` for the team, once per range |
| Club admin or platform admin in a **team** workspace (if offered) | as the route answers | the same; a 404 is silent |
| Anyone in a club, platform or private-coach workspace | no (Q2) | none: the calendar never asks from those workspaces, although the route itself would admit a club admin in the club's workspace or a platform admin |
| Athlete (K4a Calendar) | no | none |
| A reader of the team's events who may not open Imports | no | the route's 404 is silent |

## 5. Tests

**Frontend** (`frontend/tests/central-calendar-k5-4.actions.test.mjs`, real handlers, fake fetch):
- **R1, the read:**
  - one `/calendar` read per shown range in a team workspace, with `from` / `to` the shown days;
  - none in a club, platform, private-coach or athlete answer;
  - the cache across week turns;
  - dropped on a workspace change, on sign-out and on refresh;
  - no read while the calendar's own answer is missing.
- **R2, silence:** a 404, a 403, a 500, a lost answer and a malformed answer each give no mark and no message, and
  the cards are unchanged.
- **R3, counts:**
  - `needs + ready`; `imported` / `out` alone give no mark;
  - "1 GPS session" vs "2 GPS sessions";
  - a `counts` key or chip word other than the four is ignored, never a `NaN` or an error;
  - `truncated` (1.4): the days before the answer's last day are exact; the last day reads "N+", or the uncertain
    mark at 0; every shown day after it, up to today, reads "GPS sessions may be waiting" with no number; future days
    get nothing; with no day in the answer, every shown day up to today gets the uncertain mark;
  - the mark's text and `aria-label` hold no name, id or time (a scan of the HTML for the fake answer's planted
    strings).
- **R4, late answers:** an answer for an earlier week or workspace is dropped.
- **R5, the filter:** *Show only · GPS imports* keeps the marks and counts them; other choices hide them (with K5-2).
- **R6, the midnight boundary** (1.3), with the device's time zone set (`TZ=Europe/Belgrade` for UTC+1, and
  `TZ=America/New_York` for UTC−5):
  - a session at 23:30 UTC on 14.10 on a UTC+1 device is marked on Wed 14.10, and its click chooses 14.10;
  - a session at 00:30 UTC on 15.10 is marked on Thu 15.10;
  - a session at 02:00 UTC on 15.10 on a UTC−5 device is marked on 15.10;
  - the read's `from` / `to` are the grid's own date strings in every zone.
- **B1, the entry:**
  - the click pushes one history step, sets section Imports and calls `chooseDay(D)`;
  - at 390 px the sheet opens; at 1280 px it scrolls to the chooser.
- **B1b, the computer** (1280 px):
  - after the entry, `periodOf(gx).open === false`;
  - `#imports-period` carries no `aria-modal`;
  - **one** band click (one `history.back`) returns to `central-calendar`.
- **B1c, a cut list:**
  - setup: a `/candidates` answer of 200 rows with `truncated: true`, and D older than its oldest row;
  - the entry is followed by `GET …/candidates?from=D&to=D`;
  - D's sessions are listed.
- **B2, the entry's guard:** each of these alone leaves `periodOf(gx).from === ""`, opens no sheet and keeps Imports
  as it is:
  - `gx.batch.sending`;
  - `gx.batch.unknown`;
  - the guide's write `sending` / `unknown`;
  - an undo `sending` / `unknown`;
  - a time zone save (`gx.tz.step` `saving` / `checking` / `unknown`);
  - `gx.checkStarting`;
  - `gx.check.status === "running"`.

  The leave question's "No" changes nothing.
- **B3, the band:**
  - only on the pushed step;
  - Back returns to the calendar's week, day and scroll;
  - another step at the same depth shows no band;
  - a reload of Training Load on the step (`loadTrainingLoad`) still shows it;
  - after another `pushAppHistory` it is gone.
- **`gpexe-period-data`** (its own test in the mapping stream's period suite, with its owner's word):
  - `chooseDay` sets exactly `anchor`, `from`, `to` and `month`, and leaves `open` as it was;
  - it refuses a future day and a non-date through the same `dayOff`;
  - with a waiting first tap 40 days before D, `chooseDay(D)` still returns `true`, with `from` = `to` = D;
  - `dayOff` without the fourth argument still refuses a day more than 31 days from a waiting first tap;
  - `pickDay`'s first and second taps and its 31-day refusal are unchanged after it moves onto the shared `setDays`
    (the suite's existing cases run unchanged).

**Mutations:**
- the workspace gate removed (a club or athlete answer reads);
- `imported` / `out` counted;
- `truncated` ignored, or the uncertain mark dropped for the days after the answer's last day;
- the mark placed by local-time arithmetic instead of the `day` string (R6);
- `chooseDay` without `dayOff`;
- `chooseDay` setting `open` (B1b), or the sheet opened at 1280 px;
- no `ensurePeriodData` after the entry (B1c);
- the guard missing any one of its fields (B2);
- the band drawn only once instead of on every render (B3);
- the cache key without the team;
- a late answer kept;
- the 404 shown as a message;
- the entry choosing a day during a batch;
- the band on every step.

**Backend:** no change. **A key-by-key pin of `/calendar`'s answer is mandatory** (the OptiMove manager's condition).
It goes in the calendar stream's suite (Q5), in `backend/tests/central-calendar-k5-4-read.test.mjs`, on a disposable
world. It checks exact deep key equality with no extra keys, **for three audiences**: the team's coach (team
workspace), the club's admin (club workspace) and a platform admin. For each it asserts:
- the top level is exactly `from`, `to`, `days`, `truncated`;
- each day is exactly `day`, `chips`, `counts`;
- `counts` is exactly `needs`, `ready`, `imported`, `out`, each a whole number;
- each chip is one of the four state words;
- no label, id, athlete or value appears anywhere in the serialised body. The world plants a distinctive session
  label, a GPEXE session id and an athlete name, and the test scans for them.

**A refusal is the identical 404** (status and body) for:
- an unknown team and a team the account cannot manage;
- a coach of another team;
- an athlete;
- a coach in a club workspace for a team that is not hers.

A later widening of that answer fails a calendar test first.

**e2e** (`e2e/tests/central-calendar-k5-4.test.mjs`, the imports fixture's fake source):
- a team with two waiting sessions on one day and one imported;
- at 1280 / 390 / 375 / 360:
  - the mark "2 GPS sessions to review" on that day only;
  - its click opens Imports with that day chosen, listing those sessions;
  - *Back to calendar* returns to the day;
  - no horizontal overflow;
- the club admin's club workspace shows no mark;
- the athlete's Calendar shows none.

**Reviews (the build, ★★-lite):**
- `code-reviewer`, `mobile-qa`, `ux-design-reviewer`;
- `security-reviewer`, narrow on the read's gating and the pin (a new reader of a team route);
- then the *Nezavisni revizor* and the OptiMove manager's gate, which covers the `gpexe-period-data.js` lines.

## 6. Questions and decisions

The stream manager decided every question as recommended (2026-11-20). Q1 also needs the OptiMove manager's word,
because `/calendar` is his route. The one touch in his files (3.3, `chooseDay`) goes to him with it.

| | Question | Recommendation, decided as written |
|---|---|---|
| **Q1** | Read `/calendar` (numbers only, server state, 42 days) or `/candidates` + `inboxBucket` (as the message names it)? | **`/calendar`.** It is the "small new read route, numbers only" the plan foresaw, and it now exists, built by the mapping stream. The calendar then receives no label, id or value, and duplicates no rule. The OptiMove manager decides, since it is his route. |
| **Q2** | A club workspace: read every team's calendar and mark per team? | **No for now.** It would be one read per team per range. Only the team workspace, as the manager's limit "the active workspace's team" says. If the pilot asks for it, a club read is the mapping stream's to build (one route, `clubId`). |
| **Q3** | Tell *needs you* apart in the mark ("2 GPS sessions to review · 1 needs you")? | **No:** one number and the icon (the manager's "the GPS icon and a number only"). Imports says which need what. |
| **Q4** | (b) opens the period chooser on D (today's Imports) or a new "only day D" filter on Imports' tabs? | **The period chooser.** It already lists a day's sessions with *Open* and offers *Find new sessions for* D, and needs one small function (about +12 lines, 3.3). A filter of the tabs is a new Imports feature for the mapping stream to design, not the calendar's. The band does not repeat *Show all dates*: the chooser's *Clear* is it. |
| **Q5** | Where does the `/calendar` key pin live? | **In the calendar stream's suite** (`backend/tests/central-calendar-k5-4-read.test.mjs`), since it pins what the calendar relies on. It is read-only and changes nothing of the route. |
| **Q6** | The week toolbar's total ("5 GPS to review this week", design E7)? | **No** (design E7): one mark per day, and *Show only · GPS imports* counts them. |

## 7. Not in this contract

- Any backend or route change; any change to Imports' tabs, review, batch, identity, links or guards.
- *Find new sessions* from the calendar: never.
- K5-1/K5-2 themselves (their contract), K5-3, K5-5.
- A club-wide or longer-period count (Q2): the mapping stream's, if ever.

## 8. The OptiMove manager's conditions (2026-11-20, relayed by the stream manager)

He said **yes** to both points, on these conditions. Each is written into the section named.

1. **`/calendar`:**
   - **Numbers per day only, and the same 404 for everyone without the right:** 1.1, and the key pin in section 5.
   - **`truncated: true` never looks like "nothing":** 1.4.
     - The days after the answer's last day, up to today, get the mark without a number ("GPS sessions may be
       waiting").
     - The answer's last day gets "N+".
     - The stream manager recommended "N+" on every shown day. The contract keeps "N+" on the last day only,
       because the earlier days were read whole (the rows come in start order).
   - **The day boundary:** 1.3 (the UTC day against the local grid, with three examples), and test R6.
   - **The key-by-key pin of `/calendar`'s answer in our suite is mandatory:** section 5, Backend.
2. **`chooseDay(day)`:** 3.3 and section 5.
   - It calls the same `dayOff`. Its optional `{ anchor: false }` skips only the stale-first-tap clause, after the
     code review.
   - `pickDay` and `chooseDay` share one internal function (`setDays`), not a copy.
   - It never sets `open`, the phone's sheet. The entry opens the sheet on a phone only.
   - It has its own test in the gpexe period suite.
   - The stream manager tells the GPS import executor that `gpexe-period-data.js` is touched, so as not to collide
     with their C1–C3 branch.
3. **Tier:** this contract is documents only. The build is ★★-lite: a narrow `security-reviewer`, the *Nezavisni
   revizor* and the OptiMove manager's gate.

## 9. Review record

**`security-reviewer`** (narrow: the read's gating and silence): READY WITH NON-BLOCKING NOTES. No BLOCKER, HIGH or
blocking MEDIUM, and trigger 2 does not apply: the contract adds a caller of an existing route and changes no route.
- The route is the authority. `resolveGpexeTeamAccess` re-checks the workspace and `canManageTeamById` on every
  call, so a team workspace's `scopeId` grants nothing.
- The answer is numbers and state words for every audience.
- Silence on the client is no oracle.

Applied:
- **MEDIUM:** the key pin now covers three audiences, checks exact keys, scans for planted strings and adds the
  identical-404 pairs (section 5);
- **LOW:** the cache is dropped on sign-out and another user's sign-in (1.2, R1);
- **LOW:** section 4 says the calendar never asks from a club or platform workspace;
- **LOW:** unknown state words are ignored (R3).

**`code-reviewer`** (whole document, its latest form): NOT READY. One HIGH, two MEDIUM, two LOW and a NIT, all applied:
- **HIGH:** `chooseDay` set `open`, the phone's sheet, on a computer too. Back, Escape and the band would then first
  close an invisible sheet, and the inline chooser would read as a modal dialog. Now `chooseDay` never sets `open`,
  and the entry opens the sheet only at 760 px or less (3.1 step 4, 3.3, B1b).
- **MEDIUM:** after the choice, the entry calls the exported `ensurePeriodData`, as Imports' own day pick does, so a
  cut list still lists day D (B1c).
- **MEDIUM:** a stale first tap could make `dayOff` refuse the day. Now it uses `dayOff(…, { anchor: false })`, the
  same function (3.3, period suite).
- **LOW:** the guard is named exactly and called the entry's own (3.1 step 5, B2).
- **LOW:** the band is drawn on every `renderTrainingLoad` (3.2, B3).
- **NIT:** line numbers and "8 lines" corrected.

It confirmed §0's claims, the truncation rule and the three midnight examples against `66cae9fc`. Its narrow
re-review closed every finding: READY WITH NON-BLOCKING NOTES. Its one new LOW (B2 lacked `gx.checkStarting` and a
time zone save) is applied.
