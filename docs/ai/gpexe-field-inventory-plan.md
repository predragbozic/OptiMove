# GPEXE field inventory: plan (no code)

| | |
|---|---|
| Status | Proposed by the executor on 2026-11-15, on the *Rukovodilac*'s order of that day. Plan only: no code, no migration. |
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
