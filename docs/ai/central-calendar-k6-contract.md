# Central calendar — K6 UI contract: the team and athlete switcher

Status: **Decided by the stream manager** (2026-11-20): Q1–Q9 of section 7 as recommended, so K6 stays ★, with no
backend and no new read. Next: the OptiMove manager's GO. Documents only: no code, no route, no migration. Written against `main` `ec467638`, on the K6 plan (`docs/ai/central-calendar-k6-plan.md`,
the owner's S1–S5) and the approved mockups (`docs/design/calendar-k6/`, F1–F6 as recommended). Where this contract
and a mockup differ, this contract says why.

**The manager's condition** (relayed 2026-11-20): the lists show only what the workspace already shows (S4, S5), and a
test proves that a team coach gets no athlete outside their own team. If a new read is needed, that is trigger 2
(security plus external review).

**The answer, in one line:** K6 needs **no new read and no backend change**. The switcher's lists come from two reads
the workspace already makes and already shows: the rail roster (`GET /api/admin/athletes`, `state.athletes`), and,
for a club admin's team grouping only, `GET /api/organization`, which Training Load's Club/Team/Athletes filter, the
Tests recipient picker and the Builder's athlete picker already read in the same workspace. The calendar sends the
`athleteIds` filter that `GET /api/calendar` already takes and already narrows inside the scope. Section 7 lists the
two places where a backend field would make the result better (Q4, Q7); both were decided **against** for K6.

## 1. One shared component

### 1.1 What exists

The Builder's batch switcher (`renderBuilderBatchSwitcher`, `frontend/builder-view.js:115-164` on `ec467638`) draws:
- a summary (`builder-batch-summary`): the eyebrow "Group builder", the current name, "N / M", the hidden-members
  sentence of #664 (`renderBuilderBatchHiddenNote`), and a status line for a switch in flight;
- the controls (`builder-batch-buttons`): ‹, the pills (`builder-batch-pills` / `-pill` / `-avatar` / `-photo` /
  `-caption`), ›; each pill and arrow is a button with `data-action="builder-open-batch-plan"` and `data-plan-id`;
