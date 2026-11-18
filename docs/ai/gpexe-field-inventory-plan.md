# GPEXE field inventory: plan (no code)

| | |
|---|---|
| Status | Proposed by the executor on 2026-11-15, on the *Rukovodilac*'s order of that day. **The owner's decisions D-INV-1 to D-INV-4 and his answers to Q1–Q5 are recorded in section 6.** Plan only: no code, no migration. |
| Verified against commit | `91ff79ec` (main, merge of PR #538). |
| Builds on | `docs/ai/gpexe-metric-variable-mapping-discovery.md` (sections B, D2–D3, J4, J5, J12) and `docs/ai/phase7f-extractor-registry-contract.md`. They are not re-derived here. |
| The owner's request | Source fields should list **every** variable GPEXE sends, so that he can choose which ones to map. Today it lists the ten catalogued fields (the v34 seed plus v42's `open_top`), and three of them are verified. |

## 0. Why the owner sees ten fields today

- **A check projects every answer to what the importer reads.**
  - The adapter keeps the athlete row, `/more/` and the thresholds through `BUNDLE_FIELDS`
    (`backend/src/gpexeRestV1Adapter.js:88-97`).
  - The details answers (whole session and drills) go through `projectSessionDetails` (`:602`), which keeps only
    `DETAILS_CONSUMED_FIELDS` (`:438`), that is `tot_burst_events` and `tot_brake_events` (PR #141, #149).
  - The stored snapshot therefore holds nothing else, and no other field can be listed from it.
- **A field is offered for mapping only when two things exist:**
  - a T2a row with an active T2b revision (D2–D3). No route creates a T2a row; the ten were seeded by migrations v34
    and v42;
  - an extractor in the code registry (`backend/src/sourceMetricExtractors.js:277`, J12). Without one, the field is
    `source_metric_unsupported`.
- **A mapping version is activated only when its revision's unit and meaning are confirmed** (C91–C97, J4).

## 1. The inventory: what a check would record

**What is recorded.** For each source answer a check already reads, only the **names** of the fields it carries:
- the athlete row (`athlete_session`);
- `/more/` (`events.*` and the `complementary_data.*` zone lists);
- the whole-session details (`details.players[*].<metric>`);
- the drill details (same shape);
- the thresholds answer.

For each name it records:
- **the endpoint** (`athlete_session`, `more.events`, `more.complementary_data`, `details.session`, `details.drill`,
  `team_thresholds`) and **the field name**;
- **the value-shape kind:** `number`, `text`, `boolean`, `null`, `unit_value_object` (`{unit, value}`), `zone_list`,
  `object`, `list`;
- **the unit word**, only when the answer itself carries one (the details `{unit, value}` objects) and only if it passes
  the unit-token CHECK of D3 (1–30 characters, no whitespace, control character, `|` or `=`). Otherwise it is null;
- **counts and dates:** the number of sessions it was seen in, and first and last seen (dates of the check, not of the
  session).

**What is never recorded:** a value, an athlete id or name, a session id, a date of a session, or raw JSON.

**Where names are read.**
- **No extra GPEXE request.** The names are read in memory from the answers the check already has, before the
  projection drops them.
- `projectSessionDetails` already walks every metric name of every athlete to apply its name guard (`METRIC_NAME`,
  `:439`: `^[A-Za-z_][A-Za-z0-9_]{0,63}$`, prototype keys refused). The inventory reuses that walk.
- For the athlete row and `/more/`, it is `Object.keys` before `pick`.
- A name that fails the guard is not recorded, only counted (`rejected_names`).

**Bounds:**
- at most 300 names per endpoint per check;
- at most 2,000 names in all;
- the rest is counted, never stored.

The cost is CPU only: walking keys the parser has already read, within the existing 5 MiB answer cap.

**Where it is stored:**

| Option | What | Effect |
|---|---|---|
| **A. A small table (recommended)** | `training_load.source_field_observations`: `(source_system, api_family, endpoint, field_name)` unique, `value_kind`, `unit_word`, `sessions_seen`, `first_seen_at`, `last_seen_at`, plus the owner scope (see Q2). | **Migration, so ★★** (trigger 1). A system writer only, through the finalization of a **succeeded** check, as one bounded upsert in the same COMMIT that marks the check succeeded (v33's discipline): a failed or running check records nothing. It needs an actor or system guard like v35's, decided in the contract. |
| B. On the check row | A `jsonb` of names on `gpexe_import_checks`. | No new table, but a column is a migration all the same. The lists repeat on every check, the "first / last seen" is a query over every check, and retention follows the check rows. Not recommended. |

**Privacy.** These are names of metrics, not of people, but GPEXE lets a team define its own parameters, and a custom
name could in principle carry a person's name (for example `ana_sprint`).
- The name guard limits a name to an identifier.
- The rows hold no athlete link.
- Who can read them is Q2.
- The free-text rule of D2 (no personal data in these columns) applies, and the runbook says so.

## 2. The display

- **Source fields** gets a second list: **"Available in GPEXE, not supported yet"**. It shows the observed names that no
  T2a row covers, with the endpoint, the shape kind, the unit word when there is one, and "seen in N sessions, last
  DD.MM.YYYY".
  - Each row offers **"I want this"** to the platform admin, recorded with who and when (a flag on the observation row,
    under the same writer guard).
  - A row that is wanted moves to the top of the list and waits for a field to be added (section 3).
- **Who sees it:**
  - a platform admin in the platform workspace sees all of it and marks rows;
  - a club admin is Q2. My recommendation: they see read-only only the names observed through their own club's
    connection, because names seen by another club's account are that club's information;
  - a coach sees nothing.
- No code, endpoint path or id is shown to anyone but a platform admin (P2).

## 3. Adding one field: today, and what could be made generic

**Today's end-to-end cost of one new field** (the path the tenth field, `open_top`, took in phase 5b):
1. **A migration that seeds the T2a row and its T2b revision 1** (v42 did so), because no route creates a T2a row and
   v37's guard (C90) refuses every other T2a / T2b write. That makes it ★★: the owner's order naming the migration,
   a preflight and a post-check.
2. **The projection:** the field must be added to `BUNDLE_FIELDS` or `DETAILS_CONSUMED_FIELDS`, or the stored snapshot
   never holds it. The architecture guards B7.7b and B7.8 (`backend/tests/gpexe-rest-v1-adapter-reads.test.mjs:1331`,
   `:1352`) change with it.
3. **An extractor entry** in `sourceMetricExtractors.js`: one line for a plain number or a `{unit, value}` details
   field, more for a zone or an event shape. J12's tests change with it.
4. **The display rule:** the Source fields label. The plain labels come from the T2a row; a zone or event shape needs
   its parameter form.
5. **The evidence (C97):** the owner-run read-only comparison of the unit with the GPEXE screen (two sessions, two or
   three athletes), and the meaning from official documentation or written GPEXE support; then the two acts in
   Source fields.
6. **Tests:** the migration's apply, rollback and post-check, the projection guards, the extractor, and a preview over
   a stored snapshot.

Steps 1–4 and 6 are a ★★ pull request per field or per batch of fields. Step 5 is the owner's.

**What can be made generic, honestly:**
- **Plain shapes can become data:** a row `number`, or a details `unit_value_object` (one value per athlete, no
  parameter). Two changes make that work:
  - **(a) a T2a creation route** for a platform admin, guarded like v39 (the actor, its audit row, one act), in place
    of a migration per field;
  - **(b) the projection and the registry read the active T2a keys** of these two shapes, instead of the code constants
    `DETAILS_CONSUMED_FIELDS` and `EXTRACTORS`:
    - one generic `rowNumber` and one generic `detailsEntry`, chosen by the key's prefix (`athlete_session.<name>`,
      `details.players.<name>`);
    - the field name taken only from the T2a row, never from the answer;
    - checked by the same `METRIC_NAME` guard.

  Then a new field of those shapes costs one act in the UI plus the C97 evidence, and no pull request.
- **What it changes:**
  - **The projection's guarantee.** The owner's PR #141 / #149 decision ("the snapshot holds only what the importer
    reads") still holds, but "what the importer reads" becomes a database set instead of a code set. The check must
    read that set before its first request and pin it for the whole run, so a field added during a check never changes
    that check.
  - **Architecture guards B7.7b and B7.8.** Today they assert a fixed list. They would assert that the mapper reads only
    keys from that pinned set, and that the set holds only these two shapes.
  - **J12's contract.** "One extractor per source field, in code" becomes "one per field for zone and event shapes; one
    per shape for plain numbers". The discovery document's D2 / J12 rows and `.claude/rules/metrics-core-mapping.md`
    are updated in the same pull request, as that rule requires.
- **What stays code:** zone distances and event counts. Their parameters (bounds, operator, threshold, duration) and
  checks (`zoneDistance`, `eventCount`) are behaviour, not data.
- **Does today's architecture allow it?** Not without the changes above. The B7.8 guard and J12 say exactly that a
  field without a code extractor is unsupported. Making (b) safe means proving with a test that a field name from the
  database cannot reach a code path or a property lookup that the guard did not allow: the prototype keys, and a key
  outside the pinned set.

## 4. Rules and decisions this touches

- **`.claude/rules/metrics-core-mapping.md`:**
  - **no parallel registry.** The observation table is not a registry of variables: it is a list of source names with
    no semantics, outside Metrics Core. The plan treats it as T2a's waiting room, never as T2a;
  - **"a PR that changes a contract updates the discovery document":** both the inventory and option 3(b) do.
- **Evidence and the revision lifecycle:**
  - **C89–C97:** unchanged. No observed field becomes usable without the unit and meaning acts and their evidence.
    The unit word from the answer is documentation, never `source_unit`: GPEXE writes `"number"` for a count (section B).
  - **C91 (the revision lifecycle):** unchanged. A field created from the inventory starts as revision 1, `observed`.
- **Owner decisions:**
  - **Q1.** Is the inventory wanted with option A (a table, ★★ with a migration)?
  - **Q2.** Is a club admin's read-only view limited to names seen through their own club's connection, or is it the
    platform admin's view only?
  - **Q3.** "I want this": does it only record the wish, or also notify someone (the platform admin, the executor's
    queue)?
  - **Q4.** Generic plain fields (3(a) and 3(b)): wanted now, later, or never? This is the only part that changes the
    owner's projection decision and J12. It needs his explicit word.
  - **Q5.** Are names from the e03 / `api` family (the legacy path, no seeded field) recorded, or only `rest_v1`?
    I recommend `rest_v1` only.

## 5. Slices and their review regime

| Slice | Content | Regime |
|---|---|---|
| **I1** | Migration: the observation table, its writer guard, rollback, preflight and post-check. The adapter's name collection (bounded, guarded, in memory). The upsert in a succeeded check's finalization. Tests: no value or id reaches the table (a planted value and an athlete id in a fake answer), the bounds, nothing written by a failed check, the projected snapshot unchanged byte for byte, the statement count of the finalization. | ★★ (trigger 1; trigger 2 if Q2 scopes by club): `db-reviewer`, `security-reviewer`, `code-reviewer`; both GOs; the owner's order naming the migration. |
| **I2** | The read route (platform admin; a club admin per Q2; the identical 404 otherwise) and "I want this" (a guarded write, with its audit). | ★★ if Q2 scopes by club, otherwise ★ with `security-reviewer`. |
| **I3** | Source fields: the "Available in GPEXE, not supported yet" list and the button. Frontend only. | `code-reviewer` + `ux-design-reviewer` + `mobile-qa`. |
| **G1** (only on Q4) | The T2a creation route (3(a)). | ★★ (triggers 1 and 4): a migration for its guard. |
| **G2** (only on Q4) | The pinned database set in the projection and the generic extractors (3(b)); B7.7b, B7.8 and J12 updated. | ★★ (the projection is the owner's privacy decision, so trigger 5 applies if any reviewer disagrees): the external review. |

Order: I1 → I2 → I3. G1 and G2 follow only after the owner's Q4. Until then, a new field is a ★★ pull request as in
section 3.

## 6. The owner's decisions (2026-11-15)

The owner confirmed these in his chat ("da, slažem se"), and the *Rukovodilac* relayed them on 2026-11-15. They are
decisions, not proposals; each slice still needs its own contract and reviews.

| | Decision |
|---|---|
| **D-INV-1** | Source fields carries **everything GPEXE offers** (the inventory of names), so a club can map what it wants. |
| **D-INV-2** | **Generic plain fields** (a row number, a details `{unit, value}`): the unit is the unit word GPEXE itself sends with the value. The confirmation is the board's comparison of two athletes with the GPEXE screen and the admin's tick: no tick, no save. A field for which GPEXE sends no unit word stays locked until a platform admin confirms it by hand (the existing M2b acts). This changes C97 for these fields only. |
| **D-INV-3** | **Zone-dependent fields are in scope**, each carrying the team's GPEXE thresholds as its parameters. |
| **D-INV-4** | **Derived variables are in scope:** a formula with a formula version over mapped canonical values, labelled calculated, never stored as source-delivered (the owner's rule of 2026-09-17). |

**The answers to section 4:**
- **Q1:** yes, option A (a table, ★★).
- **Q2:** a club admin reads only, and only the names seen through their own club's connection. A platform admin sees
  everything; a coach sees nothing.
- **Q3:** no notification.
- **Q4:** now, for the generic plain shapes. Zones and events stay code until the zone model is decided.
- **Q5:** `rest_v1` only.

### 6.1 How D-INV-2 is recorded as evidence

Recorded in G1's migration and contract; the exact columns are its work.
- **A distinct evidence status.** T2b's `evidence_status` (v34, `unproven | documented | observed | verified`) gains a
  fifth value, **`source_stated`**: the unit is the unit word the source sends, and an administrator checked it on the
  board.
  - It is never `verified`, and the screen never shows it as "Verified by OptiMove". The words are "Unit stated by
    GPEXE, checked on the board".
  - A revision with `source_stated` may carry an active mapping version, as `verified` may. Every other rule (C91's
    lifecycle, the T4 pinning, the activation's unit check) is unchanged.
- **The unit word.** It must pass D3's unit-token CHECK, and a row of `unit_conversions` must take it to the target
  variable's unit. Otherwise the field stays locked and only the M2b acts can open it.
  - The word is read from the stored answer at the comparison, never typed by the admin.
  - The word `number` (GPEXE's word for a count, section B) is treated as the unit of a count only if a conversion row
    says so. Otherwise the field is locked.
- **The confirmation record.** It is one guarded act, with the actor, its audit row and one act per revision (the v37
  pattern). It records:
  - who and when;
  - the stated unit word;
  - the two athletes' positions in the session's GPEXE list and the session's position in the check (never an athlete
    id, a name or a value);
  - the admin's tick.

  `unit_evidence_ref` points to that record instead of a document anchor. That is a new reference shape, so v34's
  CHECK on the reference is widened in the same migration.
- **The meaning.** D-INV-2 names the unit only. For these fields, a field's meaning is the source's own label and
  description as the board shows them, and the same tick confirms it. This is the *Rukovodilac*'s reading; it is an
  open point for the owner's word before G1's contract, because C97 asks for official documentation or GPEXE support.

### 6.2 What D-INV-3 and D-INV-4 add (plans first, after I1–G2)

- **Zones (D-INV-3).**
  - Option A of the zone model is decided (C102) and built for the three seeded zone fields (v42, J7). Their
    parameters are fixed bounds today (OD1).
  - D-INV-3 asks for a zone field with **the team's own GPEXE thresholds** as its parameters. A team's zones follow its
    threshold set (v20's snapshot per event), so the bounds come from the session's threshold answer instead of the
    mapping version.
  - That is a change to J12's zone extractor and to OD1, so the *Rukovodilac* receives a short zone-model proposal
    first (Z0), and Z1 builds it (★★).
- **Derived variables (D-INV-4).**
  - **No parallel registry (ADR-007):** a derived variable is a canonical variable in Metrics Core. Its formula and
    formula version live on the variable's version, as a new kind of definition version.
  - **Its values** are written as Metrics Core values with the existing, unused columns `is_derived = true` and
    `computed_by_ref` (v13:283-284; v3 ties `derived_rollup` to both), which name the formula version and the input
    values. The occasion's `entry_method` carries the kind "calculated", a new value with a migration.
  - **The dashboards' `derived` source policy** (v16) already selects them.
  - **When it is computed** (after an import, after an estimate, on demand) and **what happens when an input changes**
    are the plan's questions. D0 is that plan, sent to the *Rukovodilac* before any code.

### 6.3 The order

**I1 → I2 / I3 → G1 / G2 → Z0 / Z1 → D0 → …**

| Slice | Content | Regime |
|---|---|---|
| **I1** | The inventory: migration, collection and upsert (section 5) | ★★ |
| **I2** | The read route (Q2: club admin read-only, own connection); "I want this" is not built (section 7.4) | ★★ (trigger 2) |
| **I3** | The Source fields list | code, ux, mobile |
| **G1** | The T2a creation route and D-INV-2's evidence status, record and act (migration) | ★★ + the Independent |
| **G2** | The generic plain extractors and the pinned set in the projection; `.claude/rules/metrics-core-mapping.md`'s document (D2, J12), B7.7b / B7.8 and J12 updated in the same pull requests | ★★ + the Independent |
| **Z0, Z1** | The zone-model proposal (C89), then zone fields with the team's thresholds | proposal to the *Rukovodilac*, then ★★ |
| **D0** | The derived-variables plan | plan first |

**Privacy throughout:** the name guard stays; a platform admin sees everything; a club admin sees only the names seen
through their own club's connection; a coach sees nothing.

## 7. I2 and I3: the plan (2026-11-15; the *Rukovodilac*'s decisions of the same day)

I1 (PR #546, migration v72) records the names. I2 reads them and I3 shows them, read-only for everyone who sees them. It is
grounded in the code on `dd3ccd19` and on I1's head `553052fc`.

### 7.1 What "not supported yet" means

An observed name is **covered** when a T2a row (`training_load.source_metric_definitions`, v34) of `gpexe` / `rest_v1`
already names it. The keys follow the seeded fields:

| Inventory endpoint | Covered by a T2a key |
|---|---|
| `athlete_session` | `athlete_session.<name>` |
| `more.events` | `more.events.<name>` |
| `more.complementary_data` | any key that starts with `more.complementary_data.<name>.` (a zone family, J7) |
| `details.session`, `details.drill` | `details.players.<name>` (one key serves both levels) |
| `team_thresholds` | never: thresholds are a team's parameters, not an athlete's value |

The list shows the names that are not covered. **P1:** `team_thresholds` names are never in the "not supported" list; a
platform admin sees them apart, folded under "Team thresholds (used by zone fields)", because they feed Z1 and are never a
variable.

### 7.2 I2: the read route (no migration)

`GET /api/training-load/sources/metrics/field-inventory`, under the existing `adminContext` (`resolveMappingAdminWith`).
Everyone else gets the identical 404 of the other metrics routes.

- **Who sees which rows (Q2):**
  - a platform admin in the platform workspace: every connection;
  - in a club workspace (the club's admin, or a platform admin there): only the rows whose connection belongs to that
    club. **P2:** that is a club-owned connection of the club, and a team-owned connection of one of the club's own
    teams. A team of another club is never included;
  - **A team-owned connection follows the team's current club** (the *Rukovodilac*'s L3, 2026-11-16). No route moves a
    team between clubs today (D43), and only names are shown. If a team-move route is ever built, it must first decide
    what happens to the names that team's connection recorded;
  - a coach, an athlete, a team workspace: the identical 404 (the route never answers them, as for `/fields`).
- **One row per (endpoint, name)**, grouped over the visible connections:
  - the endpoint in plain words (no key, code or id for a club admin);
  - the latest value kind;
  - the unit word (P3, below);
  - answers seen (summed);
  - the last sighting as a date;
  - covered or not (7.1);
  - for a platform admin only, the number of connections.
- **Never in the answer:** a connection id or label, a check id, a club or team name.
- **P3, the Independent's L1:**
  - a club admin sees the unit word only when it is the unit token of an active `unit_conversions` row; otherwise "—";
  - a platform admin sees the word as recorded;
  - names stay visible to the club whose own account sent them (Q2 already scopes them, and D-INV-1 asks to show them).
- **Paging:** an opaque cursor (C68's pattern), 200 rows a page, with the filter `state=not_supported|covered|all`
  (default `not_supported`).
- **One statement**, read-only, no lock (the pattern of the other metrics reads).

**I2 also carries:**
- **L2:** one constant for the finalization's `lock_timeout` of 2 s, used by `finalizeCheck` and I1's
  `writeFieldInventory`.
- **L3:** a block added to v72's post-check document, checking that `anon` and `authenticated` have no USAGE on
  `training_load`. It is a document change only; the migration file is untouched. It is the pattern for every later
  post-check that touches `training_load`.

**Regime:** ★★ for trigger 2 (the club scoping), without a migration. Reviewers: `security-reviewer`, `code-reviewer`;
then the *Rukovodilac* and the *Nezavisni revizor* on the frozen head.

**Tests (disposable databases, through the real route):**
- the read for each audience:
  - a platform admin sees two clubs' names;
  - a club admin, in their own club's workspace, sees their club's names, including those from a team-owned connection
    of their own team;
  - a foreign club's team-owned connection is never included;
  - a coach, a team workspace and an archived club's workspace get the identical 404. A club admin whose saved workspace
    names a club they do not administer is not refused: the workspace resolver falls back to a workspace of their own
    (`pickFallbackWorkspace`), so they read their own club's names and never the other club's (corrected after I2's review;
    I2's test 11 proves it);
- covered names are hidden by default;
- `team_thresholds` reaches the platform admin only;
- the unit word: a club admin sees it only when it is a known unit;
- paging;
- no connection or check id in any answer (a scan).

### 7.3 I3: the screen

Frontend only, in `frontend/source-fields-{view,data,actions}.js`. Reviewers: `code-reviewer`, `ux-design-reviewer`,
`mobile-qa`, and a browser check at 360, 390 and 1280 px. It is read-only for everyone who sees it.

- **A second list** under the supported fields: **"Available in GPEXE, not supported yet"**, with a one-sentence
  introduction: "Names GPEXE sent in this club's sessions that OptiMove cannot map yet." In the platform workspace it reads
  "in every club's sessions".
- **Each row:**
  - the name as GPEXE writes it (escaped);
  - where it comes from in plain words ("athlete row", "session details", "drill details", "events", "zone data");
  - the kind in plain words ("number", "number with unit", "zone list", …);
  - the unit word or "—";
  - "seen in N answers, last DD.MM.YYYY";
  - for a platform admin, the connection count.
- **Filters:** a search box over the names, and the endpoint as chips. The "Show supported too" switch reads `state=all`.
- **Empty states:** "No names yet. The list fills in after the next successful search for sessions." A club with no
  connection gets "This club has no GPEXE connection."
- *Load more* pages the list.

**As built (I3):**
- **The list:** "Available in GPEXE, not supported yet", under the supported fields, is read when Source fields opens. The
  Data configuration start screen's card does not read it.
- **Each row:** the name; where it comes from, its kind, the unit word, the answers and the last day, all in plain words;
  for a platform admin, the connection count.
- **Filters:** the endpoint chips and "Show supported too" become the read's query. The search narrows the loaded names
  in place, so its field keeps the focus. "Load more" reads the next page.
- **Team thresholds:** a platform admin's fold, read only when opened.
- **Read-only:** nothing on the list writes.

### 7.3a Structural keys are not fields (the *Rukovodilac*'s decision (b), 2026-11-16)

An identifier, a reference to another record or a timestamp is never a value GPEXE measured, so nobody could map it. One
frozen list, `STRUCTURAL_FIELDS` in `backend/src/sourceFieldInventory.js`, is used in two places:
- the collector does not record those names;
- the read (`sourceFieldInventoryRead.js`) hides the same pairs under every state and filter. This is a backstop for any
  row written before the rule; production has none yet.

No migration, and no change to who sees what.

| Endpoint | Left out | Kept, though unsure |
|---|---|---|
| `athlete_session` | `id`, `athlete`, `teamsession`, `track`, `drill`, `team`, `start_timestamp`, `end_timestamp`, `created_on`, `updated_on` | `is_stats_valid` (a flag, not an identity) |
| `team_thresholds` | `id`, `team`, `validity_start`, `validity_end` | `is_heart_rate_thresholds_in_percent`, `use_hr_min` and the `are_*_visible` flags (display settings of the thresholds, not measured values) |
| `details.session`, `details.drill`, `more.events`, `more.complementary_data` | nothing: the names there are measured values (a players' map is keyed by athlete, and /more/'s identifiers sit beside `events` and `complementary_data`, never inside them) | — |

The athlete_session list comes from the projection's identity and time fields and the request. The full key set of a real
server3 row is not in the repository: the probes returned field names to the owner only, and the fixtures are synthetic.
So a real row may carry another identifier, for example a name-like text. If one shows up in Source fields, it is added
here.

### 7.4 Open point: a wish list (not a slice)

"I want this" (a guarded, append-only wish per name) is **not built now** (the *Rukovodilac*, 2026-11-15). Its only user
would be the platform admin, and G1 gives the generic plain fields a real "add" path. A table for a personal to-do would
put another ★★ migration in front of G1 / G2.

After G2, if names remain that only code can support (zones, events), a wish list is reconsidered then.

### 7.5 The order

I2 (the read route, ★★ without a migration) → I3 (the screen) → the G1 contract (section 8).

## 8. G1: creating a generic field and its `source_stated` evidence (contract, 2026-11-16)

**Status: Accepted** (the *Rukovodilac*, 2026-11-16; merged as PR #564). The owner decided (a) the same day (8.0).

G1 is J18's reserved slice 18-P (`docs/ai/c112-drag-mapping-contract.md`, sections 5.1 note, 5.7, 15.2 and C114),
reshaped by D-INV-2 (section 6.1).
- It builds the shapes v65 reserved: T9 kind `field_observation`, its T9s session, the T9i kind `field_unit`, and T2b's
  observation columns. There is no parallel record.
- G1 and G2 ship as a pair, as two pull requests. G1 comes first: the migration, ★★ plus the *Nezavisni revizor*.
- G2 follows on top of it: the generic extractors and the pinned set, also ★★ plus the *Nezavisni revizor*.
- **G1 alone makes nothing importable.** A created field has no extractor until G2, so a T4 create on it still answers
  `409 source_metric_unsupported` (J12).

### 8.0 The *Rukovodilac*'s decisions (2026-11-16)

| | Decision |
|---|---|
| (a) | **The meaning: the owner's decision, 2026-11-16.** The *Rukovodilac* described the flow: drop a column, compare two athletes with the GPEXE screen, tick, save. It asked whether that one tick replaces both the unit and the meaning confirmation, with the meaning recorded as what GPEXE calls the field, checked on the board, without documents. The owner answered „taj način je dobar" (yes), as the *Rukovodilac* relays it. **For generic plain fields only**, the board's tick is the unit act and the meaning act together. The screen reads "Meaning: GPEXE's own label, checked on the board". **C97 is changed accordingly for these fields:** their evidence is `source_stated`, never `verified`, and never shown as "Verified". Every other field keeps C97 and the M2b document acts. |
| (b) | **One session, two athletes.** This is D-INV-2's wording and the owner's standing C97 decision ("one session instead of two", `docs/ai/gpexe-c97-unit-evidence.md#owner-decision`). It departs from C116 (J18: two sessions for a global confirmation) on the owner's decisions. The act stores which session, so a later, stricter rule can re-check it. |
| (c) | **Only a platform admin** raises a field to `source_stated`, and only in the platform workspace. A club admin's tick stays what it is today: one per save (C112). **Open point** for the day a second club exists: the owner wants clubs to map what they want, so a per-club path will be asked for then. |
| (d) | **Superseded by 8.10 (the *Rukovodilac*, 2026-11-16).** It first read: `number → count` as a seed row of `unit_conversions`. It is not a conversion: GPEXE's unit words are quantity kinds, and they are mapped by `source_unit_words` (8.10). No `unit_conversions` row is seeded. |
| (e) | **Capitalised GPEXE names** are refused with `409 name_not_supported`, because T2a's key CHECK is lower case only. I3 lists them as they are. This is revisited when the production inventory shows whether any exist; the executor reports the count after the owner's first search on the deployed build. |
| (f) | **Typed foreign-key columns** hold the proof. `training_load.source_metric_evidence_ref_ok` stays docs-only. |

Also accepted:
- creation only of what the inventory observed, with a server-derived key;
- the unit word read from the stored answer, never typed;
- `athlete_session` plain numbers stay M2b-only, because GPEXE sends no unit word with them, and the screen says so in
  plain words;
- the revisions already verified by documents stay byte for byte as they are (five today, as the *Rukovodilac* counts
  them, and seven once the owner's burst and brake acts of 2026-11-16 are done);
- `source_stated → verified` only through a new revision R+1 and the M2b acts, and `verified` is never replaced by
  `source_stated`.

### 8.1 Route C: creating a field

`POST /api/training-load/sources/metrics/fields`

- **Who:** an active platform admin in the platform workspace. Everyone else gets the identical 404 (ADR-006), as the
  M2b acts do.
- **Body:** `{ requestKey, endpoint, name, label, supportsSession, supportsDrill }`. Any other key is a `400`.
- **The key is derived by the server and never typed:**

  | `endpoint` | Key | `value_shape` |
  |---|---|---|
  | `athlete_session` | `athlete_session.<name>` | `number` |
  | `details.session`, `details.drill` | `details.players.<name>` | `unit_value_object` |
  | any other | — | `409 shape_not_generic` |

  Zones and events stay code (Q4).
- **The name:**
  - it must exist in `source_field_observations` for that endpoint on some `rest_v1` connection, otherwise
    `409 name_not_observed`;
  - it must not be a structural key (`STRUCTURAL_FIELDS`), otherwise `409 name_not_observed`;
  - it must match T2a's key CHECK, otherwise `409 name_not_supported` (decision (e));
  - if an active or retired T2a row already has the key, the answer is `409 field_exists`, carrying the existing id.
- **The label:** `source_metric_text_ok(label, 80)`, the same rule as M2b's free text (Q10). The levels need at least
  one of the two, and for `details.drill` `supportsDrill` must be true.
- **One write:**
  - a T2a row with `created_by_user_id`;
  - T2b revision 1: `state = 'active'`, `evidence_status = 'unproven'`, `parameter_kind = 'none'`;
  - `expected_source_unit` = the seeded unit token of the latest unit word the inventory saw (`source_unit_words`,
    8.10), otherwise null: a word without a row is never guessed. (Before 8.10 this line said the word itself, if it
    passed the unit-token rule; G1a built the 8.10 rule.)
    It is a hypothesis, never `source_unit`;
  - its T8 row `source_field_created`.
- **Replay:** idempotent by `requestKey` (the M2 request record), with the bounded COMMIT and the
  `verified_after_commit_error` / `outcome_unknown` discipline.

### 8.2 Route O: the observed confirmation (J18's route 9)

`POST /api/training-load/sources/metrics/fields/:fieldId/revisions/:revisionId/observed-confirmation`

and its read, J18's route 8: `GET /fields/:fieldId/observation?candidateId=…&pairs=i,j`.

- **Who:** the same as route C.
- **Body:** `{ requestKey, session: { candidateId, pairs: [i, j], placementHash }, attested: true }`. That is one
  session (decision (b)) and two athletes, given by their positions in the session's GPEXE list, never an id.
- **Which revisions:**
  - only a revision with `parameter_kind = 'none'`, `state = 'active'` and `evidence_status = 'unproven'`;
  - a revision with parameters gets `409 field_has_parameters`;
  - once its unit is proven, a revision gets `409 unit_already_verified` (M2b's code).
- **The candidate:**
  - it is read under the candidate's own team, through a binding of a `rest_v1` connection;
  - its last check must have succeeded;
  - `placementHash` must still match, otherwise `409 board_changed`.
- **The unit word:**
  - it is read from the stored answer (`details.players[athlete].<name>.unit`) for both athletes;
  - the two must agree, otherwise `409 unit_not_stated`;
  - it must pass the unit-token rule, otherwise `409 unit_not_stated`;
  - it must be the `from_unit` of an active `unit_conversions` row, otherwise `409 unit_not_stated`;
  - an `athlete_session` field always answers `409 unit_not_stated` with the sentence "GPEXE sends no unit with this
    value. A platform administrator confirms it with a document (Confirm the unit)."
- **One write,** in this order:
  - the T9 row: kind `field_observation`, `owner_scope = 'system'`, no club;
    - the binding, team and connection the session came from;
    - `source_metric_version_id` = the revision;
  - its one T9s session row, which records the check, the candidate's hash, the GPEXE session id and its start, so a
    stricter rule can re-check it later;
  - two T9i `field_unit` items, each with the athlete's raw value, the stated unit word, a salt and a digest. The values
    expire under v65's purge (C118), and no athlete id is stored;
  - T2b:
    - `source_unit` = the word, with `unit_verified_by_user_id`, `unit_verified_at` and
      `unit_observation_id` = the T9 row;
    - and the same for the meaning (`meaning_observation_id`), decision (a);
    - `evidence_status = 'source_stated'`;
  - two T8 rows, `source_metric_unit_observed` and `source_metric_meaning_observed`, linked by `confirmation_id`.
- **Who sees the values:** platform admins only, in the platform workspace, through J18's route 10
  (`GET /fields/:fieldId/observations`; C119 (c)). A club admin sees "Unit stated by GPEXE, checked on the board" on the
  field, never the values.

### 8.3 The schema (migration v74, `migrations_v2/202611161200_training_load_v74_…sql`; the prefix is the *Rukovodilac*'s of 2026-11-16)

- **T2b:**
  - `evidence_status` gains `source_stated`;
  - two columns: `unit_observation_id` and `meaning_observation_id`. Each references T9 `on delete restrict`, and a
    BEFORE trigger checks that the T9 row is of kind `field_observation` and names the same revision;
  - `unit_proof_together` and `meaning_proof_together` become: the user and the time are set together, together with
    exactly one of the document reference and the observation id;
  - `verified_iff_proven` becomes:
    - "proven ⇔ `evidence_status in ('verified', 'source_stated')`";
    - "`source_stated` ⇔ the unit's proof is an observation";
  - `evidence_ref_iff_proven` treats `source_stated` like `verified`. Its `evidence_ref` is null and the proof is the
    observation id.
- **T9:**
  - `kind` admits `field_observation` and `owner_scope` admits `system` (`field_observation` ⇔ `system`, with no club);
  - a nullable `source_metric_version_id` is set exactly for `field_observation`;
  - T9i's `kind` admits `field_unit`.
  - These are the widenings J18 section 5.1 reserved. v65's deferred checks gain: `field_observation` has exactly one
    session and exactly two `field_unit` items, and T2b names it in the same transaction.
- **T8:**
  - the actions `source_field_created`, `source_metric_unit_observed` and `source_metric_meaning_observed`, their shapes,
    and one row per operation;
  - v37's C90 refusal ("every other T2a / T2b write") gains these two built chains.
- **Seed:** the `unit_conversions` row `number → count (1, 1, 0)`, decision (d).
- **Replaced bodies,** each behind an md5 check of the body in force:
  - v37's T2b and T8 guards and v42's actor guard admit the new acts;
  - v52's activation guard and v65's T9i guard accept `evidence_status in ('verified', 'source_stated')`;
  - v34's write-once guard lists the two new columns.
- **Lock order:** v65's T4 → T2b → T9 → T8, and the acting user's rows users first (v54). T8 is taken `NOWAIT`, as v65
  does. Preflight block: a quiet moment.
- **Preflight, post-check and rollback:**
  - v73 (App health's) may or may not be recorded, in either order, and every block allows both;
  - the post-check asserts that the already-verified revisions are unchanged byte for byte, by a digest of their rows
    taken in the preflight;
  - the rollback refuses once any T2a row was created by route C, any `field_observation` row exists, or the seeded
    conversion was changed or used. Otherwise it restores every body by md5 and the CHECK texts, and removes the seed.

### 8.4 Code that changes with G1 (no extractor)

- **The board gates** read `evidence_status in ('verified', 'source_stated')`:
  - `sourceMetricBoardService.js` around lines 325 and 500–501;
  - `sourceMetricMappingService.js` around line 1488;
  - and the database guards of 8.3.
- **The platform workspace's board:**
  - it offers the unproven generic fields of any bound session;
  - the admin compares two athletes with the GPEXE screen and ticks; no tick, no save;
  - the save is route O.
- **The club workspace's board:** unchanged in rights. A `source_stated` field is placeable like a verified one, and
  its tick per save (C112) stays.
- **Source fields:**
  - "Create field" on an inventory row (route C), and the status words "Unit stated by GPEXE, checked on the board";
  - "Meaning: GPEXE's own label, checked on the board" (decision (a)). It is never "Verified".
  - For an `athlete_session` row: "GPEXE sends no unit with this value, so a platform administrator confirms it with a
    document."
- **The revision lifecycle** (`sourceRevisionLifecycleService.js` around line 509): replacing `source_stated` with
  `verified` is allowed (R+1 with the two M2b acts, then L2), and replacing `verified` with `source_stated` is refused.

### 8.5 Tests (G1)

- **The migration:**
  - apply, the md5 gates (each refuses a changed body), and the rehearsed rollback with each refusal;
  - preflight and post-check with v73 recorded and not recorded;
  - the already-verified revisions unchanged byte for byte.
- **Route C:**
  - access and the identical 404 (a club admin, a club workspace, a coach, no session);
  - each refusal (`shape_not_generic`, `name_not_observed`, a structural key, `name_not_supported`, `field_exists`);
  - the derived key and shape, `expected_source_unit` from the inventory;
  - idempotency and the COMMIT outcomes;
  - a raw T2a insert without the chain is refused by the database.
- **Route O:**
  - access;
  - each refusal (`field_has_parameters`, `unit_already_verified`, `unit_not_stated` for each reason and for
    `athlete_session`, `board_changed`, a failed check, another family);
  - one write with every row of 8.2;
  - no athlete id anywhere, and the values only in T9i;
  - the deferred checks (a second session, a missing item, T2b not naming the row);
- **The gates:** a `source_stated` revision activates a T4 version and is placeable on the club's board; a club admin
  never reads `field_observation` values (route 10 is 404 for a club admin).
- **The lifecycle:** `source_stated → verified` through R+1, and `verified → source_stated` refused.
- **Concurrency:**
  - route O against an M2b act on the same revision, in both orders;
  - route O against an Unbind of the session's binding, in v65's order;
  - the recorded SQL order of route O's locks (`.claude/rules/migrations.md`).
- **Mutations** for every new guard.

### 8.6 What G1 does not do

- No extractor, and no change to the projection or the stored snapshot (G2).
- No zone or event field (Z0 / Z1).
- No club-scoped raising of a field (decision (c), an open point).
- The revisions already verified by documents are not touched.

### 8.7 The generic display rule `as_sent` (the *Rukovodilac*'s addition, 2026-11-16)

**Found on production on 2026-11-16.** The owner confirmed `details.players.tot_burst_events` and `tot_brake_events` by
documents: unit `count`, plus the meaning. Both are `verified`, yet the board still refused them with
`display_rule_missing`. The display registry knew only the three athlete-row columns:
- in code, `RULES` in `backend/src/sourceMetricBoard.js`;
- in the database, v65's `training_load.source_metric_display_unit_ok`, which checks every T9i's `gpexe_display_rule`.

So no proven field beyond those three could ever be compared or placed, and that would also block every `source_stated`
field.

**The rule:**
- **`as_sent`:** the value exactly as GPEXE sends it, in the field's own proven unit.
  - Its unit is the revision's `source_unit`, which must be a unit token.
  - It shows the canonical decimal text of the raw value with **no rounding**: a whole number stays whole, otherwise
    GPEXE's own digits.
  - The comparison sentence on the board names this rule.
- **`displayRuleFor`:** a specific rule still wins, and only in its own unit (a specific column proven in another unit
  is still `display_rule_missing`). A field with no specific rule falls back to `as_sent`.
- **`DISPLAY_REGISTRY_VERSION`** goes from 1 to 2. The placement hash's inputs carry no registry version, so the hashes
  of the three specific rules do not change. A test pins one of them from `main`.
- **v74** replaces `source_metric_display_unit_ok`'s body behind its md5 check. It keeps the three cases byte for byte
  and adds `when 'as_sent' then training_load.source_metric_unit_token_ok(p_unit)`. The rollback restores the v65
  body, and refuses once any T9i row carries `as_sent`.
- **Burst and brake** become placeable through it with unit `count`. Their placement still needs an active conversion
  to the variable's unit.

**Tests:**
- the two real keys are placeable after v74, with a disposable world on v74;
- an unproven field is still `field_not_confirmed`;
- the three specific rules and a pinned placement hash are unchanged;
- the database function refuses a non-token unit, and the three old cases answer as in v65;
- a board save with an `as_sent` placement is refused before v74 (v65's function) and accepted after it.

**Built before v74 (branch `feature/gpexe-field-create-g1`):** the code half, with its unit tests and the board suites
updated. It ships only with v74: until then a board save with an `as_sent` column would be refused by v65's database
function.

### 8.8 Backlog: a sentence for a system variable on the club's board (wording only, later)

The owner created his "Burst" variable in the platform workspace, so it is a system variable. The club's board then
says "OptiMove does not fill this variable from a column of this session", which is correct, but it does not tell him
what to do. A proposal for a platform admin on such a slot, three lines:

> This is an OptiMove variable, so a club does not fill it by dragging.
> To fill it for this club, create the variable in the club's workspace and drag the column onto it there.
> To fill it for every club, a platform administrator maps it in Data configuration > Mappings.

### 8.9 As built (G1a; the executor, 2026-11-16)

The migration is v74, `migrations_v2/202611161200_training_load_v74_generic_source_fields.sql`, with its runbook
`docs/runbooks/generic-source-fields-v74.md` (preflight, post-check, rollback). Route C is
`backend/src/sourceFieldCreateService.js`. The tests are `backend/tests/source-field-create-g1.test.mjs` and
`source-field-create-g1-unit.test.mjs`. Where it departs from 8.1–8.3, and why:

- **T2a is guarded only when a write carries an acting user.** v37 never guarded a T2a insert, and the test suites
  write raw T2a fixtures without an actor. So a write with an acting user (every application write sets one) is held
  to route C's contract:
  - a platform admin, in their own name;
  - a generic key;
  - its `source_metric_create` row at COMMIT.

  A write without an actor stays as before v74. This is a known limit of the same kind as C74.
- **Route C reuses existing chains.** It reuses v34's reserved action `source_metric_create` (its chain is built here)
  instead of a new action. Revision 1 is created through v39's own chains (a draft, then its activation), so it ends
  active and unproven, as 8.1 says. That makes three T8 rows; the keyed one, `source_metric_create`, is the request
  record.
- **One `field_unit` row, not two.** A field observation holds exactly one `field_unit` T9i row carrying both athletes'
  raw values (`raw_a`, `raw_b`), in T9i's existing per-row shape for one session.
- **Route O comes after G2.** Route O reads the two values from the stored snapshot, and the snapshot holds only the
  importer's consumed fields (PR #141, #149) until G2 projects the pinned set of active fields. So route O, routes 8
  and 10, the platform-workspace board and "Create field" are **G1b**, after G2. v74 already holds their whole database
  chain, and tests 8 and 9 write it by SQL as route O will.
- **The function bodies are generated, not copied.** They come from `pg_get_functiondef` of the bodies in force, with
  checked replacements.
- **The rollback is proven exact.** It restores the catalog of v72 exactly (test 11).

- **The unit words (8.10) replace decision (d).** v74 seeds `source_unit_words` (nine rows), not a `unit_conversions`
  row. A `field_unit` row names its word, and v74's T9i guard takes the unit, rule and screen unit from it; a mapping
  row that names a word is refused. The rollback refuses while a row names a word (test 11). Proof: test 6 (the nine
  rows, seed-only and append-only), test 8 (four words, each with its own rule), test 9 (a word not in the table, a unit
  or rule not the word's), and `source-metric-board-18-2` test 14.

- **The words table's unit column is `source_unit`,** the name T2b and T9i already use for a unit token. It was first
  `unit_token`, and the legacy-schema dump scanner (`tools/legacy-schema/scan.mjs`) read `unit_token = 'm/s'` as a
  literal secret.
- **The test list "before the confirmation gate" stops at v69 by name.** `GPEXE_TEST_MIGRATIONS_BEFORE_CONFIRMATION_GATE`
  (`backend/tests/_gpexe-disposable-db.mjs`) was the whole list minus v66, so it held v74 without v66. v66's md5 gate
  rightly refuses that state, because v74 replaces a body v66 checks, and production never has it. It now follows the
  v66 suite's rule (PR #565): every migration up to v69 by file name, except v66. The suites of 7h, LO-1 and 9-B pass.

- **After the internal reviews of `76fb65c1`** (db, security, code, mobile; no BLOCKER or HIGH):
  - v74 takes every lock it needs before its first change, in the writers' order (T4, T2a, T2b, T9, T9i, then T8
    NOWAIT), with `lock_timeout` 5 s (db MEDIUM-1). A test reads the file's statements and pins that order, the
    timeout first and every lock before the first change (`source-field-create-g1-unit`, the rule of PR #346; code LOW).
    The 5 s replaces the runner's 30 s lock wait for the whole of v74: a busy table fails the deploy fast, nothing applied.
  - A `field_unit` row's word is final, by v65's update guard, and inside its values digest; a row without a word keeps
    v65's digest (db MEDIUM-2, test 13). Fourteen bodies are now replaced.
  - Route C's `source_metric_create` row must carry its request key, since it is the request record (db LOW-1,
    test 5).
  - A mapping row shown `as_sent` is accepted only in its own source unit (security 2a, db LOW-3, `source-metric-board-18-2`
    test 14).
  - The importer treats `source_stated` as proven through `statusProven`, as every other consumer does (security 1,
    code 2; `gpexe-import-mapped-plan-9b` test 2).
  - Route C's lost answer is proven through the route: a verified COMMIT answers 200 `verified_after_commit_error`; an
    unknown one answers 503 `outcome_unknown`, and the same key then creates the field once (code 1, test 12).
  - Recorded, not built: the club board shows the raw values of every readable column, proven or not. Once G2 gives
    created keys an extractor, a club admin would see two athletes' values of an unproven created field from the club's
    own session. G2 decides that (security 2). Also recorded: a structural name answers `name_not_observed` as 8.1
    says; the losing writer of a race gets `field_exists` without `current`; the levels are declared by the admin; the
    expected unit may come from another club's observation, and is only a hypothesis; T2a's key rule holds only with
    an acting user (C74).

**Not yet tested:** v52's activation gate on a `source_stated` revision (mutation M10 survives). A mapping version of a
created field needs its extractor (J12), which is G2's; G2's or G1b's tests cover it.

### 8.9b As built (G1b-1; the executor, 2026-11-17)

- **"Create field" on Source fields.** It sits on an inventory row and calls route C. It is offered only where the
  inventory answer says `creatable: true`, a flag only route C's audience (a platform admin in the platform workspace)
  gets, computed by the read from route C's own rules: not covered, a generic endpoint, a name `deriveField` takes, and
  every observation a value kind a check keeps (`KEPT_VALUE_KINDS`: a number, or a value with its unit, or no value).
  Route C decides again on the request.
  - The form takes the name in OptiMove and the levels the endpoint allows (a per-drill name always keeps the drill). It
    says once what happens next: "This field has no values yet. Its unit is confirmed on the board once new sessions
    carry it."
  - The three outcomes: created (the new field opens); a coded refusal (nothing was created, the form stays); a lost
    answer (Result not confirmed; Check result sends the same request and key). `field_exists` opens the existing field.
- **The status words (8.4).** A `source_stated` revision is never "confirmed": its unit reads "stated by GPEXE, checked
  on the board" and its meaning "GPEXE's own label, checked on the board", in the list, the revision and its history.
  An athlete-row field without a unit says that GPEXE sends none and that a platform administrator confirms it with a
  document.
- **Route C's audience test** (`source-field-create-g1` test 4) now covers a coach and an athlete, and a text/plain body
  and an array body, each the identical 404 before the body is read.
- **After the reviews of G1b-1** (code, ux, mobile: READY WITH NON-BLOCKING NOTES):
  - a details name GPEXE sends both for the whole session and per drill is one key (`details.players.<name>`), so its
    form opens with both levels and says so (code MEDIUM); a whole-session name says to tick Each drill only if GPEXE also
    sends it per drill;
  - `creatable` is false when the derived key exists in any state (route C answers `field_exists` for a retired key too);
    a `field_exists` without the existing field (the losing writer of a race) says the field exists and reads the list
    again;
  - a per-athlete name's next step says that a document confirms its unit, since GPEXE sends no unit with it (ux MEDIUM;
    the wording approved by the *Rukovodilac*, 2026-11-17); the detail's history heading is "Checks and confirmations".
- **After G2's merge (the *Rukovodilac*'s orders of 2026-11-17):**
  - **The interim refusal.** Until G1b-2, a created details field (a generic `details.players.` key) whose proven unit
    is not `count` gets no mapping version: `extractabilityCode` answers `unit_not_importable` ("This field's unit cannot
    be imported yet."), so T4, A1, the copy (7i), the 7e preview and the importer's plan all refuse it, and the board
    shows such a column as unsupported. The generic details entry reads only the word `number`; any other word would
    block every session of the team (`source_shape_mismatch`). G1b-2 removes the refusal in the PR that teaches the
    extractor the unit words. Proof: `source-metric-extractors-7f` test 15, resolver test 52. **Removed by G1b-2** (section 8.11).
  - **The retire remedy (i).** The pinned set keeps only a field with an active revision, so retiring the active
    revision (L5) stops every check from keeping it; a pending snapshot keeps its values until the retention run
    projects them away. Proof: resolver test 51. The runbook (`docs/runbooks/gpexe-in-app-import.md`, "Created source
    fields in a check") says how.
  - Route C's value-kind rule and the inventory's `creatable` share `KEPT_VALUE_KINDS`.
- **Two connections.** Two GPEXE accounts may send the same name with different unit words. The expected unit of a
  created field comes from the latest observation only, as a hypothesis. Route O's refusal of a word that differs from
  the revision's expected unit (`unit_not_stated`, carry-over 5) is G1b-2's.

### 8.10 GPEXE's unit words are kinds, not units (the *Rukovodilac*'s amendment, accepted 2026-11-16)

**The finding.** The *Rukovodilac* counted the production inventory read-only, after the owner's first search on
`34d5e8f3`. The distinct unit words in `details.session` and `details.drill` are `acceleration`, `distance`,
`duration`, `energy`, `energy_std`, `number`, `power`, `speed` and `time`. These are quantity kinds, not units, so
D-INV-2's "the unit is the word GPEXE sends" is not taken literally.

The athlete row carries no unit word on any field. No name has a capital letter, so decision (e) has no case today; the
refusal stays.

**The rule.**
- A seeded, seed-only table, `training_load.source_unit_words`, maps each word to:
  - the unit token the raw value is in;
  - the board's display rule;
  - the kind and reference of its evidence.

  It is not `unit_conversions`, so a kind word never stands where a unit is expected.
- **Each row is a hypothesis per word.** The two-athlete tick is what proves each field.
- **A word without a row is never guessed:** route O answers `409 unit_not_stated`, and only the M2b document acts can
  open the field.
- **Adding a tenth word is a migration** (the seed window), with its evidence.

| Word | Unit token | Display rule on the board | Evidence |
|---|---|---|---|
| `number` | `count` | `as_sent` | <a id="unit-word-number"></a>repository: the C97 burst / brake evidence, a `{unit: "number"}` details value is a count (`docs/ai/gpexe-c97-unit-evidence.md#burst-events-unit`) |
| `speed` | `m/s` | `speed_kmh` | <a id="unit-word-speed"></a>repository: probe C of 2026-10-24, the details' `max_values_speed` (unit word `speed`) equals the row's `max_v` in m/s for 9 of 9 pairs (`docs/ai/CURRENT_STATE.md`, the owner-run read-only sitting, C; `docs/ai/gpexe-c97-unit-evidence.md#max-v-provenance`) |
| `distance` | `m` | `distance_m` | <a id="unit-word-distance"></a>repository, by analogy: the athlete row's `total_distance` is in m (`docs/ai/gpexe-c97-unit-evidence.md#total-distance-unit`). No details field with this word is compared yet |
| `time` | `s` | `duration_mmss` | <a id="unit-word-time"></a>repository, by analogy: the athlete row's `total_time` is in s (`docs/ai/gpexe-c97-unit-evidence.md#total-time-unit`). **Unresolved whether `time` and `duration` differ in GPEXE**; no fixture shows it |
| `duration` | `s` | `duration_mmss` | as `time` (`#unit-word-time`) |
| `power` | `W/kg` | `as_sent` | <a id="unit-word-power"></a>the owner's statement, 2026-11-16, as the *Rukovodilac* relays it |
| `energy` | `J/kg` | `as_sent` | <a id="unit-word-energy"></a>the owner's statement, 2026-11-16, from the GPEXE application's own screen, as the *Rukovodilac* relays it |
| `energy_std` | `J/kg` | `as_sent` | as `energy` (`#unit-word-energy`) |
| `acceleration` | `m/s2` | `as_sent` | <a id="unit-word-acceleration"></a>the owner's statement, 2026-11-16, as the *Rukovodilac* relays it; spelled `m/s2`, as Metrics Core's own variables form spells it |

**The owner's statements** (`power`, `energy`, `energy_std`, `acceleration`) are recorded as his statements, relayed
by the *Rukovodilac*: not documentation. This is the same class as the burst / brake meaning.

**What it changes in G1:**
- **The T9i `field_unit` row** gains `source_unit_word`. It is set exactly for `field_unit`, so the stored evidence
  records both the word and the unit token.
- **Route O and v74's guard** take everything from the word's row:
  - the unit token: `source_unit` must equal it;
  - the display rule: the row's own;
  - the display unit: that rule's screen unit — `km/h`, `mm:ss` or `m`, or the token itself for `as_sent`.
- **No conversion requirement on the act.** The act no longer requires an active conversion from the unit; a mapping
  version still needs its conversion, or the same unit, at T4.
- **The board's sentence (G1b):**
  - it always names each athlete's expected number, so a mismatch is visible and the tick is a deliberate "they
    match";
  - there is no tick without both values shown;
  - for `as_sent` with no known screen format it says plainly: "GPEXE may show this rounded or in another unit.
    Compare the number: <value> <unit>.";
  - for `duration_mmss` it says that GPEXE may show hours for long values.
- **The rollback of v74** refuses once any T9i row carries a `source_unit_word`.

### 8.11 As built (G1b-2; the executor, 2026-11-17)

No migration: v74 holds the whole chain. Routes 8, O and 10 are `backend/src/sourceFieldObservationService.js`; GPEXE's
words are read by `backend/src/sourceUnitWords.js`. The screen is *Compare with GPEXE* on Source fields (the field's
detail). Tests: `backend/tests/source-field-observed-g1b2.test.mjs` (routes 8, O, 10), resolver tests 52 and 53 (the
word rule through the import, and the energy field end to end through the real routes),
`source-metric-extractors-7f` test 15, `source-metric-board-18-2` test 16, `frontend/tests/source-fields-observe-g1b2.actions.test.mjs`
and `e2e/tests/source-fields-observe.test.mjs`.

- **Route 8** (`GET /fields/:fieldId/observation`) takes `teamId` or `candidateId`, and `pair` (the pair's rank, as the
  board's) or `pairs=i,j` (two positions); with a team only, the team's newest saved session (of the last five, within a
  4 s budget, one always tried) that has a pair to compare. A position is the athlete's place in the import plan's list of the session (the import's own gates),
  never an id. The pairs are the board's rule (C117): two athletes OptiMove can name, two different non-zero values. The
  answer carries the word, its unit token and display rule, each athlete's raw value and the number GPEXE should show, and
  the comparison's hash (`g1.observation.v1`, over the bundle, the pair, the two names, the revision, the word, the rule
  and both raw values; never stored). It says `confirmable: false` with a reason (`words_disagree`, `word_unknown`,
  `expected_unit_differs`) where the tick would be refused, so the screen never offers it. A per-athlete field answers
  `409 unit_not_stated` (`no_unit_word`, the 8.2 sentence) before any session is read; a field with parameters
  `field_has_parameters`; a proven one `unit_already_verified`.
- **Route O** builds the comparison once, on plain reads, and compares its hash (else `board_changed`). After every lock it
  reads again only what the comparison stands on, without the bundle (the DB review's MEDIUM-1): the candidate's content
  hash, last check, binding and state, and the two athletes' names (else `board_changed`). Its locks: the per-user lock and the request record (runWrite), the revision FOR UPDATE (as an M2b
  act takes it, so the two serialize and the second answers `unit_already_verified`), the session's binding and team FOR
  SHARE, the rights users first, the team's club FOR SHARE; then T9, T9s, T9i (under the value statement bound), the T2b
  update and the two T8 rows, the keyed `source_metric_unit_observed` first. The recorded statement order is test 7.
  T9s's `pair_index` is the pair's rank. The answer is the revision and the comparison's id; a replay is the same.
  Refusals of the database (v65's candidate texts) read as `board_changed`; a lost right is the identical 404.
- **Other refusals:** a revision that carries other evidence (`documented`, `observed`) is `field_has_evidence`, never
  "already confirmed"; both athletes without a word is `no_unit_word`; a word is echoed in a refusal only when it is a
  seeded one.
- **The answer names GPEXE's value** (`gpexeName`, the key's last part), so the admin finds it on the GPEXE screen; the
  last question names it as the meaning.
- **A wrong word in an import names the field** (the Independent's LOW-1): the first value refused for its shape names
  its activation, and the preview's administrator sentence says which GPEXE field and which variable, so that one mapping
  can be switched off for the team; a coach reads the plain sentence.
- **Carry-over 5:** a word whose unit token is not the revision's expected unit is `unit_not_stated`
  (`expected_unit_differs`): two GPEXE accounts may send one name with different words.
- **Route 10** lists a field's comparisons (at most 50, newest first, `truncated` when there are more) with the team, the club, who, when, the word, the
  unit, and the two raw values only while they are kept (not removed, not past their date - also when the removal before
  the read fails). A club's admin gets the identical 404 and reads only the status words of 8.9b.
- **Rule (b):** the generic details extractor reads a value only when its word is one of the seeded words whose unit
  token is the mapping version's proven source unit (`energy` and `energy_std` both J/kg; `time` and `duration` both s);
  any other word, an unknown word, or a read without that context is `unexpected_unit` - a shape refusal that blocks the
  session, never a skip. The word -> token map is read once per plan from `source_unit_words`, and only when a generic
  details field is read (the importer's mapping context, the 7e preview, the club board), so a database before v74 is
  never asked. **Rule (c):** the value stays in the source unit; the version's conversion gives the canonical unit, and T6
  keeps the raw value (resolver tests 52 and 53: J/kg imported as kJ/kg).
- **The interim refusal of G1b-1 is removed:** `unitImportableCode`, `unit_not_importable` and their texts are gone; the
  club board reads a created details field through the word rule.
- **The architecture guards** (`gpexe-import-mapped-architecture-9b` test 3): the mapper's one spec now passes the unit
  context; the board's extracts pass their column's context; and the comparison service is the one other reader of the
  keyed values, with exactly one extract, the registry's own `genericObservationExtract` of the field.
- **Carry-over 3:** a `source_stated` revision is activated through M2 (v52's gate; route test 6) and through the platform
  board's save (resolver test 53, the Rukovodilac's addition: the energy field's last leg places the proven column onto an
  OptiMove kJ/kg variable for the team).
- **The club board after a tick** (the Rukovodilac's addition; route test 11): before route O a created field's column
  carries no value on the club's board; after it, the column is a normal proven column, its values read and placeable.
- **Carry-over 6, recorded (the *Rukovodilac*'s choice (ii)):** limiting `as_sent` to `parameter_kind 'none'` in the
  database twin belongs in the T9i insert guard's mapping branch, md5-gated; it is done by the next migration that touches
  that guard. The application already offers `as_sent` only for a field without parameters.
- **Recorded, not changed:** routes 8 and 10 run the removal of expired values before the read (a write in a GET, as the
  board does); the club check under the locks uses the team read before them (teams do not change club, D43).
- **Rule (b) at the mapping** (the code review's MEDIUM): T4 create, A1 and a club's copy refuse a created details field
  whose proven unit no seeded word carries (`409 unit_word_missing`, nothing written; route test 13), since every value
  of it would be a shape refusal and block the session. Route 8's `word_unknown`, and its `no_unit_word` for a details
  value, now say the field cannot be imported until OptiMove knows GPEXE's word for it. The club board's column reason
  is unchanged (a follow-up: the column carries no value, so it is never placeable).
- **Under the locks** route O reads again the candidate's metadata (not the bundle: no second parse while the locks are
  held) and the two athletes' names; a change is `board_changed` with nothing written (route test 12). v65's T9s trigger
  refuses a session whose bundle hash moved as a backstop.
- **Route O's COMMIT outcomes** go through the shared `runWrite`: a rollback with a lost answer is `503
  outcome_unknown` and the same key then writes once; a COMMIT with a lost answer is verified through the request record;
  a failed read after the COMMIT answers the write with `readError` (route test 14).
- **Route 8 without a session:** a pair without `candidateId` is `400 invalid_query`; a stored session the plan cannot
  walk is passed by, its error name logged only (route test 15).
- **Mutations:** 22 of the new guards; 21 killed. One is equivalent at the outcome: removing route O's under-lock
  bundle-hash comparison (v65's T9s trigger refuses the same write, still `board_changed` with nothing written). Removing
  the under-lock `evidenceRefusal` is killed by route test 8 (document first).
- **Recorded:** route test 9 covers the tick-first order against Unbind only; the Unbind-first order (the tick waits
  on the binding lock, then `binding_not_active`) is a follow-up test.
- **Not run:** PostgreSQL 17; 360 and 375 px; a physical device.

### 8.12 As built (G1b-3; the executor, 2026-11-18)

The *Rukovodilac*'s order after the Independent's GO on G1b-2: one small pull request, **no migration**.

- **The exact proven word (the Independent's LOW-1, the *Rukovodilac*'s decision).** A revision proven through route O
  names the word GPEXE sent: `T9i.source_unit_word` of its unit observation (`unit_observation_id`), final in v74 and
  never removed with the values. The importer's mapping context, the 7e preview and the board read it with the revision
  (`sourceUnitWords.provenWordSql`), and the extractor takes that word only: another word of the same token (energy /
  energy_std, time / duration) is `unexpected_unit`, the shape block with the sentence that names the field (resolver
  test 54: energy, time, duration and speed proven, imported as kJ/kg, min, min and km/h; each change of word inside a
  pair blocks the next session and nothing more is imported).
- **A document proof** (no stored word) keeps the token rule only where the unit has exactly one seeded word. A shared
  token reads nothing in the extractor, and T4 create, A1, a club's copy and the board save refuse it with `409
  unit_word_ambiguous` (the *Rukovodilac* accepted this on 2026-11-18); a unit with no word stays `unit_word_missing`
  (`sourceUnitWords.unitWordCodeOf`, shared by all of them; route tests 13 and 16, 7f test 15).
- **The way out is one the server takes** (the *Rukovodilac*'s point): route O refuses a revision a document already
  proved (`unit_already_verified`), and v74 holds a revision's unit proof as a document or an observation, never both
  (`num_nonnulls(unit_evidence_ref, unit_observation_id) <= 1`), so no word-only observation is added. The refusal says the
  real steps: retire the revision (L5), add a new unproven revision (L1), activate it (L3), then compare it with GPEXE.
  Route test 19 runs exactly those steps and then creates the version. L1, L3 and L5 have no screen yet.
- **The board (the Independent's LOW-2):** a created column without a readable word has the reason
  `unit_word_missing` or `unit_word_ambiguous`, carries no value and is not placeable; the save checks the word itself
  as well (route test 18: a save naming such a column is `409 unit_word_ambiguous`, nothing written).
- **The tests recorded in 8.11:** `unit_word_missing` on activation and on a club's copy (route test 16), the
  Unbind-first race against route O (route test 17: the tick waits on the binding lock, then `binding_not_active`,
  nothing written), and the duration and speed fields end to end (resolver test 54).
- **After the code review (NOT READY, one HIGH, two MEDIUM):**
  - *The sentence follows the caller* (HIGH): a club's admin may take none of L1, L3, L5 or route O, so its
    `unit_word_ambiguous` says "Ask a platform administrator to compare this field with GPEXE"; the platform's names the
    steps (server `unitWordMessage`, by the owner scope; the screen by the workspace; route test 20, frontend test).
  - *S1 checks the word too* (MEDIUM): an active version from before this rule is not switched on for another team
    (route test 21). The deploy transition: a read-only count of such versions before the deploy (runbook, expect 0).
  - *The save's own check* (MEDIUM): it runs over every row before the board's placement. The column's reason says the
    same from the same inputs, so each guard holds alone; removing either one is equivalent at the outcome, removing both
    is killed. The first mutation record called the save check killed; that was wrong (the mutation script counted a
    failed cleanup audit as a failed test) and the script now counts only a failed test.
  - LOWs: test 17 waits until the tick is seen waiting on a lock; the copy's `unit_word_ambiguous` is in test 16.
- **The proven word is read only for a created details field** (the full disposable run): read inside the importer's
  activations query it broke every plan on a database without v74's comparison tables. It is now read, like the words,
  only when a generic details field is planned (`sourceUnitWords.provenWordsFor` / `provenWordsOf`), in the importer, the
  7e preview and the board; the mapping context still never imports the registry (9b architecture test 3).
- **Mutations** (counted by failed tests only): 17 of the new guards, 15 killed. Two are equivalent at the outcome:
  removing the save's own check (the column's reason refuses the same row from the same inputs), and dropping the
  board's "no value" for a column without a readable word (the extractor reads nothing for it either).

### 8.13 As built (the readable Source fields list; the executor, 2026-11-18)

The owner's first real use of "Available in GPEXE" (relayed by the *Rukovodilac*): the rows showed GPEXE's word instead
of the unit, no zone fact, and names that are not values among the ones that can be mapped. One pull request, inventory
read and screen, **no migration**.

- **The unit, not the word:** the read joins v74's `source_unit_words` and returns `unit` (the seed's token, so every
  audience sees it); the row shows "m", "s", "W/kg"… A details word without a seed row reads "unit not stated by GPEXE";
  a per-athlete number reads "number (GPEXE sends no unit)".
- **The zone fact, never a range:** `zoneOf(name)` reads only the name (`athletesession<family>zone_<distance|time|events>_<n>`)
  and the row is titled "Power zone 4 · distance". Which range a number stands for is not proven: the details carry four
  power zones where `/more/` carries five and no numbering reproduces them (`docs/ai/gpexe-details-coverage-plan.md`), so
  no range is derived. A platform admin also reads the team thresholds ("team thresholds: 20, 25, 60, 75 W/kg"), from the
  `teamThresholds` of the newest stored session of each active binding: one set while they all agree, otherwise "team
  thresholds differ between teams" (`zoneThresholdsOf`; route test 22). A club never gets them (P1). Relative speed and
  the other families show the zone's name only.
- **Not values:** `isStructuralName` (`id`, `athlete`, `user`, `team`, …, `*_id`, `are_*_visible`, `is_*_visible`,
  `validity_*`, `*_timestamp`) joins `isStructuralField`, so route C refuses them and they are never creatable. Each row
  carries `isValue` (a field, or one route C would create); the screen folds the rest under one closed "Other names GPEXE
  sends (not values)". The collector still skips only the exact pairs it skipped before.
- **Readable and grouped:** the readable name and unit first, GPEXE's own name small under it, the counts last; values
  grouped by quantity (distance, time, power, energy, speed, acceleration, counts, other), zones together in zone order.
  The search finds a GPEXE name or a readable one. Grouping applies to the loaded page (200 names per page).
- **#601's LOW-1:** `unit_word_ambiguous` is worded by basis too - a platform admin working in a club's workspace is told
  to switch to the platform workspace (route test 23, frontend test R3).
- **Create field for several names at once: a follow-up, not built.** Route C takes one name per request with its own
  key, label and levels, and each lost answer needs its own *Check result*; a sequential batch is cheap to send but needs a
  per-name label and level choice and a per-row outcome (saved, refused, not confirmed). It is its own small screen change.

## 9. G2: the pinned set, the generic extractors and the club-board guard (as built, 2026-11-17)

The plan of section 5 ("G2") and the *Rukovodilac*'s GO of 2026-11-17. One pull request, **no migration**: v74 holds
everything G2 needs in the database.

### 9.1 The pinned set (`backend/src/sourcePinnedFields.js`)

- **What it is.** The GPEXE field names a check keeps in the stored snapshot besides the importer's own consumed fields.
  They come from T2a: the **active** gpexe / rest_v1 rows whose key is `athlete_session.<name>` (a row number) or
  `details.players.<name>` (a details `{unit, value}`). Never from a GPEXE answer; a retired field is not pinned.
  - Since v74 such a row exists only through route C, or as a seed.
  - A seeded name is already in the adapter's lists, so the union changes nothing for it.
- **Bounds:**
  - every name is an identifier (the projection's `METRIC_NAME`) and never a dangerous key
    (`DANGEROUS_FIELD_NAMES`, the one list route C, the inventory, the extractor registry and the set share). A stored
    key that breaks this rule is **left out** of the set and counted in one log line that names no key: one bad row never
    fails every team's check (security review of G2, MEDIUM). Route C never creates such a name;
  - at most 64 names per endpoint (`PINNED_FIELDS_MAX`). Route C refuses the 65th active field of a kind
    (`too_many_fields`), two creates of one kind serialized by a two-key transaction advisory lock (namespace
    719402689, the second key the kind's prefix). Route C is the only writer that makes a T2a row (no route makes a
    retired field active again), so the bound holds unless a row is written by hand. A set over the bound
    (written past route C) stops a check with `pinned_fields_too_many` before any GPEXE read; the code is
    administrator-only (a coach reads the sentence to contact an administrator). `pinned_field_invalid` stays for a
    malformed set handed to the adapter;
  - a pinned row value is a finite number or null; anything else (a text included) fails the answer closed as
    `field_shape_unknown` (code review of G2, LOW: data minimisation);
  - so route C creates a field only when every connection observed the name in the shape a check keeps: a number (row)
    or a value with its unit (details), or no value (`null`). Any other observed kind is `409 value_not_number`, nothing
    written (code review of G2's fixes, MEDIUM: a created text field would otherwise fail every team's check). A value of
    another shape GPEXE sends later still fails the check closed; retiring the field is the remedy.
- **Where it is read:**
  - **A check** reads it once, before its first request, and freezes it in its adapter. A field created while the check
    runs is not kept by that check; the next check keeps it.
  - **Retention** reads it with the first id page of every run. Until it is known, nothing is projected. A set refused
    as a whole (over the bound, only by a hand-written row) does not stop the run and projects **nothing** in it: every
    stored value stays as the check that read it kept it, the purge runs, the cursor stays, and the code is logged
    (database review of G2, MEDIUM, and the reviews of its fixes: no stored pinned value is discarded). A failed read is
    `projection_failed` as before.
  - **The supersede step** of a check's finalization reads it inside the finalization's transaction; a set refused there
    fails the check with `check_finalize_failed` before its COMMIT, nothing of it written.
- **Both proven and unproven created fields are pinned.** Their values accumulate for the comparison that proves them
  (G1b's route O and route 8).

### 9.2 The projection (`backend/src/gpexeRestV1Adapter.js`)

- **Athlete rows.** They keep `BUNDLE_FIELDS.athleteSession` plus the run's pinned row names (`athleteSessionFieldsOf`),
  with the same scalar rule. A pinned value of another shape fails the check (`field_shape_unknown`).
- **Details** (the whole session and every drill). They keep `DETAILS_CONSUMED_FIELDS` plus the pinned details names
  (`detailsFieldsOf`), each validated by `metricValue` and copied as `{unit, value}` only. A pinned value of another
  shape fails the whole-session read, or ends the drill set.
- **`projectStoredDetails(bundle, pinnedFields)`** keeps the same union. Without the run's set it keeps the consumed
  fields only, as before.
- **Nothing else of the snapshot changed:** no other key, no retention period, no hash rule.
- **MT-0** (`gpexeImportMapper.js`) compares every stored row field apart from the row's identity (`id`, `athlete`,
  `track`, `teamsession`). A created field that differs between two tracks makes them two recordings, never one
  (fail closed).
  - **Stated limit (code review of G2, LOW):** the legacy e03 path stores raw rows unprojected, so for it MT-0 now also
    compares fields such as timestamps, and two identical tracks whose other fields differ are no longer merged (the
    `multiple_tracks` anomaly). This fails closed, and production has no `GPEXE_API_TOKEN`; F3c4 retires that path.

### 9.3 The generic extractors (J12 amended; `backend/src/sourceMetricExtractors.js`)

- **The two entries.**
  - `gpexe/rest_v1/athlete_session.<name>` is one row number (`number`, no parameters).
  - `gpexe/rest_v1/details.players.<name>` is one details number (`unit_value_object`, unit word `number`, no
    parameters).
- **What they read.** Only the row's or the athlete's **own** property of that name (`Object.hasOwn`); they convert
  nothing.
- **What they refuse.** A name that is not an identifier, a dangerous name, a dotted name, another family or another
  source has no entry.
- **Unchanged.** The seeded keys keep their own entries; zones and events stay code.
- **Why no database read is needed.** A version needs its T2a revision (C90), and a version of an unproven field is never
  activated (v52's gate). So an unproven created field is never in the importer's plan, even though its values are in
  the snapshot.
- **Architecture guards:**
  - B7.8 now treats a quoted `details.players.` key literal and a comment line as what they are, not a lookup. B7.8 had
    failed on `main` since G1a, inside the known-failing adapter suite, because of route C's key prefix.
  - B7.8 pins the registry's one generic prefix and its two own-property reads.
  - B7.7c proves the mapper reads nothing of a drill athlete's details but the mapped generic name.

### 9.4 The club-board guard (`backend/src/sourceMetricBoardService.js`)

- **The rule.** A field created by route C (`created_by_user_id` set) whose revision is not proven is **never readable**
  on the board.
  - Its column has no raw value, and nothing of it is anywhere in the answer.
  - A placement on it is refused with no values.
- **Unchanged.** A created proven field and a seeded unproven field are shown as before.
- **The same gate on the 7e aggregate preview** (code review of G2, LOW): a mapping version of a created field whose
  revision is not proven (a unit set, the evidence not proven) answers `409 unit_not_proven` and its bundle is never read
  (`sourceMetricPreviewService.js`).
- **Where the comparison happens.** The platform's comparison that proves a created field is G1b's.

### 9.5 Effects, as decided

- **(a) The one-time "changed".** Once a created field carries values, the next check reads every session that has them
  as changed once.
  - **A pending candidate** is superseded by one that holds the new field.
  - **An imported session** gets a new candidate whose preview writes nothing. The inbox shows it as imported (nothing
    new), not as needing review, unless the session has a reason of its own.
  - Verified by the resolver suite's test 48; no fix was needed.
- **(b) No backfill.** A field's values are only in snapshots read after it was created. **Create the field, then find
  sessions again for a day that carries it.**
- **(c) Imported sessions are not rewritten.** A mapping switched on later does not write into an already imported
  session by itself; that needs an undo and a new import.

### 9.6 Tests (G2)

- `backend/tests/source-pinned-fields-g2.unit.test.mjs`: the set, the bound of 64 and its refusals, the union, both
  projections.
- `gpexe-import-credential-resolver` tests 41–50, end to end with the fake source:
  - 41: the pinned names kept, the unpinned ones not stored;
  - 42: a field created mid-check is not kept by it;
  - 43: a pinned value of an unknown shape (an object, a text) fails closed;
  - 44: exactly 64 pass, the 65th stops the check before any session read; a stored invalid name is left out;
  - 45: retention keeps the pinned names;
  - 46: the supersede path keeps them too;
  - 47: a proven, mapped created field is imported, and an unproven one is never activated and never imported;
  - 48: the inbox after the one-time "changed";
  - 49: a retired field is not pinned; the supersede step refusing the set fails the check with `check_finalize_failed`
    and changes nothing; retention with the set refused projects nothing (the snapshot untouched);
  - 50: the 7e preview of a created, unproven field is `409 unit_not_proven` with no value.
- `source-field-create-g1` test 14: route C refuses `constructor` / `prototype` and the 65th active field of a kind, and
  a second create held behind the first at 63 is refused (the bound's lock); test 15: a name observed as text, a
  boolean, a plain object, or as text through another connection, is `409 value_not_number`.
- `source-metric-board-18-2` test 15 (the board guard), `source-metric-extractors-7f` test 14 (the generic extractors),
  `gpexe-duplicate-tracks-mt0` (a created row field on two tracks), and the adapter suite's B7.7c and B7.8.
