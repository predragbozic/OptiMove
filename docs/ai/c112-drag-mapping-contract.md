# J18 — mapping by drag and drop (C112): one board per team, a stored two-athlete confirmation, and switching on system mappings (accepted ★★ contract)

This is the contract of decision C112 in `docs/ai/gpexe-metric-variable-mapping-discovery.md` (the *discovery document*). C112 records the owner's direction of 2026-11-01 for mappings after the pilot. This contract builds on phases 1–9: migrations v34–v50, the routes of J1–J13, the Mappings screen of J16 and the importer of J17. J14 and J15 stay reserved for 7h and 7i. J19 is proposed for C111 (editing a canonical variable), which is a separate contract after phase 9. This contract only names the points where C111 touches it.

| | |
|---|---|
| Status | **Accepted** by the owner on 2026-11-04 (C113, with Q1–Q14 answered as C113–C125) and **started** (C122, ★★). The record of C113–C125 (discovery document, item 113) placed its code after the U parts of J19 "unless the owner says otherwise"; the *Rukovodilac*'s brief to the executor of 2026-11-12 says the owner ordered a dedicated executor for it that day (relayed; the executor did not read the owner's turn), and 18-A2 is on the *Rukovodilac*'s GO of the same day. It was proposed by the executor on 2026-11-01 on the *Rukovodilac*'s order of that day, 20:33 UTC, from a discovery and design panel: five fact sheets, three competing designs, and three review lenses (owner intent, security and privacy, database integrity). **Refreshed by 18-A2 on 2026-11-12** against `cc20f632`: section 15 records what changed on `main` since `c930cde1`, the *Rukovodilac*'s decisions of 2026-11-12 (R1–R9 and the split of the gate into its own migration), and the slices as they are built. Where section 15 and an earlier section differ, section 15 wins; the earlier places it changes are marked in place. |
| Verified against commit | Sections 0–13 as proposed: `c930cde1` (below). **The delta `c930cde1..cc20f632` was checked by 18-A2 on 2026-11-12** for the files and migrations this document cites, and only for them (`.claude/rules/metrics-core-mapping.md`); section 15.1 lists every cited fact that changed and section 15.6 the references 18-A2 located again. A file and line reference in sections 0–13 is still to `c930cde1` unless it is marked; a reference in section 15 is to `cc20f632`. As proposed: `c930cde1`, the merge of PR #323 (documentation only), on `8fa0ea7`, the merge of PR #322 (9-0). Code is unchanged since `656cf88` except the 9-0 files and `backend/scripts/gpexe-backup-verify.mjs` with its test. The 9-0 files are `backend/src/gpexeImportService.js`, `gpexeImportPreview.js`, `sourceImportCredentialResolver.js`, `gpexeCheckTiming.js`, `backend/scripts/gpexe-undo-imported-session.mjs`, `frontend/gpexe-import-view.js`, `frontend/gpexe-import-data.js` and their tests. This document cites some of them and changes none. A J18 slice changes one of them only where section 2 says so: 18-4 adds the board's link to the Imports success line, and the dates Imports pre-fills when the board's after-save link opens it, in `frontend/gpexe-import-view.js` (sections 3.1 and 3.8). The removal of expired evidence values runs in its own module, not in `gpexeImportService.js` (section 5.8). Every file and line reference is to `c930cde1`, except references into the discovery document and `CURRENT_STATE.md`, which this PR also edits: those are to the lines with this PR's own changes in place. The production database was not read. Production facts are quoted from `docs/ai/CURRENT_STATE.md` as the owner reported them. |
| Mark | ★★ (C122). The triggers are 1, 2, 3 and 4 of `CLAUDE.md`, plus the five-point rule for a transaction with an external effect. Trigger 5 applies to the frontend slice unless an integration run against the real routes covers it. A mark, a phase entry and its "Start" line go into the plan only on the owner's direct word (`metrics-core-plan.md:432-435`). For a ★★ phase the owner approves the contract before any code (`:450-452`). |
| Owner decisions | Section 11.1 (Q1–Q14). Q1–Q11, Q13 and Q14 become C113–C123, C124 and C125 once decided; Q12 stays O16. **18-A2:** all are decided (2026-11-04); Q12 is C127. See section 15.2. They are written into section C of the discovery document before any code (the plan's rule A3, `metrics-core-plan.md:458-460`). |
| Decides | The owner decides Q1–Q14. The *Rukovodilac* decides R1–R9 (section 11.2). The *Nezavisni revizor* reviews this contract and every ★★ slice. |

**Decided 2026-11-04 (C113–C125):** the owner answered Q1–Q14. Q2 is softened by C114 (zones and thresholds are no longer document only), Q9 gets a delta (the admin may change a mapping while no value is written under it), Q11 is closed by C123. See the discovery document, section C, and section 15.2 here for what each answer changes in this document.

**Numbers (18-A2, replacing J14's renumbering note):** wherever this document says "v52" for J18's own migration, or "v51" for 7h's, it is out of date. 7h is v52 and the numbers up to v63 are taken. J18 now has **two** migrations (section 15.3), each named by the next free number at the time its pull request is opened and checked again against `origin/main` right before; this document calls them **M-A** (18-1) and **M-B** (the gate, with 18-3) and never assumes a number. The runbook file names follow the numbers they get.
**Amended by J15 (C132, accepted 2026-11-02; in force since v53's deploy on 2026-11-04):**
sections 3.6 and 7 (a mapping of a variable the team's club hides is not eligible), Q14 (answered, option one) and
section 4.4's lock order (the hide lock), each marked in place.

---

## 0. In short

**The owner's words** were written in the *Rukovodilac*'s chat on 2026-11-01. They are recorded with their event ids in C112 (`discovery:1227-1235`):

> „kada se budu radila mapiranja u buduce u klubovima, potrebno je da taj neko uradi prvi uvoz i dobije se tabela sa varijablama od strane kluba, admin izabere varijable koje hoce da mapira, za njih dobije vrednosti iz tabele nakon toga radi prevlacenja za dvojicu sportista (potrebno je da je mapirao na isti nacin i jednog i drugog. Znaci na osnovu potvrdjenog prevlacenja to ce biti dokaz. Nema potrebe za ovim smaranjima realno. Potrebno je samo da se ucita vrednost i za to da odredi. Znaci ono sto vidim i prevucem tamo tako je, Upustvo ce dobiti sta treba da vode racuna npr. Znaci napraviti userfriendly”
>
> — owner turn `7fca0a79`, 19:54:28 UTC

> „ovo izgleda dobro, mnogo je jednostavnije i prihvatljivije, smatram da ovako nesto treba da bude u nasoj aplikaciji.”
>
> — owner turn `fbeca2ea`, 20:02:15 UTC, after seeing the *Rukovodilac*'s sketch `https://claude.ai/artifact/MwSxWhUaBWdceyxy6iJJvZ` („Mapiranje prevlačenjem”). Section 3.11 quotes the sketch's texts.

**What the screen is.**
- There is one board per team. Only the team's club administrators get it.
- It opens from Imports after a successful search, and from Data configuration.
- It reads a session OptiMove has already stored. It never sends a GPEXE request.
- The left side lists the GPEXE columns OptiMove can read. Each shows its unit and the raw values of two athletes.
- The right side lists the club's own variables and OptiMove's system variables.
- On a computer, the admin drags a column onto a variable. Everywhere, keyboard included, the admin can tap the column and then the variable. On a phone, the variables open in a bottom sheet.
- The server proposes the conversion in words, taken from the one active unit conversion. A unit mismatch is refused with the sketch's sentence.
- For two athletes of the stored session, the panel shows three columns: what GPEXE sends, what OptiMove will store, and what the GPEXE screen should show. A short guide sits beside it.
- Active system mappings are already placed for the team. The admin may remove them. Q9 recommends not placing again one switched off on this binding by an administrator.
- Each new column gets its own tick, *Matches GPEXE for both athletes*, given in the panel while its two athletes' values are on screen. A column kept unticked reads "Not compared yet · *Compare*" on the board. One button, *Save and switch on for <team>*, opens a review card that lists every new column with those values and its tick. The card's own send is enabled only when every new column is ticked. It sends every placement with one request key, in one transaction.
- The stored record is the evidence: who confirmed, when, which session, and the two athletes' values. No document is needed.

**What stays as it is.**
- The source-field catalog (T2a / T2b) stays global, platform-only and write-once. A club's confirmation never writes to it and never counts for another club.
- A club maps only a field whose revision is active and verified: its unit and meaning are proven. So the version's source unit is always the revision's proven unit. The fact guard (`v34:1563-1566`) and 9-B's `source_unit_mismatch` stay unchanged.
- A club uses a system variable only through its active system mapping. C61 stays: no club mapping ever targets a system definition.
- Every write but one has a real acting user (v35). There is no system actor. The one exception is the scheduled removal of expired evidence values, which only nulls values past their date, as v32 removes GPEXE names (section 5.8). Nothing is switched on for a team that is bound later.

**What is new in the database.** Two migrations, M-A and M-B (section 15.3; as proposed, one migration "v52"). Together they add:
- three append-only, owner-keyed tables for the evidence: the act, its session, and its rows with the values;
- typed foreign keys from the evidence to the field revision, the mapping version, the binding and its connection, and the check;
- values the server recomputes from the stored snapshot, never sent by the client;
- no athlete id, GPEXE id, name, date of birth or free text in these tables;
- value columns and a per-row random salt, removed together 90 days after the confirmation by a scheduled purge with no actor, or earlier on request. The digest the database computes survives the removal, but with the salt gone it can no longer be tested against guessed values;
- a database gate, in M-B: a club admin can activate a club version of a field without parameters only with a matching checked row, or with v53's copy link (section 5.5, C124, C125).

**What is self-service at once.** A club can map every field whose revision is active and verified. Today that is `total_time`, `total_distance` and `max_v`, as the owner reports (`docs/ai/CURRENT_STATE.md:2658-2662`). A club sees every other column with the reason it cannot be placed. Questions (a) and (b) give the owner options to make the platform's own confirmation lighter.

**Questions (a)–(d), as recommended** (section 10):
- **(a)** The meaning act stays a platform act on the global revision. For a field without parameters, the platform may base it on a stored observation on the same board: "this field is the GPEXE screen column X". No document is needed then. Zones and thresholds keep their document. A club's drag needs no meaning act.
- **(b)** The platform still confirms every global field. The first club admin's confirmation counts only for that club's own mappings.
- **(c)** A club checks two athletes of one stored session. A global confirmation needs two sessions with two athletes each.
- **(d)** The evidence goes into the new owner-keyed, append-only store. Exact values are shown only to the two admin audiences. Values are removed 90 days after the confirmation by a scheduled purge, as v32 removes GPEXE names, or earlier on request by an audited act.

**When.** As proposed: code starts once the owner has accepted this contract and decided Q1–Q11, Q13 and Q14, after phase 9 ends, and after 7h is merged; O16 (Q12) before 18-3; Q11 before the first real confirmation. **All of these are met** (section 15.1): the contract is accepted and started (C113, C122), 9-B and 7h are merged and deployed, O16 is C127 and Q11 is C123 (it opens again if a minor athlete is ever added).

---

## 1. What exists (verified at `c930cde1`)

`v34` means `migrations_v2/202610121000_training_load_v34_source_metric_mapping.sql`. Other migrations are named by their number in the same folder, always the `training_load_vNN` file: `v42` is `training_load_v42`, not one of the eight `tests_v42_*` files.

### 1.1 The source-field catalog is global, and its proof belongs to the platform

- **T2a has no owner column.** Its identity (system, family, key) is unique across the whole system, so one row serves every club (`v34:259-295`, the unique key at `:293`).
- **T2b holds one proof per revision.** The proof is the proven unit, the bound unit and the operator, plus who, when and which reference for the unit and for the meaning. T2b has no owner and no club (`v34:357-472`; its comment says "Never a value", `:478-479`). A field has at most one active and one draft revision (`:473-476`).
- **When a revision counts as verified.** `verified` holds exactly when the unit, the meaning and, for a parameterised field, the operator are proven (`v34:449-452`).
- **Every reference is a `docs/…#anchor`** (`v34:86-94`; C40, `discovery:422-428`). It is checked only by its format. Its document must be merged before the act (C95, `:809-811`).
- **A proof is written once.** The status only rises. A correction is a new revision (`v34:529-548`; C91, `discovery:795-799`; the lifecycle L1–L5, `backend/src/sourceRevisionLifecycleService.js:1-20`).
- **Who may act.** Only an active platform admin in the platform workspace may make the unit and meaning acts (`backend/src/sourceFieldVerificationService.js:88`; C94, `discovery:806-808`).
  - In the database, an actor with no club has the basis `platform_admin` or none at all (`v35:82-110`).
  - The T8 rows of both acts carry the `platform_admin` basis and a reference (`v48:307-310`).
- **The seed.** It holds the nine fields of v34 and v42's open-top zone. Each has revision 1 active, status `observed`, and no proven unit (`v34:1778-1815`; `v42:73-86`).
  - As the owner reports, TIME, TotDist and SPEEDmax now show unit and meaning confirmed, with "Evidence: Verified". The other seven stay *Observed* (`CURRENT_STATE.md:2658-2662`). The database was not read.
  - Burst and brake have no parameters, and their meaning is unconfirmed (`v34:1811-1814`).
- **Ten fields have an extractor** (`backend/src/sourceMetricExtractors.js:246-257`). An extractor returns the value in the source unit and never converts it (`:10-12`).

### 1.2 Mapping and switching on

- **T3, the mapping identity.** A club mapping may target only a definition of the same club. A system mapping may target only a system definition (`v34:652-657`; C61, `discovery:586-589`).
  - The service answers `409 target_scope_mismatch` (`backend/src/sourceMetricMappingService.js:922-925`).
  - `GET /targets` lists only the workspace's own owner scope (`:577-588`).
  - Each (field, variable) pair has at most one mapping (`source_metric_mappings_pair_key`, `v34:628`).
- **T4, the mapping version.** It is created only on a draft or active revision with a proven unit, and its source unit must be the revision's (`v34:1053-1068`; C27, `discovery:357-358`).
  - The server derives the factors from the single active `unit_conversions` row. If there is none, it refuses `conversion_unavailable` (`sourceMetricMappingService.js:1008-1017, :1085-1089`).
- **Submitting.** Both admin bases may submit (`v34:1155-1167`).
- **Activating.** It needs a revision that is active and verified, and the canonical version must still be current. Only `platform_admin` may activate.
  - Evidence: `v34:1168-1192`; the basis CHECKs at `v34:811-818`; T8's `mapping_status` branch at `v48:319-325`; `mayTransitionMappings` at `backend/src/sourceMetricAccess.js:38-40`.
  - A1 may also start the version on 0–50 listed bindings in the same transaction (`sourceMetricMappingService.js:1367-1518`).
- **T5, the activation on one team binding.**
  - A club admin may start and end activations on its own club's bindings, with system mappings or its own club's mappings (C106, `discovery:1123-1144`; `v48:84-96`; `sourceMetricAccess.js:46-61`).
  - The requirement is `required` or `optional`, with no default (C23, `discovery:352`; `backend/src/sourceMetricActivationSteps.js:19-20, :55-72`).
  - The facts of a start never change afterwards (`v48:198-206`).
  - A binding may hold one open activation per field and parameters, and one per variable and level (`v34:1337-1345`; `sourceMetricActivationSteps.js:42-47, :138-158`).
- **C9.** While an active mapping version pins a variable's current version, the variable gets no new version (`v34:1222-1240`).
- **T6.** A fact's source unit must equal the revision's proven unit and the version's (`v34:1563-1566`).
- **Nothing is ever activated automatically today.** The rules are C8 (`discovery:326-327`), C33 (`:375-380`), D6 (`:1558-1559`), and section G's "N explicit rows, each audited, never a future binding" (`:1987`).

### 1.3 The actor guards and the audit

- **v35 sets one acting user per transaction** and derives the user's basis live. There is no system actor (`v35:66-117`).
  - Each audit row must follow its own write in the same transaction, with the version already at the row's target status (`v35:216-288`).
  - At COMMIT, deferred links require an audit row for every T3 insert, T4 insert and T4 transition (`v35:290-340`).
  - A write inside a savepoint is refused (`v35:47-50`).
- **v43's G1 and G2** check that a replacement label is true and that transition times are consistent (`v43:12-27`).
- **T8, the audit table.**
  - Its list of actions is closed (`v34:1677-1683`). It has no value-bearing column (`v34:1743`; D10, `discovery:1766-1771`).
  - Each operation has exactly one keyed request record (`discovery:1758-1765`).
  - Every action except the mapping actions is checked by one revision guard. v50 checks its md5 before replacing it (`v50:84-99, :211-346`).
  - A club-admin row must name a club mapping, except activation rows, which v48 widened (`v34:1747-1753`; `v48:339-362`).
- **`runWrite`** provides the per-user advisory lock, the request record, the actor setting, the statement and lock bounds, and a bounded COMMIT verified by the request key. A replay answers only after the right is checked again (`sourceMetricMappingService.js:763-847, :776-780`).

### 1.4 The values a board can read today

- **The 7e aggregate preview is the only value read.** Per level it gives a count, a minimum and a maximum.
  - It never returns a row per athlete or an id, and it gives no minimum or maximum for fewer than 3 athletes (`backend/src/sourceMetricPreviewService.js:1-24`; `backend/src/sourceMetricPreview.js:10`; OD2 and OD3, `docs/ai/phase7e-aggregate-preview-contract.md:36, :50-51`).
  - It needs an existing mapping version (`backend/src/routes/sourceMetrics.js:225`).
- **Its loading half** is reusable. It has the scope query, the size bound (16 MiB, `sourceMetricPreviewService.js:34`), and the `snapshot_expired` and `candidate_source_mismatch` refusals (`:58-129`).
- **`gpexeLevelValues`** runs the import's own gates with one extractor and drops the athlete ids (`backend/src/gpexeImportMapper.js:419-441`).
- **`convertAtStorageScale`** applies D8 exactly at scale 9 (`sourceMetricPreview.js:33-56`). `source_metric_value_matches` checks the same rule in the database (`v34:156`).
- **The stored bundle** keeps only projected fields (`backend/src/gpexeRestV1Adapter.js:88-97`). Its numbers are SI whatever the account's `user_units` (`gpexeImportMapper.js:12-14`). For the pilot fields GPEXE sends bare numbers with no unit word (`gpexeRestV1Adapter.js:90`). The seed's note that the unit word "number" is a shape concerns burst and brake, not these fields (`v34:1811-1814`).
- **Retention of stored snapshots.**
  - An unapproved snapshot lives 30 days after it was last seen, and 90 days after an import (`backend/src/gpexeImportService.js:35-36`). The purge clears `raw_bundle` (`v22:345-360`).
  - Once imported, a candidate row is never deleted; any other candidate row may be (`v22:296-303`).
  - A check row is never deleted (`v24:336`).

### 1.5 Names, audiences and logs

- **GPEXE names exist only in the v32 identity rows.** They are admin-only (`backend/src/gpexeAthleteIdentityService.js:138-149`) and live 14 days (`v32:88`).
- **Coaches already see per-athlete converted values in Imports** (`backend/src/gpexeImportAccess.js:3-7`). J17's three-level projection is not built yet (`docs/ai/phase9-importer-mappings-contract.md:388-414`).
- **No read returns who verified a field** (`sourceMetricMappingService.js:478-493`).
- **The metrics router** sets `no-store` on every answer, and every `404` has one body, whatever was missing or not visible (`routes/sourceMetrics.js:35-78`). It logs only the method, the route and an error code (`:74`).
- **A club workspace** exists only for a user's own active `club_admin` role (`backend/src/workspace.js:46-57`).

### 1.6 The screens

- **J16's guided flow has four steps as built** (`frontend/metric-mappings-view.js:120, :132`). Its contract still says three (`docs/ai/phase8-mappings-screen-contract.md:20, :128`). 18-A records the four steps as built in J16's contract. 18-4, the first J18 PR that touches the frontend, corrects the comment in `frontend/metric-mappings-data.js:3`.
  - The tap pattern uses buttons with `aria-pressed` (`frontend/metric-mappings-view.js:167, :189`), with their handlers in `frontend/metric-mappings-actions.js:807-841`.
  - Conversions are described in words (`frontend/metric-mappings-data.js:221-226`), and refusal sentences come from `targetStatus` (`:275-314`).
  - J16's screen never shows an athlete (`phase8-mappings-screen-contract.md:318, :376-379`).
- **Dragging is offered only where `(pointer: fine)` and `(hover: hover)` match.** Nothing drags by keyboard (`frontend/data-config-drag.js:1-26`). The precedent is PR-2 (`metrics-core-plan.md:1427-1430`).
- **The frontend rules** require 16 px inputs, 44 px targets (drag handles included), no inert mobile controls, checks at 360/375/390 px, and a generation counter (`.claude/rules/frontend.md:24-42, :59-62`).
- **Entry points that already exist.**
  - The Imports success line, `renderFoundHtml` (`frontend/gpexe-import-view.js:441-451`).
  - The admin signal `identityViewer` (`frontend/gpexe-import-data.js:1263-1265`).
  - The pattern for a Data configuration card (`frontend/data-config-home-view.js:104-109`).

### 1.7 The pilot

- **Unit evidence.** The C97 unit evidence used one session with 13 athletes, a deviation the owner accepted (`docs/ai/gpexe-c97-unit-evidence.md:17-27`). The athletes were paired by distance, with no names (`:50`).
  - The GPEXE screen showed `dur` in mm:ss (raw ÷ 60, within 1 s), `dist` in metres (to 0.1 m) and `max sp` in km/h (raw × 3.6, to 0.1) (`:90, :105, :142`).
  - The screen rounds seconds inconsistently (`:146`).
- **Meaning evidence.** It comes from the GPEXE 6 handbook under O7 (`docs/ai/gpexe-c97-meaning-evidence.md:15-27`). The handbook's page 11 says the units the GPEXE app shows are each user's own setting (`:66-67`).
- **M6 steps 2–5 are done, as reported.** Three system mappings are active and switched on for the First team, each Required (`CURRENT_STATE.md:2665-2673`; J17 section 12.3, `phase9-importer-mappings-contract.md:942-945`).
- **O10.** The owner wrote „Ne treba pravni osnov”: no legal basis is needed for the production-use gate. This is the owner's own assessment, not a legal confirmation (`phase9-importer-mappings-contract.md:905-911`).

### 1.8 Not built, or not verified

**18-A2:** this list is as of `c930cde1`. 7h, 7i and 9-B are since built and deployed (section 15.1); C111's contract is still not written.

- **Not built:**
  - 7h (J14) and 7i (J15);
  - 9-B, the importer reading T5 (`phase9-importer-mappings-contract.md:77`). 9-0, the step before it (switch conditions 2 and 3), is merged as PR #322 (`8fa0ea7`) and deployed (`CURRENT_STATE.md:2691-2700`);
  - C111's contract.
- **Not verified:**
  - Whether the v35 and v43 guards accept, in one transaction, a T3 insert, a T4 insert, the submit, the activation and the T5 starts with their audit rows interleaved. Section 4.3 is designed against those guards, and PR 18-3 starts with a test that proves it (R8).
  - The GPEXE handbook itself, which is not in the repository.
  - The production state (not read).

---

## 2. Pull requests

**18-A2:** the table below is the split as proposed. The split as it is built, with two migrations and without 18-P, is section 15.3 (the *Rukovodilac*'s R1 of 2026-11-12).

| PR | Content | Migration | Reviewers (`CLAUDE.md` matrix) | External-review triggers | Merge path (proposal) |
|---|---|---|---|---|---|
| **18-A** | This contract, a J18 row in section J of the discovery document, and an "As built" note on J16's step count (documentation only) | — | `code-reviewer` on the whole document; `db-reviewer` on sections 4–5; `security-reviewer` on sections 4, 6 and 7 | 1, 2, 3, 4 (on its content) | Both ★★ GOs, then the standing merge order. The status stays Proposed until the owner accepts the contract (Q1). C113–C125 enter section C only as each is decided. |
| **7h (J14)** | Prerequisite with its own contract: a club admin approves, disables and replaces its own club's versions (C108). J18 needs from it only the activation basis: the T4 `activated_basis` CHECK (`v34:811-813`), the transition guard's `source_metric_require_platform_admin` call on activation (`:1192`), and T8's `mapping_status` branch for `needs_review → active` (`v48:322`). The disable basis, the replacement, the version-driven T5 ends (`sourceMetricActivationSteps.js:222-252`) and v48's club-less basis for those ends (`v48:386-387`) are J14's own scope. If Q13 chooses option two, J18 also needs J14's replacement, disable and version-driven end bases: the replacement branch (`v48:324-325`), the disable basis (`v34:816-818`, `v48:323`) and the version-driven end path (`sourceMetricActivationSteps.js:234`, `v48:386-387`). | **v51** if nothing comes between | J14's own | 1, 2, 4 | The standing order for migration PRs |
| **18-1** | One migration with all of J18's schema: T9, T9s and T9i with their guards; the T4 gate; T8's new column and actions; T2b's observation columns (only if Q2 and Q3 choose them); the expiry and removal rules, with the removal function, its purge marker and the salt; rollback, preflight, post-check and runbook | **v52**, the next free number after 7h | `db-reviewer`, `security-reviewer` | 1, 2, 3, 4 | The standing order for migration PRs: both ★★ GOs; the owner's order naming the file and its sha256; the preflight on the same day; the owner's „da” before the deploy |
| **18-2** | Backend reads: the board, one placement, and the evidence; the board and evidence reads run the removal function first (section 5.8); the board's name reader (section 4.2); the pair rule; the display registry | none | `code-reviewer`, `security-reviewer` | 2 | Both ★★ GOs, then the standing merge order |
| **18-3** | Backend writes: the save (section 4.3); the scheduled removal of expired values, in its own module that `server.js` starts (section 5.8); route 7; and the erasure | none | `code-reviewer`, `security-reviewer`, `db-reviewer` (transactions and locks) | 2, 3, 4, and the five-point rule | Both ★★ GOs, then the standing merge order. Only after 7h is merged and O16 (Q12) is decided. Q11's answer gates the first real confirmation through it. |
| **18-P** | Only if Q2 and Q3 choose the observation form: the platform's *Confirm a column for all clubs*, with its routes (8–10) and screen | none (its schema is in 18-1) | `code-reviewer`, `security-reviewer`, `db-reviewer`; plus `mobile-qa` and `ux-design-reviewer` for the screen | 2, 4 | Both ★★ GOs |
| **18-4** | Frontend: the board, the panel, the phone sheet, the entry points (the Imports link, and the dates Imports pre-fills after a save, change `frontend/gpexe-import-view.js`, a 9-0 file; sections 3.1 and 3.8), the history and the guide | none | `code-reviewer`, `mobile-qa`, `ux-design-reviewer`, and a narrow `security-reviewer` pass on how values and names are rendered | 2; and 5 unless the real-route run of section 9.4 covers the flow | The *Rukovodilac*'s GO (★ proposed; a mark needs the owner's direct word, `metrics-core-plan.md:432-435`) |
| **18-E** | Facts after each merge: CURRENT_STATE, the J18 row "As built", and the decisions as built | none | `code-reviewer` | — | The standing merge order |

- **Why one migration.** All of J18's schema is in 18-1, so T8's md5-checked revision guard and v48's actor guard are each replaced only once.
- **The plan.** No J18 slice changes the plan. Its phase entry, its ★★ mark and its "Start" line wait for the owner's direct word (Q10).
- **The freeze.** No J18 code is merged or deployed during the M6 freeze (J17 step 9, `phase9-importer-mappings-contract.md:680-682`).

---

## 3. The flow

### 3.1 Where the board opens

**18-A2:** Imports was rebuilt after this section was written (J19's U1–U6). The board's entry from Imports is the setup stepper's *Variables* step; section 15.4 says how, and what stays of U4's button.

- **From Imports.** After a successful search, the source card's success line (`renderFoundHtml`) gains *Map this team's GPEXE columns*.
  - It is shown only to an administrator, using the existing `status.viewer.identityAdmin` signal.
  - It appears only in a club workspace.
  - Coaches never see it. Imports is shared with them (`frontend/training-load-view.js:1545-1551`), so the server answers the identical 404 anyway.
- **From Data configuration.** A card *Map by drag and drop* is shown in a club workspace, beside *Mappings*.
  - The board first asks *Which team?*. It lists only the club's active teams with an active GPEXE binding of the club's connection, each as "<team> — linked to GPEXE team <n>" (J16 R6). The list comes from the source-connections read J16 already uses (`frontend/metric-mappings-data.js:17`).
  - With no such team it reads: "No team of your club is linked to GPEXE yet. Link one in Settings > Source connections."
  - From Imports the team is already chosen.
- **What "first import" means.** In the owner's words „prvi uvoz” is a search that stored a session. An approved import is not needed. After 9-B, a session without activations is blocked `no_mapped_values` but stays stored, so the board can read it (`phase9-importer-mappings-contract.md:269-270`).

### 3.2 Preconditions and empty states

| State | What the admin sees |
|---|---|
| The team has no active GPEXE binding of the club's connection (a tampered or foreign id; *Which team?* lists only bound teams) | The identical 404 sentence: "Map by drag and drop is not available in this workspace." |
| No team of the club has an active GPEXE binding (from Data configuration) | "No team of your club is linked to GPEXE yet. Link one in Settings > Source connections." |
| No stored session through the binding (**18-A2:** an undone import, `import_undone_at` set, does not count; v57) | "No saved session yet. Run a search in Imports first." |
| The chosen session's snapshot has expired (30 days after it was last seen) | "The saved session is no longer available. Run a new search in Imports." No GPEXE request is sent. |
| Fewer than two athletes OptiMove can name, with different, non-zero values (R6; **18-A2:** the distance option that stood here is rejected by the *Rukovodilac*'s R6 of 2026-11-12) | "OptiMove needs two athletes it can name. Link the team's athletes in Imports (Link athletes) so OptiMove can name two of them." This links to Link athletes. Loading GPEXE names, which also loads dates of birth, is not offered here (section 6.4). |
| No column can be placed | Every column is shown with its reason (section 3.3). |
| Loading, a write in flight, or a result not confirmed | Every act except *Check result* is off, as in J16 section 8. |

### 3.3 The board

- **One stored session.** By default the board uses the newest one that can be used: its last check succeeded through this binding (`gpexe_import_checks.source_binding_id`, `v31:71-72`), as the importer requires (`phase9-importer-mappings-contract.md:175-179`), and it passes the import's gates. A *Session* chooser reuses J16's session picker and its badges (`phase8-mappings-screen-contract.md:295-310`). It reads only the candidates list route.
- **Changing the athletes or the session** asks first: "Your N placements will show two other athletes. Compare each one again in GPEXE." On confirm, every placement is read again, every tick is cleared (section 3.7), and each row is marked *Compare again*. After the last pair the board says: "No other athletes have values for all your columns."
- **Left: the GPEXE columns.** There is one row per field with an extractor.
  - Each row shows its label, its key under *Technical details*, and its unit.
  - The unit is shown as "GPEXE sends values in <unit>" only when the revision's unit is proven. Otherwise the row says "Expected <unit>, not confirmed". GPEXE sends no unit word (section 1.4).
  - Each row shows the raw values of athlete A and athlete B, in the source unit.
- **Columns that cannot be placed** stay in the list, grey, with one reason:
  - "OptiMove has not confirmed this column yet. Ask OptiMove support to confirm it." The revision is not verified (section 10, (b)).
  - "Map zones and thresholds in Mappings." The field has parameters, and J16 stays the path for it.
  - "OptiMove cannot read this column yet." There is no extractor.
  - "These two athletes have no value here." The admin can choose *Other athletes*.
- **Right: the variables.** First the club's own active variables, then OptiMove's system variables, each with its unit.
  - A system variable is a target only where an active system mapping of a column on the board fills it (C61). Elsewhere it reads "OptiMove does not fill this variable from this column. Choose another variable or create your own."
  - Last comes *Create a variable in <unit>* (section 3.5).
- **Rows already on.** A variable that is already switched on for the team shows "On for <team>", with *Switch off* as a secondary act. *Switch off* is S2: one confirmation, its own request key, outside the save.

### 3.4 Placing a column

- **On a computer** that matches `(pointer: fine)` and `(hover: hover)`, the admin drags a column onto a variable.
  - A new drag module follows `data-config-drag.js`, with its own MIME type `application/x-optimove-source-field`.
  - The possible targets get a dashed outline, and the target under the pointer a solid one, as on the Categories screen.
- **Everywhere, on a computer too**, the admin can tap the column and then tap the variable.
  - The column is a button with `aria-pressed`, as in J16's tap pattern.
  - After the column is chosen, the variables are ordered: *Same unit* first, then *Converted from <unit>*, then those that cannot be used, each with its reason (`targetStatus`).
- **By keyboard**, Enter or Space selects the column. Focus then moves to the first usable variable, which is announced. Tab moves among the variables, and Enter places the column. Escape cancels.
- **On touch nothing drags.** No grip and no draggable attribute is drawn (`.claude/rules/frontend.md:36-39`).
- **Each placement** asks the server for one placement (section 4.2, route 2). It opens the panel of section 3.5 below the board, or as a sheet on a phone.
- **Changing a placement.** Every new placement has *Remove*. Placing a column that is already placed moves it. Dropping onto a variable that already holds a new placement asks "Replace <column> with <column>?". The tap path works the same way.

### 3.5 The panel: the conversion and two athletes

- **The proposal**, in words, from the one active unit conversion:
  - "Proposed conversion: s → min (÷ 60)", or "No conversion" for equal units;
  - with no active row (the database allows at most one per pair, `v34:712-713`), the panel shows the refusal.
- **The refusals**, each a sentence with its code under *Technical details*:
  - the unit mismatch, using the sketch's sentence (section 3.11);
  - a level the variable or the field does not allow;
  - a system variable that this column does not fill;
  - "This column already fills <variable> for your club. Change that in Mappings." (C33);
  - a stored value outside the variable's limits: "This value is outside <variable>'s limits (<min>–<max> <unit>). This usually means the variable or its unit is wrong. If you are sure they fit, choose other athletes." A row like this cannot be saved with this pair.
- **The two athletes.** The table has the columns *Athlete · GPEXE sends · OptiMove stores · The GPEXE screen should show*.
  - *GPEXE sends* is the raw value and its proven unit.
  - *OptiMove stores* is D8 at scale 9, in the variable's unit.
  - *The GPEXE screen should show* uses the display registry (R5). The default is the unit the C97 comparison saw: mm:ss for time, metres to 0.1 for distance, km/h to 0.1 for speed. A small choice above the table lets the admin set the unit their own GPEXE screen uses, from the units the handbook's page 11 lists. GPEXE shows each user's own units. The chosen unit is sent with the row as `displayUnit`, and `placementHash` covers it (sections 3.7 and 4.2).
- **The athletes' names.**
  - They come from the OptiMove link, or from a valid v32 GPEXE name. They are shown live to the admin and never stored.
  - If fewer than two athletes can be named, the panel refuses and points to Link athletes (section 3.2), as R6 recommends. R6's other option names an athlete by the value the GPEXE screen shows for a proven distance column, as the C97 sitting paired athletes by distance. **18-A2:** that other option is rejected (R6, 2026-11-12): the refusal is the only form.
  - The client never sends an athlete id. *Other athletes* asks the server for the next pair by its index (section 6.1).
- **The tick.** Under the table sits the row's own checkbox, *Matches GPEXE for both athletes* (section 3.7).
- **The guide** sits beside the table: *What to watch for* (its text is in section 3.11).
- **Keeping or cancelling.** *Keep this placement* closes the panel and keeps the row, with its tick. A row kept without its tick reads "Not compared yet · *Compare*" on the board (section 3.7). *Cancel* removes this placement.
- **A missing variable.** *Create a variable in <unit>* opens the existing M3-0 create form in a sheet, prefilled with the column's unit (`POST /variables`). The board keeps every placement. On return the new variable is in the list and the open placement points to it, still unsaved.

### 3.6 Pre-placed mappings

- **Which rows are pre-placed.** Every system mapping that is eligible for the team (section 7) is already placed when the board opens. Its badge reads *OptiMove mapping*. Q9 recommends one exception: a system mapping switched off on this binding by an administrator is not placed again. That is a *Switch off* (S2) or a replacement on the board. It reads "Switched off by <name> on <date> · *Add*". An end that the platform causes by disabling or replacing a version (A2, the pinned step, a G1 replacement) does not count (section 7).
  - R4 decides whether the club's own active mappings are pre-placed on another team's board in the same way, with the badge *Your club's mapping*.
  - **Amended by J15 (C132, accepted 2026-11-02; in force since v53's deploy on 2026-11-04):** a system
    mapping of a variable the team's club hides is not eligible, so it is not pre-placed (section 7).
- **What the admin can do.** Each row has *Remove*. It shows the two athletes' values like any other row, but they are not stored (section 5.3). It needs no comparison: its field is proven globally, and its version is active (a system version; under R4, the club's own).
- **Collisions.** A row that would collide with an open activation on the team (same field and parameters, or same variable and level) reads "Replaces <old column> → <variable> for <team>". It is not pre-placed silently. The admin may keep or remove it. After the save it reads "<old column> → <variable> is switched off for <team> and replaced."

### 3.7 Saving

- **One tick per new column.** In the panel, each new placement (a placement the admin made, not a pre-placed row) has its own checkbox, *Matches GPEXE for both athletes*, 44 px tall, beside its two athletes' values.
  - It can be ticked only while the panel shows that row's values for the current pair. A tick can be given nowhere else. Once given, it stays until one of the changes below clears it.
  - The tick clears when the row changes (another column, variable or display unit), when the pair changes, when the session changes, or when a `board_changed` answer names the row. The row then reads *Compare again*.
  - A new row kept without its tick reads "Not compared yet · *Compare*" on the board, as a row to compare again reads *Compare again*. *Compare* opens the row's panel.
  - Pre-placed rows have no tick: they need no comparison (section 3.6).
- **One requirement per row.** Each row has a visible toggle *Required*, prefilled as Q8 decides; the recommendation is Required. Its meaning appears beside it, in C110's words (section 8.3).
- **One primary button:** *Save and switch on for <team>*. It opens a review card whenever the board holds at least one row. With no row it is off and says "Place a column first." The review card names:
  - the source and the team with its link ("<team> — linked to GPEXE team <n>", J16 R6);
  - each new row (column → variable, conversion, levels, requirement), with its two athletes' three values (GPEXE sends / OptiMove stores / the GPEXE screen should show) and its tick. An unticked row has *Compare*, which opens its panel;
  - the pre-placed rows in their own group, *OptiMove mappings (no check needed)*, and under R4 *Your club's mappings (no check needed)*, each with its requirement;
  - every replacement.
- **The review card's send** is its own *Save and switch on for <team>*. It is the only gated control: it is enabled only when every new row is ticked, or when there is no new row. While it is off, it names the new columns still unticked: "Tick every new column to save: <column>, <column>." Each of them has *Compare* in the card.
- **What the save sends.** The review card's send makes one `POST /confirmations`: a fresh request key, every row, and the session and pair it was read for. Each new row carries `checked: true`, its own tick. At most 20 rows are sent (R7). No value, source or target unit, factor, note or reason is sent; only the display-unit code each new row was compared in.
- **Leaving.** The board uses J16's hooks (section load, leave guard, before-unload, discard, workspace switch reset; `phase8-mappings-screen-contract.md:100-101`). Leaving with unsaved changes asks "Discard the N changes you have not saved?". N counts only the admin's own changes: new placements, pre-placed rows removed or added, and changed requirements. Untouched pre-placed rows never ask. Going back to *Which team?* asks the same question, and placements never move to another team. While a save is in flight or its result is not confirmed, leaving asks first, before-unload included, as J16 does (`frontend/metric-mappings-actions.js:294-296`).
- **How writes behave,** as J16 section 8:
  - only one write runs at a time;
  - the client bound is 90 s;
  - a lost answer shows *Result not confirmed* with *Check result*, which repeats the same body and key and never sends by itself;
  - `request_key_reused` means a new key;
  - `try_again` reads "The server was busy. Nothing was saved. Try again.";
  - `board_changed` reads the board again and says which row changed; that row loses its tick and reads *Compare again*;
  - a generation counter drops older answers (`.claude/rules/frontend.md:59-62`).

### 3.8 After the save, and the history

- **The answer** names what was switched on: "Saved. Switched on for <team>: <list>. Checked by you on <date> with two athletes: <columns>. OptiMove mappings (no check needed): <columns>." Then: "To use them, run *Find new sessions* in Imports again, with dates that include <session date>. Sessions found from then on can be imported with these variables. Drag the next column." *Find new sessions* links to Imports and pre-fills a window that includes the session's date, as v33 pre-fills one for a session that needs another search (`frontend/gpexe-import-view.js:393-395, :474-486`). So the default 14-day search (`:414`) never leaves the checked session out. A preview made before the save does not see the new activations; the next search does (section 4.4).
- **Only if Q10 lets the board ship before 9-B is live,** the sentence reads: "Imports do not use mappings yet; nothing changes in imports until they do." This is J16's R18 sentence.
- **History** is a secondary tab (R7). For each confirmation it shows: when, by whom (a display name), the session's date, and each row's column, variable, units and conversion.
  - The values of athlete A and B appear until they expire. After that the row reads "Values removed after 90 days", or "Values erased" once a platform admin has erased them. A pre-placed row reads "Not compared" and never had values. Athletes appear there only as *Athlete A* and *Athlete B*, because names are never stored.
- **Switching a row off** is S2 (C106), with one confirmation naming the team, its link and the version.

### 3.9 Phone (760 px and below)

- The columns are listed first and the variables below them.
- **One sheet at a time.** Tapping a column opens a bottom sheet, *Fill which variable?*, with the same order and reasons as on a computer. Choosing a variable replaces it with the panel, a full-screen sheet. *Back* returns to the variable list. *Create a variable* replaces the panel with the create form, and returning reopens the panel. The page behind a sheet does not scroll.
- In the panel, *Keep this placement* (primary) closes the sheet and keeps the row, with its tick. *Cancel* removes this placement.
- Each athlete is a card with three lines (GPEXE sends / OptiMove stores / the GPEXE screen should show), so no table scrolls sideways at 360 px. The row's tick sits under the two cards.
- *Save and switch on for <team>* sits in a sticky bar at the bottom of the board, never under a sheet. It opens the review card as its own sheet whenever the board holds a row. The review card's send is the gated control (section 3.7). *Compare* there replaces the review sheet with that row's panel, and *Keep this placement* returns to the review sheet. The bar is full width and 44 px tall, and every input is 16 px.
- Nothing drags on touch, and no inert control is shown. The layout is checked at 360, 375 and 390 px, and at 1280 px.

### 3.10 Accessibility

- Every column and every variable is a real button with an accessible name, for example "TIME, seconds, choose a variable for it". The chosen column has `aria-pressed="true"`.
- A polite live region announces each step: the chosen column, the proposal or refusal, and the result.
- After a column is chosen, focus moves to the first usable variable, which is announced. After a placement, focus moves to the panel's heading. After *Cancel*, it returns to the column.
- Sheets are dialogs. Focus stays inside them, and Escape closes them.
- Colour is never the only signal: each state has a text badge.
- Every reason and error is linked by `aria-describedby`. The review card's disabled send says in text why it is off, naming the columns: "Tick every new column to save: <column>, <column>." The board's button with no row says "Place a column first."
- Drag is only an extra way to do what the tap path already does.

### 3.11 Texts

English is the app's language. The sketch's Serbian is quoted where the owner saw it. Names from the source or another admin are escaped and cleaned of control and bidi characters, and cut to 80 characters (J16 section 9).

| Where | Text | The sketch, as the owner saw it |
|---|---|---|
| Title | Map by drag and drop | „Mapiranje prevlačenjem” |
| Introduction | After a search you see what GPEXE sent. Drag a column onto your variable. OptiMove proposes the conversion and shows two athletes. Compare them with the GPEXE screen and confirm. That confirmation is the evidence. | „Admin kluba posle prvog traženja sesija vidi šta je GPEXE poslao i prevuče kolonu na svoju varijablu. Ekran sam predloži preračunavanje i pokaže dva sportista. Admin uporedi sa GPEXE ekranom i potvrdi. Ta potvrda je dokaz.” |
| Left heading and note | GPEXE columns · From the session of <date, time>. Drag a column, or tap it and then tap a variable. | „GPEXE kolone” · „Iz sesije … Prevuci kolonu, ili je dodirni pa dodirni varijablu.” |
| A column (proven unit) | <label> · GPEXE sends values in <unit> | „<label> · GPEXE šalje u <unit>” |
| Right heading and note | Variables · OptiMove's variables are here at once. Your club can add its own. | „Varijable kluba” · „Sistemske varijable su tu odmah. Klub može dodati i svoje.” |
| An empty variable · a placed one | Empty · drag a column here · From <column> · switched on for <team> | „Prazno · prevuci kolonu ovde” · „Mapirano iz … · uključeno za tim” |
| The panel, empty | Drag a column onto a variable. The check for two athletes appears here. | „Prevuci kolonu na varijablu” · „Ovde se pojavljuje provera za dva sportista.” |
| Without a fine pointer | Each "drag" text has its tap form: Tap a column, then a variable. · Empty · choose a column for it · Choose the next column. | — |
| The proposal | Proposed conversion: s → min (÷ 60) · No conversion | „Predlog preračunavanja: s → min (÷ 60)” · „bez preračunavanja” |
| A unit mismatch | The units do not match: GPEXE sends values in <unit>, and the variable is in <unit>. Choose another variable or create a new one in a fitting unit. | „Jedinice se ne slažu: GPEXE šalje <unit>, a varijabla je u <unit>. Izaberi drugu varijablu ili napravi novu u odgovarajućoj jedinici.” |
| Table headers | Athlete · GPEXE sends · OptiMove stores · The GPEXE screen should show | „Sportista” · „GPEXE šalje” · „OptiMove upisuje” · „Na GPEXE ekranu treba da piše” |
| The guide | What to watch for: Open the same session in GPEXE (<date, time>) and find these two athletes. Compare the last column with what GPEXE shows. Seconds may differ by one. Distance and speed may differ in the last digit. If it does not match, do not tick it. Remove it, or choose another column or another variable. | „Na šta da paziš”: „Otvori istu sesiju u GPEXE-u (…) i nađi ova dva sportista.” „Uporedi poslednju kolonu sa onim što GPEXE prikazuje. Sekunde mogu da se razlikuju za jednu.” „Ako se ne poklapa, ne potvrđuj. Izaberi drugu kolonu ili drugu varijablu.” |
| The guide, added | GPEXE shows each user's own units. If yours shows another unit, choose it above the table. | — |
| The tick (one per new column, in the panel) | Matches GPEXE for both athletes | „Proverio sam u GPEXE-u: vrednosti za oba sportista se poklapaju.” |
| Review card | New columns, each with its two athletes' values and its tick · Compare · OptiMove mappings (no check needed) · Your club's mappings (no check needed) (R4) | — |
| The review card's send, disabled | Tick every new column to save: <column>, <column>. | — |
| Buttons | Save and switch on for <team> · Keep this placement · Cancel · Back | „Sačuvaj i uključi za First team” · „Odustani” · „Nazad” |
| Under the button | Saved with it: who confirmed, when, and the two athletes' values of the columns you checked. That is the evidence. The values are kept for 90 days, then removed. | „Čuva se: ko je potvrdio, kada, i ove dve vrednosti. To je dokaz, bez ikakvog dokumenta.” |
| After saving | Saved. Switched on for <team>: <list>. Checked by you on <date> with two athletes: <columns>. OptiMove mappings (no check needed): <columns>. To use them, run *Find new sessions* in Imports again, with dates that include <session date>. Sessions found from then on can be imported with these variables. Drag the next column. | „Sačuvano” · „… je uključeno za First team.” · „Sledeći uvoz upisuje ovu varijablu. Prevuci sledeću kolonu.” |
| Changing the athletes or the session | Your N placements will show two other athletes. Compare each one again in GPEXE. · Compare again · No other athletes have values for all your columns. | — |
| Leaving, or going back to *Which team?* | Discard the N changes you have not saved? | — |
| Which team? | <team> — linked to GPEXE team <n> · No team of your club is linked to GPEXE yet. Link one in Settings > Source connections. | — |
| Not available | Map by drag and drop is not available in this workspace. | — |
| A new column kept without its tick | Not compared yet · Compare | — |
| The board's button, with no row | Place a column first. | — |
| A system mapping switched off on this binding by an administrator (Q9) | Switched off by <name> on <date> · Add | — |

**Departures from the sketch.**
- The sketch named the athletes „Sportista 1” and „Sportista 2”. The board names them for the admin, because the guide asks the admin to find them in GPEXE.
- The sketch saved one column at a time, with one checkbox for that column. The board saves every placement with one press, but each new placement keeps its own tick, given in the panel beside its values. One placement saved alone is the sketch's own flow.
- After saving, the sketch said the next import writes the variable. The board asks for a new search first, because a preview made before the save does not use the new mappings (section 4.4).
- The English line under the button leaves out the sketch's „bez ikakvog dokumenta” (with no document) and says what is kept instead.
- Without a fine pointer, each "drag" text has its tap form.

---

## 4. Routes and the server operation

### 4.1 Audience and info-hiding

- **The board's audience** is, in a club workspace, club X's active admin, or a platform admin who also administers club X (a club workspace exists only for a club admin, section 1.5). The team must be an active team of club X. Its binding's connection must be owned by club X (`source_metric_binding_club`, `v48:84-89`).
- **Everyone else gets the identical `404`,** with `no-store`. Callers outside the two admin bases get it before anything is read. A team, binding or candidate outside the club gets the same 404 after its id is read, before any refusal that depends on that resource. Only a malformed request (`400`, `415`), `try_again` (the pool or the per-user lock) and `request_key_reused` (the caller's own key) can come first. That includes:
  - a coach, an athlete, or a team workspace;
  - the platform workspace, except routes 4–10. There an active platform admin reads any club's confirmations (routes 4–5), erases values (route 6, the confirmer included) and removes expired values (route 7). With 18-P, a platform admin also observes (routes 8–9) and reads stored field observations (route 10, `GET /fields/:fieldId/observations`, platform workspace only);
  - another club, or X's admin working in Y's workspace;
  - a revoked role, an archived club or team, or an ended binding (routes 1–3). An ended binding never hides a saved confirmation: route 3's replay and read-back, and routes 4–5, use the predicate of section 6.2 (section 4.3 step 4);
  - an unknown id.
- **Every other id the caller names** is resolved only inside the workspace's readable owner scope, as `createMapping` does (`sourceMetricMappingService.js:921-926`). `target_scope_mismatch` is answered only for a system variable placed where the column does not fill it. A foreign id is the identical 404, never `target_scope_mismatch`, `activation_changed`, `canonical_version_changed`, `board_changed` or a database refusal:
  - `targetId`: a club variable of another club;
  - `mappingVersionId`: a version of another club's mapping;
  - an activation id in `replaces`: one not on this binding, or on another club's binding;
  - `confirmationId` (routes 5–6): a confirmation outside the caller's readable scope (section 6.2).
- **Inside the scope,** a 404 always comes before any 409 (ADR-006; `routes/sourceMetrics.js:35-78`).
- **What answers never carry.** No answer carries an athlete id, a GPEXE id, a reason text, an acting user's id or SQL text (C63). Values and names go only to this audience. Section 6.2 covers system rows.

### 4.2 Routes

All routes are under `/api/training-load/sources/metrics`, behind `requireAuth`, with `no-store`.

| # | Route | Input | Answer | Refusals |
|---|---|---|---|---|
| 1 | `GET /board` | `teamId`; optional `candidateId`; optional `pair` (an index, default 0) | The columns (id, revision, label, key, unit state, placeable or reason, raw A and B); the variables (club's own and system, with unit, current version and whether placeable); rows already on; pre-placed rows with their full placement data and hash; the pair (`index`, `count`, two live labels); the session (candidate id, label, start) | `404`; `400 invalid_query`; `409 no_stored_session`, `snapshot_expired`, `candidate_too_large`, `candidate_source_mismatch`, `candidate_not_importable`, `not_enough_athletes`, `try_again` |
| 2 | `GET /board/placement` | `teamId`, `candidateId`, `pair`, `fieldId`, `targetId` | `placeable` with the proposal (`same_unit` or the conversion and its words), or a `code`; for A and B: raw, stored, and the GPEXE screen value in each display unit; the levels; collisions; a `placementHash` for each display unit | As route 1. A placement's own refusals (`field_not_confirmed`, `conversion_unavailable`, `target_scope_mismatch` (only for a system variable; a foreign id is the 404, section 4.1), `condition_mismatch`, `level_not_allowed`, `source_metric_target_taken`, `pair_not_distinct`, `value_outside_limits`, `mapping_version_active`) are a `200` answer with `placeable: false`, so the panel can show them |
| 3 | `POST /confirmations` | `{requestKey, teamId, candidateId, pair, rows: [{kind: "new", fieldId, targetId, expectedTargetVersionId, displayUnit, placementHash, checked: true, requirement, replaces: [activationId]} \| {kind: "preplaced", mappingVersionId, placementHash, requirement, replaces: [...]}]}`, with 1–20 rows | `200 {confirmation: {id, teamId, confirmedAt, rows: [{fieldId, variableId, mappingId, versionId, activationId, requirement}]}, replayed}`; `200` with `verified_after_commit_error` after a verified COMMIT; `200` with `readError` when a committed answer cannot be read back. No values are returned. | `404`; `415 jsonRequired`; `400 invalid_body` (a new row without `checked: true`, an unknown key, a duplicate field or variable among the rows, a requirement missing, a new row's `displayUnit` missing or outside its rule's list); `409` with the codes of section 4.3 step 15, plus `board_changed` (`current.rowIndex`), `canonical_version_changed`, `mapping_version_active`, `activation_changed`, `binding_not_active`, `request_key_reused`, `try_again`; `503 outcome_unknown`; `500 internal_error` |
| 4 | `GET /confirmations?teamId=&cursor=` | — | Pages of 50: when, who (display name), the session's date, rows (column, variable, version, units, conversion, checked, and A/B values, or "removed" with its kind, `expired` or `erased`, or "not compared" for a pre-placed row) | `404` outside the predicate of section 6.2 |
| 5 | `GET /confirmations/:confirmationId` | — | One confirmation, as in route 4 | `404` outside the predicate of section 6.2 |
| 6 | `POST /confirmations/:confirmationId/erase-values` | `{requestKey, reasonCode}`: `erasure_request` or `wrong_confirmation`, never typed text | `200 {confirmation}`, with the values removed | `404` for everyone but an active platform admin in the platform workspace, the confirmer included; `400 invalid_body` (another reason code, or typed text); `409 values_already_removed`, `request_key_reused`, `try_again`; `503 outcome_unknown` |
| 7 | `POST /confirmations/expired-values/remove` | `{requestKey}` | `200 {removed: N, more: bool}`: at most 200 confirmations per call. It is the on-demand backstop of the scheduled removal: the same function, under the admin's identity, with one T8 `confirmation_values_expired` row per confirmation it removed, the last one keyed. A replay counts those rows by `operation_id`. A run that removes nothing writes no row (section 5.8) | `404` for everyone but an active platform admin in the platform workspace; `400 invalid_body`; `409 request_key_reused`, `try_again`; `503 outcome_unknown` |
| 8–9 | Only with 18-P (Q2, Q3): `GET /fields/:fieldId/observation?candidateIds=a,b&pairs=i,j` and `POST /fields/:fieldId/revisions/:revisionId/observed-confirmation` | `{requestKey, sessions: [{candidateId, pair, displayUnit, placementHash} × 2], attested: true}` | Fields without parameters only: the observed unit and meaning acts, in one operation | `404` for everyone but an active platform admin in the platform workspace; `409 field_has_parameters`; the M2b codes (`unit_already_verified`, `meaning_already_verified`, `revision_retired`); `board_changed` |
| 10 | Only with 18-P: `GET /fields/:fieldId/observations` | — | The field's stored observations: when, who (display name), the two sessions' dates, the acts they proved, and the `field_unit` values, or "removed" with its kind (`expired` or `erased`) | `404` for everyone but an active platform admin in the platform workspace |

**18-A2, routes 1 and 2:** the candidate each of them reads, chosen or default, is one with `import_undone_at is null` (v57; section 15.1); an undone one is `409 no_stored_session` when no live row of the team is left, and otherwise the identical 404 as an id that is not usable. Route 1 also answers `409 session_start_unknown` for a candidate with no start (section 5.2).

**Routes reused unchanged:**
- S2 `POST /activations/:id/end`, for *Switch off*;
- M3-0 `POST /variables`, for *Create a variable*;
- `GET /conversions`;
- the GPEXE candidates list route;
- the source-connections read J16 uses for its team list (`frontend/metric-mappings-data.js:17`), for *Which team?* (section 3.1);
- the link read, which the board's service calls internally:
  - The board resolves the workspace once (`resolveMappingAdminWith`, `sourceMetricAccess.js:88-90`).
  - It calls the link reader (`listAthleteLinks`, `gpexeImportService.js:1613-1620`) directly. It never calls `resolveGpexeTeamAccess` (`gpexeImportAccess.js:18-25`), `resolveActiveWorkspace` or `identityAdminBasis`.

**The names.** The board never calls `listIdentities` (`gpexeAthleteIdentityService.js:246`). That function also reads dates of birth and a date-of-birth conflict over `public.athletes` (`:276-300`), purges first (`:250`) and opens its own connection (`:251`). The board has a narrow reader of its own:
- It selects `display_name` only, with the same predicates: `binding_id`, `owner_team_id` and `expires_at > now()` (`:276-281`).
- It never reads `birth_date` and never runs the conflict query.
- In a save, the pair choice runs it, and the link read's query, on the save's own client, as plain reads. `listAthleteLinks` reads through the pool (`gpexeImportService.js:1614`), so a save runs the same query on its own client.

**The hashes.** `placementHash` is a SHA-256 over:
- the candidate's `bundle_hash`;
- the pair index;
- the pair's two names, as the board shows them (18-2: the index alone does not say who the pair is). A rename of
  either athlete between the read and the save therefore makes the hash stale: the save answers `board_changed`, and
  the admin compares again under the new name;
- the field revision;
- the target version (or the system mapping version);
- the conversion row (or "same");
- the display rule and the display unit (a `new` row, and each session of route 9);
- the raw and stored values of A and B.

It is not a secret and has no clock. The server recomputes it on every save. A difference is `board_changed`. No signing secret is introduced. It is a concurrency token only. It is derived from the values, so no request hash covers it (routes 3 and 9; section 4.3 step 3), and it is never stored.

### 4.3 The save, step by step (one transaction)

**The prefix, before any connection:**
1. **The right** (section 4.1). A caller outside the two admin bases gets the identical 404 before the body is read. A team, binding or candidate outside the club, and every other foreign id of the body (section 4.1), gets it at step 5, after its id is read.
2. **The body is checked.** It must be a JSON object (`415` / `400`) with exactly the keys of route 3 and 1–20 rows. Every new row needs `checked: true`, its own tick. Each row needs its requirement, and each new row a `displayUnit` from its rule's list. No two rows may share a field or a variable.
3. **The request hash** covers only the row identities (kind, `fieldId`, `targetId` or `mappingVersionId`, `displayUnit`, requirement, `replaces`), the team, the candidate and the pair index. It leaves out `placementHash`, which is derived from the values, so T8's stored `request_hash` covers no value (section 5.6). `placementHash` stays a concurrency token, checked at step 6.

**One write transaction, `runWrite`** (`sourceMetricMappingService.js:763-847`):

4. **Start.** The bounds are set first: `statement_timeout` 10 s, the idle bound, and a 5 s lock bound (`:776-778`; `:93-95`). Then the per-user advisory lock is taken (`:779`, up to 5 s), and the row-lock bound becomes 2 s (`:780`). The request record is looked up (`:782`):
   - a replay answers the current state only after the scope of routes 4–5 is checked again, under `FOR SHARE`: the admin's right; the team is active and in the workspace's club; the workspace's club is the confirmation's `owner_club_id` and is active (section 6.2). The binding need not still be active. That is a condition of the first execution only (steps 5 and 13), so an Unbind after the COMMIT never hides a saved confirmation, which History still shows. Any failure is the identical 404. The reread filters by `ctx.owner`, as `writableMappingSummary` does (`sourceMetricMappingService.js:909`);
   - another body under the same key is `409 request_key_reused`.
   Then the v35 actor setting is written (`:797`).
5. **Plain reads, with no lock:**
   - the team and its one active GPEXE binding. The binding's club must be the workspace's club, and the team must be active. Otherwise the answer is 404.
   - the candidate, through 7e's scope query (`sourceMetricPreviewService.js:98-121`). It must not be an undone import (`import_undone_at is null`, v57; section 15.1). It must be stored, not expired, at most 16 MiB, and its last check must have succeeded through this binding (`gpexe_import_checks.source_binding_id`, `v31:71-72`), as the importer requires (`phase9-importer-mappings-contract.md:175-179`). It must not be `superseded`, which blocks a candidate everywhere else (`gpexeImportService.js:1327`). Otherwise the answer is the 409 of route 1.
   - every other id of the body (`targetId`, `mappingVersionId`, each id in `replaces`) is read inside the readable owner scope and the binding (section 4.1). One outside it is the identical 404.
   - The candidate row is never locked (section 4.4).
6. **The recompute.**
   - `gpexeLevelValues` runs with each row's extractor and the version's parameters (`gpexeImportMapper.js:427-441`), and with the team's session time zone (`teamTimezone`, v62; section 15.1), so a session passes the same gates as its import. A variant keeps an internal athlete key, which never leaves the service.
   - The pair is chosen for the request's index (section 6.1). `convertAtStorageScale` gives the stored values, and the display values are computed.
   - Each row's hash is compared with the one the client got. Any difference is `409 board_changed`, naming the row. Nothing is written.
7. **Conversions.** The `unit_conversions` rows of every value pair used are taken `FOR SHARE`, in ascending order (`source_metric_lock_conversions`, `v34:952`).
8. **Fields.** The T2a and T2b rows are taken `FOR SHARE`, in ascending order. Each revision must be active and verified, and its unit must be the one the hash covered.
9. **Mappings (T3).** One pass over the rows of both kinds, in ascending mapping id, so two saves with crossed rows never deadlock:
   - For a new row, the club's existing mapping of (field, variable) is taken `FOR NO KEY UPDATE`. A missing one is only noted here; it is inserted at step 16.1.
   - For a pre-placed row, its mapping is taken `FOR SHARE`.
10. **Versions (T4).** Locks and plain reads only; nothing is written here.
    - For a new row whose mapping already has an active version with the same revision, parameters and target version, and the same factors as the panel used, that version is reused, `FOR SHARE`.
    - A mapping whose active version differs is refused at step 15 with `409 mapping_version_active` ("Disable it in Mappings first"). A mapping has one active version (`v34:888-889`), nothing is replaced automatically (C104 Q3), and an active version keeps the factors of a conversion retired since (`v34:1184-1186`).
    - Otherwise a new draft is planned for step 16.1, with:
      - the server's factors from the one active conversion;
      - the fixed note "Converted by OptiMove's active unit conversion." when the units differ;
      - the levels both the field and the variable allow (session and drill where both allow them). The two athletes are compared at the session level only (section 6.1). The field, its proven unit and the conversion are the same at both levels, so the session-level comparison is the evidence for the version as a whole (R9).
    - For a pre-placed row, its active version is taken `FOR SHARE`.
11. **Variables.** The `metric_definitions` rows are taken `FOR SHARE`, in ascending order.
    - Each must be active, and its current version must be `expectedTargetVersionId`. Otherwise the answer is `409 canonical_version_changed`.
    - Their scope capabilities are taken `FOR SHARE` (for the levels).
12. **Replaced activations.** The T5 rows listed in `replaces` are taken `FOR NO KEY UPDATE`, in ascending order, by a query that filters on this binding (`id = any($1) and source_team_binding_id = $2`). A row of another binding is neither locked nor told apart: it is the identical 404. A listed row on this binding that is no longer open is `409 activation_changed`.
13. **The binding** and its team are taken `FOR SHARE` (`lockListedBindings`, `sourceMetricActivationSteps.js:100-128`). The binding must be active. Otherwise the answer is `409 binding_not_active`.
14. **The rights.** The acting user's role, user and club rows are taken `FOR SHARE`, the users row first (LO-1, LO-2) (`rightsStillHold`, `bindingClubHolds`; `sourceMetricAccess.js:66-130`). A lost right is the identical 404, and nothing is written. Then the hide locks of J15's amendment (section 4.4) are taken, through `lockHides`, for every system target the save starts. Every new `42501` text of M-A and M-B is added to `ACTOR_REFUSALS` in 18-3 (`sourceMetricMappingService.js:341, :398`), so a right lost under a guard of M-A or M-B is the 404 too, never a 500.
15. **The state checks.** First the candidate is read again, as a plain read after the step-14 locks. If its `bundle_hash`, `last_seen_check_id`, `status`, `superseded_by_check_id` or `import_undone_at` differs from step 5's, a check was finalized meanwhile, or the session's import was undone (18-A2; v57). The check saw the session again (`gpexeImportService.js:2063`), replaced it with newer content (`:2101-2108`) or withdrew it (`:2112-2115`). The answer is `409 board_changed`. The T9s guard refuses the same cases with fixed messages (section 5.4), which the service maps to `board_changed` too, as the backstop. Then the checks run in this order, and the first failure names its row:
    1. the revision;
    2. the target;
    3. the conversion (`conversionsHold`);
    4. the levels;
    5. another mapping of the club with an active version of the same field and parameters (`source_metric_target_taken`, C33), or an active version of the row's own mapping that step 10 cannot reuse (`mapping_version_active`);
    6. extractability (`assertExtractable`);
    7. for every new row, the pair's values must be non-zero and distinct (`pair_not_distinct`);
    8. the stored values must be inside the variable's limits (`value_outside_limits`);
    9. a T5 collision not listed in `replaces` (`activation_exists`, `variable_taken_on_binding`; `sourceMetricActivationSteps.js:138-158`);
    10. a system target the team's club hides (`variable_hidden`, J15 section 4.3; read after the hide locks of step 14).
16. **The writes, in this order.** Every existing row is locked by steps 7–14, before the first write, as D requires (`discovery:1277-1280`). So the guards' own `FOR SHARE` locks at the first protected write (the role, user and club rows of v35 and v48, `v35:131, :162`; `metric_definitions` in the T3 trigger, `v34:647-648`) find their rows already held.
    1. the T3 insert of each missing mapping, in ascending (field id, variable id) order, and its `mapping_create` row; the T4 draft of each new version and its `mapping_version_create` row; its `needs_review` transition and its `mapping_status` row. Each audit row comes right after its own write, so v35's guard sees the version at its target status (`v35:268-276`);
    2. the listed T5 ends (`admin_ended`, by the actor, with the basis v48 derives), carrying the fixed reason "Replaced on the drag-and-drop board.", with their `activation_end` rows;
    3. the T9 confirmation, its session row, and its rows. The database computes each digest and checks each stored value against the raw one (section 5.4);
    4. each new club version moves `needs_review → active`, with its `mapping_status` row. The J18 gate checks its T9 row (section 5.5);
    5. the T5 starts on the one binding, one per row, in ascending version id. `insertStarts` starts one version on N bindings (`sourceMetricActivationSteps.js:163-186`); J18 adds a variant that starts N versions on one binding. A new row's start carries the fixed reason "Switched on by drag and drop; two athletes checked in GPEXE." A pre-placed row's start carries "Switched on by drag and drop; OptiMove mapping." (under R4, a club row's: "Switched on by drag and drop; the club's mapping."). Each carries the row's requirement and its `activation_start` row, unkeyed;
    6. last, the keyed request record: the T8 `mapping_confirmation` row naming the confirmation and the team.
17. **The bounded COMMIT,** with the outcome rules of section 4.5.

### 4.4 Lock order and concurrency

The order is D's (`discovery:1271-1280`). As proposed, this sentence said A1 took its listed bindings after its rights check; since LO-1 (PR #344) A1 takes them before, in D's order, as this write does (section 15.1):

`unit_conversions → T2a → T2b → T3 → T4 → metric_definitions → scope capabilities → T5 (to end) → binding → team → user / role / club`, then the hide locks (J15, below), then the new rows. (As proposed the last group read "role / user / club"; the users row is first since LO-1 and LO-2.)

**Amended by J15 (C132, accepted 2026-11-02; in force since v53's deploy on 2026-11-04):** after the
role, user and club rows (step 14) and before step 15's state checks and step 16's writes, the board takes the hide
lock for every (team's club, target definition) pair it starts, ascending by `(club, definition)`; after it no new row
lock is taken (J15 section 5).

The candidate, the team import lock and the Metrics Core connection (v11) are never locked. A row-lock wait is bounded at 2 s, the per-user lock at 5 s, and every statement at 10 s (`sourceMetricMappingService.js:93-95`). `55P03`, `40P01` and `57014` before the COMMIT answer `try_again` with nothing written.

| Against | Outcome |
|---|---|
| A1, A2 or the pinned step on the same club mapping | A1 and A2 take T3 `FOR NO KEY UPDATE`, as this write does, so they serialize at T3. The pinned step serializes earlier, at T2b, which it takes `FOR UPDATE` against this write's `FOR SHARE` (`phase7d-mapping-activations-contract.md:515`). In each case the second reads the first's result. |
| S1 or S2 on the same binding | As in 7d's table (`phase7d-mapping-activations-contract.md:507-517`): T3 → T4 → T5 in D's order. A start against an end of the same field waits only on the open-row unique index. |
| The 9-B approval, or a check-time preview, of the same team | The importer takes the team lock and the binding `FOR SHARE`, then T2b → T3 → T4 → definition → T5 `FOR SHARE`, then v11 `FOR UPDATE` (`phase9-importer-mappings-contract.md:163-216`). This write takes no team lock, no v11 row and no candidate lock. Its binding `FOR SHARE` is compatible with the importer's. It may wait for rows the importer holds `FOR SHARE`, but it never holds something the importer then waits for, so no cycle forms (the 7d argument). A preview that ran before the save does not see the new activations. The next check does (`phase9-importer-mappings-contract.md:75, :444-445`). |
| A 7g instance end | 7g needs the team's import lock. It is refused while the team has an active binding or an open activation (`v50:21-34`). This write needs an active binding, so the two never act on the same team at once. |
| An Unbind | This write holds the binding `FOR SHARE` only from step 13 to the COMMIT. Either side waits at most 2 s, then `try_again` (C58, `discovery:557-560`). If the Unbind commits first, this write answers `binding_not_active`. |
| A new version of the target variable (M3-0, or C111 later), or its archive (the plan's R2, `metrics-core-plan.md:571`) | C9's guard reads T4 without a lock (`v34:1222-1238`). This write locks the definition `FOR SHARE`. If the new version commits first, this write answers `canonical_version_changed`. If this write commits first, the new version is refused with `variable_pinned`. An archive is refused with `archive_pinned` while an active version pins the variable (`canonicalVariableAdminService.js:84`). If the archive commits first, this write answers `canonical_version_changed` (step 11). |
| A club or team archive | Both rows are held `FOR SHARE` (steps 13–14). The archive waits or lands first. Then the answer is the identical 404. |
| A role revocation | It meets this write only at the user rows `FOR SHARE`, as in 7c and 7d. |
| A check finalization of the same team | It rewrites the candidate's `last_seen_check_id` (`gpexeImportService.js:2063`), or supersedes it (`:2101-2115`). This write never locks the candidate. Step 15 reads it again and answers `board_changed`; the T9s guard is the backstop (section 5.4). |
| A session undo of the same team (18-A2; v57) | The undo marks every candidate of the event `import_undone_at` and, when the snapshot is still stored and its last check succeeded, writes a fresh pending row under a new id (`v63:840-863`); otherwise no live row is left and the board answers `no_stored_session`. This write never locks the candidate. Step 15 reads it again and answers `board_changed`; the T9s guard is the backstop, with its own fixed message. An undo that commits after the T9s insert changes nothing of the confirmation. |
| Two admins saving the same placement | The second fails on T3's pair key or on T5's open-row index. The whole operation answers `409 board_changed`, and the screen reads the board again. Nothing of the second save is written. |

### 4.5 Idempotency and the COMMIT (the five-point rule)

1. **An error before the COMMIT** is a stated refusal, and nothing is written. The answer says so: "Nothing was saved."
2. **An error at the COMMIT, or no answer to it.**
   - The connection is closed and never reused.
   - An ordinary ERROR that PostgreSQL itself raises at the COMMIT (a deferred J18, v35 or v43 link, or a deadlock) is a definite refusal, with nothing written (`commitCertainlyRefused`, `sourceMetricMappingService.js:63-77, :813-818`).
   - For every other COMMIT error, and for no answer, the request key is looked for on another connection, within a bound.
   - If it is found, the scope of step 4's replay is checked again; a failed scope is the identical 404. Otherwise the answer is `200` with `verified_after_commit_error`.
   - If it is not found, the answer is `503 outcome_unknown`.
   - Those two are never "nothing was saved". This is the F2 discipline that `runWrite` already has.
3. **After a confirmed COMMIT,** the scope of step 4's replay is checked again; a failed scope is the identical 404. A failed read-back answers `200` with `readError`, never an error.
4. **The same key and body again** is a replay. It answers `replayed: true` after the scope of step 4 is checked again. Another body under the same key is `request_key_reused`. The screen's *Check result* sends the same key and body, and never sends on its own.
5. **One targeted test through the real route** covers each outcome (section 9.2).

A partial result is never shown as switched on. If the fallback of R8 is used, the screen says what is saved and what is not.

### 4.6 What the server never does

- It never sends a GPEXE request.
- It never writes T2a or T2b on a club's behalf.
- It never creates a canonical variable from a column (C1, C2, ADR-007).
- It never replaces an active version automatically (C104 Q3).
- It never starts an activation for a binding that is not listed.
- It never logs a value, a name or a reason, and never puts a value into T8, its request hash included.
- It never returns a value to anyone outside section 4.1.

---

## 5. Data model and migrations (M-A and M-B)

**18-A2:** as proposed, this section was one migration, "v52". It is now two (section 15.3): **M-A** (18-1) holds sections 5.1–5.4, 5.6 and 5.8; **M-B** (with 18-3) holds the gate of section 5.5 alone. Section 5.7 is in neither (C114, section 15.2). "v52" below means M-A, and in section 5.5 M-B. The bodies each one replaces, and their md5, are those in force when its branch is cut (section 15.1), not the ones named below.

Each migration takes the next free number when its pull request is opened. It is additive. It replaces functions only after checking the md5 of the body in force, as v50 does (`v50:84-99`). Fixed messages are used: `42501` for a refused actor and `23514` for everything else (C79).

### 5.1 T9 `training_load.source_metric_confirmations` — the act

**18-A2:** M-A builds the `team_mapping` shape only (section 15.3). Everything in sections 5.1–5.4, 5.6 and 9.1 that exists only for `field_observation` (the kind itself, `source_metric_version_id` on T9, a second session, the `field_unit` item kind, the fourth deferred check, the two observed T8 acts, test items on them) belongs to 18-P's later migration, which widens the CHECKs; so do sections 6.2, 9.2 and 9.5 where they name `field_observation`. Decided by the *Rukovodilac* on 2026-11-12 (section 15.2).

| Column | Rule |
|---|---|
| `id` | uuid, the primary key |
| `operation_id` | uuid, not null, unique. It ties the act to its T8 rows. |
| `kind` | `team_mapping` (a board save) or `field_observation` (the platform's global confirmation, only with 18-P) |
| `owner_scope`, `owner_club_id` | `team_mapping` ⇒ `club` with its club; `field_observation` ⇒ `system`, no club |
| `binding_id`, `team_id` | Set exactly for `team_mapping`. A foreign key to `source_team_bindings (id, team_id)`, the v34 anchor (`v34:1291`). |
| `credential_connection_id` | Set exactly for `team_mapping`. It must be the binding's own v27 connection, never a v11 source instance: that row is created only at an import, and 7g ends it. |
| `source_metric_version_id` | Set exactly for `field_observation`: the revision confirmed |
| `confirmed_by_user_id`, `confirmed_basis`, `confirmed_at` | The actor, `platform_admin` or `club_admin`, and `clock_timestamp()` |
| `attested` | True exactly when a row is `checked` (deferred) |
| `display_registry_version` | A small integer, greater than 0 |
| `values_expire_at` | Set by the trigger to `confirmed_at` plus N days (Q6). The client never sets it. |

There is no free text, and no athlete data.

### 5.2 T9s `training_load.source_metric_confirmation_sessions` — the session

| Column | Rule |
|---|---|
| `confirmation_id`, `session_ordinal` | The primary key. The ordinal is 1 or 2. |
| `candidate_id` | uuid, **no foreign key**. The candidate row is never pinned, because v22 allows deleting a candidate that was not imported (`v22:296-303`). |
| `candidate_bundle_hash` | 64 lower-case hex characters, copied from the candidate |
| `gpexe_team_session_id` | The canonical session id, copied. It is a session, not a person. |
| `session_started_at` | **18-A2 (the *Rukovodilac*, 2026-11-12):** the session's start, copied from the candidate at the save, so History never reads the candidate row. A session fact, not a person's. `timestamptz`, **NOT NULL**. The candidate's own column is nullable (`v22:254`), so route 1 refuses a candidate whose start is null with `409 session_start_unknown`, and such a candidate is never the default session. The T9s guard requires the value to equal the candidate's (section 5.4). |
| `check_id` | A foreign key to `gpexe_import_checks`, which are never deleted (`v24:336`). The check must have succeeded for this team. For `team_mapping`, through this binding (`gpexe_import_checks.source_binding_id`, `v31:71-72`), as the importer requires (`phase9-importer-mappings-contract.md:175-179`). For `field_observation`, through `source_connection` on a host of the field's family. |
| `team_id` | The session's team |
| `pair_index` | Zero or more: the server's pair order. No athlete id. |

`team_mapping` has exactly one session. `field_observation` has exactly two, from different GPEXE sessions. Both rules are deferred checks.

### 5.3 T9i `training_load.source_metric_confirmation_items` — the rows and their values

| Column | Rule |
|---|---|
| `id`, `confirmation_id`, `session_ordinal`, `item_no` | The session is a foreign key to T9s |
| `item_kind` | `club_mapping`, `system_mapping` or `field_unit` |
| `checked` | True for a new row: the admin's own tick for that row (`checked: true` in the body, section 3.7). False for a pre-placed row. True for a `field_unit` row (route 9's `attested: true`, section 4.2). |
| `source_metric_version_id` | A foreign key to T2b |
| `mapping_version_id` | A foreign key to T4, set exactly for the two mapping kinds. Unique per confirmation. **18-A2:** M-A also creates an index that leads with `mapping_version_id`, for M-B's gate lookup. |
| `parameter_fingerprint`, `source_unit`, `target_unit`, `scale`, `scale_divisor`, `offset` | Copies that must equal T4's, and T2b's unit. For `field_unit` there is no target unit or factor. |
| `compared_level` | `session` only: the level at which the two athletes were compared. It is the evidence for the version as a whole, its drill level included (section 4.3 step 10, R9). |
| `gpexe_display_rule`, `gpexe_display_unit` | Set exactly for a checked row: a registry code (`^[a-z_]{1,40}$`) and a unit from that rule's closed list, the `displayUnit` the row was sent with. It is what the admin compared against. |
| `raw_a`, `stored_a`, `raw_b`, `stored_b` | `raw_a` and `raw_b` are set exactly for a checked row. `stored_a` and `stored_b` are set exactly for a checked mapping row; a `field_unit` row has no stored value. A row with `checked = false` stores no values (data minimization, recommended). Finite numerics. While the values are present, a BEFORE trigger checks, with fixed messages, that the two raw values are non-zero and different, and that `stored_*` is D8 of `raw_*` (`source_metric_value_matches`, `v34:156`, which is false for a NULL). Every other rule of this table that can fail on a row holding values is enforced in the same BEFORE triggers, with fixed messages: the shape of `checked`, the display rule and unit, the salt and the removal facts. A BEFORE ROW trigger runs before the CHECKs, so the table CHECKs are unreachable backstops. This matters because PostgreSQL prints the whole failing row, values included, for any failing CHECK, whatever its expression tests. |
| `values_salt` | 16 random bytes, generated by the trigger on a checked row. It belongs to the removable column set: it is null exactly when the values are. It is never returned. |
| `values_digest` | SHA-256 over the salt, the canonical text of the row's facts, and its values. It is computed by the trigger. It survives the removal, but with the salt gone it can no longer be tested against guessed values: it can be checked only until the removal. |
| `values_removed_at`, `values_removed_kind`, `values_removed_by_user_id` | Kind `expired` or `erased`. On a checked row the values and the salt are null exactly when `values_removed_at` is set. `values_removed_by_user_id` is set by the update guard from the v35 actor, never by the writer (section 5.4). It names the actor of an erasure or of route 7, and is null only for the scheduled removal (section 5.8). A row with `checked = false` has no values and is never removed. |

### 5.4 The guards (the C76 / v35 / v48 pattern)

- **BEFORE INSERT on T9:**
  - The v35 actor must equal `confirmed_by_user_id`.
  - `confirmed_basis` must equal `source_metric_actor_basis(actor, owner_club_id)` (`v35:82-110`). Otherwise the answer is `42501`. A `field_observation` row needs `platform_admin`.
  - For a `team_mapping` row: `source_metric_binding_club(binding_id)` must equal `owner_club_id`. The binding must be active. The connection must be the binding's.
  - A write inside a savepoint is refused.
- **Plain reads.** Every v52 guard reads the connection, the binding, the check and the candidate as plain reads and never locks them. So an Unbind's order (the connection, then the binding; `CURRENT_STATE.md:824-827`) is never inverted, as v34's T5 trigger keeps it for the v27 rows (`discovery:1288-1290`).
- **BEFORE INSERT on T9s and T9i:** the row's confirmation must have been written in this transaction by the same actor.
  - On T9s, the check's facts must hold. For `team_mapping`, the team must be the binding's, and the check must have run through the confirmation's binding. At insert the candidate exists, belongs to `team_id`, has `last_seen_check_id = check_id`, carries `candidate_bundle_hash`, and is not `superseded`. Each failure has its fixed message.
    **18-A2:** at insert the candidate is also not an undone import (`import_undone_at is null`, v57), with its own fixed `23514` message, which the service maps to `board_changed`; its direct database test and mutation are in section 15.5. The guard also requires the row's `session_started_at` to be `is not distinct from` the candidate's `session_started_at`, with its own fixed `23514` message (a null start is refused by the column's NOT NULL, and before that by route 1); its test and mutation are in section 15.5 too.
  - On T9i, the T4 and T2b facts must be equal; the T4's owner must be the confirmation's club for `club_mapping`, and `system` for `system_mapping`; the T2b revision must be active and verified.
  - The salt and the digest are computed by the trigger. A salt or digest the writer supplies is overwritten. Every rule of section 5.3 that can fail on a row holding values is checked here, with fixed messages, before any CHECK.
- **UPDATE:** refused on T9 and T9s. On T9i, only the two removals of section 5.8: the values and the salt set to null, with `values_removed_at`, `values_removed_kind` and `values_removed_by_user_id`, and nothing else. The guard checks the removal's shape itself, with fixed messages, before any CHECK.
  - **The actor.** The guard reads the v35 actor setting without raising. An absent or empty setting is "no actor". A present setting that is not valid (not canonical, or of another transaction; `v35:66-77`) is `42501`, never "no actor". The guard sets `values_removed_by_user_id` to the actor, or to null with no actor. A value the writer supplies is overwritten.
  - An `expired` removal needs the confirmation past its `values_expire_at` and the valid purge marker (section 5.8), so it happens only inside the removal function. With an actor, the actor must be an active platform admin.
  - An `erased` removal always needs an actor who is an active platform admin, and always its T8 row.
  - **The one exemption from a T8 row** is one predicate: kind `expired`, no v35 actor setting, the purge marker present and valid, and `values_removed_by_user_id` null. Every other removal has an actor and its T8 row.
- DELETE and TRUNCATE are refused on all three tables.
- **Deferred checks, at COMMIT.** The first four are `AFTER INSERT` constraint triggers only, so a later removal never runs them:
  - A confirmation has its keyed T8 row of the same operation, by the same user (`mapping_confirmation`, or `source_metric_unit_observed` for a field).
  - A `team_mapping` act has exactly one session and at least one row. Every mapping row's version is active and has an open activation on the confirmation's binding, started in this transaction.
  - `attested` is true exactly when a row is checked.
  - A `field_observation` act has exactly two sessions and two `field_unit` rows, and T2b's unit act names it in the same transaction (section 5.7).
  - A T9i row whose values an actor removed has the T8 row of its kind: `confirmation_values_erased`, or route 7's `confirmation_values_expired`. This is a deferred constraint trigger `AFTER UPDATE … WHEN (old.values_removed_at IS NULL AND new.values_removed_at IS NOT NULL AND new.values_removed_by_user_id IS NOT NULL)`, as v48 does for T5 ends (`v48:280-285`). It finds its T8 row by the same user, the action of its kind, the row's confirmation, and a T8 xmin equal to this transaction (`source_metric_current_xmin()`, `v35:116-119`, as v48's end link uses it, `v48:259-261`). The guard sets the user column from the actor, so an actor's removal never reaches COMMIT with a null user. The scheduled removal, under the exemption above, needs no T8 row.

### 5.5 The gate on a club admin's activation

**18-A2:** the gate is M-B, deployed together with 18-3 (the *Rukovodilac*, 2026-11-12: no gap in which a club admin's activation is refused while the board's backend does not exist). Its first body already accepts v53's copy link (C125; section 15.3).

- A new trigger on T4 runs `BEFORE UPDATE`. It is named to sort after v34's and v35's guards.
- When `needs_review → active` has `activated_basis = 'club_admin'` and the version's `parameter_kind` is `'none'`, it requires a T9i `club_mapping` row that:
  - has `checked = true`;
  - names exactly this version, so its levels too. The comparison is at the session level only; it is the evidence for the version's drill level as well (section 4.3 step 10, R9);
  - belongs to a confirmation written in this transaction by `activated_by_user_id`, for the mapping's club.
- Otherwise it refuses with `23514` and one fixed message. M2's allowlist of database refusals (`sourceMetricMappingService.js:312-324`) maps that message to `409 confirmation_required`, "Switch this version on from *Map by drag and drop*.", so A1 answers a sentence, never a sanitized `500 internal_error` (C63).
- J16's screen (under 7h) does not offer *Activate* or *Replace* to a club admin for such a version; it shows the same sentence with a link to the board (section 8.6).
- The gate applies only to a version whose field has `parameter_kind = 'none'`. It comes on top of 7h's basis change, never instead of it, and a platform admin's A1 is unaffected.
- A1 writes no T9 row (`sourceMetricMappingService.js:1465-1506`). So after v52 a club admin's A1 under 7h is refused for such a version, a replacement included. The owner decides the consequence in **Q13 → C124**:
  - option one: a club admin activates a parameter-less club version only through the board, and a replacement is "disable in Mappings, then place again";
  - option two: the board gains a version-replacement row with v43's G1 chain.
- Zone and threshold versions keep 7h's J16 path, with no J18 gate.
- **A 7i copy.** OD7's form (b) copies a system mapping as the club's draft version, approved under C108 (`discovery:1188-1193`). Its activation is a club admin's activation of a club version of a field without parameters, with no T9i row, so the gate refuses it. The owner decides in **Q14 → C125**:
  - option one: J15 adds, in its own migration, a second proof the gate accepts: a typed link from the club version to the system T4 version it copies, with identical revision, fingerprint, units and factors;
  - option two: the copy goes through the board, with a two-athlete check.
  - Recommended: option one, decided with 7i. Until then the gate refuses a copy's activation.
  - **Answered by J15's acceptance (2026-11-02):** option one, in 7i's migration (J15 sections 7.2 and 7.6); C125
    itself is recorded with J18's other decisions.

### 5.6 T8

- **One new nullable column:** `confirmation_id`, referencing T9 with `on delete restrict`. A CHECK ties it to the new actions: it is set exactly for `mapping_confirmation`, `confirmation_values_expired`, `confirmation_values_erased` and the two observed acts. It is a typed foreign key, not a value (D10 as extended, section 8.6).
- **New actions** are added to the closed list. Every existing branch of `row_ok` stays byte for byte:
  - `mapping_confirmation`: the keyed request record of a board save. It names the team and the confirmation, with the basis `platform_admin` or `club_admin`, no reason and no evidence.
  - `confirmation_values_expired`: the record of one confirmation whose values route 7 removed. It names that confirmation, with `platform_admin` and no reason. Route 7 writes one per confirmation it removed; the last is the keyed request record of the operation (the `startAuditRows` pattern, `sourceMetricActivationSteps.js:192-200`). A replay counts the operation's rows by `operation_id`, so it answers the same `removed`. A run that removes nothing writes no row, and its replay runs the function again, which is harmless. The scheduled removal writes none.
  - `confirmation_values_erased`: names the confirmation, with `platform_admin` and a fixed reason code as its reason (`erasure_request` or `wrong_confirmation`), never typed text.
  - Each of the two comes at most once per confirmation: a unique index on `(confirmation_id, action)` for these two actions, as v48 has for activations (`v48:293-295`). A confirmation's values are removed once.
  - Only with Q2 a2 and Q3 b1: `source_metric_unit_observed` and `source_metric_meaning_observed`. They name T2a, T2b and the confirmation, with `platform_admin` and no `evidence_ref`.
- **Replaced bodies,** each after its md5 check:
  - the revision guard gains the new branches. Each row must follow its own T9 or T9i write in this transaction, by the acting user, once per confirmation and action. Route 7's rows come one per confirmation, each after that confirmation's removals; the keyed one is last.
  - v48's actor guard admits a `club_admin` basis on `mapping_confirmation` for the confirmation's club.
  - v48's insert guard admits a club-admin `mapping_confirmation` row that names a confirmation of the actor's club.
- T8 gains one typed foreign key, `confirmation_id`, and keeps no value-bearing column (D10 as extended, section 8.6). Its `request_hash` covers no value (section 4.3 step 3).

### 5.7 T2b — only if Q2 chooses a2 and Q3 chooses b1

**18-A2: not built by J18's migrations.** C114 changed this form (zones and thresholds too, a note and an optional image, no document). It gets its own contract amendment and its own later migration, with 18-P (section 15.2). The text below is the proposal as it stood.

- **New columns:** `unit_observation_id` and `meaning_observation_id`, both referencing T9 with kind `field_observation` and the same revision. Also `meaning_evidence_kind` (`document` or `observed_column`), and `meaning_observed_column`, a registry code (never typed text).
- **Rewritten CHECKs:**
  - A unit proof carries `unit_evidence_ref` or `unit_observation_id`, never both, and `unit_observation_id` only when `parameter_kind = 'none'`.
  - The same holds for the meaning. `observed_column` is allowed only when `parameter_kind = 'none'`.
  - `evidence_ref_iff_proven` accepts an observation in place of a reference.
  - `verified_iff_proven` stays as it is: unit plus meaning plus, for a parameterised field, the operator (`v34:449-452`).
- **Replaced bodies,** each after its md5 check: v34's write-once guard lists the new columns; v42's actor guard admits the observed acts; v37's deferred audit link requires their T8 rows.
- **`source_metric_evidence_ref_ok` stays byte for byte,** because T8 and `unit_conversions` share it (`v34:86-94`).

### 5.8 Expiry, removal and erasure in the database

- **Expiry.** No route returns a value after its `values_expire_at`, before any physical removal. This is the precedent of `raw_expires_at` (section 1.4).
- **The scheduled removal** (recommended in Q6). A SQL function, `training_load.remove_expired_confirmation_values(p_limit)`, removes one bounded batch of whole confirmations, as v32's purge of GPEXE names removes one batch (`v32:88, :325-340`).
  - It takes at most `p_limit` confirmations past their `values_expire_at` that still hold values, `order by values_expire_at, id`, locking their T9 rows `for update skip locked`. Then it nulls all their checked T9i rows and returns their ids, never a value. A confirmation another transaction holds (route 6, or another run) is skipped and taken by a later run. `p_limit` counts confirmations.
  - It sets a purge marker whose value is the id of this transaction (`'<xid>'`), compared with `pg_current_xact_id()` as v35 compares its actor setting (`v35:66-77`). It sets the marker itself and resets it before it returns, so a session-level or stale marker is refused. The T9i update guard accepts the marker in place of an actor, only for rows past their `values_expire_at`, and only to null the values and the salt and set `values_removed_kind = 'expired'` and `values_removed_at`. With no actor, those columns are the record, so it writes no T8 row, and `values_removed_by_user_id` stays null (the exemption of section 5.4).
  - The scheduled run comes every 6 hours, from a new module that `server.js` starts, outside `gpexeImportService.js`. It calls the function batch after batch until none is left. Each call is its own short transaction, with `statement_timeout` and `lock_timeout` set.
  - Before every board or history read (routes 1, 4 and 5; route 10 with 18-P), the read runs ONE batch in its own call, before its read transaction, as the identity reads purge first (`gpexeAthleteIdentityService.js:218-229, :250`). A read transaction is read-only (`sourceMetricMappingService.js:173`), so the batch cannot run inside it. Its failure is logged by code only and never fails the read: no route returns a value past its date anyway (Expiry, above).
  - While the server runs, a value stays in the live table at most 90 days plus 6 hours. Dead row versions leave with vacuum.
  - The marker can only remove values already past their date, so it can only reduce data. Like the v35 actor setting, it is no defence against whoever holds the database credentials (`v35:42-46`).
- **Route 7, the on-demand backstop.** An active platform admin runs the same function under their own identity, in one `runWrite`. The removed rows name that admin. From the ids the function returns, the operation writes one T8 `confirmation_values_expired` row per confirmation it removed, each naming its confirmation; the last is keyed (the `startAuditRows` pattern, `sourceMetricActivationSteps.js:192-200`). A replay counts them by `operation_id`. A run that removes nothing writes no row: its replay runs the function again, which is harmless, and a lost answer of it can be `503 outcome_unknown`. The deferred link of section 5.4 requires each row.
- **Erasure on request.** Route 6 removes the values earlier, with `values_removed_kind = 'erased'` and a T8 `confirmation_values_erased` row carrying its fixed reason code. It takes the confirmation's T9 row `FOR UPDATE` first, so it and the removal function never remove one confirmation at once.
  - It needs an active platform admin in the platform workspace. A platform admin who confirmed may erase too: erasure only reduces data, and the T8 row and its actor record who did it.
  - A confirmer or a club admin who is not a platform admin can never remove evidence.
- **What survives.** The salted digest, the facts, who and when all stay. With the salt gone, the digest can no longer be tested against guessed values.
- **Backups.** A backup keeps the values for its own retention. The removal runs before a restored copy is used (the v32 rule; `CURRENT_STATE.md:1214, :4215`).

### 5.9 Rollback, preflight and post-check

**18-A2:** each of M-A and M-B has its own runbook, preflight, post-check and rehearsed rollback (section 15.3). The preflight's "last migration" is the one in force on the day, not 7h's. The count of club versions of fields without parameters in `draft` or `needs_review` belongs to M-B's preflight, since M-B is the migration that stops a club admin's A1 for them.

- **Rollback:** `docs/runbooks/source-metric-confirmations-v52-rollback.sql`. It refuses:
  - once any T9 row exists;
  - when any v52 trigger is missing or disabled, as the v35 rollback refuses (`docs/runbooks/source-metric-mapping-v35-rollback.sql:20-22, :86-90`);
  - once a T2b observation column is set (**18-A2:** 18-P's migration only; M-A creates no such column, so M-A's rollback has no such refusal);
  - once a later migration is recorded (C96's pattern).
  Otherwise it restores the replaced bodies by their md5, and drops the triggers, tables, columns and actions. It is rehearsed on a disposable database: apply → rollback → identical catalog → apply again.
- **Preflight (read-only):**
  - the server version;
  - the last migration (7h's);
  - the md5 of every body to be replaced;
  - T8's action list as expected;
  - the number of club versions of fields without parameters in `draft` or `needs_review` (**18-A2:** in M-B's preflight, counted apart for versions with a copy link to an active system version, which pass the gate and need nothing). **If the count of the others is above 0, the owner decides before the joint deploy of 18-3 and 18-4 who disables or activates them; nothing is disabled automatically** (the *Rukovodilac*, 2026-11-12). After v52 a club admin can no longer activate them, and the board does not adopt them (step 10 reuses only an active version). So they are disabled, or activated under 7h, before v52 is applied;
  - a quiet moment.
- **Post-check (read-only):** every object exists and is enabled; the md5 of each new body; no T9 row.
- Neither is ever run by the executor against a persistent database.

### 5.10 What never changes

- T2a.
- T2b's global scope (it gets no owner column) and its write-once proof.
- `source_metric_evidence_ref_ok`.
- `unit_conversions` and its writers, which stay the platform's (`backend/src/unitConversionService.js:59`).
- T5's schema and unique indexes.
- T6 and its guard; T7.
- v34's T3 trigger (C61).
- The Metrics Core tables: no new registry (C1, ADR-007, `.claude/rules/metrics-core-mapping.md`).
- The import switch.

---

## 6. Evidence and privacy

### 6.1 (c) Which athletes, and which session

- **One stored session.** It is the board's session, of the team being switched on.
- **Two athletes, the same pair for every row of a save** („da je mapirao na isti nacin i jednog i drugog”).
- **How the server chooses the pair:**
  - from the athletes the import admits (`gpexeLevelValues`), at the session level;
  - athletes OptiMove can name come first (a link, or a valid v32 row);
  - pairs are ranked by the number of placeable columns where both values are non-zero and different;
  - ties are broken by an internal stable order that is never returned.
- **Choosing another pair.** `pair=n` is the next pair in that order. *Other athletes* moves to it.
- **No athlete id travels.** None is sent by the client or appears in a URL.
- **Rows that cannot be saved with this pair.** A new row whose two values are equal or zero cannot be saved with this pair. The panel says so. A pre-placed row is not compared, so a legitimate 0 (bursts, for example) does not block it.
- **The level.** The comparison is at the session level only. It is the evidence for the version's drill level too, since the field, its unit and the conversion are the same there (section 4.3 step 10, R9).
- **A global confirmation** (18-P) needs two sessions with two athletes each (Q4).

### 6.2 (d) What is stored, where, and for whom

**Stored**, in T9, T9s and T9i (section 5):
- who and when;
- the session's ids and hash, and its check;
- the binding and its connection;
- per row: the revision, the version, the units and the factors; for a checked row also the display rule and unit compared, the two raw and two stored values, and a random salt (a pre-placed row stores no values);
- a salted database digest, which cannot be tested against guessed values once the values and the salt are removed.

**Never stored:** an athlete id, a GPEXE athlete id, a name, a date of birth, free text, or a value typed by the client.

**Readers:**

| Row kind | Values and the confirmer's display name | Others |
|---|---|---|
| `team_mapping` (a club's save) | That club's active admins, in its workspace; platform admins, in the platform workspace (routes 4–5) or as the club's admin in its workspace | The identical 404 |
| `field_observation` (the platform's global act) | Platform admins only, in the platform workspace (route 10). The values come from some club's session. | A club admin sees only "Confirmed by OptiMove on <date>" on the field |

- **The predicate of routes 4–5**, and of route 3's replay and read-back (section 4.3 step 4): the confirmation's `owner_club_id` is the workspace's club, its team is active and currently in that club, and the club is active. Anything else is the identical 404. A platform admin in the platform workspace is unaffected.
- So a confirmation stays readable after its binding ended. Once its team has moved to another club (possible after an Unbind; no route moves a team today), its old club reads the identical 404. Its values follow their own expiry.
- The confirmer's user id is never returned.
- Coaches, athletes, team workspaces and other clubs get no route.
- Answers are `no-store`.

### 6.3 Expiry, removal and backups

- **Expiry.** Values are kept for N days after the confirmation (Q6; 90 recommended, like an imported snapshot, `gpexeImportService.js:36`). After that, no read returns them, and the scheduled removal nulls them with no actor (section 5.8). While the server runs, a value stays in the live table at most 90 days plus 6 hours; dead row versions leave with vacuum. Route 7 is the on-demand backstop.
- **Erasure on request.** An active platform admin, the confirmer included, can erase values earlier, with a fixed reason code (sections 5.6 and 5.8).
- **What stays after removal.** The salted digest proved what was stored until the removal. With the salt gone, it cannot be tested against guessed values. The facts say who confirmed what.
- **Backups.** A database backup keeps the values for the backup's own retention. Before a restored copy is used, its expired values are removed. This is the v32 precedent (the CURRENT_STATE risk "Backups can outlive the 14-day identity snapshot").

### 6.4 Names

- Names are shown live, only to the board's audience, which lies inside the identity audience of `gpexeAthleteIdentityService.js:138-149`. They come from an athlete link, or from a v32 GPEXE name that has not expired (`v32:88`).
- The board needs a name, never a date of birth. It points to Link athletes. Loading GPEXE names, which also loads dates of birth, stays a separate, secondary step in Imports, outside the board.
- The board reads names with one workspace resolution per request, through its own reader of `display_name` only (section 4.2). It never reads a date of birth.
- Names are never stored, logged, or returned anywhere else.
- History shows *Athlete A* and *Athlete B*.

### 6.5 Logs and answers

- The routes log only the method, the route and an error code (`routes/sourceMetrics.js:74`).
- No value, name, reason or id of an athlete appears in a log, a T8 row or an error body.
- The write's answer carries no value. T8's `request_hash` covers no value (section 4.3 step 3).

### 6.6 The legal basis (O10)

- **What O10 decided.** The owner's „Ne treba pravni osnov” (turn `bdb881f2`, 2026-11-01 21:25:05 UTC) answered whether a legal basis and a notice to athletes, and to the parents of minors, exist for processing names, dates of birth and GPS data from GPEXE. The owner decided the production-use gate is not required, by his own assessment. It is not a legal confirmation (`phase9-importer-mappings-contract.md:905-911`).
- **This contract's reading.** O10 covers the evidence store too. Its values are GPS data of the same athletes, and OptiMove already imports them as their values. Minors may be among them.
- **The gate.** Q11 asks the owner to confirm this reading before the first real confirmation. That confirmation is the hard gate the security lens asks for, without reopening O10.

---

## 7. Automatic switch-on of system mappings

**What "automatic" means here.** No extra act and no document is needed. It is not a background job.

**Which system mappings are eligible for a team:**
- the version is an active system version, so its revision is verified;
- its field has an extractor for the binding's family, and a value in the board's session;
- the team has no open activation of the same field and parameters, and none of the same variable and level (`sourceMetricActivationSteps.js:42-47`);
- under Q9's recommendation, the mapping was not switched off on this binding by an administrator. That is an activation on this binding ended with `end_reason = 'admin_ended'` (`v34:1317-1319`): a *Switch off* (S2, `sourceMetricActivationService.js:193-194`) or a replacement on the board (section 4.3 step 16.2). A version-driven end does not count: A2, the pinned step and a G1 replacement end with `mapping_version_disabled` or `mapping_version_replaced` (`sourceMetricMappingService.js:1465, :1555`; `sourceRevisionLifecycleService.js:245`). Such a mapping reads "Switched off by <name> on <date> · *Add*" and is placed only on *Add*.
- **Amended by J15 (C132, accepted 2026-11-02; in force since v53's deploy on 2026-11-04):** the
  variable is not hidden in the team's club.
- **18-A2:** a system mapping already switched on for the team, by U4's *Use the OptiMove GPEXE set* or in Mappings, is not pre-placed: it is a row already on, "On for <team>" (section 3.3, section 15.4).

**How they are switched on:**
- The board shows every eligible system mapping already placed, with the badge *OptiMove mapping*.
- The admin's one *Save and switch on for <team>* includes them as N explicit T5 rows on that one binding:
  - under the admin's own identity (C106; the v48 basis);
  - with the fixed server reason "Switched on by drag and drop; OptiMove mapping.", which passes `source_metric_text_ok`;
  - each with its row's requirement, explicit in the body (Q8);
  - each with a T9i row with `checked = false`, for the record, with no values.
- The admin can remove any pre-placed row before saving.
- A collision with the club's own open activation is never pre-placed silently. It is shown as "Replaces …", and the admin decides (C33, with C106's club admin as the one who chooses).

**Teams bound later, and new system versions:**
- A team bound later sees its pre-placed rows on its board at its first stored session. Nothing is switched on for it until an admin presses the button.
- When the platform activates a new system mapping, it appears pre-placed, as *New from OptiMove*, the next time a club opens a board. A newer version of a mapping switched off on this binding by an administrator follows Q9's answer.
- When the platform replaces a system version, its own A1 replacement keeps teams on the new version (J16 R7). No version is replaced automatically (C104 Q3).

**Kept:** C8 (an explicit act, per binding), C33's "none is activated automatically", D6, and section G's "never a future binding". In substance, every row is explicit and audited.

**Rejected:**
- a truly unattended switch-on, for example at Bind time or after a check. It needs a "system" actor basis, which v35 does not have (`v35:66-117`). It needs a requirement default, which C23 forbids. It would mix the bind transaction's team locks with T5's.
- a job that switches on for future bindings. Section G forbids it.

**The owner decides Q9.** If the owner wants an unattended form, it needs a new decision that supersedes C8, D6, G and C23, plus a migration on v35 and v48, and is not in this contract.

---

## 8. Relation to J16, C97 / M2b, C110, C111 and 9-B

### 8.1 J16

- J16 stays. It remains the path for:
  - zones and thresholds;
  - replacing a version (by a club admin, only of zones and thresholds; section 5.5);
  - version history;
  - system mappings in the platform workspace.
- **Amended by the J18 gate** (section 5.5, Q13 → C124). After v52 a club admin no longer activates a club version of a field without parameters through J16's A1 under 7h, because A1 writes no T9 row. Under Q13's option one, such a version is activated only through the board, and its replacement is "disable in Mappings, then place again". Under option two, the board gains a version-replacement row. A platform admin's A1, and zones and thresholds, keep J16's path.
- In a club workspace, the board becomes the main path for fields without parameters (R3).
- J16's rule "never an athlete" (sections 7 and 9) stays for J16's own screen. The board is a scoped exception (Q7).
- 18-A records in J16's contract that its flow is built with four steps, the fourth being *Review* ("Step 1 of 4"). 18-4 corrects the comment in `frontend/metric-mappings-data.js:3`.

### 8.2 C97 and M2b (J4)

- **For a club mapping, no document is needed.** The club builds only on verified fields. Its stored two-athlete confirmation is the evidence of its own choice (Q1, Q5).
- **The platform's acts stay as M2b built them.** With Q2 a2 and Q3 b1, a field without parameters may also be confirmed from a stored observation of two sessions with two athletes each (C97's floor, Q4). No document is needed then.
- **Zones and thresholds** keep the documented meaning and operator (C97's meaning half).
- **The pilot's evidence stays as merged.** Its anchors are stored for good (`gpexe-c97-unit-evidence.md:12-13`).

### 8.3 C110

- **At confirmation time,** a stored value outside the variable's limits blocks that row with its reason. For the pair, it is a strong sign of a wrong unit or variable.
- **At import time,** C110 still applies. Form B leaves out such a value, and form C comes later (`discovery:1203-1218`).
- **The requirement toggle explains C110's meaning** in plain words: "Required: if a session has no value here, OptiMove imports the rest and shows 'Required value missing' in the review." and "Optional: if a session has no value here, it is simply left out." It promises no later administrator decision: form C is not in this contract (section 13). If the owner wants Required to stop a session, that is a separate decision.

### 8.4 C111 (J19) — touch points only

**18-A2:** "J19" in this section and in section 13 was the number proposed for C111's contract. J19 has since become the GPS import flow (`docs/ai/gps-import-flow-contract.md`); C111's contract is not written and has no number yet.

1. **Creating a variable.** The board creates a variable only through M3-0's create (`POST /variables`). A column never creates a variable (C1, C2).
2. **Editing in place.** C111 allows an in-place edit of the unit, the daily aggregation, min/max, the condition, the levels and the key only while the variable has no value and no mapping. "No mapping" must count T3 and T4 rows of any status, and every T9i row naming the variable's versions.
3. **After a confirmation.** A change becomes "only a new version". C9 refuses it while the active version pins the old one (`v34:1222-1238`). So the board says: "To change a confirmed variable's unit, create a new variable and place the column again." The replacement is explicit, through "Replaces …".
4. **Always editable.** The name, short name, description and icon stay editable in place. They create no version, so they never touch a confirmation: T9i pins the T4 version, and the T4 version pins the canonical version.
5. **Logging.** Each C111 change is logged by its own v36-style request record. J18's acts are logged by T8 and T9.
6. **Order.** J19 is written separately after phase 9. If its backend is merged before 18-4, the board may offer *Fix the unit* for a variable with no value and no mapping. Otherwise it offers *Create* only.

### 8.5 9-B, 7h, 7i and O16

**18-A2:** all four are settled (section 15.1): 9-B, 7h and 7i are merged and deployed, and O16 is C127 (a team coach sees a club variable's name and unit).

- **9-B.** Nothing switched on has any effect before 9-B is live, because the importer reads T5 only from 9-B (`phase9-importer-mappings-contract.md:77`).
  - After 9-B, a session with no activation is `no_mapped_values` and stays stored. That is the board's source.
  - The first check after a save refreshes the previews (`:75, :444-445`).
  - Section 4.4 shows the lock orders fit.
- **7h is needed** for a club admin's activation of a club version. 18-3 waits for it. Section 2 names what J18 needs from J14: the activation basis. Under Q13's option two it also needs J14's replacement, disable and version-driven end bases.
- **7i is not needed** for system variables. Pre-placed system mappings are C106's S1 starts, which is form (a)'s switch-on. 7i's hiding and copying stay 7i. But the J18 gate refuses the activation of a copy (OD7 (b)) until Q14 → C125 is decided and, under its option one, J15's own migration adds the copy proof (section 5.5).
- **O16** must be decided before any club variable is switched on for a team (J17 O16, `phase9-importer-mappings-contract.md:871-874`). J17 recommends deciding it with 7h. System variables are named for everyone.

### 8.6 What this contract supersedes or amends, by number

| Decision | Effect |
|---|---|
| C97 (the evidence standard) | Amended for club mappings: one session, two athletes, built only on a verified field (Q1, Q5). Amended for global fields only under Q2 a2 and Q3 b1: two sessions with two athletes, from a stored observation (Q4). Kept for the meaning and operator of zones and thresholds. |
| C93 (the meaning is a document reference) | Amended only under a2: an `observed_column` kind for fields without parameters |
| C90 (fail closed: T2b takes only the two documented acts) | Amended only under a2: the observed unit and meaning acts join them, each with its built chain (section 5.7). |
| C40, C95 | The format check stays byte for byte. Observations are linked by typed columns, never encoded into `evidence_ref`. |
| C94 | Kept. A club's confirmation is a new club-scoped act on a new record. |
| C28, J11 OD2 and OD3, J16 sections 7 and 9 | A scoped exception (Q7): (a) the board, routes 1–3, for the club's admins and a platform admin in that club's workspace; (b) the stored values in the history, routes 4–5, for the same audience and for an active platform admin in the platform workspace; (c) with 18-P, route 10, for the platform workspace. The 7e preview and J16 stay aggregate. |
| C23 | Kept in the database. The board prefills a visible per-row toggle (Q8). |
| C8, D6 | Kept. "Automatic" means pre-placed and the same click (Q9). |
| C33, G | Kept: none is activated automatically. Amended: "the platform admin chooses which one a binding uses" (`discovery:378-379, :1988-1989`) becomes the club admin's choice on its own binding (C106), shown as "Replaces …" (section 7). |
| J16's screen under 7h (sections 4–5 of `phase8-mappings-screen-contract.md`) | Amended by the gate (Q13): for a club admin and a club version of a field without parameters, *Activate* and *Replace* are not offered; the screen says "Switch this version on from *Map by drag and drop*." with a link to the board. A direct call answers `409 confirmation_required`. Zones and thresholds are unchanged. |
| J16 R14 (no default, `phase8-mappings-screen-contract.md:460`) | Amended by Q8: the board prefills *Required*, visible on every row. |
| C61, D4 | Kept. A club uses a system variable only through the system mapping. |
| C108 (7h) | A dependency, and amended. J18's gate adds a database condition to a club admin's activation of a club version of a field without parameters, which a club admin then activates only through the board (section 5.5, Q13). Zone and threshold versions keep 7h's J16 path. |
| C109 (7i) and OD7 (b) | Form (a)'s switch-on is done by pre-placed rows. Hiding stays 7i. Amended for form (b), the copy (`discovery:1188-1193`): the J18 gate refuses the activation of a copied club version of a field without parameters until Q14 → C125 is decided. Under its option one, J15 adds the typed copy proof in its own migration (section 5.5). |
| C74–C79 (v35: one acting user per write) | Kept for every write but one: the scheduled removal of expired evidence values runs with no actor, as v32's purge of GPEXE names does (`v32:325`). It can only null values past their date (section 5.8; Q6 → C118). |
| C9, C13, C16, C22, C34, C55, C57, C58, C63, C76 | Kept |
| The plan's order (`metrics-core-plan.md:1062-1074`) | 7h stays right after phase 9. J18 comes next, then the rest of 7i (Q10, on the owner's direct word). |
| D10 (T8's closed column set, `discovery:1752-1771`) | Extended by one typed column, `confirmation_id`, a foreign key to T9 (section 5.6). No value-bearing column is added. |

---

## 9. Tests

### 9.1 The database (disposable `optimove_tests_*`, the T1 runner)

1. **Every rule of T9, T9s and T9i.** A rule that can fail on a row holding values is refused first by its BEFORE trigger, with a fixed message; the table CHECK behind it is a backstop:
   - the kind and owner pairs;
   - the binding pair;
   - the session counts;
   - the nullable foreign keys by kind;
   - raw values non-zero and different on a checked row, stored values D8 of the raw ones on a checked mapping row, and no values, salt, display rule or unit on a row with `checked = false`;
   - the removal facts;
   - the display rule format, and the display unit within its rule's list;
   - `compared_level` is `session`;
   - each rule that can fail on a row holding values is provoked with a planted number in the values. The answer is the trigger's fixed message, and neither the message nor the server log carries the number. Each backstop CHECK is also proven on its own, with its BEFORE trigger disabled on the disposable database.
2. **The actor guard:**
   - another actor is refused with `42501`;
   - a basis that does not match is refused;
   - a club admin of another club is refused;
   - a write in a savepoint is refused;
   - a club admin writing a `field_observation` is refused.
3. **The binding's club, connection, team and check facts.** Each wrong fact is refused with `23514`: a candidate of another team, a `last_seen_check_id` other than the row's check, another bundle hash, a superseded candidate, and a check through another binding included. The guards take no lock on the connection, binding, check or candidate.
4. **Each row against T4 and T2b.**
   - A wrong revision, fingerprint, unit or factor is refused.
   - A stored value that is not D8 of its raw value is refused.
   - A salt or digest the writer supplies is overwritten. Two rows with the same values get different salts and digests.
5. **Append-only behaviour.**
   - Any change of a fact is refused. DELETE and TRUNCATE are refused.
   - The expiry removal is refused before the date, without the purge marker, with a session-level or stale marker (another transaction's id), and for any column but the values, the salt and the removal facts. Under the marker with no actor, it writes no T8 row and leaves `values_removed_by_user_id` null. With an actor, that actor must be an active platform admin.
   - A present but invalid actor setting (not canonical, or of another transaction) is `42501`, never "no actor". A `values_removed_by_user_id` the writer supplies is overwritten with the actor, or with null when there is none.
   - The erasure is refused for a club admin who is not a platform admin, and without an actor. An active platform admin who is the confirmer may erase.
6. **The deferred links.**
   - A confirmation without its keyed T8 row fails at COMMIT.
   - A `team_mapping` act with no rows fails.
   - A row whose version has no open activation started in the same transaction fails.
   - A mismatch between `attested` and `checked` fails.
   - A removal by an actor without its T8 row fails at COMMIT: an erasure without its `confirmation_values_erased` row, or a route 7 removal without the `confirmation_values_expired` row of its confirmation. It fails the same way when the writer supplies a null `values_removed_by_user_id`: an erasure, and an expired removal with an actor. A T8 row of another user or another transaction does not count. The scheduled removal, with no actor, commits with no T8 row. A second `confirmation_values_erased` or `confirmation_values_expired` row for one confirmation is refused.
   - The first four deferred checks fire on INSERT only: a removal on a confirmation of an earlier transaction commits with its T8 row.
7. **The gate.**
   - A club-admin activation fails without its row, and with a row of another version (another version of the same mapping included), another club, another transaction or `checked = false`.
   - A platform admin's A1 is unaffected.
   - A club admin's activation of a zone or threshold version is not gated. A club admin's A1 of a version without parameters is refused (Q13). A club admin's activation of a 7i copy, which has no T9i row, is refused until J15's proof exists (Q14).
   - Through the real route: a club admin's `POST /mappings/:id/versions/:vid/activate` of a `needs_review` club version with `parameter_kind = 'none'` and no T9i row answers `409 confirmation_required`, with no SQL text in the body and nothing written; never `500 internal_error`.
8. **T8.**
   - The new actions' shapes and the `confirmation_id` CHECK are enforced. `confirmation_values_erased` takes only its two reason codes, never typed text. A board's `activation_end` row without its reason is refused (`v50:304-306`).
   - The md5 check refuses a different body in force.
   - Every existing branch is unchanged: a byte comparison of each replaced body's untouched part, as v50 did.
9. **T2b, only if Q2 and Q3 choose it.**
   - The observation columns are write-once.
   - `observed_column` and `unit_observation_id` are allowed only when `parameter_kind = 'none'`.
   - `verified` is reached by the two observed acts.
   - `source_metric_evidence_ref_ok` is unchanged (md5).
10. **The rollback** refuses once a T9 row exists, and when a v52 trigger is missing or disabled. Apply → rollback → identical catalog → apply again is rehearsed.

### 9.2 Routes and services

11. **The audience matrix of section 4.1 on every route:**
    - the identical 404 with `no-store`: before anything is read for a caller outside the two admin bases, and after its id is read, before any refusal that depends on that resource, for a team, binding or candidate outside the club. Only a malformed request, `try_again` and `request_key_reused` may come first;
    - for each other id kind (`targetId`, `mappingVersionId`, an id in `replaces`, `confirmationId`) on routes 2, 3, 5 and 6: an id of another club and an id that does not exist get a byte-identical status and body;
    - `resolveActiveWorkspace` is called exactly once per request on routes 1–3 (a spy);
    - in the platform workspace, only routes 4–10 answer, and only a platform admin;
    - inside the scope, a 404 before any 409.
12. **The board:**
    - proven against expected units; "GPEXE sends values in" never shown for an unproven unit;
    - every reason a column cannot be placed;
    - pre-placed rows. A system mapping switched off on the binding by S2 or by a board replacement is not pre-placed and reads *Switched off by <name> on <date> · Add*. One whose activation ended by A2 or the pinned step is pre-placed again once a newer version is active;
    - the pair is the same on two calls;
    - named athletes come first; with fewer than two, the refusal of R6 (**18-A2:** no distance option; R6, 2026-11-12);
    - `not_enough_athletes`, `snapshot_expired`, `candidate_too_large`, `candidate_source_mismatch`, `no_stored_session`;
    - a session whose last check ran through another binding is never used;
    - a scan that no answer or URL carries an athlete id;
    - no board or save query reads `birth_date`, and the board never calls `listIdentities` (a query spy).
13. **A placement:**
    - the proposal is the one active conversion; no active row gives `conversion_unavailable`;
    - the mismatch sentence;
    - stored values equal `convertAtStorageScale`;
    - the display values and a `placementHash` for each display unit, the hash changing with the unit;
    - the limits block;
    - collisions are listed;
    - `target_scope_mismatch` only for a system variable; a club variable of another club is the 404.
14. **The save:**
    - First, the one-transaction test with every guard on. If it fails, R8's fallback is used.
    - Replay, `request_key_reused`, and `board_changed` when the snapshot, a value or a row's display unit changed. `mapping_version_active` when the mapping's active version differs, factors included.
    - The request hash is the same for two bodies that differ only in `placementHash`, and T8's `request_hash` depends on no value. A new row without `checked: true` is `400 invalid_body`.
    - A replay, a verified COMMIT and a read-back after a team archive, a club archive, a move of the team to another club or a workspace switch answer the identical 404. After an Unbind between the COMMIT and the read-back, the read-back answers `200`, and a replay answers `200` with `replayed: true`, never a 404. A right revoked under a v52 guard answers the 404, never a 500.
    - The seven COMMIT-outcome tests of `gpexe-in-app-import.test.mjs`, in that pattern: verified and unknown outcomes, and a definite refusal at the COMMIT (a deferred J18 link failing), answered as a refusal with nothing written, never `outcome_unknown`.
    - The keyed row is last. The starts carry their fixed reasons (a new row's, a pre-placed row's) and explicit requirements, and the ends carry theirs. A pre-placed row stores no values. Replacements end exactly the listed activations.
    - Run against a 9-B fixture: the importer reads the new activations.
15. **The logs:** a scan of the whole suite's logs for every value and name.
16. **The evidence reads:**
    - club rows go to the club's admins and to platform admins;
    - a test proves no club admin ever receives a value of a `field_observation` row;
    - route 10 answers only a platform admin in the platform workspace (18-P);
    - the confirmer's id is never returned;
    - values are hidden after expiry, before any removal;
    - a confirmation on an ended binding stays readable by the club's admins while its team is active and in the club, and the club is active. After an Unbind and a move of the team to another club, the old club's admin reads the identical 404 on routes 4–5, and a platform admin in the platform workspace still reads it.
17. **Removal:**
    - the scheduled removal runs with no actor, only on rows past their date, and nulls only the values and the salt; the board and history reads run one batch first, in its own call, and its failure never fails the read; the scheduled run loops batches, each its own short transaction;
    - route 6 works only for an active platform admin in the platform workspace, the confirmer included, and only with one of its two reason codes;
    - route 7 works only for a platform admin. It writes one T8 row per confirmation it removed, the last one keyed, and a replay answers the same count. A run that removes nothing writes no row;
    - the T8 rows are written;
    - the digest is kept, and the salt is removed.

### 9.3 Concurrency (real connections)

18. Each case runs with no `40P01` that is not answered `try_again`, and with nothing half-written:
    - the save against A1 and A2 on the same mapping;
    - against S1 and S2 on the same binding;
    - against an Unbind (`try_again` within 2 s);
    - against a 9-B approval and a check-time preview of the same team;
    - against a new version of the target (`canonical_version_changed` or `variable_pinned`), and against its archive (`canonical_version_changed` or `archive_pinned`);
    - against a club archive and a team archive;
    - two admins saving the same placement;
    - against the revision lifecycle's pinned step;
    - against a conversion retirement;
    - against a 7g end attempt (refused while the binding is active);
    - against a role revocation;
    - against a check finalization between steps 5 and 16.3 that sees the session again, replaces it or withdraws it (`board_changed`, nothing written);
    - two saves with crossed rows, a new row on one mapping and a pre-placed row on another and the reverse: no deadlock;
    - the scheduled removal against route 6 and route 7 on the same confirmations: each confirmation's values are removed once, with no deadlock.

### 9.4 Frontend and browser

19. **A JSDOM suite over the real handlers** with `frontend/tests/support/fetch-mock.mjs`, whose fakes keep the server's rules. It covers:
    - tap-then-tap with `aria-pressed`; Enter, Space and Escape;
    - drag only with a fine pointer and hover; on touch, no `draggable` attribute and no grip;
    - the phone sheet;
    - each new row's tick: given only while its values are on screen, kept when the panel closes, cleared when the row, the pair or the session changes or a `board_changed` answer names the row (*Compare again*); an unticked kept row reads *Not compared yet · Compare*; the board's button opens the review card whenever there is a row; the review card's send is enabled only when every new row is ticked, and its disabled text names the unticked columns;
    - the review card: every new row with its two athletes' values and its tick, *Compare* on an unticked row opening its panel, and the pre-placed rows in their own group;
    - *Remove* on a new placement, moving a placed column, and the replace question;
    - changing the athletes or the session: the question, every tick cleared, *Compare again*;
    - the leave guard: N counts only the admin's own changes, untouched pre-placed rows never ask, going back to *Which team?* asks too, and placements never move to another team; and with a save in flight and an unconfirmed result;
    - *Which team?* from Data configuration, and its sentence with no linked team;
    - one sheet at a time on a phone, with *Keep this placement*, *Cancel* and *Back*;
    - the tap texts without a fine pointer, and focus on the first usable variable after a column is chosen;
    - the save body (no values, no athlete ids; each new row's display unit and `checked: true`);
    - *Result not confirmed* · *Check result* with the same key;
    - the generation counter;
    - every refusal's sentence;
    - hostile labels;
    - removing a pre-placed row;
    - the requirement toggle on every row;
    - the review card's text;
    - the after-save link to Imports, which pre-fills a window that includes the session's date.
20. **Browser QA** at 1280, 360, 375 and 390 px.
21. **An integration run on a disposable database with the real routes:** create a club variable, place three columns, tick each, save, read the evidence, switch one off, replay, and let one value expire and be removed by the scheduled run. This is the answer to trigger 5.
22. **The production build** (`npm --prefix frontend run build`).

### 9.5 Mutations

Each new guard has a mutation that the suite kills:
- every CHECK;
- every trigger condition;
- the gate and its `parameter_kind = 'none'` condition;
- the expiry and erasure conditions, the purge marker's and its binding to the transaction, the one exemption predicate, and the overwrite of `values_removed_by_user_id`;
- the salt, and the request hash's field list;
- the per-row tick, on the client and on the server;
- the replay scope (with no binding condition) and the candidate's re-read (its status included);
- each new T8 branch;
- the audience predicate;
- the recompute comparison;
- the pair's distinctness;
- the limits block;
- the hiding of `field_observation` values from a club admin;
- the predicate of routes 4–5;
- Q9's `end_reason` condition;
- the name reader's column list.

### 9.6 Tiers

- During development, only the files that changed are run.
- Before each review, the mapping suites are run: `source-metric-mapping-m2`, `-transitions-7b`, `mapping-activations-7d`, `-v35`, `source-metric-preview-7e`, and the new suites. `test:gpexe` and `test:frontend:fast` are run as well. **18-A2:** the suites added since, and the frontend gate, are in section 15.5.
- `test:backend:shared` runs only if non-GPEXE Training Load code changes, and only on the owner's word for that run, because it writes to the local OPTIMOVE database (`.claude/rules/agent-efficiency.md` §6).

---

## 10. Recommendations (a)–(d)

### (a) What remains of the meaning act, and how it is recorded

| Option | What it means | Cost |
|---|---|---|
| a1 | No change. The platform's meaning act needs a document for every field (C93, C95). | No code. Every new field waits for a merged document before any club can map it. |
| **a2 (recommended)** | The meaning act stays a platform act on the global revision, so `verified` still needs it and activation still needs `verified` (`v34:449-452, :1175-1176`). For a field without parameters, its evidence may be the platform's own stored observation on the board: "this field is the GPEXE screen column <name>". The name comes from the reviewed registry, never typed. It is linked by `meaning_observation_id`. Zones and thresholds keep a document: an operator or a bound cannot be read from two values (`v42:155-159`). A club's drag needs no meaning act; its T9i row records "this column fills my variable". | A migration on T2b and two T8 actions (sections 5.6–5.7), and slice 18-P. For burst and brake, it proves "what GPEXE shows in that column", not GPEXE's definition of a burst. |
| a3 | No meaning act for a club mapping. The club's confirmation replaces `verified` for its own version's activation. | It changes the activation rule (`v34:1175-1176`). Global revisions would stay unverified while clubs import from them. One field could mean different things in different clubs. It breaks the database lens. Not recommended. |

**Why a2.** It removes the document for fields without parameters. It keeps the database's chain intact. It keeps each global fact in one place.

**How it is recorded.**
- Under a2: T2b's `meaning_verified_by` and `meaning_verified_at`, `meaning_evidence_kind = 'observed_column'`, `meaning_observation_id` and the registry code, plus the T8 `source_metric_meaning_observed` row.
- Under a1: as today.

### (b) Does the platform still confirm global fields, or does the first admin's confirmation count?

| Option | What it means | Cost |
|---|---|---|
| **b1 (recommended)** | The platform confirms every global field (C94 kept). A club's confirmation counts only for its own mappings and is never written to T2b. With a2, the platform's confirmation is a short act on the same board, with no document. | A club waits for the platform when it needs a new field. Today only two GPEXE fields without parameters are unconfirmed (burst and brake); five have parameters and need a document anyway. |
| b2 | The first club admin's confirmation is written to T2b and counts for every club. | T2a and T2b have no owner (`v34:259-295, :357-472`). One club would bind every club. The proof is write-once, so a correction is a new revision that replaces every pinned version (C91). Club admins would become writers of the shared catalog, against C94 and G. A wrong unit would be imported in every club. Not recommended. |
| b3 (an add-on to b1) | A club's check of an unconfirmed column without parameters is sent to the platform as a proposal. A platform admin countersigns it with one click, citing the club's stored values. Those values are then platform-only. | A proposal state, a platform list, a route and a screen. One club's values become evidence of a global fact. Q4's two-session floor needs a second session. |

**What is self-service at once.** Every field whose revision is active and verified. Today that is `total_time`, `total_distance` and `max_v`, as the owner reports.

**What a club sees for any other field.** The column with its reason: "OptiMove has not confirmed this column yet. Ask OptiMove support to confirm it." or "Map zones and thresholds in Mappings.".

**The honest tension.** The owner's „Nema potrebe za ovim smaranjima” is fully met for every confirmed field. For a new field, a club waits for one platform act. That act needs no document under a2, and the club itself drives it under b3.

### (c) Two athletes from the same session, or from two sessions?

| Option | What it means | Cost |
|---|---|---|
| **c1 (recommended)** | For a club: one stored session, two athletes chosen by the server, the same pair for every row (section 6.1). | As stated under **Cost** below. |
| c2 | For a club too: two sessions with two athletes each, C97's floor. | A second stored session within 30 days, a second lookup in GPEXE, and more friction against „za dvojicu sportista”. |
| c3 | One session, athletes chosen by the admin. | Athlete ids would travel in the body or the URL, which the security lens forbids, and the pair can be equal or zero. |

**Recommended:**
- **For a club:** two athletes of one stored session, the same pair for every row, chosen by the server (section 6.1). Both values must be non-zero and different for every confirmed column.
- **For a global confirmation (18-P):** two sessions with two athletes each (Q4).

**Why:**
- A conversion is linear, with factors from the one active conversion. Two different non-zero points rule out a wrong scale and a wrong offset.
- The field's unit is already proven globally. The club's check proves its own choice: the right column, onto the right variable, in the right unit.
- One session matches the guide: "open the same session in GPEXE".
- The owner's own words are „za dvojicu sportista”.
- The pilot set a precedent: one session with 13 athletes (`gpexe-c97-unit-evidence.md:17-27`).
- A global act binds every club, so it keeps C97's two-session floor.

**Cost:**
- It is weaker than C97, which is acceptable only because it is club-scoped.
- Only the session level is checked. Drill values use the same extractor, but they are not compared. The session-level comparison is taken as the evidence for the version's drill level too (R9).
- The GPEXE screen rounds seconds inconsistently (±1 s, `gpexe-c97-unit-evidence.md:146`).

### (d) Where the evidence is stored

| Option | What it means | Cost |
|---|---|---|
| **d1 (recommended)** | The new append-only T9, T9s and T9i (section 5), written in the save's transaction. Exact values sit in a separable column set with a salted database digest. No athlete identity is stored. Values are removed N days after the confirmation by a scheduled purge with no actor, as v32 removes GPEXE names, or erased earlier on request. Readers are as in section 6.2. | A new copy of personal performance data. They are the same athletes' GPS values that OptiMove imports. It needs guards, tests, and backup handling. While the server runs, a value stays in the live table at most N days plus 6 hours; dead row versions leave with vacuum. Backups keep it for their own retention, and the removal runs before a restored copy is used. |
| d2 | Values in a `docs/` document, as for C97 | A pull request per confirmation, and athletes' values in the repository. Not possible. |
| d3 | Values in T8 | D10 refuses it: T8 has no value column, and its rows cannot be erased (`discovery:1766-1771`). |
| d4 | Only a digest, no values | Nothing readable is kept. "Ove dve vrednosti" is what the owner's sketch asked to keep. |

**Why d1.** It keeps exactly what the owner named: who, when, and the two values. It shows them only to administrators. Names are never stored. It respects D2's and D10's reason, that values must not sit in rows that cannot be erased: here the values can be removed while the act stays.

---

## 11. Owner decisions

### 11.1 For the owner (Q1–Q14)

Each of Q1–Q11, Q13 and Q14 becomes the decision named here when decided. It is written into section C of the discovery document before any code (plan rule A3).

- **Q1 → C113. Accept J18** as the contract of C112, with the effects listed in section 8.6. Recommended.
- **Q2 → C114. (a):** a1, a2 or a3. Recommended: a2.
- **Q3 → C115. (b):** b1 or b2, and b3 as an add-on or not. Recommended: b1, without b3 for now.
- **Q4 → C116. The floor of a global confirmation from an observation** (only with a2 and b1): two sessions with two athletes each, or one session as the pilot's precedent. Recommended: two sessions.
- **Q5 → C117. (c), for a club:** one stored session, two athletes, the same pair for all rows, chosen by the server, values non-zero and different. Recommended.
- **Q6 → C118. (d) and its bounds:**
  - d1, with N days. Recommended: 90.
  - Recommended: a scheduled removal of expired values with no actor, as v32 removes GPEXE names (`v32:88, :325`). It nulls the values and the salt of rows past their date and records the removal on the row. Those columns are the record, so it writes no T8 row. It runs every 6 hours in its own module, outside `gpexeImportService.js`, batch after batch, and one batch before every board or history read. While the server runs, a value stays in the live table at most 90 days plus 6 hours; dead row versions leave with vacuum. Route 7 stays as an on-demand backstop by an active platform admin, with one T8 row per confirmation it removed, the last one keyed (section 5.8).
  - The alternative: removal only by a platform admin's audited act (route 7). It keeps "every removal has an actor and a T8 row", but expired values stay stored, hidden, until a platform admin acts, with no time limit.
  - Erasure by an active platform admin in the platform workspace, the confirmer included, with a fixed reason code (`erasure_request` or `wrong_confirmation`), never typed text.
  - Backups keep values for their own retention. The removal runs before a restored copy is used (the v32 rule).
- **Q7 → C119. The two-athlete values** as a scoped exception to C28, J11's OD2 and OD3, and J16 sections 7 and 9. It covers (a) the board, routes 1–3, for the club's admins and a platform admin in that club's workspace; (b) the stored values in the history, routes 4–5, for the same audience and for an active platform admin in the platform workspace; and (c) with 18-P, route 10, for the platform workspace. Recommended.
- **Q8 → C120. The requirement on the board:** a visible per-row toggle, prefilled *Required* (the owner's pilot choice), explicit in every saved row. The database keeps no default, so C23 stays there. Alternative: no prefill, one tap per row. Recommended: the prefill.
- **Q9 → C121. What "automatic" switch-on means:** pre-placed and switched on by the same click, under the admin's identity. No background job, no system actor, never a future binding. Recommended, with one rule: a system mapping switched off on this binding by an administrator is not placed again. That is a *Switch off* (S2) or a replacement on the board (`end_reason = 'admin_ended'`). A version-driven end (A2, the pinned step, a G1 replacement) does not count. Such a mapping is shown as "Switched off by <name> on <date> · *Add*", so a save made for another column never switches it back on. The owner also decides whether a newer OptiMove version of a mapping switched off this way is offered again as *New from OptiMove*, or stays "Switched off … · *Add*" (section 7). A truly unattended form needs its own decision (section 7).
- **Q10 → C122. Order, start and mark.**
  - The order: 7h (J14) right after phase 9 as the plan says, then J18, then the rest of 7i.
  - "Phase 9 ends" means 9-B is merged and deployed and M6 is closed (step 16 passed, the freeze ended).
  - The mark is ★★. The plan entry and its "Start" line are written on the owner's direct word.
  - The option of shipping the board before 7h, for system rows only, is not recommended.
- **Q11 → C123. O10's reach:** does „Ne treba pravni osnov” also cover the stored evidence values, minors included? This is needed before the first real confirmation.
- **Q12. O16** (does a team coach see a club variable's name and unit?). Decide it with 7h. No club placement is saved before it. This is J17's O16, recorded here, not a new decision.
- **Q13 → C124. The gate's consequence for a club admin** (section 5.5). After v52 a club admin activates a club version of a field without parameters only with a checked T9i row, and A1 writes none. So 7h's J16 path no longer does it, a replacement included.
  - Option one: a club admin activates such a version only through the board, and a replacement is "disable in Mappings, then place again".
  - Option two: the board gains a version-replacement row with v43's G1 chain.
  - Zone and threshold versions keep 7h's J16 path either way.
  - Either way, the gate's refusal is `409 confirmation_required` with its sentence, and J16's screen under 7h offers no *Activate* or *Replace* for such a version (section 8.6).
  - Recommended: option one. It matches step 10's `mapping_version_active` ("Disable it in Mappings first"), and option two can be added later.
- **Q14 → C125. A 7i copy and the gate** (section 5.5). 7i's form (b) (OD7, `discovery:1188-1193`) copies a system mapping as the club's draft version. Its activation by a club admin has no T9i row, so the v52 gate refuses it.
  - Option one: J15 adds, in its own migration, a second proof the gate accepts: a typed link from the club version to the system T4 version it copies, with identical revision, fingerprint, units and factors.
  - Option two: the copy goes through the board, with a two-athlete check.
  - Recommended: option one, decided with 7i. Until then the gate refuses a copy's activation.
  - **Answered by J15's acceptance (2026-11-02):** option one, in 7i's migration (J15 sections 7.2 and 7.6); C125
    itself is recorded with J18's other decisions.

### 11.2 For the *Rukovodilac* (R1–R9)

**Decided by the *Rukovodilac* on 2026-11-12** (its answer to the executor's delta plan; section 15.2 gives each): R1 the split of section 15.3; R2, R3, R4, R7 and R9 as written; R5 only `total_time`, `total_distance` and `max_v`; R6 the refusal, no distance fallback; R8 the fallback only, after the failing test is shown.

- **R1.** The PR split of section 2. Recommended: as written.
- **R2.** The route names and shapes of section 4.2. Recommended: as written.
- **R3.** In a club workspace, the board is the main path for fields without parameters. J16's flow and its card stay. Recommended: yes.
- **R4.** Pre-place the club's own active mappings on another team's board, beside system mappings. Recommended: yes.
- **R5.** The display registry's first entries (`total_time`, `total_distance`, `max_v`; counts later), and the GPEXE display-unit choice from the handbook's page 11. Each rule is added only with evidence and a test.
- **R6.** With fewer than two athletes OptiMove can name, either name an athlete by its GPEXE screen distance (the C97 pairing), or refuse with the way to Link athletes. Recommended: the refusal, with the way to Link athletes. The distance fallback stays an option, only when the distance column is proven and its two values differ.
- **R7.** At most 20 rows per save; History as a secondary tab; *Switch off* as a separate act. Recommended: yes.
- **R8.** If the one-transaction test of 18-3 fails: two keyed operations behind one button. First the mapping writes, then the confirmation and the starts. Each has its own lost-answer handling, and nothing is shown as switched on until both settle. Recommended as the fallback only.
- **R9.** The board's versions keep the levels both the field and the variable allow. The session-level comparison covers the drill level of the same version (section 4.3 step 10). Alternative: board versions are session-only and drill mappings stay in Mappings; then a club admin's drill activation of a field without parameters is refused by the gate. Recommended: as written.

---

## 12. Risks

- **A wrong confirmation imports wrong values.** C13 forbids reinterpreting a fact afterwards. Mitigations:
  - only verified fields can be placed;
  - the server proposes the conversion;
  - the limits block;
  - a distinct, non-zero pair;
  - a tick per new column, given while its values are on screen, with every row's values in the review card;
  - approval per candidate, while the import switch stays off;
  - one-tap *Switch off*;
  - the undo runbook for anything already imported.
- **The one-transaction save is designed against the guards, not proven.** The test comes first, and R8 is the fallback.
- **Each user's GPEXE display units differ** (page 11). The third column follows the unit the admin chooses. A wrong choice makes the admin refuse to confirm, which is the safe direction.
- **Only the session level is checked.** Drill values use the same extractor but are not compared. The session-level comparison is taken as the evidence for the version's drill level too (R9).
- **A second copy of personal data.** It is bounded: while the server runs, values are removed from the live table at most 90 days plus 6 hours after the confirmation (dead row versions leave with vacuum), or earlier on request, and a removed value cannot be recovered from the salted digest. Backups keep values for their own retention (section 6.3).
- **A removal with no actor.** The scheduled removal runs under a purge marker, not a user. The marker is bound to its transaction and set only inside the removal function. It can only null values past their date, so it can only reduce data. Like the v35 actor setting, the marker is no defence against whoever holds the database credentials (`v35:42-46`).
- **Clubs may wait for the platform.** A new field waits for one platform act. That is the honest limit of "no hassle" under b1.
- **Dependencies:** 7h, O16 and 9-B; Q14 for 7i's copy; the M6 freeze; a plan order that needs the owner's direct word.
- **T5 collisions** between system and club mappings on one team. The board shows them before saving.
- **The snapshot lives 30 days after it was last seen.** The board needs a recent search and never sends a GPEXE request.
- **C9 pinning.** A club's active version pins its own variable, so a unit change becomes a new variable (C111). C61 is kept, so no club can freeze a system variable.
- **Migration size.** T8's revision guard and v48's actor guard are replaced, and T2b too under a2. Each replacement is md5-checked. The rollback refuses once the tables are used.
- **The pair must be findable.** Without links or GPEXE names, the board refuses and points to Link athletes (R6). **18-A2:** R6's distance option, the only thing that would have helped there, is rejected (2026-11-12), so linking athletes is the way.

---

## 13. Not in this contract

- C111's contract (J19), except the touch points of section 8.4.
- 7h (J14) and 7i (J15), except what J18 needs from them and the copy proof Q14 asks of J15.
- Zones and thresholds on the board.
- Evidence at the drill level.
- Unit conversions created or maintained by a club.
- New sources and adapters.
- C110's form C.
- A background, Bind-time or future-binding switch-on.
- b3's proposal queue, unless the owner chooses it.
- Showing evidence to coaches.
- Any GPEXE request, and any read or write of a persistent database by the executor.
- The import switch.
- Any change to sections 1–4 of the plan, its ★ marks or its phase order. Those happen only on the owner's direct word.

---

## 14. Review record

*Empty for the proposal.* The reviews of 18-A2 are recorded in its pull request. This section will record the internal reviews (`code-reviewer`, `db-reviewer`, `security-reviewer`), then the *Rukovodilac*'s and the *Nezavisni revizor*'s ★★ reviews, and the owner's decisions on Q1–Q14.

---

## 15. Refresh at `cc20f632` (18-A2, 2026-11-12)

This section brings the contract to `main` as it is when J18's code starts. It was written from a check of
`c930cde1..cc20f632` limited to the files and migrations this document cites. No database was read and no test was run
for it: it is documentation only. A reference in this section is to `cc20f632`.

### 15.1 What changed on `main`, and what it changes here

**Prerequisites, all merged and deployed** (`docs/ai/CURRENT_STATE.md`, the discovery document's status line):

| Prerequisite | Where | Evidence in the code |
|---|---|---|
| 7h, the club admin's activation basis (C108, C126) | PR #339 (`0334ddbd`), migration v52 | T4's basis CHECKs admit `club_admin` (`v52:103-108`); the activation branch of T4's update guard (`v52:202-207`); T8's row shape (`v52:261-265`); `mayTransitionMappings` (`backend/src/sourceMetricAccess.js:42-45`) |
| 7h-F, *Save and activate* | PR #345 (`ee85875c`) | J16's screen offers a club admin the activation of its club's version |
| LO-1: every service rights lock users first, A1 in D's order | PR #344 (`ad0e0d63`) | `backend/src/sourceMetricMappingService.js:1462-1469` |
| LO-2: the database's rights-lock functions take the users row first | PR #359 (`d67cc7b0`), migration v54 | the three source-metric functions, `v54:210-274` |
| 7i-B1: copy, hide, the copy link (C125 option one) | PR #352 (`26b6c8bc`), migration v53 | `source_metric_mapping_version_copies` (`v53:265-276`); the hide in T5's insert guard (`v53:709-715`); `lockHides` (`backend/src/sourceMetricActivationSteps.js:156`) |
| 9-B, the importer reads T5 | PR #326 (`b6c2254`) | `backend/src/gpexeImportMapping.js:88` |
| O16 (Q12) | C127; 7h-V, PR #337 (`d3dcb641`) | a team coach sees a club variable's name and unit |
| Q1–Q14 | C113–C125 | discovery document, section C |

**The bodies in force that J18 replaces.** Sections 5.4–5.6 name them by the migration that last wrote them at
`c930cde1`. At `cc20f632` they are:

| Function | Last written by | J18 replaces it in |
|---|---|---|
| `source_metric_audit_row_ok` | v52 (`:239`; before: v48) | M-A (the new actions' shapes) |
| `source_metric_audit_actor_guard` | v52 (`:355`; before: v48) | M-A (`club_admin` on `mapping_confirmation`) |
| `source_metric_audit_insert_guard` | v48 (`:339`) | M-A |
| `source_metric_audit_revision_guard` | v50 (`:211`) | M-A (the new branches) |
| `source_metric_mapping_versions_update_guard` | v52 (`:117`; before: v34) | not replaced: the gate is its own trigger (section 5.5) |
| `source_metric_activations_insert_guard`, `_update_guard` | v53 (`:632`), v52 (`:284`) | not replaced |
| `source_metric_actor_basis`, `_require_platform_admin`, `_require_club_admin` | v54 (`:242`, `:210`, `:225`) | not replaced; the new guards call them |

The md5 list of every replaced body is taken from `origin/main` when a migration's branch is cut, checked again right
before its pull request is opened, and checked a third time on the merge tree right before the merge, together with the
prefix check (section 15.3). Another executor is adding migrations (the GPS import's estimates), so both the number
and the list may move while a ★★ pull request is open.

**Facts of sections 1–9 that are no longer true:**

- **The hide lock is in force.** v53's T5 insert guard takes it itself for a system mapping and refuses a start while
  the binding's club hides the variable. So the save takes the hide locks through `lockHides` after the rights (step
  14) and before the state checks; it gains the refusal `variable_hidden` (step 15.10); and a hidden variable's system
  mapping is not pre-placed (sections 3.6 and 7).
- **A1 is in D's order** since LO-1; section 4.4's first sentence said otherwise. Rights checks lock the users row
  first, in the services (LO-1) and in the database (LO-2). A new guard of M-A or M-B that locks rights rows follows
  that order (`.claude/rules/migrations.md`).
- **Candidates (v57, the session undo).** `gpexe_import_candidates` has `import_undone_at` (`v57:118`), and its unique
  key is (team, session, content) among rows that are not undone (`v57:136-138`). So one session can have an undone row
  and a live one. **Everywhere the board reads or re-reads a candidate to work on it, it requires
  `import_undone_at is null`:** route 1's default and chosen session, route 2, step 5, step 15's re-read and the T9s
  guard (marked in place: section 3.2's row, the note under section 4.2's table for routes 1 and 2, section 4.3's steps 5 and 15, section 4.4's undo row and section 5.4). An imported candidate is still never deleted, and a check row is
  still never deleted.
  - **History reads no candidate** (routes 4 and 5; the *Rukovodilac*, 2026-11-12). T9s copies the session's start
    at the save (`session_started_at`, section 5.2), so History shows the session's date from T9s and never reads the
    candidate row, which an undo marks and, when it was never imported, a purge may delete.
- **The mapper (v62).** `gpexeLevelValues` takes the team's session time zone
  (`backend/src/gpexeImportMapper.js:490`). The board and the save pass it, so a session whose devices report more than
  one time zone passes the same gates as its import.
- **Stored values can be removed again.** The session undo deletes T6 rows (`metric_value_source_provenance`;
  `v63:761`, as `v57:611` and `v60:785` before it). This matters only for C121's "while no value is written" (section 15.2).
- **Imports.** The screen was rebuilt (J19's U1–U6, D5, IMP3). `renderFoundHtml` is at
  `frontend/gpexe-import-view.js:665`, but it is no longer the place a first-time admin lands: that is the setup
  stepper (section 15.4). There is now also a per-team import switch (v56, `gpexe_team_import_switch`), beside the
  server's `GPEXE_IMPORT_APPLY_ENABLED`, which still gates every approval (`backend/src/gpexeImportService.js:46-47`).
  The board depends on neither: it reads a stored session. Section 3.8's Imports-not-yet sentence (Q10's early-ship
  option) is not used, since 9-B is live.
- **GPEXE names.** U3 added suggested athlete pairs, and a team coach now sees a date of birth there (C123, J19 R2).
  The board's rule is unchanged: its own reader selects `display_name` only, never `birth_date`, and it never calls
  `listIdentities` (`backend/src/gpexeAthleteIdentityService.js:289`) or `listPairSuggestions` (`:410`).

### 15.2 The decisions since the proposal

**The owner's C113–C125** (2026-11-04; the discovery document, section C) and what each changes here:

| Decision | Effect on this document |
|---|---|
| C113 (Q1) | The contract is accepted, with the effects of section 8.6. |
| C114 (Q2) | Softer than a2: the platform confirms global fields, **zones and thresholds too**, without a document, by a note "this column is column X on the GPEXE screen"; for zones and thresholds an image of the GPEXE screen may be added and is not required. **A club takes responsibility for its own mappings and thresholds, with an in-app instruction that warns what to check:** on the board that is the guide of section 3.11 (18-A2's reading; 18-4, its text for the ux review). The same instruction for a club's zone and threshold versions, which stay on J16's screen, is not part of J18; it is recorded for 18-P's amendment or a J16 follow-up. Section 5.7, routes 8–10 and 18-P as written do not fit this form. **They are not built by J18's migrations or slices;** 18-P gets its own contract amendment and its own later migration (the *Rukovodilac*, 2026-11-12). Until then the platform's two acts stay as M2b built them, and C97's text stands until a pull request amends it. A club still places only a field whose revision is active and verified. |
| C115 (Q3), C116 (Q4) | b1 without b3; two sessions with two athletes for a global confirmation. Both concern 18-P only. |
| C117 (Q5) | Section 6.1 as written. |
| C118 (Q6) | Sections 5.8 and 6.3 as written: 90 days, the scheduled removal with no actor, erasure by a platform admin. |
| C119 (Q7), C120 (Q8) | As written. |
| C121 (Q9) | Section 7 as written, plus **a delta that is not in this contract yet**: the admin may change a mapping while no value is written under it; after the first value the rule is replacement. It is a separate slice after 18-4, with a short proposal to the *Rukovodilac* first (what it needs from T4, v43's replacement chain and the gate; that an undo can make "no value" true again). Until it is built, a wrong saved placement is corrected by C124's path. |
| C122 (Q10) | J18 starts, ★★. |
| C123 (Q11) | No legal basis is needed for the stored confirmation values. It opens again if a minor athlete is ever added. |
| Q12 | C127: a team coach sees a club variable's name and unit. |
| C124 (Q13) | Option one: a club admin activates a club version of a field without parameters only through the board; a replacement is "disable in Mappings, then place again". |
| C125 (Q14) | Option one, already built in v53: the gate accepts the copy link. |

**The *Rukovodilac*'s decisions of 2026-11-12** (section 11.2):

- **R1.** The split of section 15.3: two migrations, no 18-P, 18-A2 first.
- **R2, R3, R4, R7.** As written: the routes of section 4.2 (routes 8–10 wait for 18-P); the board is the main path for
  fields without parameters in a club workspace; the club's own active mappings are pre-placed on another team's board
  as *Your club's mapping*; at most 20 rows, History as a secondary tab, *Switch off* as its own act.
- **R5.** The display registry starts with `total_time`, `total_distance` and `max_v` only, each with its evidence and
  a test. A column without a rule cannot be placed as a new row; it reads "OptiMove cannot show what GPEXE displays for
  this column yet." (a text proposed by 18-A2, for the ux review of 18-4).
- **R6.** With fewer than two athletes OptiMove can name, the board refuses and points to Link athletes. No distance
  fallback.
- **R8.** The two-operation fallback is used only after the failing one-transaction test has been shown to the
  *Rukovodilac*.
- **R9.** As written: a board version keeps the levels both the field and the variable allow, and the session-level
  comparison covers the drill level of the same version.
- **M-A's shape, History's date and the joint deploy.** M-A builds the `team_mapping` shape only (section 5.1's note); T9s copies the session's start, so History reads no candidate (section 15.1); 18-3's merge waits for 18-4's GO and the two go out in one deploy (section 15.3).
- **The gate has no gap.** The refusal `confirmation_required` must not reach production before the board's backend.
  So the gate is its own migration, M-B, in 18-3's pull request and deploy.
- **U4's button stays.** Section 15.4.

### 15.3 The slices as they are built (R1)

| Slice | Content | Migration | Mark | Reviewers (`CLAUDE.md` matrix) | External-review triggers |
|---|---|---|---|---|---|
| **18-A2** | This refresh, and the J18 row of the discovery document (documentation only) | — | ★★ by its content | `code-reviewer` on the whole diff; `db-reviewer` on sections 4–5 and 15.1, 15.3; `security-reviewer` on sections 4, 6, 7 and 15 | 1, 2, 3, 4 (on its content) |
| **18-1** | **M-A:** T9, T9s and T9i with their guards and deferred links (sections 5.1–5.4); T8's `confirmation_id`, the actions `mapping_confirmation`, `confirmation_values_expired` and `confirmation_values_erased`, and the replaced T8 bodies (section 5.6, without the two observed acts); the removal function, its purge marker and the salt (section 5.8). Only the `team_mapping` shape (section 5.1's note). It is the first migration to alter T8's table: it checks the action CHECK's text before it replaces it (as `v52:87-96` does for T4), locks T4, T5 and T8 in the writers' order (as `v52:63-65`) with T8, the table it alters, taken `nowait` (the modes are fixed and reviewed in 18-1), and creates the index for the gate's lookup. Runbook, read-only preflight and post-check, rehearsed rollback (it restores v34's CHECK text and the replaced bodies by md5), md5 gates. **No gate, no T2b column, no application code.** | M-A | ★★ | `db-reviewer`, `security-reviewer` | 1, 2, 3, 4 |
| **18-2** | Backend reads: the board, one placement, the evidence (routes 1, 2, 4, 5); the name reader; the pair rule; the display registry (R5) | none | ★★ | `code-reviewer`, `security-reviewer` | 2 |
| **18-3** | Backend writes: the save (route 3, section 4.3); the scheduled removal in its own module; routes 6 and 7. **M-B, the gate** (section 5.5): one new trigger on T4, accepting a checked T9i row or v53's copy link, with the service's `confirmation_required` mapping in the same pull request. It replaces no body; its precondition and preflight pin the md5 of T4's update guard in force and T4's trigger set. Its preflight counts the club `draft` and `needs_review` versions of fields without parameters that have no copy link; above 0, the owner decides before the joint deploy who disables or activates them, and nothing is disabled automatically (section 5.9). | M-B | ★★ | `code-reviewer`, `security-reviewer`, `db-reviewer` | 1, 2, 3, 4, and the five-point rule |
| **18-4** | Frontend: the board, the panel, the phone sheet, the entries of section 15.4, the history, the guide; J16's sentence and link in place of *Activate*, *Replace* and *Save and activate* for a club admin's version of a field without parameters | none | ★ (proposed) | `code-reviewer`, `mobile-qa`, `ux-design-reviewer`, and a narrow `security-reviewer` pass on how values and names are rendered | 2; 5 is answered by the real-route run of section 9.4 item 21 |
| **18-E** | Facts after each merge | none | — | `code-reviewer` | — |
| later | C121's change while no value is written (its proposal first); 18-P (its amendment first) | their own | — | — | — |

- **Why the gate can stand alone.** It is a trigger of its own on T4 (section 5.5), not a line of T4's update guard, and
  no guard of M-A depends on it: M-A's deferred link asks only that a confirmation's versions are active with an open
  activation started in the same transaction (section 5.4). Between M-A and M-B the three tables exist and nothing
  writes to them.
- **M-B's first body knows the copy link.** A club admin's activation of a `needs_review` club version with
  `parameter_kind = 'none'` passes with a checked T9i row of this transaction (section 5.5), **or** with a row of
  `source_metric_mapping_version_copies` for that version whose system version is still active, read with a plain read
  and never a lock (J15 sections 7.2 and 7.6). J15's R7 ("whichever migration lands second replaces the other's gate
  body") is settled by this: v53 landed first, so no body is replaced for it.
- **Each migration** has its runbook, its read-only preflight and post-check SQL, and a rollback rehearsed on a
  disposable database (apply → rollback → identical catalog → apply again). M-A's rollback refuses once a T9 row exists
  or a later migration is recorded (M-B included, so M-B is rolled back first); M-B's refuses under a later migration and drops only its trigger and function.
  Neither is applied by the executor: only on the owner's order naming the file.
- **18-3 and 18-4 are deployed together** (the *Rukovodilac*, 2026-11-12). M-B is applied only in the deploy that
  also carries the board's frontend. M-B stays in 18-3's pull request, where the gate and the service's
  `confirmation_required` mapping are tested together, and **18-3's merge waits for 18-4's GO**: the two are merged one
  after the other and go out in one deploy. So a club admin never meets the refusal without the board and its link.
- **The prefix rule.** Before each migration pull request is opened, and again before its merge, the 12-digit prefixes
  of the merge tree are checked for a duplicate (`.claude/rules/migrations.md`).

### 15.4 The entries, and U4's button

- **From the setup stepper** (U6b, `frontend/gpexe-guide-steps.js`; J19 section "U6b"). In its *Variables* step,
  *Choose my own* opens the Mappings screen today (`frontend/gpexe-guide-view.js:90-92`). 18-4 points it to the board
  for the step's team, **only in a club workspace** (section 3.1's conditions carry over; in the platform workspace it
  stays the Mappings screen, since routes 1–3 answer the identical 404 there). This replaces section 3.1's link on the
  Imports success line.
- ***Use the OptiMove GPEXE set* stays as it is** (the *Rukovodilac*, 2026-11-12): U4's write, the existing
  `POST /activations`, one request per system mapping (`frontend/gpexe-guide-data.js:213`). A system mapping is not
  gated, so M-B does not touch it. J19's note that this button is re-pointed to the board
  (`docs/ai/gps-import-flow-contract.md:111`) is narrowed to *Choose my own*; 18-4 amends that line (not this pull request: that file is another executor's while the GPS import is being built).
- **On the board,** a mapping already on for the team reads "On for <team>" with *Switch off* (section 3.3), whoever
  switched it on. Only an eligible system mapping that is not on is pre-placed (section 7).
- **From Data configuration:** the card *Map by drag and drop* and *Which team?*, as section 3.1.
- **Never for a coach.** A coach sees the administrator's steps as one row and never gets the board, its link or a
  route of it; the server answers the identical 404 (section 4.1). **The board never sends a GPEXE request**
  (section 4.6).

### 15.5 Tests added to section 9

- **The recorded-SQL-order test of the save** (`.claude/rules/migrations.md`, the rule of PR #346): the SQL the save
  sends is recorded and asserted against section 4.4's order with the hide locks after the rights, with no locking
  clause between the first write and the COMMIT.
- **Candidates:** an undone import is never the board's session, on any of the reads of section 15.1, route 2
  included; a session with an undone row and a live row uses the live one; an undo between step 5 and the T9s insert
  answers `board_changed` with nothing written; a confirmation whose candidate was undone or deleted afterwards still shows its
  session date in History, from T9s, and History's queries read no candidate row (a query spy); after an undo that leaves no live row, route 1 answers `no_stored_session`, never the
  undone row. **The T9s guard alone** (a direct insert, past the service) refuses an undone candidate with its fixed
  `23514` message, added to section 9.1 item 3, with its mutation.
- **The session's start:** a direct T9s insert whose `session_started_at` differs from the candidate's is refused with
  the guard's fixed `23514` message, with its mutation (the comparison removed); a null value is refused; route 1
  answers `409 session_start_unknown` for a candidate with a null start and never picks one as the default session.
- **The time zone:** a mixed-zone session of a team with a session time zone is readable by the board exactly when it
  is importable.
- **The hide:** a hidden system variable is not pre-placed; a save that names it answers `variable_hidden`; the save
  against a hide and a show of the same variable ends without a `40P01` that is not answered `try_again`.
- **The gate (M-B):** section 9.1 item 7, plus a copy: a club admin's activation of a copied draft passes through the
  link and is refused once the linked system version is disabled (J15 section 10).
- **Regression suites before each review**, beside those of section 9.6: `source-metric-mapping-club-admin-7h`,
  `source-metric-variables-club-7i`, `lock-order-lo1`, `rights-locks-users-first-lo2`.
- **The frontend gate** (`.claude/rules/testing-evidence.md`): the whole `--preset frontend-fast` on the head and on a
  clean `origin/main`, compared file by file; the production build; `--preset e2e`, run alone.
- **The runner:** every command is `node scripts/test-runner.mjs …` (T1); databases are disposable
  `optimove_tests_*` ones on a local PostgreSQL, removed after the run.

### 15.6 References that moved

Same content at a new place, unless section 15.1 says the content changed. The table holds the references 18-A2
located again for the slices' work; it is not a complete list, and an unlisted reference of sections 0–13 is to
`c930cde1`.

| Cited in sections 1–13 | At `cc20f632` |
|---|---|
| `sourceMetricMappingService.js:763-847` (`runWrite`), `:776-780`, `:93-95` (the bounds) | `:789`; the bounds at `:91-95` and `:802-806` |
| `sourceMetricMappingService.js:63-77` (`commitCertainlyRefused`) | `:72` |
| `sourceMetricMappingService.js:312-324` (the allowlist), `:341, :398` (`ACTOR_REFUSALS`) | `TRIGGER_REFUSALS` at `:314`; `ACTOR_REFUSALS` at `:345`, used at `:402` |
| `sourceMetricMappingService.js:909` (the call of `writableMappingSummary` in `createMapping`), `:921-926` (its owner-scope check) | `:935` (the function is defined at `:719`); `:947-952` (`createMapping` starts at `:926`) |
| `sourceMetricMappingService.js:1367-1518` (A1), `:1465-1506` (its writes), `:1465, :1555` | `activateVersion` at `:1403`, its writes at about `:1517-1560`; `:1518` and `:1607` |
| `sourceMetricActivationSteps.js:100-128` (`lockListedBindings`), `:138-158` (the collision checks), `:163-186` (`insertStarts`), `:192-200` (`startAuditRows`), `:222-252` | `:110`, `checkListedStarts` `:201`, `:228`, `:257`; `lockOpenActivations` `:276`, `endOpenActivations` `:295` |
| `sourceMetricAccess.js:38-40`, `:46-61`, `:66-130`, `:88-90` | `mayTransitionMappings` `:42`, `mayManageActivations` `:51`, `activationInScope` `:62`, `bindingClubHolds` `:71`, `resolveMappingAdminWith` `:93`, `rightsStillHold` `:128` |
| `gpexeImportMapper.js:419-441` (`gpexeLevelValues`) | `:490` |
| `gpexeImportService.js:35-36` (retention), `:1613-1620` (`listAthleteLinks`) | `:38-39`; `:1750` |
| `gpexeAthleteIdentityService.js:246` (`listIdentities`), `:138-149` | `:289`; `identityAdminBasis` `:157` |
| `sourceMetricPreviewService.js:34` (16 MiB) | `:35` |
| `sourceMetricPreview.js:33-56` (`convertAtStorageScale`) | `:37` |
| `frontend/gpexe-import-view.js:441-451` (`renderFoundHtml`) | `:665` |
| `frontend/gpexe-import-data.js:1263-1265` (`identityViewer`) | `:1684` |

### 15.7 As built: 18-1, migration M-A (v65)

Built on `c16f0047` (the merge of 18-A2). Not applied anywhere but disposable test databases; it is applied only on
the owner's order (runbook `docs/runbooks/source-metric-confirmations-v65.md`).

- **The file:** `migrations_v2/202611121800_training_load_v65_source_metric_confirmations.sql`, with
  `docs/runbooks/source-metric-confirmations-v65-preflight.sql`, `-postcheck.sql`, `-rollback.sql` and the runbook.
  The number and the prefix are the ones free when the branch was cut and are checked again before the pull request
  and on the merge tree.
- **What it holds:** sections 5.1–5.4, 5.6 and 5.8 in the `team_mapping` shape, as section 15.3 lists them: T9, T9s
  (with `session_started_at`) and T9i with their guards and the two deferred links;
  `remove_expired_confirmation_values(p_limit)`; T8's `confirmation_id`, three actions, two CHECKs, one index and the
  four bodies. No gate, no T2b column, no application code: nothing writes these tables until 18-3.
- **The four bodies** are the ones in force (v52's row shape and actor guard, v48's insert guard, v50's revision
  guard; their md5 is pinned in the migration, the preflight and the rollback) with the new lines between
  `-- M-A (J18) begin` and `-- M-A (J18) end`. The suite strips the marked lines and compares the rest with the old
  body, byte for byte.
- **Departures from the text above, each for the *Rukovodilac*'s review of 18-1:**
  - **Locks.** Section 15.3 said T4, T5 and T8. M-A locks T4 first (`SHARE ROW EXCLUSIVE`, which T9i's foreign key
    takes anyway), creates its tables (their foreign keys take `SHARE ROW EXCLUSIVE` on the clubs, teams, users,
    connections, bindings, checks and revisions, each within the runner's `lock_timeout`), and only then takes T8
    (`ACCESS EXCLUSIVE`, `NOWAIT`) right before T8's own statements. So T8 is never held exclusively while the migration
    waits for another table (the database review's finding). It neither changes nor locks T5.
  - **The display registry in the database.** Section 5.3 asks that a checked row's display unit is "a unit from that
    rule's closed list". The lists are a function, `source_metric_display_unit_ok(rule, unit)`, with the three rules
    R5 allows and the one unit each has evidence for: `duration_mmss` → `mm:ss`, `distance_m` → `m`, `speed_kmh` →
    `km/h` (`docs/ai/gpexe-c97-unit-evidence.md`). Section 3.5's choice of another GPEXE display unit has no evidence
    in the repository (the handbook's page 11 is not in it), so a further unit is a later migration with its evidence
    and test. Until then the panel offers one unit per rule.
  - **The salt** is 16 bytes from `gen_random_uuid()` (122 random bits), and the digest uses the core `sha256()`: no
    function of `pgcrypto`, whose schema differs between the local and the deployed database.
  - **The expiry** is `confirmed_at + interval '2160 hours'` (90 days), so the CHECK that ties the two does not depend
    on a session's time zone.
  - **Rows that were not compared** store no digest (section 5.3 said only that the trigger computes it).
  - **A system row is never compared** (`checked = false`): a new row is always a club's own mapping (C61). The guard
    and a backstop CHECK refuse a checked `system_mapping` row.
  - **The removal function** returns the ids as one `uuid[]` and takes a limit of 1 to 1000. The purge marker is the
    setting `optimove.source_metric_confirmation_purge`.
  - **T8's shapes:** `mapping_confirmation` names the team and the confirmation only; the two removal rows name the
    confirmation only. T8's table comment now mentions confirmations; the rollback restores v34's text.
  - **Foreign keys.** T9's foreign keys take `FOR KEY SHARE` on the binding and the connection, as T5's foreign key
    to the binding already does. A Reconnect's update of the connection does not conflict with it. An Unbind takes the
    binding `FOR UPDATE`, so it and the foreign key's check wait for each other, exactly as a T5 start and an Unbind
    already do: no new lock edge. The guards themselves read both rows with plain reads (section 5.4).
  - **The removal guard checks the right first:** an acting user who is not an active platform admin, and a present
    but invalid actor setting, get `42501` on every update of T9i, before any refusal about the row.
  - **T8's new rows carry the transaction's time:** the two new chains of the revision guard refuse a `performed_at`
    other than `now()`.
  - **A row added late is still checked.** T9i has its own deferred link, which holds every row to the activation and
    `attested` rules at COMMIT, also when the confirmation's own link was forced early.
  - **A club admin's removal audit row** is refused by T8's insert guard first ("a club-admin row names a club
    mapping", `23514`), as for every platform-only action before it; the right itself is refused `42501` on T9i.
- **For 18-3, from the reviews of 18-1** (acceptance items there, none of them a change of M-A):
  - the save holds the binding `FOR SHARE` before its first write (step 13), because the T9 guard reads it without a
    lock; its recorded-SQL-order test covers it;
  - route 6 takes the confirmation's T9 row `FOR UPDATE` before it touches T9i (section 5.8), with a recorded-order
    test: an eraser that updates rows first can deadlock with the removal function;
  - a route never forwards a database error's `detail` or `constraint` (a unique or foreign-key violation prints
    ids), and every value travels as a bind parameter;
  - the preflight's block 10 reports how the server logs statements; if it logs bind parameters, the values of a save
    would reach the server log, which is decided before 18-3 is deployed;
  - the removal function's scan walks every expired confirmation on each call; negligible now, recorded;
  - the digest's canonical text joins fields with `|` and no escaping; sound for an append-only row, recorded.
  - the deferred links hold at COMMIT for the rows a transaction inserted; a state changed later in the same
    transaction after the links were forced early (raw SQL only) is not checked again, so 18-3 does not rely on it;
  - a T8 row's `performed_at` is the transaction's start, while `confirmed_at` and `values_removed_at` are the
    clock's: History orders by the T9 time, never by comparing the two.
- **Tests** (`backend/tests/source-metric-confirmations-v65.test.mjs`, disposable databases, 17 tests): the preflight
  and every flipped block; the `NOWAIT`, md5 and CHECK refusals; the exact catalog change; the post-check; every
  refusal of the rollback; apply → rollback → the identical catalog → apply again; and the guards of sections 9.1
  items 1–8 and 10 and 15.5 for a save written as raw SQL in section 4.3 step 16's order. Section 9.1 item 7 (the
  gate) is M-B's; item 9 (T2b) is 18-P's.
- **Not covered here, stated:** the removal link's condition that the audit row is of the same transaction and user
  is a backstop behind the revision guard and the actor guard, which refuse every case first; no test reaches it
  alone. The server log was checked by hand on the local server for the planted values (none found); the suite itself
  asserts the error's message, detail, hint and context.

- **Two corrections of the migration's header comments** (the *Nezavisni revizor*'s L1 and L2 at the GO on
  `92d745fb`; the frozen migration file is not reopened for wording, so the correct statements are these):
  - **Savepoints (header lines 48-50).** "A write inside a savepoint is refused: every guard compares the xmin" holds
    only for the guards that read T9 and for the deferred links. A T9s or T9i row written inside a savepoint after
    a T9 row written outside it is not refused by its own guard; the deferred links decide at COMMIT.
  - **Locks (header lines 76-77).** T8's `ACCESS EXCLUSIVE` and the `SHARE ROW EXCLUSIVE` locks on the foreign-key
    targets are held until the migration's COMMIT, not "only for its own statements". The effect is the intended
    one because T8 is taken last, so the migration never waits for another table while it holds T8. A failed
    `NOWAIT` applies nothing and leaves the old instance serving; the deploy is simply repeated.

### 15.8 As built: 18-2, the board's reads

Backend only, no migration, no write route. Stacked on 18-1 (v65). Nothing links to these routes before 18-4.

- **Routes** (`backend/src/routes/sourceMetrics.js`, under `/api/training-load/sources/metrics`), each `GET`,
  `Cache-Control: no-store`, a strict query (an unknown or repeated key, a malformed id, a `pair` that is not a
  non-negative integer is `400 invalid_query`, and only for a caller who is admitted):
  - route 1, `/board?teamId[&candidateId][&pair]`: the board of a team;
  - route 2, `/board/placement?teamId&candidateId&pair&fieldId&targetId`: one placement;
  - route 4, `/confirmations?teamId[&cursor]` (50 per page) and route 5, `/confirmations/:confirmationId`.
  Route 3 (the save) is 18-3.
- **Audience.** Routes 1 and 2: the active admin of the team's club, or a platform admin, **in that club's
  workspace** only. Routes 4 and 5 also admit a platform admin in the platform workspace (History, after an Unbind
  or an archive). Everyone and everything else is the identical `404 {"error":"notFound"}`: a coach, no role,
  another club's admin, an unknown, archived, unbound or other club's team, an unknown or other club's candidate,
  an undone (v57) or superseded candidate, another club's or a hidden variable, an unknown field. A refusal about
  the session or the pair is given only after all of that holds: on route 2 the column and the variable are
  resolved before the session's own `409` and before the pair is chosen. Routes 4 and 5 use one predicate; a
  platform admin in the platform workspace lists and reads a team's History after a team or a club archive.
- **Modules.** `backend/src/sourceMetricBoard.js` is pure: the display registry (version 1; `total_time` in s as
  `mm:ss`, `total_distance` in whole metres (no evidence says the GPEXE screen shows a decimal of a metre, so one rule), `max_v` in m/s as km/h to one decimal, exact decimal arithmetic),
  the pair rule and the placement hash. `backend/src/sourceMetricBoardService.js` reads the database through the
  M2 kit's bounded read. `gpexeImportMapper.js` gains `gpexeLevelValuesKeyed` (the 7e raw read with each athlete's
  internal key); the importer's architecture guard holds its one caller, the board, to the registry's extractors.
- **The stored session.** The newest by its start among the team's candidates that are not undone or superseded,
  whose snapshot is present and not expired, whose check ran through the team's current binding and whose start is
  known. Chosen by id, each state has its own answer: `409 snapshot_expired` (`current.reason` `expired` or
  `purged`), `409 session_start_unknown`, `409 candidate_source_mismatch`, `409 candidate_too_large`,
  `409 candidate_not_importable` (the import's own gate, with its code). No candidate: `409 no_stored_session`.
- **The pair** (section 6.1, R6). Only athletes OptiMove can name: a link's athlete name first, then the stored
  GPEXE identity's `display_name` (never its date of birth; the identity service is not called). Pairs are ranked
  by how many placeable columns they can prove (both values there, non-zero and different), ties by the internal
  key, at most 200. `pair` is an index in that order; the answer carries `{ index, count, labels }` and never an
  athlete id or a GPEXE athlete id. Fewer than two such athletes, or no pair that proves a column:
  `409 not_enough_athletes`; an index past the end: `409 pair_out_of_range` with the count. No distance fallback.
- **The board** (`board`): `team`, `session`, `pair`, `displayRegistryVersion`; `columns` (every `gpexe` /
  `rest_v1` field with its label, its proven unit or none, `placeable`, one `reason` of `field_not_confirmed`,
  `field_has_parameters`, `source_metric_unsupported`, `display_rule_missing`, `no_value_for_pair`, the display rule
  and units, and the pair's two raw values); `variables` (the club's, then OptiMove's that the club does not hide;
  an OptiMove variable is a target only through OptiMove's own active mapping); `on` (open activations of the
  team); `preplaced` (OptiMove's and the club's active versions that are not on, not switched off by an
  administrator and not on a hidden variable, each with the pair's raw and stored values and a placement hash);
  `replaceable` (the same, when it collides with something that is on, with what it would replace); `switchedOff` (the mapping's latest activation on this binding was ended by an administrator: who and when;
  never placed again by itself, Q9; a mapping switched on again and then ended another way is pre-placed again).
- **A placement** is `200` for an admitted caller with known ids and a usable session and pair: either
  `placeable: false` with one code (`target_scope_mismatch`, `activation_exists` (the same contract is already on
  for the team, OptiMove's or the club's own), the column's reason, `target_not_usable`, `condition_mismatch`,
  `conversion_unavailable`, `level_not_allowed`, `source_metric_target_taken`, `mapping_version_active`,
  `pair_not_distinct`, `value_outside_limits`; a refusal carries no value) or the proposal: the conversion (the one
  active one, or `same_unit`), the levels, the two athletes' raw and stored values, what the GPEXE screen shows per
  display unit, one `placementHashes[unit]`, `reusesVersionId` when the club's own active version is the same
  contract, and the `collisions` with what is on for the team.
- **The placement hash** is sha256 over the candidate's bundle hash, the pair index and the pair's two names (the
  index alone does not say who the pair is), the field revision, the target
  version or the mapping version, the conversion, the display rule and unit, and the four values. It is a
  concurrency token, not a secret; nothing stores it. 18-3 recomputes it on the save.
- **History.** A row's `valuesState` is `present`, `expired`, `erased` or `not_compared`. A value is never returned
  past `values_expire_at`, removed or not. The confirmer is returned by name, never by id. The page cursor
  carries the last row's time in microseconds as text from SQL; anything but that exact form is `400 invalid_query`.
- **The one write.** Before a board read (route 1) and a History read (routes 4 and 5), never before a placement,
  the service runs one batch of `remove_expired_confirmation_values` in its own short transaction on its own
  connection: `statement_timeout` 2 s, `lock_timeout` 0.5 s, and a 4 s client bound that closes the connection. A
  failure or a stall is logged by its code only and never fails the read.
- **Never:** a GPEXE request, an identity load, a date of birth, a write other than that removal batch, a lock.
- **Tests:** `backend/tests/source-metric-board-18-2.test.mjs` (disposable database, the real HTTP stack, 9 tests:
  the audience matrix, the board, the session states, placements with the 404 before any 409, what exists on the
  team, a hidden variable, History with expiry, a failed and a stalled removal, History's pages, cursor, erased
  values and archives, and the leak scan of every answer and log line) and
  `backend/tests/source-metric-board.unit.test.mjs` (7 tests, the pure module and the keyed read). The importer's
  architecture guard also holds that no source module sets the board's two test seams and that the internal key
  is asked for only through `gpexeLevelValuesKeyed`.
- **Not covered, stated:** no test counts the calls of `resolveActiveWorkspace` (the routes go through the
  router's existing `adminContext`, once per request); `candidate_too_large`, `candidate_not_importable` and
  `target_not_usable` have no test of their own; a `replaceable` row is asserted only as absent; no test holds an
  item row's lock against the removal batch (the stalled batch is a planted one); the routes were not run against
  a real GPEXE bundle.
- **For 18-3:** a board replacement ends the replaced activation as `admin_ended`, so the replaced mapping then
  reads as switched off by an administrator, not as pre-placed. Whether that is Q9's intent for a replacement is
  decided with the save.

### 15.9 As built: 18-3, the board's writes and migration M-B (v66)

Backend and one migration. Stacked on 18-2. Its merge waits for 18-4's GO; the two go out in one deploy.

- **R8: the save is one transaction.** The first thing built was the test: the whole of section 4.3 step 16 written
  as raw SQL in its order, committed for real with every guard, the gate and every deferred link on
  (`club-activation-confirmation-gate-v66.test.mjs`, test 1: two new mappings, their versions through both
  transitions, a replaced activation, the confirmation, the starts, the keyed row; one xmin). It passes, so no
  fallback of R8 exists.
- **M-B, v66** (`migrations_v2/202611131000_training_load_v66_club_activation_confirmation_gate.sql`; runbook
  `docs/runbooks/club-activation-confirmation-gate-v66.md` with its preflight, post-check and rehearsed rollback).
  - One function and one `BEFORE UPDATE` trigger on T4, `source_metric_mapping_versions_v66_confirmation_gate`,
    which sorts after v34's update guard and v35's actor guard. It replaces no body, alters no table, changes no row.
  - It fires on `needs_review → active` with `activated_basis = 'club_admin'` and `parameter_kind = 'none'`, and
    passes with a T9i row (`club_mapping`, checked, this version) of a confirmation of **this transaction** by the
    activating user for the version's club, or with v53's copy link to a system version that is still active.
    Otherwise `23514` with one fixed text, mapped to `409 confirmation_required`.
  - "This transaction" is v35's xmin comparison. A confirmation of an earlier, committed transaction by the same
    admin does not pass. A confirmation written inside a savepoint of the same transaction does not pass either (a
    subtransaction has its own xid): the gate fails closed, and v65's own guards refuse such a write before it.
  - Its precondition pins the md5 of T4's update guard and actor guard and T4's six triggers, all enabled.
  - The preflight's block 4 counts the club `draft` and `needs_review` versions of fields without parameters, apart
    for those with a copy link. Its block 5 is a refusal, run as the application's role: each column says whether a
    save's bind parameters could reach the server log - statement, duration and sampled-transaction logging,
    logging on error, pgaudit by class or by its object-audit role, auto_explain with parameters or a verbose plan,
    a printed plan, and any role or database override of these settings. Not covered by it, stated in block 6: the
    pooler's own log, and a value inside an error's text (v65's guards refuse such rows first with fixed texts).
- **Route 3, the save** (`backend/src/sourceMetricBoardSaveService.js`), as section 4.3, with these points:
  - It recomputes with the board's own read functions, twice: on plain reads, to answer a stale or refused row
    before any lock, and again after every lock, which is the answer that counts.
  - Every foreign or unknown id of the body (team, candidate, field, variable, mapping version, listed activation of
    another binding), in whichever row, is the identical 404 before any 409: all rows' ids are resolved first.
    (A body that is not valid JSON is `400 invalid_json` from the application's parser, before any route, for every
    caller alike.)
  - A refusal names its row: `409 <code>` with `current.rowIndex`. The codes are the placement's own, plus
    `board_changed`, `canonical_version_changed`, `activation_changed`, `activation_exists`,
    `variable_taken_on_binding`, `variable_hidden`, `binding_not_active`, and the read's `409`s (`board_too_large`
    among them).
  - A row's `replaces` must be exactly what is on and in its way. The club's own version that is already on for the
    team is `activation_exists`, never an end and a start of the same contract.
  - An OptiMove variable is saved only as a `preplaced` row. The club's own active version is switched on for
    another team as a `preplaced` row too, unchecked (R4).
  - A mapping whose active version is the same contract is reused: no version is written, and the confirmation's
    checked row names the reused version.
  - The request hash covers identities only. No value, name or hash is written to T8, logged or returned.
  - The candidate is compared again after the locks by its `bundle_hash`, `last_seen_check_id` and `status`; an
    undone or superseded one is no longer found. Each is `board_changed`.
  - The database's refusals are mapped, each text held word for word to the migration that raises it (the save
    suite's test 11): a lost right under a guard of v35, v48, v52 or v65 is the 404; a candidate that changed under
    the save, and a row another save wrote first (the T3 pair key, the one-active indexes, T5's open-row indexes),
    are `board_changed`.
  - A replay checks the scope of routes 4 and 5 again under `FOR SHARE`. It answers after an Unbind and is the 404
    once the team is archived.
- **The lock order** is section 4.4's, proven by the SQL the save sends (the save suite's test 7): conversions,
  fields, revisions, mappings, versions, variables, their levels, the activations to end, the binding, the team, the
  users row before the role row, the club, the hide locks, and last one advisory lock per binding
  (`board-save:<binding>`); then the first write, and no locking clause after it. The mappings are locked one by
  one in ascending id, whatever the order of the body's rows. The candidate, the team import lock and the v11
  connection are never locked.
  - **One save per binding.** Two admins' saves with crossed rows would meet on T5's open-row indexes in two orders
    (a `40P01`). Only a save takes the binding's key, after its last row lock, so it adds no cycle; the second save
    reads what the first wrote and answers a 409 of the board. Proven on free-running connections (test 12).
  - **Foreign keys.** Three rows the save does not lock are key-share locked by a foreign key after the first write:
    the variable's version (T4's), the connection (T9's) and the check (T9s's). Key share conflicts only with a
    delete or a `FOR UPDATE`; Connect, Reconnect, Test and Unbind take the connection `FOR NO KEY UPDATE`, and A1
    has the same edge on T4.
  - **A replay** locks the users row before the team and the club (both `FOR SHARE`); a save locks the team first.
    No writer holds a team row exclusively and then waits for a users row, so no cycle forms.
- **A replacement is not a switch-off** (the *Rukovodilac*, 2026-11-12, option B). The end keeps `admin_ended`; the
  board reads "switched off by an administrator" only when the mapping's latest activation on the binding ended
  `admin_ended` and its `activation_end` row's operation holds no `mapping_confirmation` row. A replaced mapping
  that is still eligible is offered as a replacement of what replaced it. No end reason was added.
- **Routes 6 and 7** (`backend/src/sourceMetricConfirmationAdminService.js`): API only in J18, for an active platform
  admin in the platform workspace; the runbook says how they are called. Route 6 takes a fixed reason code and
  locks the confirmation's row first. Route 7 runs the removal function under the admin's identity and writes one
  audit row per confirmation whose values this transaction removed (a confirmation the schedule emptied a moment
  earlier is returned by the function too and gets no row), the last keyed; a call that removes nothing writes
  nothing.
- **The scheduled removal** (`backend/src/sourceMetricConfirmationRemoval.js`, started by `server.js`): every 6 hours
  and one minute after the start, batch after batch of 200 until none is left, at most 200 batches a run. Each batch
  is its own transaction with `statement_timeout` 2 s, `lock_timeout` 0.5 s and a 4 s client bound that closes the
  connection. It is the one implementation; the board's reads call the same batch. Two server processes cannot
  remove the same confirmation: the function takes each confirmation's row `FOR UPDATE SKIP LOCKED`. One run at a
  time in a process. It starts nothing inside the test runner or without a database.
- **One plan per board read.** A read built one import plan per readable column. It builds one for all of them
  (`gpexeSessionValuesKeyed`, session level only; the importer's architecture guard holds its one caller to the
  registry's extractors). The plan's session and athlete gates run as before; no extractor is called on a drill
  row any more, and no extractor refuses a session. Measured on this machine on a synthetic session of 40 athletes with two drills each,
  per board read: 3 columns 11.8 ms → 3.9 ms; 30 columns 111.5 ms → 5.4 ms; 120 columns 448.1 ms → 9.2 ms. A read
  of more than 60 000 cells (readable columns × athlete rows of the session, drill rows included) is refused with
  `409 board_too_large`, before any value is read.
- **v67 (MT-A) reaches production before v66** (it was merged after it, and sorts after it by file name). The runner
  applies by file name and takes v66 all the same, so nothing in the deploy changes. What this slice changed for it:
  the preflight's block 1 expects v67 recorded with its checksum and as the last migration and no OTHER migration
  after v66; the post-check's block 1 expects v67 recorded and no other later migration; the rollback tolerates
  exactly v67 (another table, it does not read the gate and is not rolled back with it) and refuses any other later
  migration. The suites that build "before the gate" take every migration but v66, so the rehearsal database holds
  v67 when v66 is applied -
  production's own order - while a database built from the whole list in one run gets v66 first, a fresh deploy's
  order. The migration file itself is unchanged.
- **Suites of other slices.** After v66 a club admin's A1 on a field without parameters is refused by design. The
  suites of 7h, LO-1 and 9-B's concurrency exercise a club admin's A1, A2 and replacement on test fields without
  parameters; they build their database without the gate. Those code paths are unchanged and stay in force for zones and
  thresholds: a club admin's A1 of a zone version runs through the real routes on the v66 schema in the gate's
  suite (test 3b). M2's architecture test lists the save and the two removals as writers.
  - **Each such file keeps a test on the full schema** (the *Rukovodilac*, 2026-11-12): the suites of 7h and of
    9-B's concurrency apply v66 in their last test and run the same route for what stays allowed (a platform admin's
    A1 in the club's workspace, the club admin's S1 and S2, an import through the club's mapping), and see the club
    admin's A1 refused with `confirmation_required`.
  - **Each condition of the gate has a behavioural test** (the *Nezavisni revizor*'s L2; gate suite test 4b): the
    item's own xmin (the item written inside a savepoint of the transaction that holds the confirmation), the
    confirmation's own xmin (the confirmation committed earlier, only its item written here), `item_kind` (a
    `system_mapping` row for the version does not pass) and the copy link's system side (a link whose other side is
    the club's own active version). Each case is a refusal with the gate's own text and nothing changed, and each is
    paired with the same rows made to pass. **Stated:** `item_kind` and `checked` cannot be separated behaviourally
    - v65's `source_metric_confirmation_items_system_unchecked` forbids a checked system row, which the test asserts
    - so removing `item_kind` alone from the gate is still killed only by the md5 pin of test 5; the other three
    conditions are killed by 4b itself (four mutations run, four killed).
  - **The LO-1 suite has it too** (added once PR #504 fixed its tests 7 and 8, which had left connections holding a
    `users` row): its last test applies v66 and runs a platform admin's A1 against the real revocation in both
    orders, a club admin's A1 queued behind its own revocation (the identical 404) and a club admin's A1 alone
    (`confirmation_required`, nothing written), with no `40P01`.
- **The schedule and test databases.** The removal schedule starts nothing under node's test runner, under the T1
  runner, without a readable `DATABASE_URL`, or when the database's name begins with `optimove_tests_` (the e2e
  world starts a real server process on such a database). It would be harmless there: it only nulls values already
  past their date, which no route returns.
- **Tests:** `club-activation-confirmation-gate-v66.test.mjs` (6: R8, the gate, the routes, a zone version not
  gated, the copy link, the migration's rehearsal) and `source-metric-board-save-18-3.test.mjs` (12: the save, the
  body and the audience, refusals by row, reuse and replacement, races through a hold seam before the locks and
  before the first write, the COMMIT outcomes, the recorded lock order, routes 6 and 7, the scheduled removal, the
  size cap, the mapped database refusals, two admins' crossed saves on free-running connections).
- **Not covered, stated:**
  - the races but the crossed saves and the two-run removal use a hold seam inside the save;
  - route 7 against a removal that lands between the function's snapshot and its lock is not raced;
  - `test:backend:shared` was not run (no local development database);
  - the save was not run against a real GPEXE bundle.

### 15.10 As built: 18-4, the board's screen

Frontend only, stacked on 18-3; no migration, no backend change. English texts only.

- **Where.** Training Load > Data configuration: a sixth card, *Map by drag and drop*, and the section `board`
  (`frontend/metric-board-{data,view,actions,drag}.js`, state slice `state.trainingLoad.board`). The setup stepper's
  *Choose my own* opens the board for the stepper's team in a club workspace and stays the Mappings screen in the
  platform workspace (15.4).
- **Who.** A club workspace only (`boardContext()`): the club's admin, or a platform admin working in the club. A
  team's coach, the platform workspace and every other workspace get no card, no section and no request; the server
  answers 404 again for everyone else, and the screen reads it as "not available in this workspace".
- **Which team.** The club's teams with an active binding, from the connections list. One team opens at once; two or
  more ask *Which team?*.
- **The board.** Two om-cards: *GPEXE columns* (label, unit, the two athletes' raw values, the key under Technical
  details, why a column cannot be placed) and *Variables* (the club's first, then OptiMove's), with a slot per
  variable: empty, new, pre-placed, on, switched off. A column that is already on for the team is shown as used and is
  not offered for dragging: it is switched off first.
  - **A computer** (fine pointer with hover): the browser's own drag and drop with its own type; tap a column and then
    a variable works too, and is the only way by keyboard.
  - **A phone** (760 px and below): one column of cards and one bottom sheet at a time (*Fill which variable?*, the
    check, Switch off); the page behind it does not scroll; nothing drags; 44 px targets; the save bar is sticky only
    while there is something to save.
- **The check.** Route 2's answer as it is: the proposed conversion, both athletes' raw, stored and displayed values,
  *What to watch for*, the tick *Matches GPEXE for both athletes* (never set for the admin) and *Required*. A refusal
  is a sentence and never becomes a row. *Other athletes* reads every placement again and takes every tick away.
- **The save.** Offered only when every new row is ticked. The body carries identities, the display unit, the
  placement hash, the tick and the requirement: never a value, an athlete, a unit, a factor or an owner. One request
  key per save; a lost answer is *Result not confirmed* and *Check result* sends the same request. A repeated request
  settles only on the saved answer or on a `409` the service states by name: signed out, no access, a busy or a failed
  server leave it not confirmed, with the same key. A stated refusal saves nothing, says so, reads the board again and
  takes every tick away. The outcome is shown where the admin is (inside the review, inside the Switch off question,
  on a phone inside the sheet) and takes the focus. A save holds at most 20 rows. After a save: "Saved. Switched on
  for <team>", the slot reads "On for <team>", and the notice links to *Find new sessions*.
- **Switch off.** Asks first, then the existing `POST …/activations/:id/end` with its own request key.
- **History.** The second tab: who confirmed and when, the session, each row with its conversion and the stored
  values as "Athlete A / Athlete B". No athlete name.
- **Mappings.** `409 confirmation_required` on a club admin's *Activate* reads "Switch this version on from Map by
  drag and drop." with a button that opens the board.
- **What stays in memory.** Leaving the board, by any way, drops what was read for it (the two athletes' names and
  values, the notice of the last save, the history); the next visit reads the board again. A workspace change drops
  everything, a team asked for by the stepper included.
- **Leaving.** An unsaved placement, a save in flight and an unconfirmed result ask before a section, tab, team or
  workspace change and on `beforeunload`. Escape closes the topmost of review, panel, chosen column.
- **One sentence and one next step** (the owner's standing decision of 2026-11-13, applied to the board's
  sentences only, no layout change): a column's key, a refusal's code and the GPEXE team's number are shown to a
  platform admin only (Technical details, "linked to GPEXE team N"); a club's admin sees the team's name alone. The
  lead is one sentence, and Required has one line of help instead of two.
- **Not checked, stated:** dragging in Firefox (the column is a `<button draggable>`; the e2e runs Chromium only; tap
  a column and then a variable works in every browser).
- **Left out of 18-4, stated:** the session chooser (the board uses the session route 1 picks) and the choice of the
  display unit (the first the server offers is sent).
- **Tests:** `frontend/tests/metric-board.actions.test.mjs` (the real handlers and markup against answers captured
  from the real routes) and `e2e/tests/metric-board.test.mjs` (1280 px drag, 390 px tap, a coach offered nothing), with
  the fake source's `board` scenario (three linked athletes with different values).