- the Builder's own mode (`builder-batch-mode`): *Apply changes to all athletes*, or the edit draft's sentence. Step 2
  (#673, frozen, not merged) replaces this part for an edit draft with its own panel.

`renderBuilderBatchSwitchProgress` (`builder-view.js:350-372`) disables the arrows and pills and marks the rest of
the workspace inert while a switch is in flight.

### 1.2 What is extracted

A new module, `frontend/athlete-switcher.js`, with pure functions and no state of its own:

```
renderAthleteSwitcherStripHtml({
  items,          // [{ key, name, caption?, imageUrl?, teamColorStyle?, groupLabel? }]
  currentKey,     // the chosen item's key, or "" for none
  action,         // the data-action of every pill and arrow
  keyAttr,        // the data-* attribute that carries the key ("data-plan-id", "data-athlete-key", …)
  allItem,        // optional { label: "Everyone", caption: "All" }: a first pill whose key is ""
  ariaLabel,      // the strip's label ("Batch athlete plans", "Athletes")
  wrapArrows,     // false: ‹ on the first pill and › on the last are disabled (the Builder today);
                  // with allItem, *All* is the first pill, so ‹ is disabled on *Everyone*
})
athleteCaption(name)          // "Ana K." — the rule the Builder uses today
athleteSwitcherScrollIntoView(root)   // keeps the chosen pill in view (F1, phones)
```

It returns exactly the `builder-batch-buttons` markup: ‹, the pills, ›. The pills keep the `builder-batch-*` classes,
so the look is one CSS, not two. What is new is opt-in, drawn only when its argument is given:
- the *All* pill (`allItem`), first in the strip;
- the team-colour dot (`teamColorStyle`): a `<span class="athlete-switcher-dot">` inside the avatar;
- the vertical team label between groups (`groupLabel` on the first item of a group; F4).

The search field and the "Groups" row are **not** part of the strip. They are separate small renderers in the same
module, so the Builder never draws them:

```
renderAthleteSwitcherSearchHtml({ value, action, placeholder, results, activeIndex, emptySentence })
```

### 1.3 What stays in the Builder

`renderBuilderBatchSwitcher` keeps its section, its summary, its hidden-members sentence, its status line and its
mode part. It calls `renderAthleteSwitcherStripHtml` with:
- `items` = the batch plans (key = plan id, name = `athleteName || name || "Program copy"`, image from
  `state.athletes`, the rule of today: the fallback feeds the caption, the title and the initials);
- `action` = `builder-open-batch-plan`, `keyAttr` = `data-plan-id`;
- no `allItem`, no dot, no group label, `wrapArrows: false`.

`builder-actions.js` and `renderBuilderBatchSwitchProgress` do not change: they still find the buttons by
`data-action="builder-open-batch-plan"`.

### 1.4 How the Builder keeps working byte for byte

- **A golden test**, written and committed **before** the extraction, on today's `renderBuilderBatchSwitcher`: three
  batches (2, 5 and 12 plans; first, middle and last chosen; with and without a photo; with a hidden count; as an edit
  draft and not; one plan with neither `athleteName` nor `name`, so "Program copy" is pinned). It compares the **raw
  HTML string**, whitespace included: the extraction copies the template literal's indentation and line breaks as
  they are, so every string stays identical. The existing Builder suites
  (`builder-edit-draft-batch-sync`, `builder-batch-hidden-members`, `builder-drafts-view-cache` and the rest of
  `--filter builder`) must stay green unchanged.
- **Order with #673.** Step 2 changes the Builder's mode part and the render chain around the switcher
  (`builder-view.js`), not the strip. K6's code starts from a `main` that holds #673, or, if K6 is first, it touches
  only the strip part of `renderBuilderBatchSwitcher` (`builder-batch-buttons`), so the two merge cleanly. The K6
  pull request runs a `git merge-tree` against #673's head before review.
- The Builder gets no *All* pill, no dot and no search in K6. It can take them later (mockups, "Not in these
  mockups").

## 2. K6-1, the calendar (frontend only)

### 2.1 Where it is drawn (F1)

The **switcher box** sits under the week's navigation, above the day grid, in the week and day views. In the month
view it is drawn too: an athlete chosen there narrows the month the same way.

- **Computer:** the box is always open.
- **Phone (≤ 760 px):** folded to one line, "Everyone · U19 ▾" or "Ana Kovač · U19 ▾". A tap opens the box in place;
  choosing an athlete folds it again. The green "Showing …" line (2.5) stays visible when the box is folded.

The box holds, from top to bottom: the **Groups** row (2.2), the **search** (2.6), the **strip** (2.3).

### 2.2 Groups: the existing chips, moved

The *Groups* chips of the Filters panel (`central-calendar-all-groups`, `central-calendar-toggle-team`,
`frontend/central-calendar-view.js:515-519`) move from the Filters panel into the switcher box. Their actions, their
state (`cal.filters.teamIds`), their counts and their colours do not change. They are not drawn twice: the Filters
panel loses its Groups row and keeps Types and the event types.

- **One team at a time inside the box.** In the box a Groups chip is a choice of one team (or *All groups*), since the
  strip shows one team's athletes. Today the chips toggle several teams. **Q1** (section 7) asks whether to keep the
  multi-toggle; the recommendation is one team, with *All groups* for all.
- The Groups row is drawn only where the calendar's answer has more than one team (`cal.data.teams.length > 1`): a
  club workspace, and the platform workspace. A team workspace has one team, so no Groups row (S5). A private coach
  has none.
- Choosing a team re-fills the strip with that team's athletes. If the chosen athlete is not in the new team, the
  athlete choice goes back to *Everyone*.

### 2.3 The strip: where the athletes come from

The strip never lists anyone who is not in `state.athletes`, the rail roster the workspace already shows. That roster
is the one the calendar's panel already uses for its drill-in (`centralCalendarRosterIndex`,
`frontend/central-calendar-actions.js:264`). The server builds it with `athleteRosterScope`
(`backend/src/athleteRosterScope.js`) for the active workspace:

| Workspace | `state.athletes` (server rule) | Team per athlete (for Groups, the dot and the order) | The strip |
|---|---|---|---|
| **Team** (team coach) | active members of this one team | not needed: one team | the roster, by name |
| **Club** (club admin) | active members of this club | `GET /api/organization` → `athletes[].memberships`, kept only where `membershipType = 'team'`, `status = 'active'`, and `teamId` is one of `cal.data.teams` | the chosen team's athletes; with *All groups*, every athlete by team (2.4) |
| **Private coach** | athletes of this coach's active private relationships | none (no teams) | the roster, by name; no Groups row |
| **Platform** | **empty** (`athleteRosterScope` has no platform branch: `and false`) | — | **no strip and no search** (Q2); the Groups row stays as today |

The strip's list is `state.athletes` **intersected with** the membership facts, never `GET /api/organization`'s
athlete list on its own. That list also carries rows whose only tie is archived (for Settings' *Show archived*), and
**every** membership of each athlete it returns, with the club's and team's names, in other clubs too:
`loadManagedAthletes` builds `memberships` from all of the athlete's rows (`backend/src/routes/organization.js:3670-3686`),
and the workspace filter (`:70-101`) narrows which athletes are returned, not their memberships. That is an existing
property of the Settings read, outside K6 (recorded for the OptiMove manager, section 8). For K6 it means the
**frontend rule below is the only thing that keeps another club's names off the calendar**, and F-H2 is its guard:
- **Reduced on arrival.** The calendar never stores the answer. On arrival it keeps only `{ athleteUuid, teamId }`
  pairs where `membershipType === "team"`, `status === "active"`, `teamId` is one of `cal.data.teams`, and the
  athlete is in `state.athletes`; everything else (users, e-mails, invites, join links, access requests, names,
  archive reasons, other memberships) is dropped at once and is never put into `state` or the calendar's state.
- a row of `GET /api/organization` that is not in `state.athletes` is never drawn;
- a membership whose team is not one of the calendar answer's `teams` is never kept: no other team's or club's name
  is shown, even for an athlete who also trains with another club;
- an athlete of the roster with no active team membership in the workspace's teams is listed after the teams, under
  the label "No team" (club workspace only).
- **Narrower than the calendar's scope, on purpose.** A club workspace's roster is the athletes with an active
  **club** membership (`athleteRosterScope.js:15`); the calendar's own scope also reaches an athlete with only a
  team membership in one of the club's teams on that day. Such an athlete is on the cards but not in the strip, and
  K6 never sends their id. That is not a leak (the strip is the narrower set).
- **A presentation hint only.** The kept pairs decide the grouping, the dot and the order; they authorize nothing. The
  server decides every read again (`athleteIds` narrows inside its scope, 2.5).

**Why `GET /api/organization` and not a new read.** It is already read, in the active workspace, by Training Load's
filter (`loadTrainingLoadOrgPickerData`, `frontend/training-load-data.js:404-409`), the Tests recipient picker and the
Builder's athlete picker, and what K6 takes from it (who is in which of the workspace's teams) is already shown in
Settings → Teams and → Athletes of the same workspace. The calendar reads it once per workspace, **only in a club
workspace**, into its own small cache of the reduced pairs, keyed by sign-in and workspace
(`currentUserWorkspaceContextParts()`) and guarded by a generation counter, so an answer for workspace W1 that
arrives after a switch to W2 is dropped and never drawn. A workspace switch or a sign-out clears it. A team coach, a
private coach and the platform do not read it for K6.

If `GET /api/organization` fails or is still loading in a club workspace, the strip shows the roster by name with no
team grouping and no dot, and the Groups row still works on the cards (2.5). A sentence says "Teams could not be
loaded. Try again", with a retry.

### 2.4 Order, the dot and the team label (S4, F3, F4)

- **One team chosen:** the team's athletes by name (`localeCompare`, the same order the calendar's panel uses). The
  first pill is *All* ("Everyone"), the key "".
