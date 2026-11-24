# Roles R4-4: the screens of the role layers (screen contract)

Step R4-4 of `docs/ai/roles-r4-contract.md` (the *R4 contract*; section 13, row R4-4): the screens of section 9 and the
navigation of section 5.2. This document is the discovery and the screen contract only. **No screen is built before the
manager's go.**

| | |
|---|---|
| Status | **Accepted** (the manager's GO, 2026-11-24, with the owner's decisions of section 11a). Built in two pull requests (section 10). |
| Written against | `origin/main` at `2f2a2b3` (2026-11-24): R4-1 (v92), R4-2 (`club_view` / `team_view`), v95 and the R4-3 API are merged. Re-checked at `766e338` (R4-3b, PR #759, merged): it changes only the grant routes' locks, tests and R4 contract 18; no route, body or code this document uses changed. Its decision that *Accept the default* is not checked against the admin's own words means both O3 buttons are always offered to a club admin (5.2). Every `file:line` below is at `2f2a2b3`; the frontend files did not change since. |
| Level | Ordinary (frontend only, no server change planned; section 9 names the one place where a server change could be asked). Reviews: `code-reviewer`, `ux-design-reviewer`, `mobile-qa`; the *Rukovodilac*. |
| Owner orders | Every new or substantially reworked screen is a React island (`.claude/rules/frontend.md`, "React islands"). Simple and plain for a club admin. Phone first: 360 / 375 / 390 px, 44 px targets, 16 px inputs. No real athlete's name in tests, fixtures or screenshots. |

## 1. What exists today

| Place | Today | Evidence |
|---|---|---|
| Settings > Roles (R3) | A plain screen: the list of roles (R2 `GET /api/organization/roles`), a form per role with every word grouped by module, a "Level" select per group, create / edit / copy / archive. Offered to a platform admin (platform or club workspace) and to a holder of `roles.manage` or `org.view` in a **`club`** workspace. | `frontend/roles-view.js`, `roles-actions.js`, `roles-data.js:23-38` (`rolesContext`), `navigation.js:180` |
| Settings > Users (R3) | The plain organization users list, the R2 assignment form ("Give a role") and "Who holds what" (R2 assignments, revoke). The old Club admin / Team coach rows are managed in *Manage account*. | `roles-view.js:252-378`, `organization-view.js:1429`, `:1534-1590` |
| Settings > Clubs | The clubs list and the club form (platform admin edits). No licence. | `organization-view.js` |
| Permission words in the browser | `permission-nav.js` hides Settings tabs by the words of `/me`; without a list it falls back to the old visibility (`legacy`). | `frontend/permission-nav.js:16-40` |
| View workspaces | **Not known to the frontend at all**: no file under `frontend/` names `club_view`, `team_view` or `closedModules` (grep at `2f2a2b3`). Every row of the R4 contract's table 5.2 is still open. | grep |
| React islands | One island so far (`react/bottom-nav.jsx`), the bridge `react/mount.jsx` (`mountIsland` / `unmountIsland`), the entry `react/islands.jsx`, the committed build `react-build/`, and two tests (`tests/react-islands.test.mjs`, `tests/react-islands-build.test.mjs`). `dashboard-controls.jsx`, named in the brief as an example, is not on `main` at `2f2a2b3`. | `ls frontend/react` |

**What the server gives a view workspace** (`backend/src/permissions.js:342-345`): `/me` lists only `org.view` there
(`VIEW_WORKSPACE_USABLE_WORDS`). `staff.assign` and `roles.manage` are system-role-only and the basic roles cannot be
given through R2, so a role holder in `club_view` never holds them (R4 contract section 17, "The `club_view` members
path ... is not reachable"). So a `club_view` account sees no Roles and no Users screen, and this contract adds none for
it (section 4.3).

## 2. What R4-4 replaces and what it extends

| Screen | R4-4 | Island? |
|---|---|---|
| Settings > Roles **in a club workspace** (club admin, or platform admin in that club) | **Replaced** by one island, *Club roles*: the club's system roles with their club state, and the club's own roles (R2 create / copy / archive kept, inside the island). | yes: `react/club-roles.jsx` |
| Settings > Roles **in the platform workspace** (system roles) | **Unchanged** in R4-4 (the R3 plain screen; it edits the defaults). Q-2 asks whether it moves to the island later. | no |
| Settings > Users: a person's row | **Extended**: a new *Access in this club* button opens one island, *Person access* (the user's roles in this club, custom roles, "Back to the role"). The R2 assignment form and "Who holds what" stay as they are, apart from the "(custom)" mark R4-3 already sends (`displayName`). | yes: `react/person-access.jsx` |
| Settings > Users: drift | **New** block at the top of Users when there is drift: "N people still have rights their role no longer gives" with *Take it from them too*. | part of `person-access.jsx` (a second export, `CustomDrift`) |
| Settings > Clubs: a club's licence | **New**: *Club licence* inside the club's row, platform admin only (write); read-only list for the club admin is shown in Settings > Roles (Q2 of the R4 contract). | yes: `react/club-licence.jsx` |
| Navigation of view workspaces (R4 contract 5.2) | **Extended** plain modules: `access.js`, `navigation.js`, `permission-nav.js`, `workspace-actions.js`, `coach-home.js`. Small changes to existing plain code, not a reworked screen, so no island (except the short Home, Q-4). | no |

## 3. Routes used (all under `/api/organization/roles`, R4-3)

| Action on screen | Route | Body / notes |
|---|---|---|
| Open *Club roles* | `GET /clubs/:clubId/roles` + R2 `GET /?clubId=…&state=all` + R2 `GET /catalog?clubId=…` | The first gives each system role's club state (`follows_default` / `own_version` / `question_pending`), `effectiveItems`, `question`, `actions`, and `closedModules`; R2's list gives the club's own roles' `holderCount` and `actions` (the R4-3 read has no holder count); the catalog gives groups, labels, `checked` / `storable` per word, `held`. Three reads in parallel, one generation counter. |
| Save a role's ticks (first change makes the club version, O3) | `POST /:roleId/clubs/:clubId/version` | `{requestKey, expectedRevision (null the first time), add, remove, reason}` |
| *Use the new default* / *Keep ours* | `POST /:roleId/clubs/:clubId/version/answer` | `{requestKey, systemRevision, choice: "accept_default" \| "keep_mine"}` |
| *Take it from them too* (after a save, or from drift) | `POST /:roleId/clubs/:clubId/custom-word-removal` | `{requestKey, word, customIds, reason}`; one word per request; the screen sends one request per word, one at a time |
| Club's own role: create / edit / copy / archive | R2 `POST /`, `/:roleId/change`, `/:roleId/copy`, `/:roleId/archive` | unchanged R2 bodies |
| Licence read | `GET /clubs/:clubId/ceiling` | a platform admin also gets `reason`, `closedBy`, `history` |
| Licence change | `POST /clubs/:clubId/ceiling` | `{requestKey, close, open, reason}`; platform admin only |
| Open *Person access* | `GET /users/:userId/clubs/:clubId` + R2 `GET /catalog?clubId=…` | holdings with `roleItems`, `effectiveItems`, `custom` (`added`, `removed`), `stillHeldThrough`, `customHistory`, `closedModules` |
| Save a person's ticks (makes or changes "<Role> (custom)", O4) | `POST /users/:userId/clubs/:clubId/custom` | `{requestKey, roleId, scopeType, scopeId, expectedRevision (null = create), add, remove, reason}` |
| *Back to <Role>* (end custom) | `POST /users/:userId/custom/:customId/end` | `{requestKey, reason}` |
| Drift list | `GET /clubs/:clubId/custom-drift` | |

Every write: a fresh `requestKey` per attempt, the 90 s bound of `sendRolesWrite` (`CENTRAL_CALENDAR_WRITE_BOUND_MS`) (`roles-data.js:122-125`), one write at
a time per island, and a lost answer handled as in section 5.6. Nothing on screen is the protection: the server decides
every button (`actions`) and every refusal.

## 4. Who sees what

### 4.1 Team coach (`team` workspace)

Nothing new. Their Settings is "My team" (`permission-nav.js:42-51`: Athletes, Join links, Tags & Presets, Icons); no
Roles tab (R3's Q5) and no Users tab. A test pins that none of the three islands is ever mounted for a team coach.

### 4.2 Club admin (`club` workspace, holds `staff.assign` and `roles.manage` there)

- **Settings > Roles** = *Club roles*:
  - a short licence line on top: "Your club's licence covers: Organization, Athletes, … . Not included: Imports." (from
    `GET …/ceiling`; no reason, no history);
  - **Built-in roles** (system roles): each a row with its name, its state as text and a glyph (never colour alone):
    "Same as OptiMove's default", "Changed for <Club>", "OptiMove changed the default – your answer is needed";
  - **Club admin** row: read-only ("Only OptiMove changes this role", Q3 of the R4 contract);
  - **Your club's own roles** (R2 club roles): as R3 today, inside the island;
  - opening a role shows the role editor (5.2).
- **Settings > Users**: each staff row gets *Access in this club* -> *Person access* (5.4); the drift block when there is
  drift (5.5). The R2 form and "Who holds what" unchanged.
- **Settings > Clubs**: no licence controls.

### 4.3 Role holder (`club_view` / `team_view`)

No Roles, no Users, no licence (section 1). R4-4 delivers for them only the navigation of the R4 contract's 5.2:
Settings with Overview, Clubs, Teams (the words `/me` gives), everything else hidden; a short Home with the club's name
and the sections it may open; the switcher labelled with the club or team name. This is exactly the e2e of the R4
contract's section 14, test 11.

### 4.4 Platform admin

- In a **club workspace**: everything of 4.2, and also: the Club admin role is editable there (Q3: only the platform
  admin), the licence line shows "Change licence" (opens the licence in Settings > Clubs), *Person access* may make a
  custom of a club admin (Q13).
- In the **platform workspace**: Settings > Clubs, each club row: *Licence* (5.1, read and write, with the reason, who
  and the history). Settings > Roles stays the R3 plain screen of the defaults.

## 5. Screens and their states

### 5.1 Club licence (platform admin, Settings > Clubs)

- One card per club row, folded: "Licence: 9 of 10 parts" (count + text).
- Opened: one row per part (`modules[]`, in the server's order): the part's name, a switch "Included" / "Not included"
  (a real checkbox with a visible label, 44 px row), and under a part with `ceilingEffective: false` the note "This part
  does not follow the licence yet" (R4 contract 7.1). *Organization* is shown included and cannot be switched off
  ("Always included").
- Changing switches collects a draft; one *Save licence* with a required reason (textarea, 16 px). One request with
  `close` and `open`.
- History folded: "History (N)" – date, part, closed / opened, by, reason.
- States: loading; read error with *Try again*; 404 -> "This club is not available." (archived or gone); `ceiling_unchanged`
  -> "Nothing changed – the licence was already like this." and the fresh list from `current`; `module_not_closable` ->
  "Organization is always included."; lost answer -> 5.6.

### 5.2 Role editor (inside *Club roles*)

- Title: "<Role> in <Club>"; under it: "Changes apply to everyone with this role in <Club>" (O3), and who holds it
  (`holderCount` from R2 where known).
- **Words grouped by module**, one card per group (`catalog.groups`), the group's label and a count "3 of 5 on". Inside,
  one checkbox row per word (the R3 labels of `permissionLabel`, moved to a shared module so the plain screen and the
  islands use one table). A word is:
  - on / off and changeable;
  - **locked, "Not available yet"** – `storable && !checked` (O6). It shows its current state (ticked or not) but can
    never be changed, and it is never shown as taken away;
  - **locked, "Not in your club's licence"** – its module is in `closedModules` (Q8). The whole group card is then shown
    closed: the header says "Not in your club's licence", the words are listed read-only, folded;
  - **locked, "You don't have this yourself"** – not in `catalog.held` and not ticked (the R2 ceiling rule);
  - **hidden** – platform-only words, and system-role-only words outside Club admin (as R3).
- A changed draft shows a sticky bar: "2 changes · Save for <Club>" and *Cancel*. Save asks for a reason (required,
  kept in the history) and sends `add` / `remove` against the revision the screen read.
- **Default changed (O3)**: a role in `question_pending` opens with a panel above the words: "OptiMove changed this role.
  Added: …. Removed: …." (from `question.defaultChanges`), and two buttons: *Use the new default* ("your own changes for
  <Club> are dropped") and *Keep ours*. Words stay read-only until the question is answered.
- **Back to the default** for a role with its own version: there is no route that ends a club version except the O3
  answer (`accept_default` needs a pending question). So R4-4 offers no "reset" button; Q-3.
- **After a save that took words away (Q15)**: if the answer carries `customsStillHolding`, a panel: "3 people with a
  custom version of this role still have: Manage calendar events." with their names and *Take it from them too* (one
  request per word, a reason prefilled "Removed from <Role> in <Club>", editable). `customsStillHoldingTruncated` adds
  "and more – see Users".
- Platform admin in a club, Club admin role: the same editor; Save is refused by the server unless `staff.assign` and
  `roles.manage` stay (`club_admin_requires`); the screen keeps both ticked and locked with "A Club admin always has
  this".

### 5.3 Club's own roles

The R3 form (create, edit, copy, archive) moves into the island unchanged in behaviour, with the same locked states of
5.2. R4-1's decision 1 is shown: after *Copy*, the words dropped as "not available yet" are listed by name.

### 5.4 Person access (Settings > Users, a person)

- Title: "<Name> in <Club>". One card per holding (role and scope): "Team coach · U19" or "Club admin · whole club",
  with "(custom)" when a live custom exists.
- Opened, the card shows the role's words grouped by module, as in 5.2, ticked from `effectiveItems`, plus a line per
  difference: "Added for <Name>: …", "Taken away for <Name>: …" (`custom.added`, `custom.removed`).
- Changing ticks and *Save for <Name>* makes or changes "<Role> (custom)" (O4). Before the first save the note: "Only
  <Name> gets this. Later changes of <Role> will not reach <Name>." (frozen, Q15).
- A word taken away but still held through another role: "Still has it through <Role B>" (`stillHeldThrough`, Q14).
- *Back to <Role>* (end custom) with a reason; after it the card shows the role's words again.
- **Not offered** (the server refuses; the screen hides): a club admin's card for a peer club admin or for the Club admin
  role (`admin_not_narrowable`), and the actor's own row (`self_custom`): the card says "Only OptiMove can change this"
  or "You can't change your own access".
- History folded: "Earlier custom versions (N)".
- Locked states as in 5.2 (not available yet, licence, not held).

### 5.5 Drift (top of Settings > Users)

Shown only when `GET …/custom-drift` lists any. "4 people still have rights their role no longer gives." Folded list:
name, role, the words. Per word: *Take it from them too* (the same route as 5.2). An empty list shows nothing.

### 5.6 Common states and codes

| State / code | What the screen says (one sentence and one next step) |
|---|---|
| Loading | "Loading…" (status role). |
| Read error | "The roles could not be read." *Try again*. 401: "Please sign in again." |
| 404 `notFound` (any read or write) | "This is no longer available." and the island returns to its list and reloads (archived club or team, revoked role, another club). Never names what is missing. |
| `version_changed` / `custom_changed` | "Someone changed this meanwhile. The newest version is shown; check your ticks and save again." The draft is kept on top of the fresh `current`, words that clash are marked. |
| `question_outdated` | "The question has changed. The newest is shown." |
| `permission_not_available_yet` | "<word>: not available yet." (should not happen; the tick is locked) |
| `closed_by_club_ceiling` | "<word>: not in your club's licence." |
| `permission_not_held` / `role_exceeds_your_permissions` | "You can't give what you don't have yourself: <words>." |
| `club_admin_requires` | "A Club admin always keeps: Give roles to people, Create and change roles." |
| `club_admin_would_lack` | (platform screen only) "A club's Club admin would lose a right its coaches have." |
| `admin_not_narrowable` / `self_custom` | "Only OptiMove can change a club administrator." / "You can't change your own access." |
| `custom_exists`, `holding_ambiguous` | "This person's access changed meanwhile." *Reload*. |
| `module_not_closable`, `ceiling_unchanged` | as in 5.1 |
| `try_again` (409) | "The server is busy. Nothing was written. Try again in a moment." |
| `permissions_unavailable` (503) | "Permissions could not be checked right now. Try again." |
| 400 | the form's own sentence next to the field (reason missing, nothing to change); the screen prevents most of them |
| Lost answer (no answer, 5xx, `internal_error`, the 90 s bound) | "Result not confirmed." *Check result* sends **the same request with the same requestKey**; every other write in that island is off until it settles (the R3 rule, `roles-data.js:137-147`, extended with the R4-3 codes above). |

A coach or club admin never sees a code, an id or a server sentence (`frontend.md`, "Interaction principles"); a platform
admin gets the code folded under "Technical details".

## 6. Mobile layout (phone first)

- One column at every width ≤ 760 px; no table. A role list row and a person card are full-width buttons, ≥ 44 px.
- Groups are cards that fold (`<details>`-like, a button with `aria-expanded`); a closed module's card is folded and
  says so in its header.
- A word row: the whole row is the label (≥ 44 px tall), checkbox on the left, the lock reason on a second line in
  smaller text (not a tooltip).
- The Save bar sticks to the bottom (above the phone's bottom navigation and its safe area), with the change count and
  *Save*; *Cancel* beside it. The reason textarea opens in the bar's sheet, `font-size: 16px`.
- The O3 question panel and the Q15 panel sit above the words, never in a modal.
- Nothing scrolls sideways at 360 / 375 / 390 px; long role, club and person names wrap (`overflow-wrap: anywhere`).
- Desktop (≥ 761 px): the role list left, the editor right (two columns), the same components.

## 7. Structure in code

- **Islands** (`frontend/react/`): `club-roles.jsx` (list, role editor, club's own roles, the O3 and Q15 panels),
  `person-access.jsx` (`PersonAccess`, `CustomDrift`), `club-licence.jsx`, and a shared `role-words.jsx` (the grouped,
  locked word list used by all three). Exported from `react/islands.jsx`; `npm --prefix frontend run build:islands`;
  the build committed.
- **Plain side**: `roles-layers-data.js` (the reads and writes of section 3, one generation counter per island,
  requestKeys, the code table of 5.6) and `roles-layers-actions.js` (mount / unmount from the Settings render, the leave
  guard for an unsaved draft or an unconfirmed write, the same pattern as R3). `roles-view.js`'s club-workspace branch
  mounts the island instead of rendering the R3 list; the platform branch is unchanged.
- **Labels** of words move from `roles-view.js:16-38` into `frontend/permission-labels.js`, imported by both.
- The islands get data and callbacks as props from the plain side; they do not fetch on their own (`frontend.md`).
- 5.2 navigation: `access.js` (`VIEW_WORKSPACE_TYPES`, `hasOrganizationAccess`, `accessScopeLabel`), `navigation.js`
  (Settings tabs for a view workspace), `permission-nav.js` (for a view workspace a missing word list hides, never
  `legacy`), `workspace-actions.js` (switcher labels), `coach-home.js` (short Home).

## 8. Test plan

**Unit, plain side** (`frontend/tests/roles-layers.actions.test.mjs`, JSDOM, a fake server that keeps the R4-3 rules:
it filters by club, applies `closedModules`, answers the identical 404 for another club, and refuses as the real
service does):
- the right island per role (club admin, platform admin in club, platform admin in platform, team coach: none,
  `club_view`: none);
- every code of 5.6 -> its sentence; no code or id in the DOM for a club admin;
- a lost answer: *Check result* resends the same body and requestKey; other writes stay off until it settles;
- `version_changed` keeps the draft on the fresh revision; `expectedRevision: null` for the first save;
- the generation counter: a slower old read never overwrites a newer one (club switch);
- unchecked words are never in `add` / `remove`; closed-module words are never in `add`;
- `customsStillHolding` -> one removal request per word, in order.

**Island tests** (`frontend/tests/react-islands-roles.test.mjs`, the `react-islands.test.mjs` pattern: import the build
under JSDOM, assert text and booleans, await one task after a click): locked rows are disabled with their sentence; a
closed group is folded with its header; the sticky bar counts changes; the O3 panel shows the difference and its two
buttons; *Person access* shows "(custom)", the differences and "Still has it through …"; `react-islands-build.test.mjs`
passes (fresh build).

**Navigation** (`frontend/tests/access-workspace-nav.test.mjs`, `permission-nav.test.mjs`, `workspace-switcher.test.mjs`
extended): `club_view` / `team_view` labels; Settings tabs Overview, Clubs, Teams only; missing words hide everything
for a view workspace; a mutation that returns `legacy` there fails.

**e2e** (`e2e/tests/roles-layers.test.mjs`, invented names only, e.g. "Test Club", "Coach A", "Player 01"):
1. the R4 contract's test 11: a platform admin closes Imports for a club and makes a club version of Team coach; a role
   holder signs in, lands in `club_view`, sees Settings > Overview, Clubs, Teams and nothing else; at 1280 and 390 px;
2. a club admin unticks a word of Team coach, saves with a reason, sees "Changed for Test Club"; a team coach of that
   club then lacks it (checked through `/me` or the module's route that checks it);
3. a club admin makes a custom for one coach, sees "(custom)" and the difference, then *Back to Team coach*;
4. the O3 question: the platform admin changes the default, the club admin sees the difference and keeps / accepts;
5. a word of a closed module is shown locked, "Not in your club's licence";
6. no horizontal scroll, every control ≥ 44 px, every input 16 px at 360, 375 and 390 px.

The `--preset frontend-fast` gate on the head and on clean `main` (`testing-evidence.md`, "Frontend PR gate"); the
production build; `git diff --check`. Mutations only on the key guards (two or three: the locked-word filter, the
same-requestKey resend, the view-workspace hide fallback).

## 9. Risks and notes found in discovery

- **No server change is needed** for 4.2-4.4. The one gap: the R4-3 club roles read carries no holder count, so the
  island reads R2's list beside it (three reads). If the manager prefers one read, `holderCount` in
  `GET /clubs/:clubId/roles` is a small server change (then the pull request is no longer frontend only).
- **A role holder (`club_view`) can never use these screens** in R4: `/me` gives it `org.view` only, and the R4-3 routes
  it could reach (`GET /clubs/:clubId/roles` with `org.view`) are not offered. Q-1.
- The R3 platform screen and the new island will both show word lists; one shared label module and one shared locking
  rule (`permissionReason` extended) keep them the same.
- Size: about 4 islands, 2 plain modules, 6 plain files touched, 4 test files. Section 10 proposes splitting it.

## 10. Proposed pull requests

**Decided (the owner, 2026-11-24, overriding the proposal of four, to save usage): two pull requests.**

| PR | What | Reviews |
|---|---|---|
| **A** | Navigation of view workspaces (5.2, section 4.3, the short Home) and *Club licence* (5.1) | `code-reviewer`, `mobile-qa`; e2e test 1 |
| **B** | *Club roles* (5.2, 5.3) with the shared word list, *Person access* and drift (5.4, 5.5) | `code-reviewer`, `mobile-qa`, `ux-design-reviewer`; the *Nezavisni revizor* |

A is built first, frozen and handed to the manager; then B. Each before its freeze: the targeted unit and island tests,
`--preset frontend-fast` on the head and on clean `main`, the production build with the islands' drift test, the
targeted e2e (the navigation and settings files and the new ones), and one internal review round plus at most one narrow
re-review.

### 10.1 PR B as built (from `main` `ed6817a1`)

- **Files.** `frontend/roles-layers-rules.js` (the word locks in their order – licence, not checked yet (O6), a Club
  admin's required words, not held by the caller –, the groups, one plain sentence per R4-3 code, which Check-result
  answers settle); `frontend/roles-layers-data.js` (the two islands' state and every R4-3 write, one at a time, each with
  its own requestKey; a lost answer is *Result not confirmed* and *Check result* sends the same body and key; a 404 or a
  busy server on that resend stays not confirmed; state belongs to one club and one person, an older read never wins);
  `frontend/roles-layers-actions.js` (the hosts, the lazy islands, the callbacks); `frontend/react/role-words.jsx`,
  `club-roles.jsx`, `person-access.jsx`; the styles at the end of `frontend/styles.css`.
- **Club roles** (5.2, 5.3) replaces the R3 list in a club's workspace (`renderRolesPanelHtml` draws the island's host
  there; the platform workspace keeps the R3 list of the system roles, Q-2). It reads R4-3's club roles, R2's list
  (holders, the R3 actions) and the catalog in parallel (11a, finding 2).
- **Person access and drift** (5.4, 5.5) sit in Settings > Users under "who holds what", for a platform admin and for a
  holder of `staff.assign` in the club.
- **Deviations from section 5, decided by the executor (for the manager's review):**
  1. The club's own roles are listed in the island, but *Edit* / *View*, *Copy*, *Archive* and *New role* open the R3
     plain form unchanged (the island dispatches the R3 actions); a React rewrite of that form is Q-2's later work.
  2. *Person access* chooses the person from a picker inside the island, not from a button on each user row.
  3. *Take it from them too* sends one request per word, each naming only the customs that still hold that word (the
     server refuses a custom that does not: `custom_changed`); the reason is prefilled "Removed from <Role> in this
     club".
  4. A saved club version or O3 answer whose read failed (`readError`) reads the club's roles again; a replay answer
     (no `customsStillHolding`) offers no *Take it from them too*.
- **After the internal review round** (code NOT READY: one HIGH, two MEDIUM; UX: six MEDIUM; mobile: LOW only):
  - the club's roles are read again on entering Roles and after every write of the club's own roles (R3's list read
    marks them stale; the list stays on screen until the new read); drift and the chosen person are read again on
    entering Users, after a role is given or taken there, and after a club version or a removal in Roles;
  - a failed list or catalog read is a sentence with *Try again*, as is a failed read in Access;
  - Access in this club, with its drift, now opens Settings > Users (5.5: the top of Users);
  - drift asks first: *Take it from them* opens a step with the names, an editable prefilled reason, *Take it from N
    people* and *Cancel*; after a save, *Take it from them too* has *Leave it* beside it;
  - every save waits for a reason and says "Write a reason to save." beside the button;
  - the outcome of a removal names every word taken and the number of people, says when the list was cut, and a
    `custom_changed` refusal drops the offer with its own sentence; the caller's own custom is never listed;
  - a pending role's row says *Answer*; *All roles* is off while a write is open; the history uses DD.MM.YYYY.
- **Recorded, not built (LOW):** an *Access* button on each user row; asking before an unsaved draft is dropped (*All
  roles*, *Cancel*, another person); a shorter save bar on small phones; the iOS keyboard over the save bar (a physical
  device).
- **Tests.** `frontend/tests/roles-layers.data.test.mjs` (14, a fake server keeping the R4-3 rules; mutations of the
  per-word customs filter and of the Check-result 404 rule killed), `frontend/tests/roles-layers.islands.test.mjs` (8,
  the compiled islands; the self-block mutation killed), `frontend/tests/roles-r3.actions.test.mjs` (tests 2 and 3 moved
  to the new place of the list), `e2e/tests/roles-r4-4-club-roles.test.mjs` (6: a club version saved, the O3 question
  with *Keep ours*, a person's custom and *Back to the role*, and 360/375/390 px).

## 11a. Decided (the owner, 2026-11-24, relayed by the manager)

- **Q-1 to Q-6: as recommended.** No role list for a view workspace; the platform screen of default roles stays the R3
  plain screen; no "reset to default" button now (Q-3, later, with a small server change); the short Home as proposed;
  a closed part shown as a closed card with text, no padlock; *Take it from them too* offered right after a save.
- **Q-7: two pull requests, not four** (section 10).
- **Finding 2 (holder count): frontend only** – *Club roles* reads R4-3's club roles, R2's list and the catalog in
  parallel; no server change.

## 11. Pitanja za vlasnika (open questions, with a recommendation; all decided, 11a)

| # | Pitanje | Preporuka |
|---|---|---|
| Q-1 | Osoba koja ima samo novu ulogu (bez starog "club admin" reda) ulazi u klub kao "pregled". Da li ona u Podešavanjima treba da vidi spisak uloga kluba (samo za čitanje)? | **Ne za sada.** Vidi samo Pregled, Klubove i Timove, kao što R4 ugovor kaže; spisak uloga kasnije, ako zatreba. |
| Q-2 | Ekran podrazumevanih uloga (platforma, Settings > Roles u radnom prostoru platforme) ostaje stari ekran. Da li i njega prepisati u novi (React) izgled sada? | **Ne u R4-4.** Prepisati ga kada se bude menjao zbog MANAGE koraka; sada bi to udvostručilo posao. |
| Q-3 | Klub je promenio ulogu (npr. Trener tima). Da li admin kluba treba dugme "Vrati na OptiMove podrazumevano" i kada OptiMove ništa nije menjao? Danas server to dozvoljava samo kao odgovor na pitanje posle promene podrazumevane uloge. | **Da, ali kasnije** (treba mala izmena na serveru). U R4-4 admin to postiže ručnim vraćanjem kvačica. |
| Q-4 | Osoba "samo za pregled" na Početnoj: kratka strana sa imenom kluba i delovima koje sme da otvori. Da li je to dovoljno? | **Da**, jedna rečenica i dugmad za delove koje sme (danas samo Podešavanja). |
| Q-5 | Deo aplikacije koji licenca ne pokriva: prikazati ga kao zatvorenu karticu sa tekstom "Nije u licenci kluba" (bez katanca, prema ranijoj odluci Q2). U redu? | **Da**, tekst i oznaka, bez katanca; katanac u meniju dolazi kasnije. |
| Q-6 | Kada admin kluba skine pravo sa uloge, a neki ljudi imaju svoju "(prilagođenu)" verziju sa tim pravom: ponuditi odmah dugme "Oduzmi i njima" (sa spiskom imena)? | **Da**, odmah posle čuvanja, ništa se ne oduzima samo od sebe (odluka Q15). |
| Q-7 | Jedan veliki PR ili četiri manja (navigacija, uloge kluba, pristup osobe, licenca)? | **Četiri manja** (odeljak 10): brži pregled, manji rizik. |
