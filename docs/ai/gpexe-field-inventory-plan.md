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

### 7.4 Open point: a wish list (not a slice)

"I want this" (a guarded, append-only wish per name) is **not built now** (the *Rukovodilac*, 2026-11-15). Its only user
would be the platform admin, and G1 gives the generic plain fields a real "add" path. A table for a personal to-do would
put another ★★ migration in front of G1 / G2.

After G2, if names remain that only code can support (zones, events), a wish list is reconsidered then.

### 7.5 The order

I2 (the read route, ★★ without a migration) → I3 (the screen) → the G1 contract.