- **All groups, up to 60 athletes in the strip** (F3): every athlete, ordered by team in the Groups row's order (the
  answer's `teams` order: `t.name, t.id`), then by name. A thin vertical label with the team's name starts each team's
  group (F4), and each avatar carries its team's colour dot (the colour the calendar's chips already use,
  `teamColorStyle`).
  - **An athlete in two teams of the club** (the owner's concern of 2026-10-30) appears **once**, under the first of
    their teams in that order, with that team's dot. In a chosen team's strip they appear in each of their teams.
    The search result names both teams (2.6).
- **All groups, more than 60 athletes:** no strip. The box shows the search and one sentence, "62 athletes in the
  club. Search for an athlete, or choose a group." The number is the length of the strip's own list (2.3, the
  roster after the intersection), never the length of `GET /api/organization`'s list (which also counts
  archived-only ties). The 60 is a constant in the code, not a setting.
- **"N / M"** counts within the strip shown (the team's, or the club's when the strip is shown with *All groups*). It
  is not drawn while *Everyone* is chosen.

### 2.5 Choosing an athlete: the read, FE-D16, *Show only*, and the green line

**The read.** Choosing an athlete reads the calendar with `athleteIds=<the athlete's UUID>` (one id). The server
already narrows inside the mandatory scope (`calendarAthleteFilterSql`, `backend/src/calendarAccess.js:250-269`): an
id outside the scope matches nothing (tested today: `central-calendar-k1a.test.mjs`, the `outsider` case at line 855).

- The URL builder (`centralCalendarUrl`) gains `athleteIds`. The cache key (`centralCalendarContextKey`) gains
  `athlete:<uuid>`, so the unfiltered read keeps its key and its cache.
- **`athleteIds` alone.** The athlete read never sends `clubIds` or `teamIds`: the server's filter is a union inside
  the scope ("club OR team OR athlete", `calendarAthleteFilterSql`), so a team sent with the athlete would widen the
  answer to the whole team. The Groups chips stay an in-memory filter (2.2). A URL-builder test and a mutation pin it.
- **No new content.** For any viewer, the athlete read returns a subset of the unfiltered read of the same range
  (H5): K6 adds no card, team or right the coach does not already see, it only gathers one athlete's.
- This changes decision A of the K1b data module ("never a filter parameter", `central-calendar-data.js:9-12`): the
  athlete is a server filter. Its comment is updated. The reason: the cards and their numbers must be that athlete's
  (the mockup's "U19" without "18", Ana's own "Gym · upper body"), which an in-memory filter of the unfiltered answer
  cannot give.
- The unfiltered answer is still read and kept: the Groups chips' counts, the teams, the workspace and the event
  form's suggestions come from it, as today.

**With FE-D16.** The two filters stack. While only non-event kinds are chosen, the kinds read
(`centralCalendarServerKinds`) also carries `athleteIds`: its key is `kinds:<kinds>` plus `athlete:<uuid>`. The cards
come from the most specific read that covers the range: kinds + athlete, else athlete. **While an athlete is chosen,
the cards never fall back to the unfiltered answer** (today's last fallback of `centralCalendarShownData`,
`central-calendar-data.js:91-96`): while the athlete's read is loading the grid shows the calendar's loading state,
and if it fails, the calendar's error state with *Try again*, never everyone's cards under "Showing Ana Kovač". A
stale read is dropped by the generation counters, as today.

