# Data configuration: visual proposal (icons, layout, dragging variables)

**A proposal only: no app code, no migration.** It answers the owner's task "Data configuration: visual polish of
Variables, Domains & categories and Source fields" (`docs/ai/metrics-core-plan.md`, section 6, with the owner's words of
2026-10-28). It goes to the *Rukovodilac*, then to the owner to choose. Code comes only after the owner's word.

| | |
|---|---|
| Status | Proposed by the executor on 2026-10-28, on the *Rukovodilac*'s order of that day. PR-1 is built (section 11) and merged (PR #256, `0e38ae9`, 2026-10-28). PR-2 is built (section 12) in an open pull request. The *Rukovodilac* reviewed `c830050` (GO as a document, no BLOCKER, HIGH or MEDIUM; three LOW notes for PR-1, recorded in sections 3.4, 3.5 and 4) and decided R1–R3 (section 10). The owner's choices V1–V5 were made on 2026-10-28 (section 10). |
| Mockup | `docs/ai/mockups/data-configuration-visual.html` — a static page, opened in any browser. It holds the three layouts at 1280 px (scaled) and 360 px, the icon picker, Settings → Icons, the variables list and the Source fields list. It talks to no server, and every name and number in it is invented. |
| Verified against commit | `0b947ab` (merge of PR #252). File and line references are to that commit. |
| Decides | The owner: V1–V5 (section 10). The *Rukovodilac*: R1–R3 (section 10), inside the plan. |

---

## 1. What the owner asked, in short

- Every variable has an icon, chosen from a list of icons that fit OptiMove.
- The icons live in Settings, so they can serve other needs later.
- The screens look and feel like the coach's Home ("home strana trenera").
- Variables can be dragged into categories.
- Domains are clearly separated from categories.
- Later (step 2): a club or a person can have their own icons, stored on R2 like the exercise media.

The order is approved: step 1, then step 2. Nothing else is approved yet (plan, section 6).

---

## 2. What is there today

### 2.1 The screens
- Training load → Data configuration has a **Variables | Source fields** sub-navigation for an administrator (phase 6),
  and Variables has a **Variables | Domains & categories** switch (12c).
- Domains & categories is one long section: domains with their categories, then the categories in no domain, all in
  one look. A domain and a category differ only by their heading.
- The variables list is plain text rows; a variable has no picture.
- The review follow-ups that this task would close (from PR #249 and PR #251, recorded in
  `docs/ai/CURRENT_STATE.md`):
  - two look-alike segmented controls, one above the other, on phones;
  - archived and active domains and categories mixed in the list filter;
  - a dead end after "first create one";
  - which button is the primary one;
  - the Source fields legend's punctuation, and scrolling to the start of a section.

### 2.2 Where an icon already has a place

| Object | Column today | Who writes it today | In step 1? |
|---|---|---|---|
| Canonical variable (`training_load.metric_definitions`) | `icon_url` (v10, `migrations_v2/202609041400_training_load_v10_metrics_catalog.sql:108`) | Nobody for a canonical variable: M3-0's create writes no icon (`backend/src/canonicalVariableAdminService.js:608`), and the older API's cosmetic edit, which takes an `iconUrl` URL (`backend/src/trainingLoadMetricsCatalog.js:341-358`), refuses canonical rows (C98) | **Yes, at create, with no migration.** A later change is section 3.4. |
| Domain and category of variables (`metric_domains`, `metric_categories`) | none (v10, v41 add only `key` and `description`) | — | **No.** It needs a migration: owner option V4. |
| Builder plan nodes: domain, category, section (the exercise hierarchy) | `color`, `icon_url` | The Builder: a URL, or one of five glyph codes `icon:target`, `icon:bolt`, `icon:dumbbell`, `icon:calendar`, `icon:heart` (`frontend/builder-helpers.js:3-14`) | Later, through the same picker. |
| Settings → Tags & Presets | `icon_url` (an "Icon URL" field, `frontend/taxonomy-view.js:183`, and the same glyph codes) | The presets screen | Later, through the same picker. |
| The coach's Home | inline SVG in the code (`frontend/coach-home.js`) | — | It only lends its visual language. |
| Source fields | none | — | A fixed icon by value shape, in the frontend only; no data. |

---

## 3. Icons (step 1)

### 3.1 The library
- **One built-in set, vendored as data, with no runtime dependency.** `frontend/icon-library.js` holds about 100 icons.
  Each has a key, its SVG geometry, a category (Movement, Sport, Body, Effort and load, Time and distance, Charts,
  Recovery and wellness, General) and search words. A generator script reads the chosen set at a pinned version once.
  It keeps only `<path>`, `<circle>`, `<rect>`, `<line>`, `<polyline>`, `<polygon>` and `<ellipse>` with their geometry
  attributes, so no script, link, style or event attribute can come in with an icon. The licence text is kept next to
  it (`frontend/icon-library-LICENSE.txt`).
- **The set (V2):**
  - **Recommended: Tabler Icons** (MIT, 5,203 outline icons at 3.50.0). It is drawn like Home's own icons: 24 px,
    stroked and round. It has many sport icons (run, bike, swimming, stretching, barbell, heart-rate monitor,
    stopwatch, and so on).
  - Lucide (ISC, 2,193 icons at 1.63.0): the same style, but fewer sport icons.
  - Carbon icons (Apache-2.0, the design reference): drawn filled at 32 px, so they would not match Home's stroked
    icons next to them.

  The mockup shows 55 Tabler icons, extracted exactly as above.
- **The stored value is a key, never a URL or markup:** `icon:<key>`, for example `icon:run`, in the existing
  `icon_url` columns. The renderer draws only keys of the library; an unknown key draws a neutral placeholder.
- **The five old Builder glyph codes become library keys with no data change.** `icon:target`, `icon:bolt`,
  `icon:calendar` and `icon:heart` exist in the library under those names, and `icon:dumbbell` is kept as an alias of
  `barbell`. A preset or a plan node that has one today draws a real icon instead of a character.
- **Size:** about 100 icons is about 20 KB of geometry, about 6 KB compressed.

### 3.2 Settings → Icons
- A new Settings tab: a searchable gallery grouped by category, showing each icon with its key and its search words,
  and a *Copy key* button.
- **Read-only. Anyone who sees Settings sees it**: nothing in it is private, and it changes nothing.
- *Where an icon is used* is a later addition.

### 3.3 The shared picker
- One component, used everywhere an icon is chosen: a dialog on a computer and a bottom sheet on a phone.
- It has a search field (16 px), category chips, a grid of 52 px buttons, *No icon* and *Use icon*.
- Nothing is preselected. The chosen key is named under the grid ("stored as `icon:run`").
- Keyboard: every icon is a button, in order. The search narrows the grid. The picker opens with the focus on the
  search field.

### 3.4 Variables
- **At create: no migration.** M3-0's `POST /variables` takes an optional `iconKey`. The server checks it against the
  library's key list (`backend/src/iconKeys.js`, written by the same generator; a test proves the two lists agree)
  and stores `icon:<key>`. The key is covered by the request hash as part of the body. v36's guard does not read the
  column, so it needs no change.
  - **For PR-1 (the *Rukovodilac*'s LOW-1):** a request without `iconKey` must hash exactly as before, so a replay of an
    older create keeps its answer. The body is canonicalized without absent keys, and a test proves it.
- **A finding — changing the icon later needs a migration.** v38's audited change record of a canonical variable covers
  the label, short label, description and state only (`migrations_v2/202610271000_training_load_v38_metric_variable_changes.sql`,
  the trigger `AFTER UPDATE OF label, short_label, description, state`, and the change table's `old_*` / `new_*`
  columns). An icon update would be written with no change row and no request row: an unaudited admin write, which
  C76 forbids. Three ways:
  - **I1 (recommended): a small migration** that adds the icon to v38's change record (two columns and the trigger's
    column list) and an "icon" kind of change. A route then changes a variable's icon, audited like a rename, with
    the same rights (R2: the platform admin, the club admin and a team coach for club variables). It is its own pull
    request, needs the owner's order naming the migration, and is reviewed by `db-reviewer` and `security-reviewer`
    (trigger 1).
  - I2: the icon is chosen only at create and never changed. No migration, but a wrong icon stays for good, and the
    variables that already exist never get one.
  - I3: the icon is changed only together with a rename, in the same request. This still needs the v38 migration, so it
    is no smaller than I1.
- **Where a variable's icon shows:** the variables list, the variable's detail, the chips of Domains & categories, and
  later the dashboards' metric pickers (C80: the pickers themselves do not change in this task).

### 3.5 Source fields
- Each source field gets a fixed icon by its value shape (distance, time, speed, zone, events), drawn from the
  library. This is frontend only: no column and no API change.
- The evidence badges get the four colours of the legend: Not proven grey, Documented blue, Observed amber, Verified
  green. Colour is never the only carrier: every badge keeps its word (the *Rukovodilac*'s LOW-2).

### 3.6 Domains and categories of variables (V4, not in step 1)
- An icon on a domain or a category needs a migration: one nullable column per table, with the same value rule and
  v41's guards widened (a canonical row's icon change audited as its rename is).
- **Proposed column name: `icon_url`, holding `icon:<key>`**, the name every other table uses. One renderer and one
  rule serve all, and the Builder's and the presets' values already look like this. The name is historical (it may
  hold a key, not a URL); `icon_key` would be clearer but would differ from five other tables.
- Until then, a domain has a filled tile and a category an outlined one (section 5), so they are told apart without an
  icon of their own.

---

## 4. Layouts (V1)

Every variant uses Home's language: white panels with an 8 px radius and a 1 px line, a 24 px stroked icon in accent
colour, bold titles, a muted second line, a chevron for "opens another screen", 44 px targets, and the club colour
(`#934c65`) for club-owned things as Home uses it.

- **A · Board.** Domains are a row of cards across the top, each with its counts. The chosen domain's categories are
  columns holding their variables as chips. A tray on the right holds the variables in no category; on a computer a
  chip is dragged from the tray, or from another category, onto a category. Archived items are in one folded row at
  the bottom.
  - For: everything at once, and dragging is natural.
  - Against: with many categories in one domain the columns scroll sideways. On a phone it becomes a domain strip that
    scrolls sideways, with stacked category cards.
- **B · Two panes.** On the left is one list in three groups that look different: Domains (filled tiles), Categories in
  no domain (outlined tiles) and Archived (folded). On the right is the chosen domain with its categories, or the
  chosen category with its variables.
  - For: it is the closest to today's screen, so it is the least work. It scales to many items, and the search is
    natural.
  - Against: less "Home". Dragging works only into the categories shown on the right.
- **C · Home cards.** Data configuration opens on four cards like the coach's Home: Variables, Domains, Categories and
  Source fields. Each card shows its count and its first rows, with a chevron. Each card opens its own screen, so
  domains and categories are fully separate. The Categories screen holds the drag tray.
  - For: the most like Home and the easiest on a phone (one column). It also replaces the two look-alike segmented
    controls with one start screen.
  - Against: one more step to reach a list, and a new start screen to keep up to date.
  - **For PR-1 (the *Rukovodilac*'s LOW-3):** the start screen's counts and first rows must not cost four separate
    reads. They come from one read: the existing lists with a small limit, or one summary read if that is needed. No
    new API contract is added where the existing reads suffice.

**Recommendation: C**, because the owner asked for Home's look and feel, and separate Domains and Categories screens
answer "razdvojiti domene od kategorija" most directly. Its Categories screen takes A's tray and drop zones, so dragging
is as natural as in A.

---

## 5. Domains apart from categories (every variant)

- **Two looks:** a domain is a filled tile in accent colour (club colour for a club's), with the badge "Domain". A
  category is an outlined tile with the badge "Category". A variable is a soft tile.
- **Two headings and two lists, never one mixed list.** Categories in no domain have their own group.
- **Archived is its own folded group**, and the list filter puts active and archived items in separate groups (the
  LOW note of PR #249).
- A system item keeps its "System" badge. In a club workspace it stays read-only, as today.

---

## 6. Dragging variables into categories (step 1, its own pull request)

- **Only on a computer** with a mouse or trackpad (`pointer: fine` and `hover: hover`), as the Builder's library drag
  (`frontend/builder-library-drag.js:29-32`). On a phone or by keyboard, *Add to a category* stays the way, and it is
  never removed.
- **What a drop does:** a variable chip dropped on a category sends the existing classification link create (C4 of J6)
  with its own `requestKey`. That is the same call, the same rules and the same rights as *Add to a category*.
  - Dropping a chip on a category it is already in sends nothing ("already there").
  - Archived categories and read-only (system, in a club workspace) categories are not drop targets.
  - A drop never removes a link: a variable may sit in several categories (O3). Removing stays an explicit act.
- **Undo, not a confirmation (R2).** After a drop the screen says "*X* was added to *Y*" with *Undo* for 10 seconds.
  *Undo* sends the existing link remove (C5) with its own `requestKey`. Adding is harmless and reversible, and a
  question on every drop would slow the work that dragging is meant to speed up.
- **Outcomes, as everywhere in this tab:** one write at a time. A lost answer is *Result not confirmed*, and *Check
  result* sends the identical request. A refusal is a warning and changes nothing on the screen.
- **Not in it:** dragging a category onto a domain. A category sits under at most one domain (O3), so moving it would be
  a remove and a create; it stays the form.

---

## 7. Step 2, a sketch only: own icons (★★, its own contract later)

- **Owners**, on ADR-002's pattern: `system` (a platform admin; seen by everyone), `club` (the club's admin; seen in
  that club only) and `user` (a private coach; seen by that user only). Another owner's icon answers the identical 404.
- **Formats:** PNG first, at most 64 KB and 512 × 512 px. SVG only if sanitizing it can be proven (no script, no
  external reference, no `<foreignObject>`, no event attribute); otherwise never.
- **Storage:** R2 through the exercise media infrastructure (`backend/src/mediaUploads.js`, `mediaStorage.js`,
  `mediaInspection.js`, `r2UploadStore.js`; the cleanup CLI). That means the presigned PUT, the verification, the
  quota of Settings → Storage (0 B by default, so no quota means the built-in library only) and the cleanup.
- **What it needs from the database:**
  - `media.uploads.purpose` takes no icon purpose today (`migrations_v2/202610191100_media_storage_foundation.sql:58`,
    `purpose in ('exercise_video', 'exercise_image', 'video_frame', 'automatic_thumbnail')`);
  - `media.storage_accounts` has a user or a club owner, never `system`;
  - a new icon table: owner, key, label, MIME type, bytes, SHA-256, the asset and a state.

  So it is a migration.
- **The reference:** `icon:custom:<id>` in the same `icon_url` columns. The other way, a foreign key, would need a new
  column in every table that has an icon.
  - The consequence: no foreign key, so a reference can outlive its icon. So an icon is archived, never deleted, and
    an icon the viewer may not see draws the placeholder.
- **Reviewers:** `db-reviewer`, `security-reviewer`, `code-reviewer`, and `ux-design-reviewer` with `mobile-qa` for the
  screens. Its contract goes to the *Rukovodilac*, the *Nezavisni revizor* and then the owner. The migration needs the
  owner's own order naming it.

---

## 8. What does not change

- The classification API (C1–C6), v41's rules and O3's one domain per category.
- The variable rights of R2, and the M3-0 contract apart from the optional `iconKey`.
- The Source fields logic and its acts (F2, F3), and phase 5.
- The dashboards' metric pickers (C80).
- No persistent database is written by the executor.

---

## 9. Test plan

- Unit suites for the library (keys unique, geometry only, the old glyph codes resolved), the picker (search, choose,
  *No icon*, keyboard), `iconKey` at create (the body, the server's refusal of an unknown key, the hash) and the drag
  (offer only on a computer, the body, already there, refused targets, *Undo*, a lost answer).
- The existing Variables, classification and Source fields suites, updated where the markup changes.
- A browser integration run on a disposable database, with the real server in process and the real frontend in
  Chromium, at 360 / 375 / 390 / 1280 px. Every control at least 44 px, every field 16 px, no horizontal overflow.
- Mutations for the guards that matter: the key check, the drag offer, the one-write-at-a-time rule.
- Reviewers: `code-reviewer`, `ux-design-reviewer`, `mobile-qa`, and `security-reviewer` for the new `iconKey` input.

---

## 10. Decisions

**For the owner — decided on 2026-10-28, as recommended.** The owner's words, in the *Rukovodilac*'s chat: „Slažem se
po preporuci idi” (owner turn `cfeac86e`, 21:58:15 UTC). They answer the *Rukovodilac*'s message that offered „po
preporuci” for V1–V5. The *Rukovodilac* reads them as V1–V5 accepted as recommended: C, Tabler, I1 (its own PR-1b,
whose migration needs the owner's order naming it), later, and PNG first. That reading is the *Rukovodilac*'s, not the
owner's own words. The executor checked the turn in the *Rukovodilac*'s transcript.
- **V1 — the layout:** A, B or C. Recommended: **C**.
- **V2 — the icon set:** Tabler (MIT) or Lucide (ISC). Recommended: **Tabler**.
- **V3 — changing a variable's icon later:** I1 (a small audited migration), I2 (only at create) or I3. Recommended:
  **I1**, as its own pull request after PR-1.
- **V4 — icons on domains and categories of variables:** now (a migration, the column `icon_url`) or later.
  Recommended: **later**; the filled and outlined tiles separate them in the meantime.
- **V5 — own icons (step 2), PNG only first:** yes, or PNG and SVG together. Recommended: **PNG first**.

**For the *Rukovodilac* (inside the plan) — decided on 2026-10-28, as proposed:**
- **R1 — the pull requests:**
  - PR-1: the library, Settings → Icons, the picker, the icon at create (`iconKey`), the chosen layout and the visual
    pass, with no migration;
  - PR-1b: the icon change (I1), with its migration, if the owner chooses it;
  - PR-2: dragging variables into categories.

  Each merges after the *Rukovodilac*'s GO: PR-1 and PR-2 under the standing order, PR-1b on the owner's order naming
  the migration.
- **R2 — undo, not a confirmation, after a drop** (section 6).
- **R3 — the settings tab is read-only and visible to everyone who sees Settings** (section 3.2).

---

## 11. PR-1 as built (from `f4abd7c`; no migration)

PR-1 is step 1 without dragging (R1): the library, Settings → Icons, the picker, the icon at create, layout C and the
visual pass. Where it differs from sections 3–6, this section says so.

**The library (3.1):**
- `scripts/icon-library/manifest.json` names 128 icons of Tabler Icons 3.50.0 (MIT): the 126 of eight categories, plus
  `stack` and `folder`, which draw the domain and category tiles (section 5).
- `scripts/icon-library/generate.mjs` reads the pinned package's `package.json` (the name and the version must be the
  manifest's) and its `tabler-nodes-outline.json`. Of each icon it takes only `<path>` elements with a `d` of
  path-data characters, and any other element, attribute or character stops the run. Its `--check` mode writes nothing
  and fails when a committed file differs. It is a maintenance step, never part of a build.
- The generator writes `frontend/icon-library.js`, which holds data only (about 37 KB, 9.5 KB compressed), and
  `backend/src/iconKeys.js`. The licence is `frontend/icon-library-LICENSE.txt`.
- The renderer is a separate, hand-written module, `frontend/icon-render.js`. It draws a key's paths as inline SVG and
  any other `icon:` value as a placeholder, and it escapes every attribute.
- **A rule:** a released key is never removed or renamed, because stored values name it.
  `scripts/icon-library/released-keys.json` lists every released key and is only ever appended to; a test holds the
  library to it (every released key is still a key, and every key is listed).
- The five old Builder codes resolve in the renderer (`dumbbell` through its alias). The alias is the frontend's
  tolerance only: the server never writes it, and its reads answer `icon: null` for `icon:dumbbell` written by hand,
  while the renderer would draw it as the barbell. **Not switched:** the Builder and the
  Tags & Presets screens still draw their old glyph characters. Moving them to the library is later (table 2.2).

**The icon at create (3.4):** as J3 of the discovery document records it. The `iconKey` is a key of the current list,
never an alias. A create without one hashes as before (LOW-1). Every read gives `icon`, the coach's reduced view
included.

**A finding while building it:** two older screens draw a metric definition's `icon_url` as an image: Activities'
recorded metrics and the dashboards' metric pickers. A canonical variable with an icon would show a broken image
there. They now go through `renderMetricIconHtml`, which draws a library icon for an `icon:` value and keeps the image
for any other value. The pickers are otherwise unchanged (C80).

**Settings → Icons (3.2):**
- Read only, and offered to everyone who sees Settings.
- It is a searchable list grouped by category.
- Copy key copies the stored value (`icon:run`) and says so where it was pressed: the button reads "Copied" for a
  moment. When the browser cannot copy, that icon's own card shows the key as text to select. A status line tells a
  screen reader the same, and coming back to Settings → Icons, a search or a chip clears the result.
- A credit line names the source and the licence.

**The picker (3.3):**
- A dialog on a computer and a bottom sheet on a phone.
- It is modal: the form behind it is inert and is never sent while the picker is open, and Tab stays inside it.
- The grid scrolls first. On a screen too short even for that, the dialog itself scrolls and its foot - the choice line
  and the actions - stays pinned to its bottom, so Use icon is always on the screen, and a control reached by the
  keyboard is scrolled clear of the foot. On a phone or a short screen the chips are one row that scrolls sideways; on
  a short screen (a phone on its side) the dialog is compact (the actions side by side, the search's label for screen
  readers only), so a full row of icons shows when it opens. Checked at 360×640, 375×667, 390×844, 667×375 and
  844×390.
- **A difference from 3.3:** with a mouse or a keyboard the focus opens in the search; on a touch screen it opens on
  the dialog's title, so the phone's keyboard does not cover the grid and Use icon.
- The buttons are Use icon, Use no icon and Cancel.
- Escape and Cancel close it without a choice, and the focus returns to the button that opened it.
- The search and the chips narrow the grid in place, so the focus stays where it is.

**Layout C (4):**
- **Cards:** Data configuration opens on the cards Variables, Domains, Categories and, for an administrator, Source
  fields. A team's coach gets three cards.
- **Counts (LOW-3):** they come from the reads the screens already make: the variables list (its page of 100; "More
  than 100" when it has more), the one read of the domains and categories, and for an administrator the source fields
  list. There is no read of its own and no new API.
  - The Variables count is shown only for the default list: this workspace's own active variables, with no filter.
- **The old controls:** the sub-navigation and the Variables | Domains & categories switch are gone.
- **Ways back:** every screen has "← Data configuration", Source fields' through Training Load's own section switch.
- **Focus:** a new screen puts the focus on its title and scrolls to it, a variable's detail and the way back from it
  included. Source fields, opened through Training Load's section switch, does not yet (a follow-up).

**Domains apart from categories (5):**
- Two screens, each with one primary button (New domain, New category).
- A domain is a filled tile and a category an outlined one, both in the club colour for a club's.
- Archived items are a folded group of their own, and the list filter puts them in groups of their own.
- "First create one" and "no active domain" now link to Categories and Domains.

**Source fields (3.5):** each field has a tile by its kind of value (a count of events by its unit `count` too). The
legend is the four badges, each with its colour and its word, followed by its meaning.

**A variable without an icon** shows a neutral dashed circle, never an icon of the library.

**Not in PR-1:**
- dragging (PR-2);
- changing an icon (PR-1b, I1);
- icons on domains and categories (V4, later);
- the Builder and the presets on the library;
- own icons (step 2).

**Tests:**
- New frontend suites:
  - `frontend/tests/icon-render.test.mjs`;
  - `icon-picker.actions.test.mjs`;
  - `icon-gallery.actions.test.mjs`;
  - `data-config-home.actions.test.mjs`.
- `backend/tests/icon-library.test.mjs`: the two key lists agree with each other and with the manifest, and the files
  hold geometry only.
- Test 18 of `metric-variables-m3-0.test.mjs`.
- The Variables, classification and Source fields suites, updated for the start screen.
- Mutations of the eight guards.
- A browser run on a disposable database at 1280, 360, 375 and 390 px, and as a touch screen at 360×640, 375×667,
  390×844, 667×375 and 844×390.

**Recorded follow-ups (the internal reviews, LOW; not in PR-1):**
- the active Data configuration tab could return to the start screen;
- a domain's row counts its archived categories, and a category in an archived domain is not marked;
- an open domain without categories has no button to Categories;
- the Variables card counts the club's own variables only, while the domain and category cards count the system's too;
- the picker's choice line names the stored value (`icon:run`), a storage detail in the main flow;
- Source fields does not move the focus to its title.

---

## 12. PR-2 as built (from `0eb7e10`; frontend only, no migration)

PR-2 is section 6: dragging a variable onto a category on a computer. It uses the existing classification API and
changes no backend file. Where it differs from section 6, this section says so.

**Where it is offered:**
- Only on the Categories screen, and only with a mouse or trackpad (`pointer: fine` and `hover: hover`;
  `frontend/data-config-drag.js`, the pattern of `frontend/builder-library-drag.js`).
- Only for the administrator of the workspace: a platform admin, or a club's admin in that club's workspace. A team's
  coach and a phone get the screen as before, with no tray and no target.
- **The tray:** a panel beside the categories (under them below 960 px), titled *Variables*. It holds this workspace's
  own active variables, the first page of the default list (100), with each variable's icon tile.
  - It is read again each time the screen opens.
  - When the list has more, the tray says so and points to *Add to a category*.
  - The tray names the keyboard way: open a variable and choose *Add to a category*.
- **Drop targets:** this workspace's own active categories. An archived category and a system category in a club
  workspace take no drop, as in section 6.

**What a drop does:**
- It sends the existing link create (C4) with its own `requestKey` and the body `{ requestKey, variableId, categoryId }`.
  This is the body *Add to a category* sends.
- The line under the title says "*X* was added to *Y*." with *Undo* for 10 seconds (R2). *Undo* sends the existing link
  remove (C5) with a new `requestKey` and no reason.
- A refusal is a warning with the screen's own sentence, and nothing else changes.
- **Different from section 6, "already there":** every drop is sent. The read of the domains and categories carries no
  variable's links, so the screen cannot know beforehand that a variable is already in a category. The server answers
  `link_exists`, and the line says "*X* is already in *Y*. Nothing was changed.", with no warning and no Undo.
  - An earlier build kept the links it had seen in memory and sent nothing for those. It was removed before the pull
    request, because a link removed elsewhere (in the variable's detail, or by another administrator) would then have
    been reported as present.

**One write at a time:**
- While a drop is being saved, or its result is not confirmed, the tray is locked (nothing is draggable), and so is
  every other drop. The screen's forms share the rule.
- A lost answer (no answer, `503 outcome_unknown`, an uncoded 5xx) shows *Result not confirmed*. *Check result* sends
  the identical request (the same `requestKey`), and only an answer the server gives after reading its request record
  settles it. *Close without checking* says the result was not checked, and the list is read again when it is next shown.
- **Leaving:** leaving with a drop in flight or not confirmed asks first. This covers the screen's own ways back, the
  section switch, leaving Training Load and closing the page. Leaving ends the drop's line and its Undo. When the drop
  may have been saved, the list is read again.
- A late answer to a drop left behind changes nothing on the screen in use.

**Not in PR-2:**
- dragging a category onto a domain (section 6);
- dragging a variable from one category to another;
- a variable's own categories on the Categories screen (the read has none);
- touch dragging.

**Tests:**
- `frontend/tests/metric-classification-drag.actions.test.mjs`: 25 tests through the real handlers, the real drag
  handlers and the real markup with a fake fetch and a fake drag. They cover the offer per workspace and device, the
  targets, the drag's own data type, the body, "already there", four refusals, Undo and its 10 seconds, the three kinds
  of lost answer with *Check result*, the leave guards and a late answer.
- Mutations of 22 guards, all killed.
- A browser run on a disposable database with the real backend and the built frontend in Chromium, with a real HTML5
  drag:
  - the database holds exactly the links the screen reports, Undo removes only its own, and a lost answer that the
    server saved is settled by *Check result* with one link;
  - the tray beside the categories at 1280 px and under them at 900 px;
  - no tray at 360, 375 and 390 px as a touch screen, or for a coach;
  - 44 px targets and no overflow.