**Known: an athlete only linked to an event.** Under `athleteIds` an event is kept only when one of its **target**
athletes is in the filter (`calendarQuery.js:904-910`). An athlete whose session is linked to an event she is not a
target of (`targeted: false`) therefore sees that session as her own planned card, not under the event. That is the
server's existing rule; K6 does not change it, and the panel of the unfiltered calendar still shows the event.

**With K5's *Show only*** (K5-2, not built yet). *Show only* filters the shown answer in memory, so it works on the
athlete's read unchanged ("only GPS imports, for Ana"). If K5 is built first, K6 adds the athlete to its line; if K6
is first, K5 adds its kind to K6's line.

**The Groups chips while an athlete is chosen.** The chips' in-memory card filter (`cal.filters.teamIds`,
`central-calendar-view.js:125-130`) is **suspended** while an athlete is chosen: the chosen team then scopes only the
strip. Otherwise a club-wide event Ana is in (its `teamIds` empty or another team's) would vanish from her week
(Q3, decided).

**The open panel.** The day read for the panel (`include=athletes`) carries the same `athleteIds` and kinds as the
cards it was opened from (the FE-D16 rule of `central-calendar-data.js:475`), so the panel finds its card. The
panel's athlete list is then the chosen athlete's row. *Show everyone* in the panel's note reads the item again
without the athlete (Q5, decided).

**The green line (F2).** Whenever the choice is not *Everyone*, a line above the grid says what is shown:
- "Showing **Ana Kovač** · U19 · *Show everyone*";
- with a kinds filter or *Show only*: "Showing Ana Kovač · U19 · only GPS imports · *Show everyone*";
- a team coach and a private coach: no team part ("Showing Ana Kovač · *Show everyone*").

*Show everyone* sets the athlete back to *Everyone* and leaves the kinds as they are. The existing "Clear filters"
clears the athlete too.

**Remembered (F2).** The chosen athlete and team are kept in memory, by sign-in and workspace, for the session (the
pattern of the calendar's view mode, but in memory only, never in `localStorage`). Before the first read that would
use it, a remembered athlete is checked against the current `state.athletes` (and a remembered team against
`cal.data.teams`); one that is no longer there is dropped and *Everyone* is used, so a stale id is never sent. A
workspace switch or a sign-out clears the choice. Entering the platform workspace clears it too, and there "Showing
…" never appears (no strip, Q2).

**One athlete at a time.** ‹ › move to the previous or next pill in the strip shown. The *All* pill is the strip's
first pill, so on *Everyone* › chooses the first athlete and ‹ is disabled; on the last athlete › is disabled (no
wrap, as in the Builder). A read in flight shows the calendar's existing loading state; a second tap cancels the
first by generation.

### 2.6 The search (S4)

- A 16 px field above the strip, with the placeholder "Search athletes". Drawn whenever the strip has more than 8
  athletes, or *All groups* has more than 60 (when it is the only way in).
- It searches the same list the strip draws from (2.3) **in memory**. It never reads the server.
- Matching: case- and accent-insensitive (`normalize("NFD")`, the marks removed), a match at the start of any word of
  the name first, then anywhere in the name. The results are ordered by that rank, then by team (Groups order), then
  by name. At most 8 results are shown, then "and N more — keep typing".
- Each result shows the photo or initials, the name with the matching letters marked, and, in a club workspace, the
  team's name and dot (both teams for an athlete in two).
- ↑ ↓ move, Enter chooses, Escape clears. Choosing a result of **another** team sets the Groups choice to that team
  (the first of the athlete's teams in the club's order if two), re-fills the strip with that team, scrolls the pill
  into view, and reads the athlete's week.
- No match:
  - a team coach: "No athlete in this team matches ‘marko’." (nothing about other teams);
  - a club admin: "No athlete in this club matches ‘marko’.";
  - a private coach: "None of your athletes matches ‘marko’."

  The sentence depends only on the typed text and the list searched: a name of an athlete outside the list (another
  team's, another club's) gives exactly the same sentence as a name that exists nowhere.

### 2.7 Phones

- The Groups row and the strip scroll sideways; ‹ › stay fixed at both ends of the strip.
- Every target is at least 44 px; the field is 16 px (no iOS zoom).
- The chosen pill is scrolled into view after every render (`athleteSwitcherScrollIntoView`).
- No page-level horizontal overflow at 360, 375 and 390 px.

## 3. K6-2, the Weekly plan header (frontend only)

### 3.1 Where it is drawn, and for whom

The Weekly plan's header gets the switcher whenever the coach opened the plan from the central calendar (its panel,
K6-1's "Open the week" or K6-3), and the list has more than one athlete. It is drawn above the week's navigation:

"‹ (avatar) **Ana Kovač** › · U19 · 1 / 18", with the strip under it (the shared component, `wrapArrows: false`), and
in a club workspace the Groups row above it (S2).

- **The list:** the same list as K6-1's strip for the team chosen there (2.3); from K6-3, the event's athletes only
  (4.2). An athlete not in `state.athletes` is never in it (the plan's own route reads by the roster's id).
- It is not drawn for an athlete's own workspace, and not when the plan was opened from the Athletes list or Coach
  Home (the switcher belongs to the calendar's flow; Q8, decided).

### 3.2 Moving to another athlete keeps the week, the day and the open session

The plan is selected by `state.selectedAthleteId` (the roster's `athlete_id`) and drawn from
`GET /api/athletes/:athleteId/program-data?program=__weekly__` (cached per athlete, `weekly-data.js`). The place the
coach is at is:
- the week: `state.viewedWeekStart`;
- the day: `state.selectedWeekDay`;
- the open session: `state.navStack`, the drill-in path of nodes (`app.js:3221-3227`). Its first levels are the
  session levels built by `frontend/program-structure.js`: an `amPm` node (AM / PM), under it a `bta` node (one node
  per B / T / A of that half-day: **every session of the same slot shares one `bta` node**, whatever its order); or,
  for items with no AM/PM, a `bta` node directly, or one `session` node (the blank group, `program-structure.js:90`).
  Below those come domain / category / section nodes. Node ids are random (`crypto.randomUUID()`), and nodes carry no
  slot field.

**The slot key of each level**, derived from the node's own items (never from its label or id):
- `amPm` → the items' `amPm`;
- `bta` → (`amPm` of its items, or "" when none, `bta`);
- `session` → the blank group: ("", "").

Matching goes **no deeper than the session level**: below it (domains, categories, sections) the nodes are each
athlete's own content, with no shared key, and labels are not used to match (they carry a session's own name and
time, which may differ between athletes; today's sibling match by type and label, `app.js:4523-4525`, is not used
here). Two sessions in one slot are one `bta` node, so "the session" kept is that slot's node.

Moving to athlete B:
1. Remember A's place as **slot facts**: the week, the day, and the slot keys of `navStack`'s session levels (at most
   two: `amPm`, then `bta`; or one).
2. Set `state.selectedAthleteId` to B, load B's weekly data (cached if seen this session), and set
   `viewedWeekStart` and `selectedWeekDay` to A's.
3. Rebuild `navStack` for B from B's nodes of that day, level by level, matching the slot key. Stop at the deepest
   level that matches, never below the session level.
4. A quiet line under the header says what is kept: "Monday 12.10 · Training · Main session" (B's own names). If the
   path stopped early, the line says what B does not have: "Ben has no Training (PM) on Monday 12.10." The day stays
   open. If A was deeper than the session level, B's view stops at the session level, and the line says so ("Opened
   at Training · PM").

**History.** Moving between athletes pushes **no** history entry and replaces `navStack` without
`pushAppHistory()`. The rebuilt path therefore holds no per-level entries. Back works as it does today, which
(`handleAppBack`, `app.js:2285-2289` before `takeAppBackEntry`, `:2331`) means:
- **the phone's and the browser's Back** first step up the open session's levels that were opened by a drill-in
  (each drill-in pushed one entry, `app.js:3221-3227`), and then return to where the plan was opened from (the
  calendar's place, or the event's panel, K4-0). After a switch, B's path may be shorter than A's, so some of A's
  drill-in entries find no level left to pop; today's code then takes the newest app-history entry, and a stale entry
  of the same tab is skipped (`skipStaleAppBackEntry`). The contract's requirement is the outcome, not a press count:
  every Back either steps up one open level or moves on, never shows the same view twice, and the last one lands on
  the calendar's place. The weekly test pins the exact count for A two levels deep and B one level deep;
- **the visible *Back to calendar* control** returns to the calendar's place in one tap, whatever the depth: it
  clears `navStack` and goes back through the app history to the entry the calendar left (`takeAppBackEntry` /
  `restoreAppPlace`).

So ten athletes are never ten Backs (Q6, decided). Changing the phone's Back to skip the session levels would change
the app-wide Back and is not part of K6.

**A write in flight.** The Weekly plan's own writes (the copy modal, the more-menu actions) keep their existing
guards; while one is in flight the switcher's buttons are disabled, the Builder's pattern
(`renderBuilderBatchSwitchProgress`).

### 3.3 An athlete with no plan this week (F5)

› never skips. An athlete with no weekly plan in the kept week shows the week's blank state with "No plan this week"
and the existing *Create weekly plan* action (`weekly-create-plan`), labelled "Plan it in the Builder". The order is
the strip's order.

## 4. K6-3, *See each athlete* from an event (frontend only)

### 4.1 Where the action is

The event's panel gets **See each athlete** (the panel's one primary action, as in the mockup), with "Opens Main
session, one athlete at a time, only the 5 of this event." It is offered when:
- the viewer **manages** the event (the panel already has the manager view of `GET /api/calendar/events/:eventId`,
  whose `sessionLinks` carry each linked athlete and the slot: `planId`, `day`, `amPm`, `bta`, `order`,
  `athleteId`; `backend/src/calendarEventService.js:463-488`), and
- at least one listed athlete of the event's day is in `state.athletes`.

A coach who only reads the event (the reduced view, no `sessionLinks`) gets **Open the week** instead: the same
switcher on the event's day, without a session (Q7, decided: no slot in the reduced view). A reader never gets the
"not in your roster" sentence of 4.2.

### 4.2 Which athletes are listed (F6)

The switcher holds the athletes of the event's panel list for that day (the day read's `athletes`, which already
holds the event's targets and every athlete of a linked session, `targeted: false` for a linked one who is not a
target), **intersected with `state.athletes`**, in the panel's order (by name). An athlete outside the roster stays in
the panel as today ("Not in this workspace's roster") and is not in the switcher; the switcher says "2 athletes of
this event are not in your roster" (the Builder's hidden-count sentence of #664, worded for the event). The number is
the panel list's own length minus the switcher's, so it counts only athletes the server already named to this
manager in the panel; it is shown to a manager only (a reader has no switcher here, 4.1).

- **The session opened** is the event's linked slot of that day: the (`amPm`, `bta`) of its session links (3.2's
  slot key; a link's `order` is not a level of the Weekly plan, so two links of one slot open the same node). If the
  event's links on that day name more than one slot (two trainings in different slots linked to one event), the panel
  shows one button per slot: "See each athlete · Main session", "See each athlete · Gym".
- **How it opens.** The plan opens on the day, then on the slot's node, by the same drill-in as a tap (one history
  entry per level, 3.2), so Back steps up from the slot and then returns to the panel.
- **F6: a target with no linked session.** The athlete is in the switcher. When the coach reaches them, the plan
  opens on the day and says "**Not in this session** · Ben has no Main session linked to this event on Monday 12.10."
  The strip marks the pill with a small "–" once known. Before the coach reaches them, the switcher knows only who
  has a link: an athlete with a session link of that day (from `sessionLinks`) is "in", every other target is "not in
  this session". So the mark is drawn from the start, with no new read.
- "3 / 5 in this event" counts the listed athletes.

### 4.3 Back

*Back to calendar* sits above the switcher and returns, in one tap, to the calendar with the event's panel open on
that day. The phone's and the browser's Back first step up the opened slot's levels, then return there (3.2). The
place is K4-0's app-history entry (`appHistoryEntryOf`, `frontend/app-history.js:10-23`: the view, the anchor, the
selected day and the open panel's key) restored by `restoreCentralCalendarPlace` (`central-calendar-actions.js:376-394`).
The chosen athlete is not part of that entry; it survives Back through the in-memory remembered choice of 2.5.
Switching athletes pushed no entry (3.2), so it adds no Back.

## 5. Who sees what, and the info-hiding tests

### 5.1 The rule

The switcher never lists, names, counts or colours an athlete or a team the active workspace does not already show:
- athletes: only `state.athletes` (the server's roster scope), intersected, never united, with any other list;
- teams: only `cal.data.teams` (the calendar answer's workspace teams), for the Groups row, the dot, the order and the
  search's team names;
- counts: the Groups chips' counts of today; the strip's own length (never `GET /api/organization`'s); the
  hidden-count sentences count only athletes the server already named to this viewer (an event's panel list, a
  batch's `hiddenCount`);
- stored data: of `GET /api/organization`, only the reduced `{ athleteUuid, teamId }` pairs of 2.3, never the answer.

The server is the guard. `athleteIds` narrows inside the scope; a forged id returns nothing; the athlete read is
always a subset of the unfiltered read (H5). The frontend rule is defence in depth and a correctness rule (no pill
that leads nowhere), and for other clubs' membership names in `GET /api/organization` it is the only guard (2.3).

### 5.2 The info-hiding test list

Backend (disposable database, through the real routes; no new route, so these pin the reads K6 relies on):
- **H1, the manager's condition.** A club with teams A and B; athlete a1 in A, b1 in B, and x1 in A **and** in another
  club's team. A team coach of A in A's team workspace: `GET /api/admin/athletes` lists a1 and x1 and **not** b1;
  `GET /api/calendar?athleteIds=<b1>` returns no card of b1; `GET /api/calendar?athleteIds=<b1>&teamIds=<B>` still
  returns nothing outside A's scope. (These exist in parts today; H1 puts them in one test named for K6.) H1 does
  **not** assert anything about `GET /api/organization`: a team coach does not read it for K6, and that answer does
  carry x1's other-club membership names today (2.3, recorded in section 8).
- **H5, no new content.** For the team coach of A and for the club admin: `GET /api/calendar?athleteIds=<x1>` for a
  range returns a **subset** of the unfiltered read of the same range: every card's key, title, `teams` and
  `canManage` also appear in the unfiltered answer (x1 is in the other club's team too, so items of that club that
  target x1 are in both or in neither).
- **H2.** A club admin of the club: the roster lists a1, b1 and x1, no athlete of the other club;
  `athleteIds=<an athlete of the other club>` returns nothing.
- **H3.** A private coach: only their own relationship's athletes; no `GET /api/organization` read is needed.
- **H4.** The platform workspace: `GET /api/admin/athletes` returns no rows (documents why no strip is drawn, Q2).

Frontend (JSDOM, through the real handlers, with a fake API that keeps the routes' contracts):
- **F-H1.** Team workspace: the strip and the search list exactly the roster; a name of another team typed in the
  search gives the team sentence and no other team's name anywhere in the DOM; that sentence is byte-identical to the
  one for a name that exists nowhere; no Groups row; `GET /api/organization` is not requested.
- **F-H2.** Club workspace, `GET /api/organization` answering an athlete **not** in the roster (an archived-only tie),
  a membership of x1 in another club's team, users with e-mails and a join link: the archived athlete is drawn
  nowhere; the other club's team and club names are in no pill, label, search result or `aria-label`; the stored cache
  holds only `{ athleteUuid, teamId }` pairs of the workspace's teams (no other key, no e-mail, no other-club id or
  name, checked with `JSON.stringify` of the whole calendar state).
- **F-H3.** A `GET /api/organization` that fails: the strip falls back to the roster by name; nothing else is drawn.
- **F-H4.** K6-3: a panel athlete not in the roster is not in the switcher, and the event sentence counts them.
- **F-H5.** The platform workspace: no strip, no search, no `GET /api/organization` read for K6, no "Showing …" line,
  and an athlete chosen in another workspace is cleared on entering it.
- **F-H6.** A workspace switch clears the chosen athlete, the search and the cached organization pairs; the next
  workspace's first render shows none of them.
- **F-H7.** A coach with roles in two workspaces: a slow `GET /api/organization`, athlete read, kinds read or panel
  day read of W1 that answers after the switch to W2 is dropped and drawn nowhere; a remembered athlete is checked
  against W2's roster before the first read, so its id is never sent in W2.

## 6. Tests

### 6.1 Unit (frontend, T1 runner, `--project frontend`)

- `athlete-switcher.test.mjs`: the strip with and without *All*, the dot and the group label; the caption rule; the
  disabled ends; the scroll helper; the search's ranking, accents, the 8-result cap and the empty sentences.
- `builder-batch-switcher-golden.test.mjs` (1.4): committed first, unchanged by the extraction.
- `central-calendar-k6.actions.test.mjs`, through the real handlers:
  - the list per workspace type (2.3), the 60 rule (2.4), the order by team then name, x1 once with *All groups*;
  - the read's URL and key with an athlete, with kinds, and both (2.5); the athlete URL never carries `teamIds` or
    `clubIds`; a slower older read dropped;
  - while an athlete is chosen and its read is pending or failed, no card of the unfiltered answer is drawn;
  - the Groups chips suspended while an athlete is chosen (Q3);
  - the green line's three forms; *Show everyone*; Clear filters;
  - search → another team sets Groups and reads the week;
  - remembered across a view switch, cleared by a workspace switch;
  - the F-H tests of 5.2.
- `weekly-k6.actions.test.mjs`: › keeps the week, the day and the slot path; A and B with differently named sessions
  in the same T slot reach the `bta` level; A deeper than the session level → B stops at it, with the sentence; a
  missing slot and its sentence; "No plan this week"; switching athletes pushes no history entry
  (`state.appHistoryDepth` unchanged); through `handleBrowserBack()` from a real drill-in: Back steps up A's drilled
  levels, then lands on the calendar (`state.activeTab === "central-calendar"`), and *Back to calendar* lands there
  in one tap.
- `central-calendar-k6-3.actions.test.mjs`: the action offered to a manager only; one button per slot; the list,
  roster-intersected, with its sentence (a manager only); "Not in this session" for a target without a link; Back to
  the panel, with `selectedDate` kept and the chosen athlete still chosen.

Backend: H1–H5 in `central-calendar-k6-scope.test.mjs` (disposable).

### 6.2 e2e (Playwright, `e2e/`, at 1280, 390, 375 and 360 px)

The world: one club, two teams (one with 18 athletes, one with 24, one athlete in both), a team coach, a club admin,
a private coach, three events (one with five linked athletes and one target without a link).

1. Club admin: Groups → U19 → Ana → the week shows her cards only; › → Ben; the green line; *Show everyone*.
2. Club admin, *All groups*: the mixed strip with team labels and dots; search "mar" → Marko of the First team →
   Groups switches, his week is shown.
3. Team coach: no Groups row; the strip of the team only; a search for another team's athlete → the team sentence.
4. Weekly plan: from the calendar, open Ana's Monday, drill into Training · Main session, › → Ben on the same session;
   an athlete without a plan → "No plan this week"; *Back to calendar* → the calendar in one tap; again from the
   session, the phone's Back steps up the levels and then lands on the calendar.
5. K6-3: the event's panel → *See each athlete* → 3 / 5 in this event; the target without a link → "Not in this
   session"; Back → the event's panel.

At every width: no page-level horizontal overflow, every control ≥ 44 px, every field 16 px, the chosen pill in
view, no console error.

### 6.3 Mutations (key guards only, §6 of `agent-efficiency.md`)

- the roster intersection removed (the strip draws `GET /api/organization`'s list) → F-H2 fails;
- the team filter on memberships removed (another club's team name drawn) → F-H2 fails;
- `athleteIds` dropped from the URL → the read test fails;
- `teamIds` sent with `athleteIds` → the URL-builder test fails;
- the reduction of the organization answer removed (the raw answer stored) → F-H2's state check fails;
- the fallback to the unfiltered answer kept while an athlete read is pending → the pending-read test fails;
- the remembered athlete sent without the roster check → F-H7 fails;
- the athlete part dropped from the cache key → the key test fails;
- the Groups suspension removed → the club-wide event test fails;
- the slot match replaced by the label match → the "labels differ" weekly test fails;
- `pushAppHistory()` on an athlete switch → the "no history entry" weekly test fails;
- the K6-3 roster intersection removed → F-H4 fails.

### 6.4 Gates

The Frontend PR gate (the whole `--preset frontend-fast` on the head and on a clean `origin/main`, compared), the
targeted suites above, the backend disposable H tests, the build, `git diff --check`, the browser check of 6.2, and
`git merge-tree` against #673 and the open calendar branches. Reviews: `code-reviewer`, `mobile-qa`,
`ux-design-reviewer` (the plan's section 4); no `security-reviewer` on the code, since no backend changes (Q4 and Q7
decided).

## 7. Questions, decided

**Decided by the stream manager on 2026-11-20: every question as recommended below.** In particular Q2 (no strip in
the platform workspace; the Groups chips stay), and Q4 and Q7 (the light reads are not taken), so K6 stays ★ with no
backend change.

- **Q1. The Groups chips: one team, or several as today?** The strip shows one team's athletes. **Recommend one
  team** (plus *All groups*), in the box and on the cards. Several teams at once would make the strip a mix the
  coach did not ask for. It changes today's chips from toggles to a choice; nobody loses a view they have, since
  *All groups* stays.
- **Q2. The platform workspace.** Its roster is empty by rule (`athleteRosterScope` has no platform branch), so there
  is nothing to list without a new read. **Recommend no strip and no search there** in K6; the Groups row stays. A
  platform admin who needs one athlete works in that club's workspace. A platform list would be a new read: trigger 2.
- **Q3. While an athlete is chosen, do the Groups chips still filter the cards?** **Recommend no:** the chosen team
  then scopes the strip only, so a club-wide event of the athlete is not hidden.
- **Q4. A light athlete→team read instead of `GET /api/organization`?** That read is heavy (users, join links, invite
  states) and K6 uses one fact of it. A small `include=roster` on `GET /api/calendar` would be cleaner, but it is a
  new read of membership data: trigger 2 (security and external review). **Recommend `GET /api/organization` for
  K6** (already read in the same workspace by three screens, nothing new shown), and the light read only if its
  weight is measured to matter.
- **Q5. The panel while an athlete is chosen: only that athlete, or everyone on the item?** **Recommend only that
  athlete** (the panel follows the cards it was opened from, the FE-D16 rule), with *Show everyone* to read the item
  again without the athlete.
- **Q6. The Weekly plan: does moving between athletes add history entries?** **Recommend no entry**, so the number of
  Backs (the drilled levels, then the calendar; or one tap on *Back to calendar*) does not grow with the athletes seen
  (3.2). Today's app-wide Back, which steps up the drilled levels first, is not changed.
- **Q7. K6-3 for a coach who only reads the event (no `sessionLinks`)?** **Recommend Open the week** (the day, no
  session) for readers in K6. Opening the session for them needs the slot in the reduced view, a backend change to an
  info-hiding contract (trigger 2).
- **Q8. The Weekly plan switcher when the plan was not opened from the calendar** (the Athletes list, Coach Home)?
  **Recommend not in K6**: S1 asks for it inside the calendar's flow. It can follow with the same component.
- **Q9. The 60 of F3: a constant, or per club?** **Recommend a constant** in `athlete-switcher.js`, changed by a pull
  request if the pilot shows another number.

## 8. Not in K6

- No new route, no backend change, no migration (Q4 and Q7 decided: the light reads are not taken).
- No change to the Builder's switcher beyond the extraction (1.4).
- No change to K5; K6 and K5 share the green line (2.5) in whichever order they land.
- No physical-device check in this contract; the e2e widths of 6.2 and `mobile-qa` cover the layout, and a device check
  is recorded as a follow-up.
- **Recorded for the OptiMove manager, outside K6 (found by this contract's security review):** `GET /api/organization`
  returns, for every athlete it lists, all of that athlete's memberships with the club's and team's names, other
  clubs included (`backend/src/routes/organization.js:3670-3686`; the workspace filter at `:70-101` narrows the
  athletes, not their memberships). So a team coach or club admin reading Settings sees the names of another club's
  teams an athlete also belongs to. Whether that is intended is a separate decision; changing it is a backend change
  to an info-hiding contract (trigger 2). K6 does not depend on it either way: it keeps only its reduced pairs (2.3).
