# J18 — mapping by drag and drop (C112): one board per team, a stored two-athlete confirmation, and switching on system mappings (proposed ★★ contract)

This is the contract of decision C112 in `docs/ai/gpexe-metric-variable-mapping-discovery.md` (the *discovery document*). C112 records the owner's direction of 2026-11-01 for mappings after the pilot. This contract builds on phases 1–9: migrations v34–v50, the routes of J1–J13, the Mappings screen of J16 and the importer of J17. J14 and J15 stay reserved for 7h and 7i. J19 is proposed for C111 (editing a canonical variable), which is a separate contract after phase 9. This contract only names the points where C111 touches it.

| | |
|---|---|
| Status | **Proposed** by the executor on 2026-11-01. It follows the *Rukovodilac*'s order of that day, 20:33 UTC. The order, paraphrased: write the contract now as a proposal, documentation only; code comes after phase 9; sections 1–4 of the plan stay untouched; answer questions (a)–(d) as recommendations for the owner. It was drafted from a discovery and design panel: five fact sheets, three competing designs, and three review lenses (owner intent, security and privacy, database integrity). **No code is written before the owner accepts this contract and decides Q1–Q11 and Q13. O16 (Q12) gates 18-3, and Q11's answer gates the first real confirmation. No code is written before phase 9 ends, unless the owner says otherwise** (Q10 proposes what "ends" means). |
| Verified against commit | `c930cde1`, the merge of PR #323 (documentation only), on `8fa0ea7`, the merge of PR #322 (9-0). Code is unchanged since `656cf88` except the 9-0 files and `backend/scripts/gpexe-backup-verify.mjs` with its test. The 9-0 files are `backend/src/gpexeImportService.js`, `gpexeImportPreview.js`, `sourceImportCredentialResolver.js`, `gpexeCheckTiming.js`, `backend/scripts/gpexe-undo-imported-session.mjs`, `frontend/gpexe-import-view.js`, `frontend/gpexe-import-data.js` and their tests. This contract touches none of them. Every file and line reference is to `c930cde1`. The production database was not read. Production facts are quoted from `docs/ai/CURRENT_STATE.md` as the owner reported them. |
| Mark | ★★, proposed. The triggers are 1, 2, 3 and 4 of `CLAUDE.md`, plus the five-point rule for a transaction with an external effect. Trigger 5 applies to the frontend slice unless an integration run against the real routes covers it. A mark, a phase entry and its "Start" line go into the plan only on the owner's direct word (`metrics-core-plan.md:432-435`). For a ★★ phase the owner approves the contract before any code (`:450-452`). |
| Owner decisions | Section 11.1 (Q1–Q13). Q1–Q11 become decisions C113–C123, and Q13 becomes C124, once decided, and are written into section C of the discovery document before any code (the plan's rule A3, `metrics-core-plan.md:458-460`). |
| Decides | The owner decides Q1–Q13. The *Rukovodilac* decides R1–R8 (section 11.2). The *Nezavisni revizor* reviews this contract and every ★★ slice. |

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
- Active system mappings are already placed for the team. The admin may remove them.
- One checkbox, *I checked in GPEXE: the values of both athletes match.*, and one button, *Save and switch on for <team>*, send every placement. They use one request key and one transaction.
- The stored record is the evidence: who confirmed, when, which session, and the two athletes' values. No document is needed.

**What stays as it is.**
- The source-field catalog (T2a / T2b) stays global, platform-only and write-once. A club's confirmation never writes to it and never counts for another club.
- A club maps only a field whose revision is active and verified: its unit and meaning are proven. So the version's source unit is always the revision's proven unit. The fact guard (`v34:1563-1566`) and 9-B's `source_unit_mismatch` stay unchanged.
- A club uses a system variable only through its active system mapping. C61 stays: no club mapping ever targets a system definition.
- Every write has a real acting user (v35). There is no system actor. Nothing is switched on for a team that is bound later.

**What is new in the database.** Migration v52 comes after 7h's v51 (section 5). It adds:
- three append-only, owner-keyed tables for the evidence: the act, its session, and its rows with the values;
- typed foreign keys from the evidence to the field revision, the mapping version, the binding and its connection, and the check;
- values the server recomputes from the stored snapshot, never sent by the client;
- no athlete id, GPEXE id, name, date of birth or free text in these tables;
- value columns that can be removed, while a digest computed by the database survives the removal;
- a database gate: a club admin can activate a club version of a field without parameters only with a matching checked row (section 5.5, Q13).

**What is self-service at once.** A club can map every field whose revision is active and verified. Today that is `total_time`, `total_distance` and `max_v`, as the owner reports (`docs/ai/CURRENT_STATE.md:2658-2662`). A club sees every other column with the reason it cannot be placed. Questions (a) and (b) give the owner options to make the platform's own confirmation lighter.

**Questions (a)–(d), as recommended** (section 10):
- **(a)** The meaning act stays a platform act on the global revision. For a field without parameters, the platform may base it on a stored observation on the same board: "this field is the GPEXE screen column X". No document is needed then. Zones and thresholds keep their document. A club's drag needs no meaning act.
- **(b)** The platform still confirms every global field. The first club admin's confirmation counts only for that club's own mappings.
- **(c)** A club checks two athletes of one stored session. A global confirmation needs two sessions with two athletes each.
- **(d)** The evidence goes into the new owner-keyed, append-only store. Exact values are shown only to the two admin audiences. Values are hidden after 90 days and removed by an audited act, or earlier on request.

**When.** Code starts once the owner has accepted this contract and decided Q1–Q11 and Q13, after phase 9 ends, and after 7h, the club admin's approval of its club's mapping versions, is merged. O16 (Q12) must be decided before 18-3, so before any club variable is switched on. Q11's answer must come before the first real confirmation (sections 2, 6.6 and 8.5, Q10).

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
  - Burst and brake have no parameters, and their meaning is unconfirmed (`v34:1812-1815`).
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
- **Nothing is ever activated automatically today.** The rules are C8 (`discovery:326-327`), C33 (`:375-380`), D6 (`:1555-1556`), and section G's "N explicit rows, each audited, never a future binding" (`:1984`).

### 1.3 The actor guards and the audit

- **v35 sets one acting user per transaction** and derives the user's basis live. There is no system actor (`v35:66-117`).
  - Each audit row must follow its own write in the same transaction, with the version already at the row's target status (`v35:216-288`).
  - At COMMIT, deferred links require an audit row for every T3 insert, T4 insert and T4 transition (`v35:290-340`).
  - A write inside a savepoint is refused (`v35:47-50`).
- **v43's G1 and G2** check that a replacement label is true and that transition times are consistent (`v43:12-27`).
- **T8, the audit table.**
  - Its list of actions is closed (`v34:1677-1683`). It has no value-bearing column (`v34:1743`; D10, `discovery:1763-1768`).
  - Each operation has exactly one keyed request record (`discovery:1755-1762`).
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

| PR | Content | Migration | Reviewers (`CLAUDE.md` matrix) | External-review triggers | Merge path (proposal) |
|---|---|---|---|---|---|
| **18-A** | This contract, a J18 row in section J of the discovery document, and an "As built" note on J16's step count (documentation only) | — | `code-reviewer` on the whole document; `db-reviewer` on sections 4–5; `security-reviewer` on sections 4, 6 and 7 | 1, 2, 3, 4 (on its content) | Both ★★ GOs, then the standing merge order. The status stays Proposed until the owner accepts the contract (Q1). C113–C124 enter section C only as each is decided. |
| **7h (J14)** | Prerequisite with its own contract: a club admin approves, disables and replaces its own club's versions (C108). J18 needs from it only the activation basis: the T4 `activated_basis` CHECK (`v34:811-813`), the transition guard's `source_metric_require_platform_admin` call on activation (`:1192`), and T8's `mapping_status` branch for `needs_review → active` (`v48:322`). The disable basis, the replacement, the version-driven T5 ends (`sourceMetricActivationSteps.js:222-252`) and v48's club-less basis for those ends (`v48:386-387`) are J14's own scope. If Q13 chooses option two, J18 also needs the replacement branch (`v48:324-325`). | **v51** if nothing comes between | J14's own | 1, 2, 4 | The standing order for migration PRs |
| **18-1** | One migration with all of J18's schema: T9, T9s and T9i with their guards; the T4 gate; T8's new column and actions; T2b's observation columns (only if Q2 and Q3 choose them); the expiry and removal rules; rollback, preflight, post-check and runbook | **v52**, the next free number after 7h | `db-reviewer`, `security-reviewer` | 1, 2, 3, 4 | The standing order for migration PRs: both ★★ GOs; the owner's order naming the file and its sha256; the preflight on the same day; the owner's „da” before the deploy |
| **18-2** | Backend reads: the board, one placement, and the evidence; the pair rule; the display registry | none | `code-reviewer`, `security-reviewer` | 2 | Both ★★ GOs, then the standing merge order |
| **18-3** | Backend writes: the save (section 4.3), the purge of expired values, and the erasure | none | `code-reviewer`, `security-reviewer`, `db-reviewer` (transactions and locks) | 2, 3, 4, and the five-point rule | Both ★★ GOs, then the standing merge order. Only after 7h is merged and O16 (Q12) is decided. Q11's answer gates the first real confirmation through it. |
| **18-P** | Only if Q2 and Q3 choose the observation form: the platform's *Confirm a column for all clubs*, with its routes (8–10) and screen | none (its schema is in 18-1) | `code-reviewer`, `security-reviewer`, `db-reviewer`; plus `mobile-qa` and `ux-design-reviewer` for the screen | 2, 4 | Both ★★ GOs |
| **18-4** | Frontend: the board, the panel, the phone sheet, the entry points, the history and the guide | none | `code-reviewer`, `mobile-qa`, `ux-design-reviewer`, and a narrow `security-reviewer` pass on how values and names are rendered | 2; and 5 unless the real-route run of section 9.4 covers the flow | The *Rukovodilac*'s GO (★ proposed; a mark needs the owner's direct word, `metrics-core-plan.md:432-435`) |
| **18-E** | Facts after each merge: CURRENT_STATE, the J18 row "As built", and the decisions as built | none | `code-reviewer` | — | The standing merge order |

- **Why one migration.** All of J18's schema is in 18-1, so T8's md5-checked revision guard and v48's actor guard are each replaced only once.
- **The plan.** No J18 slice changes the plan. Its phase entry, its ★★ mark and its "Start" line wait for the owner's direct word (Q10).
- **The freeze.** No J18 code is merged or deployed during the M6 freeze (J17 step 9, `phase9-importer-mappings-contract.md:680-682`).

---

## 3. The flow

### 3.1 Where the board opens

- **From Imports.** After a successful search, the source card's success line (`renderFoundHtml`) gains *Map this team's GPEXE columns*.
  - It is shown only to an administrator, using the existing `status.viewer.identityAdmin` signal.
  - It appears only in a club workspace.
  - Coaches never see it. Imports is shared with them (`frontend/training-load-view.js:1545-1551`), so the server answers the identical 404 anyway.
- **From Data configuration.** A card *Map by drag and drop* is shown in a club workspace, beside *Mappings*.
- **What "first import" means.** In the owner's words „prvi uvoz” is a search that stored a session. An approved import is not needed. After 9-B, a session without activations is blocked `no_mapped_values` but stays stored, so the board can read it (`phase9-importer-mappings-contract.md:269-270`).

### 3.2 Preconditions and empty states

| State | What the admin sees |
|---|---|
| The team has no active GPEXE binding of the club's connection | The identical 404 sentence of Data configuration: "This is not available in this workspace." |
| No stored session through the binding | "No saved session yet. Run a search in Imports first." |
| The chosen session's snapshot has expired (30 days after it was last seen) | "The saved session is no longer available. Run a new search in Imports." No GPEXE request is sent. |
| Fewer than two athletes OptiMove can name, with different, non-zero values (R6; under its distance option, only when no proven distance column can name them either) | "OptiMove needs two athletes it can name. Link the team's athletes in Imports (Link athletes), or load their GPEXE names." This links to both places. |
| No column can be placed | Every column is shown with its reason (section 3.3). |
| Loading, a write in flight, or a result not confirmed | Every act except *Check result* is off, as in J16 section 8. |

### 3.3 The board

- **One stored session.** By default the board uses the newest one that can be used: its last check succeeded through this binding (`gpexe_import_checks.source_binding_id`, `v31:71-72`), as the importer requires (`phase9-importer-mappings-contract.md:175-179`), and it passes the import's gates. A *Session* chooser reuses J16's session picker and its badges (`phase8-mappings-screen-contract.md:295-310`). It reads only the candidates list route.
- **Left: the GPEXE columns.** There is one row per field with an extractor.
  - Each row shows its label, its key under *Technical details*, and its unit.
  - The unit is shown as "GPEXE sends values in <unit>" only when the revision's unit is proven. Otherwise the row says "Expected <unit>, not confirmed". GPEXE sends no unit word (section 1.4).
  - Each row shows the raw values of athlete A and athlete B, in the source unit.
- **Columns that cannot be placed** stay in the list, grey, with one reason:
  - "OptiMove has not confirmed this column yet." The revision is not verified (section 10, (b)).
  - "Map zones and thresholds in Mappings." The field has parameters, and J16 stays the path for it.
  - "OptiMove cannot read this column yet." There is no extractor.
  - "These two athletes have no value here." The admin can choose *Other athletes*.
- **Right: the variables.** First the club's own active variables, then OptiMove's system variables, each with its unit.
  - A system variable is a target only where an active system mapping of a column on the board fills it (C61). Elsewhere it reads "No OptiMove mapping from this column."
  - Last comes *Create a variable in <unit>* (section 3.5).
- **Rows already on.** A variable that is already switched on for the team shows "On for <team>", with *Switch off* as a secondary act. *Switch off* is S2: one confirmation, its own request key, outside the save.

### 3.4 Placing a column

- **On a computer** that matches `(pointer: fine)` and `(hover: hover)`, the admin drags a column onto a variable.
  - A new drag module follows `data-config-drag.js`, with its own MIME type `application/x-optimove-source-field`.
  - The possible targets get a dashed outline, and the target under the pointer a solid one, as on the Categories screen.
- **Everywhere, on a computer too**, the admin can tap the column and then tap the variable.
  - The column is a button with `aria-pressed`, as in J16's tap pattern.
  - After the column is chosen, the variables are ordered: *Same unit* first, then *Converted from <unit>*, then those that cannot be used, each with its reason (`targetStatus`).
- **By keyboard**, Enter or Space selects the column, then Tab and Enter place it. Escape cancels.
- **On touch nothing drags.** No grip and no draggable attribute is drawn (`.claude/rules/frontend.md:36-39`).
- **Each placement** asks the server for one placement (section 4.2, route 2). It opens the panel of section 3.5 below the board, or as a sheet on a phone.

### 3.5 The panel: the conversion and two athletes

- **The proposal**, in words, from the one active unit conversion:
  - "Proposed conversion: s → min (÷ 60)", or "No conversion" for equal units;
  - with no active row (the database allows at most one per pair, `v34:712-713`), the panel shows the refusal.
- **The refusals**, each a sentence with its code under *Technical details*:
  - the unit mismatch, using the sketch's sentence (section 3.11);
  - a level the variable or the field does not allow;
  - a system variable that this column does not fill;
  - "This column already fills <variable> for your club. Change that in Mappings." (C33);
  - a stored value outside the variable's limits: "This value is outside <variable>'s limits (<min>–<max> <unit>). Check the variable's unit, or choose other athletes." A row like this cannot be saved with this pair.
- **The two athletes.** The table has the columns *Athlete · GPEXE sends · OptiMove stores · The GPEXE screen should show*.
  - *GPEXE sends* is the raw value and its proven unit.
  - *OptiMove stores* is D8 at scale 9, in the variable's unit.
  - *The GPEXE screen should show* uses the display registry (R5). The default is the unit the C97 comparison saw: mm:ss for time, metres to 0.1 for distance, km/h to 0.1 for speed. A small choice above the table lets the admin set the unit their own GPEXE screen uses, from the units the handbook's page 11 lists. GPEXE shows each user's own units. The chosen unit is sent with the row as `displayUnit`, and `placementHash` covers it (sections 3.7 and 4.2).
- **The athletes' names.**
  - They come from the OptiMove link, or from a valid v32 GPEXE name. They are shown live to the admin and never stored.
  - If fewer than two athletes can be named, the panel refuses and points to Link athletes (section 3.2), as R6 recommends. R6's other option names an athlete by the value the GPEXE screen shows for a proven distance column, as the C97 sitting paired athletes by distance.
  - The client never sends an athlete id. *Other athletes* asks the server for the next pair by its index (section 6.1).
- **The guide** sits beside the table: *What to watch for*, in four sentences (section 3.11).
- **A missing variable.** *Create a variable in <unit>* opens the existing M3-0 create form in a sheet, prefilled with the column's unit (`POST /variables`). The board keeps every placement. On return the new variable is in the list and the open placement points to it, still unsaved.

### 3.6 Pre-placed mappings

- **Which rows are pre-placed.** Every system mapping that is eligible for the team (section 7) is already placed when the board opens. Its badge reads *OptiMove mapping*.
  - R4 decides whether the club's own active mappings are pre-placed on another team's board in the same way, with the badge *Your club's mapping*.
- **What the admin can do.** Each row has *Remove*. It shows the two athletes' values like any other row, but they are not stored (section 5.3). It needs no comparison: its field is proven globally, and a club version is active.
- **Collisions.** A row that would collide with an open activation on the team (same field and parameters, or same variable and level) reads "Replaces <old> for <team>". It is not pre-placed silently. The admin may keep or remove it.

### 3.7 Saving

- **One checkbox:** *I checked in GPEXE: the values of both athletes match.* It is shown when at least one new placement (a placement the admin made, not a pre-placed row) is on the board, and it is 44 px tall.
- **One requirement per row.** Each row has a visible toggle *Required*, prefilled as Q8 decides; the recommendation is Required. Its meaning appears beside it, in C110's words (section 8.3).
- **One primary button:** *Save and switch on for <team>*. It is enabled when the checkbox is ticked, or when there is no new placement. Before sending, a review card names:
  - the source and the team with its link ("<team> — linked to GPEXE team <n>", J16 R6);
  - each row (column → variable, conversion, levels, requirement);
  - every replacement.
- **What one press sends.** It sends one `POST /confirmations`: a fresh request key, every row, and the session and pair it was read for. At most 20 rows are sent (R7). No value, source or target unit, factor, note or reason is sent; only the display-unit code each new row was compared in.
- **How writes behave,** as J16 section 8:
  - only one write runs at a time;
  - the client bound is 90 s;
  - a lost answer shows *Result not confirmed* with *Check result*, which repeats the same body and key and never sends by itself;
  - `request_key_reused` means a new key;
  - `try_again` reads "The server was busy. Nothing was saved. Try again.";
  - `board_changed` reads the board again and says which row changed;
  - a generation counter drops older answers (`.claude/rules/frontend.md:59-62`).

### 3.8 After the save, and the history

- **The answer** names what was switched on: "Saved. <column> → <variable> is switched on for <team>. Checked by you on <date> with two athletes." Then: "The next import writes this variable. Drag the next column."
- **Only if Q10 lets the board ship before 9-B is live,** the sentence reads: "Imports do not use mappings yet; nothing changes in imports until they do." This is J16's R18 sentence.
- **History** is a secondary tab (R7). For each confirmation it shows: when, by whom (a display name), the session's date, and each row's column, variable, units and conversion.
  - The values of athlete A and B appear until they expire. After that the row reads "Values no longer shown (90 days)", or "Values removed" once a platform admin has removed or erased them. A pre-placed row reads "Not compared" and never had values. Athletes appear there only as *Athlete A* and *Athlete B*, because names are never stored.
- **Switching a row off** is S2 (C106), with one confirmation naming the team, its link and the version.

### 3.9 Phone (760 px and below)

- The columns are listed first and the variables below them. Tapping a column opens a bottom sheet, *Fill which variable?*, with the same order and reasons as on a computer.
- The panel is a full-screen sheet. The page behind it does not scroll.
- Each athlete is a card with three lines (GPEXE sends / OptiMove stores / the GPEXE screen should show), so no table scrolls sideways at 360 px.
- The checkbox row and *Save and switch on for <team>* sit in a sticky bar at the bottom. They are full width, 44 px tall, and every input is 16 px.
- Nothing drags on touch, and no inert control is shown. The layout is checked at 360, 375 and 390 px, and at 1280 px.

### 3.10 Accessibility

- Every column and every variable is a real button with an accessible name, for example "TIME, seconds, choose a variable for it". The chosen column has `aria-pressed="true"`.
- A polite live region announces each step: the chosen column, the proposal or refusal, and the result.
- After a placement, focus moves to the panel's heading. After *Cancel*, it returns to the column.
- Sheets are dialogs. Focus stays inside them, and Escape closes them.
- Colour is never the only signal: each state has a text badge.
- Every reason and error is linked by `aria-describedby`. The disabled save button says in text why it is disabled: "Tick the box to save".
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
| The proposal | Proposed conversion: s → min (÷ 60) · No conversion | „Predlog preračunavanja: s → min (÷ 60)” · „bez preračunavanja” |
| A unit mismatch | The units do not match: GPEXE sends values in <unit>, and the variable is in <unit>. Choose another variable or create a new one in a fitting unit. | „Jedinice se ne slažu: GPEXE šalje <unit>, a varijabla je u <unit>. Izaberi drugu varijablu ili napravi novu u odgovarajućoj jedinici.” |
| Table headers | Athlete · GPEXE sends · OptiMove stores · The GPEXE screen should show | „Sportista” · „GPEXE šalje” · „OptiMove upisuje” · „Na GPEXE ekranu treba da piše” |
| The guide | What to watch for: Open the same session in GPEXE (<date, time>) and find these two athletes. Compare the last column with what GPEXE shows. Seconds may differ by one. If it does not match, do not confirm. Choose another column or another variable. | „Na šta da paziš”: „Otvori istu sesiju u GPEXE-u (…) i nađi ova dva sportista.” „Uporedi poslednju kolonu sa onim što GPEXE prikazuje. Sekunde mogu da se razlikuju za jednu.” „Ako se ne poklapa, ne potvrđuj. Izaberi drugu kolonu ili drugu varijablu.” |
| The guide, added | GPEXE shows each user's own units. If yours shows another unit, choose it above the table. | — |
| The checkbox | I checked in GPEXE: the values of both athletes match. | „Proverio sam u GPEXE-u: vrednosti za oba sportista se poklapaju.” |
| Buttons | Save and switch on for <team> · Cancel · Back | „Sačuvaj i uključi za First team” · „Odustani” · „Nazad” |
| Under the button | Saved with it: who confirmed, when, and these values. That is the evidence, with no document. The values are shown for 90 days. | „Čuva se: ko je potvrdio, kada, i ove dve vrednosti. To je dokaz, bez ikakvog dokumenta.” |
| After saving | Saved. <column> → <variable> is switched on for <team>. The next import writes this variable. Drag the next column. | „Sačuvano” · „… je uključeno za First team.” · „Sledeći uvoz upisuje ovu varijablu. Prevuci sledeću kolonu.” |

**Two departures from the sketch.**
- The sketch named the athletes „Sportista 1” and „Sportista 2”. The board names them for the admin, because the guide asks the admin to find them in GPEXE.
- The sketch saved one column at a time. The board saves every placement with one press. One placement saved alone is the sketch's own flow.

---

## 4. Routes and the server operation

### 4.1 Audience and info-hiding

- **The board's audience** is, in a club workspace, club X's active admin, or a platform admin who also administers club X (a club workspace exists only for a club admin, section 1.5). The team must be an active team of club X. Its binding's connection must be owned by club X (`source_metric_binding_club`, `v48:84-89`).
- **Everyone else gets the identical `404`,** with `no-store`. Callers outside the two admin bases get it before anything is read. A team, binding or candidate outside the club gets the same 404 after its id is read, before any other refusal except a malformed request (`400`, `415`). That includes:
  - a coach, an athlete, or a team workspace;
  - the platform workspace, except routes 4–10. There an active platform admin reads any club's confirmations (routes 4–5), erases values (route 6, not as the confirmer) and removes expired values (route 7). With 18-P, a platform admin also observes (routes 8–9) and reads stored field observations (route 10, `GET /fields/:fieldId/observations`, platform workspace only);
  - another club, or X's admin working in Y's workspace;
  - a revoked role, an archived club or team, or an ended binding;
  - an unknown id.
- **Inside the scope,** a 404 always comes before any 409 (ADR-006; `routes/sourceMetrics.js:35-78`).
- **What answers never carry.** No answer carries an athlete id, a GPEXE id, a reason text, an acting user's id or SQL text (C63). Values and names go only to this audience. Section 6.2 covers system rows.

### 4.2 Routes

All routes are under `/api/training-load/sources/metrics`, behind `requireAuth`, with `no-store`.

| # | Route | Input | Answer | Refusals |
|---|---|---|---|---|
| 1 | `GET /board` | `teamId`; optional `candidateId`; optional `pair` (an index, default 0) | The columns (id, revision, label, key, unit state, placeable or reason, raw A and B); the variables (club's own and system, with unit, current version and whether placeable); rows already on; pre-placed rows with their full placement data and hash; the pair (`index`, `count`, two live labels); the session (candidate id, label, start) | `404`; `400 invalid_query`; `409 no_stored_session`, `snapshot_expired`, `candidate_too_large`, `candidate_source_mismatch`, `candidate_not_importable`, `not_enough_athletes`, `try_again` |
| 2 | `GET /board/placement` | `teamId`, `candidateId`, `pair`, `fieldId`, `targetId` | `placeable` with the proposal (`same_unit` or the conversion and its words), or a `code`; for A and B: raw, stored, and the GPEXE screen value in each display unit; the levels; collisions; a `placementHash` for each display unit | As route 1. A placement's own refusals (`field_not_confirmed`, `conversion_unavailable`, `target_scope_mismatch`, `condition_mismatch`, `level_not_allowed`, `source_metric_target_taken`, `pair_not_distinct`, `value_outside_limits`, `mapping_version_active`) are a `200` answer with `placeable: false`, so the panel can show them |
| 3 | `POST /confirmations` | `{requestKey, teamId, candidateId, pair, attested, rows: [{kind: "new", fieldId, targetId, expectedTargetVersionId, displayUnit, placementHash, requirement, replaces: [activationId]} \| {kind: "preplaced", mappingVersionId, placementHash, requirement, replaces: [...]}]}`, with 1–20 rows | `200 {confirmation: {id, teamId, confirmedAt, rows: [{fieldId, variableId, mappingId, versionId, activationId, requirement}]}, replayed}`; `200` with `verified_after_commit_error` after a verified COMMIT; `200` with `readError` when a committed answer cannot be read back. No values are returned. | `404`; `415 jsonRequired`; `400 invalid_body` (missing `attested` with a new row, an unknown key, a duplicate field or variable among the rows, a requirement missing, a new row's `displayUnit` missing or outside its rule's list); `409` with the codes of section 4.3 step 15, plus `board_changed` (`current.rowIndex`), `canonical_version_changed`, `mapping_version_active`, `activation_changed`, `binding_not_active`, `request_key_reused`, `try_again`; `503 outcome_unknown`; `500 internal_error` |
| 4 | `GET /confirmations?teamId=&cursor=` | — | Pages of 50: when, who (display name), the session's date, rows (column, variable, version, units, conversion, checked, and A/B values or "removed" or "expired", or "not compared" for a pre-placed row) | `404` |
| 5 | `GET /confirmations/:confirmationId` | — | One confirmation, as in route 4 | `404` |
| 6 | `POST /confirmations/:confirmationId/erase-values` | `{requestKey, reasonCode}`: `erasure_request` or `wrong_confirmation`, never typed text | `200 {confirmation}`, with the values removed | `404` for everyone but an active platform admin in the platform workspace who is not the confirmer; `400 invalid_body` (another reason code, or typed text); `409 values_already_removed`, `request_key_reused`, `try_again`; `503 outcome_unknown` |
| 7 | `POST /confirmations/expired-values/remove` | `{requestKey}` | `200 {removed: N, more: bool}`: at most 200 confirmations per call | `404` for everyone but an active platform admin in the platform workspace |
| 8–9 | Only with 18-P (Q2, Q3): `GET /fields/:fieldId/observation?candidateIds=a,b&pairs=i,j` and `POST /fields/:fieldId/revisions/:revisionId/observed-confirmation` | `{requestKey, sessions: [{candidateId, pair, displayUnit, placementHash} × 2], attested: true}` | Fields without parameters only: the observed unit and meaning acts, in one operation | `404` for everyone but an active platform admin in the platform workspace; `409 field_has_parameters`; the M2b codes (`unit_already_verified`, `meaning_already_verified`, `revision_retired`); `board_changed` |
| 10 | Only with 18-P: `GET /fields/:fieldId/observations` | — | The field's stored observations: when, who (display name), the two sessions' dates, the acts they proved, and the `field_unit` values or "removed" or "expired" | `404` for everyone but an active platform admin in the platform workspace |

**Routes reused unchanged:**
- S2 `POST /activations/:id/end`, for *Switch off*;
- M3-0 `POST /variables`, for *Create a variable*;
- `GET /conversions`;
- the GPEXE candidates list route;
- the identity and link reads, which the board's service calls internally.

**The hashes.** `placementHash` is a SHA-256 over:
- the candidate's `bundle_hash`;
- the pair index;
- the field revision;
- the target version (or the system mapping version);
- the conversion row (or "same");
- the display rule and the display unit (a `new` row, and each session of route 9);
- the raw and stored values of A and B.

It is not a secret and has no clock. The server recomputes it on every save. A difference is `board_changed`. No signing secret is introduced.

### 4.3 The save, step by step (one transaction)

**The prefix, before any connection:**
1. **The right** (section 4.1). A caller outside the two admin bases gets the identical 404 before the body is read. A team, binding or candidate outside the club gets it at step 5, after its id is read.
2. **The body is checked.** It must be a JSON object (`415` / `400`) with exactly the keys of route 3 and 1–20 rows. `attested: true` is required when any row is `new`. Each row needs its requirement, and each new row a `displayUnit` from its rule's list. No two rows may share a field or a variable.
3. **The request hash** is computed over the canonical body.

**One write transaction, `runWrite`** (`sourceMetricMappingService.js:763-847`):

4. **Start.** The bounds are set first: `statement_timeout` 10 s, the idle bound, and a 5 s lock bound (`:776-778`; `:93-95`). Then the per-user advisory lock is taken (`:779`, up to 5 s), and the row-lock bound becomes 2 s (`:780`). The request record is looked up (`:782`):
   - a replay answers the current state, after the right is checked again;
   - another body under the same key is `409 request_key_reused`.
   Then the v35 actor setting is written (`:797`).
5. **Plain reads, with no lock:**
   - the team and its one active GPEXE binding. The binding's club must be the workspace's club, and the team must be active. Otherwise the answer is 404.
   - the candidate, through 7e's scope query (`sourceMetricPreviewService.js:98-121`). It must be stored, not expired, at most 16 MiB, and its last check must have succeeded through this binding (`gpexe_import_checks.source_binding_id`, `v31:71-72`), as the importer requires (`phase9-importer-mappings-contract.md:175-179`). Otherwise the answer is the 409 of route 1.
   - The candidate row is never locked (section 4.4).
6. **The recompute.**
   - `gpexeLevelValues` runs with each row's extractor and the version's parameters (`gpexeImportMapper.js:427-441`). A variant keeps an internal athlete key, which never leaves the service.
   - The pair is chosen for the request's index (section 6.1). `convertAtStorageScale` gives the stored values, and the display values are computed.
   - Each row's hash is compared with the one the client got. Any difference is `409 board_changed`, naming the row. Nothing is written.
7. **Conversions.** The `unit_conversions` rows of every value pair used are taken `FOR SHARE`, in ascending order (`source_metric_lock_conversions`, `v34:952`).
8. **Fields.** The T2a and T2b rows are taken `FOR SHARE`, in ascending order. Each revision must be active and verified, and its unit must be the one the hash covered.
9. **Mappings (T3).**
   - For a new row, the club's existing mapping of (field, variable) is taken `FOR NO KEY UPDATE`, in ascending order. A missing one is only noted here; it is inserted at step 16.1.
   - For a pre-placed row, its mapping is taken `FOR SHARE`.
10. **Versions (T4).** Locks and plain reads only; nothing is written here.
    - For a new row whose mapping already has an active version with the same revision, parameters and target version, and the same factors as the panel used, that version is reused, `FOR SHARE`.
    - A mapping whose active version differs is refused at step 15 with `409 mapping_version_active` ("Disable it in Mappings first"). A mapping has one active version (`v34:888-889`), nothing is replaced automatically (C104 Q3), and an active version keeps the factors of a conversion retired since (`v34:1184-1186`).
    - Otherwise a new draft is planned for step 16.1, with:
      - the server's factors from the one active conversion;
      - the fixed note "Converted by OptiMove's active unit conversion." when the units differ;
      - the levels both the field and the variable allow.
    - For a pre-placed row, its active version is taken `FOR SHARE`.
11. **Variables.** The `metric_definitions` rows are taken `FOR SHARE`, in ascending order.
    - Each must be active, and its current version must be `expectedTargetVersionId`. Otherwise the answer is `409 canonical_version_changed`.
    - Their scope capabilities are taken `FOR SHARE` (for the levels).
12. **Replaced activations.** The T5 rows listed in `replaces` are taken `FOR NO KEY UPDATE`, in ascending order. Each must be open and on this binding. Otherwise the answer is `409 activation_changed`.
13. **The binding** and its team are taken `FOR SHARE` (`lockListedBindings`, `sourceMetricActivationSteps.js:100-128`). The binding must be active. Otherwise the answer is `409 binding_not_active`.
14. **The rights.** The acting user's role, user and club rows are taken `FOR SHARE` (`rightsStillHold`, `bindingClubHolds`; `sourceMetricAccess.js:66-130`). A lost right is the identical 404, and nothing is written.
15. **The state checks.** They run in this order, and the first failure names its row:
    1. the revision;
    2. the target;
    3. the conversion (`conversionsHold`);
    4. the levels;
    5. another mapping of the club with an active version of the same field and parameters (`source_metric_target_taken`, C33), or an active version of the row's own mapping that step 10 cannot reuse (`mapping_version_active`);
    6. extractability (`assertExtractable`);
    7. for every new row, the pair's values must be non-zero and distinct (`pair_not_distinct`);
    8. the stored values must be inside the variable's limits (`value_outside_limits`);
    9. a T5 collision not listed in `replaces` (`activation_exists`, `variable_taken_on_binding`; `sourceMetricActivationSteps.js:138-158`).
16. **The writes, in this order.** Every existing row is locked by steps 7–14, before the first write, as D requires (`discovery:1274-1277`). So the guards' own `FOR SHARE` locks at the first protected write (the role, user and club rows of v35 and v48, `v35:131, :162`; `metric_definitions` in the T3 trigger, `v34:647-648`) find their rows already held.
    1. the T3 insert of each missing mapping and its `mapping_create` row; the T4 draft of each new version and its `mapping_version_create` row; its `needs_review` transition and its `mapping_status` row. Each audit row comes right after its own write, so v35's guard sees the version at its target status (`v35:268-276`);
    2. the listed T5 ends (`admin_ended`, by the actor, with the basis v48 derives), carrying the fixed reason "Replaced on the drag-and-drop board.", with their `activation_end` rows;
    3. the T9 confirmation, its session row, and its rows. The database computes each digest and checks each stored value against the raw one (section 5.4);
    4. each new club version moves `needs_review → active`, with its `mapping_status` row. The J18 gate checks its T9 row (section 5.5);
    5. the T5 starts on the one binding, one per row, in ascending version id. `insertStarts` starts one version on N bindings (`sourceMetricActivationSteps.js:163-186`); J18 adds a variant that starts N versions on one binding. A new row's start carries the fixed reason "Switched on by drag and drop; two athletes checked in GPEXE." A pre-placed row's start carries "Switched on by drag and drop; OptiMove mapping." (under R4, a club row's: "Switched on by drag and drop; the club's mapping."). Each carries the row's requirement and its `activation_start` row, unkeyed;
    6. last, the keyed request record: the T8 `mapping_confirmation` row naming the confirmation and the team.
17. **The bounded COMMIT,** with the outcome rules of section 4.5.

### 4.4 Lock order and concurrency

The order is D's (`discovery:1268-1277`). A1 takes its listed bindings after its rights check (`sourceMetricMappingService.js:1426, :1485`); this write takes them before, as D lists:

`unit_conversions → T2a → T2b → T3 → T4 → metric_definitions → scope capabilities → T5 (to end) → binding → team → role / user / club`, then the new rows.

The candidate, the team import lock and the Metrics Core connection (v11) are never locked. A row-lock wait is bounded at 2 s, the per-user lock at 5 s, and every statement at 10 s (`sourceMetricMappingService.js:93-95`). `55P03`, `40P01` and `57014` before the COMMIT answer `try_again` with nothing written.

| Against | Outcome |
|---|---|
| A1, A2 or the pinned step on the same club mapping | A1 and A2 take T3 `FOR NO KEY UPDATE`, as this write does, so they serialize at T3. The pinned step serializes earlier, at T2b, which it takes `FOR UPDATE` against this write's `FOR SHARE` (`phase7d-mapping-activations-contract.md:515`). In each case the second reads the first's result. |
| S1 or S2 on the same binding | As in 7d's table (`phase7d-mapping-activations-contract.md:507-517`): T3 → T4 → T5 in D's order. A start against an end of the same field waits only on the open-row unique index. |
| The 9-B approval, or a check-time preview, of the same team | The importer takes the team lock and the binding `FOR SHARE`, then T2b → T3 → T4 → definition → T5 `FOR SHARE`, then v11 `FOR UPDATE` (`phase9-importer-mappings-contract.md:163-216`). This write takes no team lock, no v11 row and no candidate lock. Its binding `FOR SHARE` is compatible with the importer's. It may wait for rows the importer holds `FOR SHARE`, but it never holds something the importer then waits for, so no cycle forms (the 7d argument). A preview that ran before the save does not see the new activations. The next check does (`phase9-importer-mappings-contract.md:75, :444-445`). |
| A 7g instance end | 7g needs the team's import lock. It is refused while the team has an active binding or an open activation (`v50:21-34`). This write needs an active binding, so the two never act on the same team at once. |
| An Unbind | This write holds the binding `FOR SHARE` only from step 13 to the COMMIT. Either side waits at most 2 s, then `try_again` (C58, `discovery:557-560`). If the Unbind commits first, this write answers `binding_not_active`. |
| A new version of the target variable (M3-0, R2, or C111 later) | C9's guard reads T4 without a lock (`v34:1222-1238`). This write locks the definition `FOR SHARE`. If the new version commits first, this write answers `canonical_version_changed`. If this write commits first, the new version is refused with `variable_pinned`. |
| A club or team archive | Both rows are held `FOR SHARE` (steps 13–14). The archive waits or lands first. Then the answer is the identical 404. |
| A role revocation | It meets this write only at the user rows `FOR SHARE`, as in 7c and 7d. |
| Two admins saving the same placement | The second fails on T3's pair key or on T5's open-row index. The whole operation answers `409 board_changed`, and the screen reads the board again. Nothing of the second save is written. |

### 4.5 Idempotency and the COMMIT (the five-point rule)

1. **An error before the COMMIT** is a stated refusal, and nothing is written. The answer says so: "Nothing was saved."
2. **An error at the COMMIT, or no answer to it.**
   - The connection is closed and never reused.
   - An ordinary ERROR that PostgreSQL itself raises at the COMMIT (a deferred J18, v35 or v43 link, or a deadlock) is a definite refusal, with nothing written (`commitCertainlyRefused`, `sourceMetricMappingService.js:63-77, :813-818`).
   - For every other COMMIT error, and for no answer, the request key is looked for on another connection, within a bound.
   - If it is found, the answer is `200` with `verified_after_commit_error`.
   - If it is not found, the answer is `503 outcome_unknown`.
   - Those two are never "nothing was saved". This is the F2 discipline that `runWrite` already has.
3. **After a confirmed COMMIT,** a failed read-back answers `200` with `readError`, never an error.
4. **The same key and body again** is a replay. It answers `replayed: true` after the right is checked again. Another body under the same key is `request_key_reused`. The screen's *Check result* sends the same key and body, and never sends on its own.
5. **One targeted test through the real route** covers each outcome (section 9.2).

A partial result is never shown as switched on. If the fallback of R8 is used, the screen says what is saved and what is not.

### 4.6 What the server never does

- It never sends a GPEXE request.
- It never writes T2a or T2b on a club's behalf.
- It never creates a canonical variable from a column (C1, C2, ADR-007).
- It never replaces an active version automatically (C104 Q3).
- It never starts an activation for a binding that is not listed.
- It never logs a value, a name or a reason.
- It never returns a value to anyone outside section 4.1.

---

## 5. Data model and migration (v52)

v52 comes after 7h's v51; if another migration comes between, the next free number. It is additive. It replaces functions only after checking the md5 of the body in force, as v50 does (`v50:84-99`). Fixed messages are used: `42501` for a refused actor and `23514` for everything else (C79).

### 5.1 T9 `training_load.source_metric_confirmations` — the act

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
| `check_id` | A foreign key to `gpexe_import_checks`, which are never deleted (`v24:336`). The check must have succeeded for this team. For `team_mapping`, through this binding (`gpexe_import_checks.source_binding_id`, `v31:71-72`), as the importer requires (`phase9-importer-mappings-contract.md:175-179`). For `field_observation`, through `source_connection` on a host of the field's family. |
| `team_id` | The session's team |
| `pair_index` | Zero or more: the server's pair order. No athlete id. |

`team_mapping` has exactly one session. `field_observation` has exactly two, from different GPEXE sessions. Both rules are deferred checks.

### 5.3 T9i `training_load.source_metric_confirmation_items` — the rows and their values

| Column | Rule |
|---|---|
| `id`, `confirmation_id`, `session_ordinal`, `item_no` | The session is a foreign key to T9s |
| `item_kind` | `club_mapping`, `system_mapping` or `field_unit` |
| `checked` | True for a row the admin placed and compared. False for a pre-placed row. |
| `source_metric_version_id` | A foreign key to T2b |
| `mapping_version_id` | A foreign key to T4, set exactly for the two mapping kinds. Unique per confirmation. |
| `parameter_fingerprint`, `source_unit`, `target_unit`, `scale`, `scale_divisor`, `offset` | Copies that must equal T4's, and T2b's unit. For `field_unit` there is no target unit or factor. |
| `level` | `session` only |
| `gpexe_display_rule`, `gpexe_display_unit` | Set exactly for a checked row: a registry code (`^[a-z_]{1,40}$`) and a unit from that rule's closed list, the `displayUnit` the row was sent with. It is what the admin compared against. |
| `raw_a`, `stored_a`, `raw_b`, `stored_b` | Set exactly for a checked row. A row with `checked = false` stores no values (data minimization, recommended). Finite numerics. On a checked row the two raw values must be non-zero and different. `stored_*` must equal D8 of `raw_*` (`source_metric_value_matches`, `v34:156`). For `field_unit` there is no stored value. |
| `values_digest` | SHA-256 over the canonical text of the row's facts and its four values. It is computed by the trigger and survives the removal. |
| `values_removed_at`, `values_removed_kind`, `values_removed_by_user_id` | Kind `expired` or `erased`. On a checked row the value columns are null exactly when `values_removed_at` is set. A row with `checked = false` has no values and is never removed. |

### 5.4 The guards (the C76 / v35 / v48 pattern)

- **BEFORE INSERT on T9:**
  - The v35 actor must equal `confirmed_by_user_id`.
  - `confirmed_basis` must equal `source_metric_actor_basis(actor, owner_club_id)` (`v35:82-110`). Otherwise the answer is `42501`. A `field_observation` row needs `platform_admin`.
  - For a `team_mapping` row: `source_metric_binding_club(binding_id)` must equal `owner_club_id`. The binding must be active. The connection must be the binding's.
  - A write inside a savepoint is refused.
- **BEFORE INSERT on T9s and T9i:** the row's confirmation must have been written in this transaction by the same actor.
  - On T9s, the check's facts must hold. For `team_mapping`, the team must be the binding's, and the check must have run through the confirmation's binding. At insert the candidate exists, belongs to `team_id`, has `last_seen_check_id = check_id`, and carries `candidate_bundle_hash`.
  - On T9i, the T4 and T2b facts must be equal; the T4's owner must be the confirmation's club for `club_mapping`, and `system` for `system_mapping`; the T2b revision must be active and verified.
  - The digest is computed by the trigger. A digest the writer supplies is overwritten.
- **UPDATE:** refused on T9 and T9s. On T9i, only the removal of section 5.8 is allowed. DELETE and TRUNCATE are refused on all three tables.
- **Deferred checks, at COMMIT:**
  - A confirmation has its keyed T8 row of the same operation, by the same user (`mapping_confirmation`, or `source_metric_unit_observed` for a field).
  - A `team_mapping` act has exactly one session and at least one row. Every mapping row's version is active and has an open activation on the confirmation's binding, started in this transaction.
  - `attested` is true exactly when a row is checked.
  - A `field_observation` act has exactly two sessions and two `field_unit` rows, and T2b's unit act names it in the same transaction (section 5.7).

### 5.5 The gate on a club admin's activation

- A new trigger on T4 runs `BEFORE UPDATE`. It is named to sort after v34's and v35's guards.
- When `needs_review → active` has `activated_basis = 'club_admin'` and the version's `parameter_kind` is `'none'`, it requires a T9i `club_mapping` row that:
  - has `checked = true`;
  - names this version;
  - belongs to a confirmation written in this transaction by `activated_by_user_id`, for the mapping's club.
- Otherwise it refuses with `23514`.
- The gate applies only to a version whose field has `parameter_kind = 'none'`. It comes on top of 7h's basis change, never instead of it, and a platform admin's A1 is unaffected.
- A1 writes no T9 row (`sourceMetricMappingService.js:1465-1506`). So after v52 a club admin's A1 under 7h is refused for such a version, a replacement included. The owner decides the consequence in **Q13 → C124**:
  - option one: a club admin activates a parameter-less club version only through the board, and a replacement is "disable in Mappings, then place again";
  - option two: the board gains a version-replacement row with v43's G1 chain.
- Zone and threshold versions keep 7h's J16 path, with no J18 gate.

### 5.6 T8

- **A new nullable column** `confirmation_id`, referencing T9 with `on delete restrict`. A CHECK ties it to the new actions: it is set exactly for them.
- **New actions** are added to the closed list. Every existing branch of `row_ok` stays byte for byte:
  - `mapping_confirmation`: the keyed request record of a board save. It names the team and the confirmation, with the basis `platform_admin` or `club_admin`, no reason and no evidence.
  - `confirmation_values_expired`: names the confirmation, with `platform_admin` and no reason.
  - `confirmation_values_erased`: names the confirmation, with `platform_admin` and a fixed reason code as its reason (`erasure_request` or `wrong_confirmation`), never typed text.
  - Only with Q2 a2 and Q3 b1: `source_metric_unit_observed` and `source_metric_meaning_observed`. They name T2a, T2b and the confirmation, with `platform_admin` and no `evidence_ref`.
- **Replaced bodies,** each after its md5 check:
  - the revision guard gains the new branches. Each row must follow its own T9 or T9i write in this transaction, by the acting user, once per confirmation and action.
  - v48's actor guard admits a `club_admin` basis on `mapping_confirmation` for the confirmation's club.
  - v48's insert guard admits a club-admin `mapping_confirmation` row that names a confirmation of the actor's club.
- T8 keeps no value-bearing column (D10).

### 5.7 T2b — only if Q2 chooses a2 and Q3 chooses b1

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
- **Removal of expired values.** An active platform admin's act (route 7) removes them. It writes the four columns to null and sets `values_removed_kind = 'expired'`, with one T8 `confirmation_values_expired` row per confirmation.
  - The T9i update guard allows it only when `now() >= values_expire_at`, and only by an active platform admin who is the v35 actor.
  - The 6-hour retention run (`gpexeImportService.js:696`) only counts confirmations past their date, without writing. The platform's Data configuration start screen shows the count.
  - Q6 offers an alternative: a removal by the scheduled run itself, with no actor.
- **Erasure on request.** Route 6 removes the values earlier, with `values_removed_kind = 'erased'` and a T8 `confirmation_values_erased` row carrying its fixed reason code.
  - It needs an active platform admin who is not the confirmer.
  - The confirmer and club admins can never remove evidence.
- **What survives.** The digest, the facts, who and when all stay.

### 5.9 Rollback, preflight and post-check

- **Rollback:** `docs/runbooks/source-metric-confirmations-v52-rollback.sql`. It refuses:
  - once any T9 row exists;
  - once a T2b observation column is set;
  - once a later migration is recorded (C96's pattern).
  Otherwise it restores the replaced bodies by their md5, and drops the triggers, tables, columns and actions. It is rehearsed on a disposable database: apply → rollback → identical catalog → apply again.
- **Preflight (read-only):**
  - the server version;
  - the last migration (7h's);
  - the md5 of every body to be replaced;
  - T8's action list as expected;
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
- **A global confirmation** (18-P) needs two sessions with two athletes each (Q4).

### 6.2 (d) What is stored, where, and for whom

**Stored**, in T9, T9s and T9i (section 5):
- who and when;
- the session's ids and hash, and its check;
- the binding and its connection;
- per row: the revision, the version, the units and the factors; for a checked row also the display rule and unit compared, and the two raw and two stored values (a pre-placed row stores no values);
- a database digest.

**Never stored:** an athlete id, a GPEXE athlete id, a name, a date of birth, free text, or a value typed by the client.

**Readers:**

| Row kind | Values and the confirmer's display name | Others |
|---|---|---|
| `team_mapping` (a club's save) | That club's active admins, in its workspace; platform admins, in the platform workspace (routes 4–5) or as the club's admin in its workspace | The identical 404 |
| `field_observation` (the platform's global act) | Platform admins only, in the platform workspace (route 10). The values come from some club's session. | A club admin sees only "Confirmed by OptiMove on <date>" on the field |

- The confirmer's user id is never returned.
- Coaches, athletes, team workspaces and other clubs get no route.
- Answers are `no-store`.

### 6.3 Expiry, removal and backups

- **Expiry.** Values are shown for N days after the confirmation (Q6; 90 recommended, like an imported snapshot, `gpexeImportService.js:36`). After that, no read returns them. A platform admin's audited act removes them (section 5.8). Until a platform admin acts, expired values stay stored but hidden, in the database and in its backups.
- **Erasure on request.** A platform admin who is not the confirmer can remove values earlier, with a fixed reason code (section 5.6).
- **What stays after removal.** The digest proves what was stored. The facts say who confirmed what.
- **Backups.** A database backup keeps the values for the backup's own retention. Before a restored copy is used, its expired values are removed. This is the v32 precedent (the CURRENT_STATE risk "Backups can outlive the 14-day identity snapshot").

### 6.4 Names

- Names are shown live, only to the board's audience. They come from an athlete link or a valid v32 GPEXE name (`gpexeAthleteIdentityService.js:138-149`).
- Names are never stored, logged, or returned anywhere else.
- History shows *Athlete A* and *Athlete B*.

### 6.5 Logs and answers

- The routes log only the method, the route and an error code (`routes/sourceMetrics.js:74`).
- No value, name, reason or id of an athlete appears in a log, a T8 row or an error body.
- The write's answer carries no value.

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
- the team has no open activation of the same field and parameters, and none of the same variable and level (`sourceMetricActivationSteps.js:42-47`).

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
- When the platform activates a new system mapping, it appears pre-placed, as *New from OptiMove*, the next time a club opens a board.
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
- **The requirement toggle explains C110's meaning:** "Required: a missing value is left out and marked 'required value missing'. Later, an administrator will decide such a session (form C). Optional: a missing value is left out with its own reason."

### 8.4 C111 (J19) — touch points only

1. **Creating a variable.** The board creates a variable only through M3-0's create (`POST /variables`). A column never creates a variable (C1, C2).
2. **Editing in place.** C111 allows an in-place edit of the unit, the daily aggregation, min/max, the condition, the levels and the key only while the variable has no value and no mapping. "No mapping" must count T3 and T4 rows of any status, and every T9i row naming the variable's versions.
3. **After a confirmation.** A change becomes "only a new version". C9 refuses it while the active version pins the old one (`v34:1222-1238`). So the board says: "To change a confirmed variable's unit, create a new variable and place the column again." The replacement is explicit, through "Replaces …".
4. **Always editable.** The name, short name, description and icon stay editable in place. They create no version, so they never touch a confirmation: T9i pins the T4 version, and the T4 version pins the canonical version.
5. **Logging.** Each C111 change is logged by its own v36-style request record. J18's acts are logged by T8 and T9.
6. **Order.** J19 is written separately after phase 9. If its backend is merged before 18-4, the board may offer *Fix the unit* for a variable with no value and no mapping. Otherwise it offers *Create* only.

### 8.5 9-B, 7h, 7i and O16

- **9-B.** Nothing switched on has any effect before 9-B is live, because the importer reads T5 only from 9-B (`phase9-importer-mappings-contract.md:77`).
  - After 9-B, a session with no activation is `no_mapped_values` and stays stored. That is the board's source.
  - The first check after a save refreshes the previews (`:75, :444-445`).
  - Section 4.4 shows the lock orders fit.
- **7h is needed** for a club admin's activation of a club version. 18-3 waits for it. Section 2 names the one thing J18 needs from J14: the activation basis.
- **7i is not needed** for system variables. Pre-placed system mappings are C106's S1 starts, which is form (a)'s switch-on. 7i's hiding and copying stay 7i.
- **O16** must be decided before any club variable is switched on for a team (J17 O16, `phase9-importer-mappings-contract.md:871-874`). J17 recommends deciding it with 7h. System variables are named for everyone.

### 8.6 What this contract supersedes or amends, by number

| Decision | Effect |
|---|---|
| C97 (the evidence standard) | Amended for club mappings: one session, two athletes, built only on a verified field (Q1, Q5). Amended for global fields only under Q2 a2 and Q3 b1: two sessions with two athletes, from a stored observation (Q4). Kept for the meaning and operator of zones and thresholds. |
| C93 (the meaning is a document reference) | Amended only under a2: an `observed_column` kind for fields without parameters |
| C90 (fail closed: T2b takes only the two documented acts) | Amended only under a2: the observed unit and meaning acts join them, each with its built chain (section 5.7). |
| C40, C95 | The format check stays byte for byte. Observations are linked by typed columns, never encoded into `evidence_ref`. |
| C94 | Kept. A club's confirmation is a new club-scoped act on a new record. |
| C28, J11 OD2 and OD3, J16 sections 7 and 9 | A scoped exception: the board's two-athlete panel, for the board's audience only (Q7). The 7e preview and J16 stay aggregate. |
| C23 | Kept in the database. The board prefills a visible per-row toggle (Q8). |
| C8, D6 | Kept. "Automatic" means pre-placed and the same click (Q9). |
| C33, G | Kept: none is activated automatically. Amended: "the platform admin chooses which one a binding uses" (`discovery:378-379, :1985-1986`) becomes the club admin's choice on its own binding (C106), shown as "Replaces …" (section 7). |
| J16 R14 (no default, `phase8-mappings-screen-contract.md:460`) | Amended by Q8: the board prefills *Required*, visible on every row. |
| C61, D4 | Kept. A club uses a system variable only through the system mapping. |
| C108 (7h) | A dependency, and amended. J18's gate adds a database condition to a club admin's activation of a club version of a field without parameters, which a club admin then activates only through the board (section 5.5, Q13). Zone and threshold versions keep 7h's J16 path. |
| C109 (7i) | Form (a)'s switch-on is done by pre-placed rows. Hiding and copying stay 7i. |
| C9, C13, C16, C22, C34, C55, C57, C58, C63, C76, D10 | Kept |
| The plan's order (`metrics-core-plan.md:1062-1074`) | 7h stays right after phase 9. J18 comes next, then the rest of 7i (Q10, on the owner's direct word). |

---

## 9. Tests

### 9.1 The database (disposable `optimove_tests_*`, the T1 runner)

1. **Every CHECK of T9, T9s and T9i:**
   - the kind and owner pairs;
   - the binding pair;
   - the session counts;
   - the nullable foreign keys by kind;
   - raw values non-zero and different on a checked row, and no values, display rule or unit on a row with `checked = false`;
   - the removal facts;
   - the display rule format, and the display unit within its rule's list.
2. **The actor guard:**
   - another actor is refused with `42501`;
   - a basis that does not match is refused;
   - a club admin of another club is refused;
   - a write in a savepoint is refused;
   - a club admin writing a `field_observation` is refused.
3. **The binding's club, connection, team and check facts.** Each wrong fact is refused with `23514`: a candidate of another team, a `last_seen_check_id` other than the row's check, another bundle hash, and a check through another binding included.
4. **Each row against T4 and T2b.**
   - A wrong revision, fingerprint, unit or factor is refused.
   - A stored value that is not D8 of its raw value is refused.
   - A digest the writer supplies is overwritten.
5. **Append-only behaviour.**
   - Any change of a fact is refused. DELETE and TRUNCATE are refused.
   - The expiry removal is refused before the date and refused without a platform-admin actor.
   - The erasure is refused for the confirmer, for a club admin, and without its T8 row.
6. **The deferred links.**
   - A confirmation without its keyed T8 row fails at COMMIT.
   - A `team_mapping` act with no rows fails.
   - A row whose version has no open activation started in the same transaction fails.
   - A mismatch between `attested` and `checked` fails.
7. **The gate.**
   - A club-admin activation fails without its row, and with a row of another version, another club, another transaction or `checked = false`.
   - A platform admin's A1 is unaffected.
   - A club admin's activation of a zone or threshold version is not gated. A club admin's A1 of a version without parameters is refused (Q13).
8. **T8.**
   - The new actions' shapes and the `confirmation_id` CHECK are enforced. `confirmation_values_erased` takes only its two reason codes, never typed text. A board's `activation_end` row without its reason is refused (`v50:304-306`).
   - The md5 check refuses a different body in force.
   - Every existing branch is unchanged: a byte comparison of each replaced body's untouched part, as v50 did.
9. **T2b, only if Q2 and Q3 choose it.**
   - The observation columns are write-once.
   - `observed_column` and `unit_observation_id` are allowed only when `parameter_kind = 'none'`.
   - `verified` is reached by the two observed acts.
   - `source_metric_evidence_ref_ok` is unchanged (md5).
10. **The rollback** refuses once a T9 row exists. Apply → rollback → identical catalog → apply again is rehearsed.

### 9.2 Routes and services

11. **The audience matrix of section 4.1 on every route:**
    - the identical 404 with `no-store`: before anything is read for a caller outside the two admin bases, and after its id is read, before any other refusal but a malformed request, for a team, binding or candidate outside the club;
    - in the platform workspace, only routes 4–10 answer, and only a platform admin;
    - inside the scope, a 404 before any 409.
12. **The board:**
    - proven against expected units; "GPEXE sends values in" never shown for an unproven unit;
    - every reason a column cannot be placed;
    - pre-placed rows;
    - the pair is the same on two calls;
    - named athletes come first; with fewer than two, the refusal of R6 (or its distance option, if chosen);
    - `not_enough_athletes`, `snapshot_expired`, `candidate_too_large`, `candidate_source_mismatch`, `no_stored_session`;
    - a session whose last check ran through another binding is never used;
    - a scan that no answer or URL carries an athlete id.
13. **A placement:**
    - the proposal is the one active conversion; no active row gives `conversion_unavailable`;
    - the mismatch sentence;
    - stored values equal `convertAtStorageScale`;
    - the display values and a `placementHash` for each display unit, the hash changing with the unit;
    - the limits block;
    - collisions are listed.
14. **The save:**
    - First, the one-transaction test with every guard on. If it fails, R8's fallback is used.
    - Replay, `request_key_reused`, and `board_changed` when the snapshot, a value or a row's display unit changed. `mapping_version_active` when the mapping's active version differs, factors included.
    - The seven COMMIT-outcome tests of `gpexe-in-app-import.test.mjs`, in that pattern: verified and unknown outcomes, and a definite refusal at the COMMIT (a deferred J18 link failing), answered as a refusal with nothing written, never `outcome_unknown`.
    - The keyed row is last. The starts carry their fixed reasons (a new row's, a pre-placed row's) and explicit requirements, and the ends carry theirs. A pre-placed row stores no values. Replacements end exactly the listed activations.
    - Run against a 9-B fixture: the importer reads the new activations.
15. **The logs:** a scan of the whole suite's logs for every value and name.
16. **The evidence reads:**
    - club rows go to the club's admins and to platform admins;
    - a test proves no club admin ever receives a value of a `field_observation` row;
    - route 10 answers only a platform admin in the platform workspace (18-P);
    - the confirmer's id is never returned;
    - values are hidden after expiry, before any removal.
17. **Removal:**
    - route 6 works only for a platform admin who is not the confirmer, and only with one of its two reason codes;
    - route 7 works only for a platform admin;
    - the T8 rows are written;
    - the digest is kept.

### 9.3 Concurrency (real connections)

18. Each case runs with no `40P01` that is not answered `try_again`, and with nothing half-written:
    - the save against A1 and A2 on the same mapping;
    - against S1 and S2 on the same binding;
    - against an Unbind (`try_again` within 2 s);
    - against a 9-B approval and a check-time preview of the same team;
    - against a new version of the target (`canonical_version_changed` or `variable_pinned`);
    - against a club archive and a team archive;
    - two admins saving the same placement.

### 9.4 Frontend and browser

19. **A JSDOM suite over the real handlers** with `frontend/tests/support/fetch-mock.mjs`, whose fakes keep the server's rules. It covers:
    - tap-then-tap with `aria-pressed`; Enter, Space and Escape;
    - drag only with a fine pointer and hover; on touch, no `draggable` attribute and no grip;
    - the phone sheet;
    - the checkbox gating the button;
    - the save body (no values, no athlete ids; each new row's display unit);
    - *Result not confirmed* · *Check result* with the same key;
    - the generation counter;
    - every refusal's sentence;
    - hostile labels;
    - removing a pre-placed row;
    - the requirement toggle on every row;
    - the review card's text.
20. **Browser QA** at 1280, 360, 375 and 390 px.
21. **An integration run on a disposable database with the real routes:** create a club variable, place three columns, save, read the evidence, switch one off, replay, and let one value expire. This is the answer to trigger 5.
22. **The production build** (`npm --prefix frontend run build`).

### 9.5 Mutations

Each new guard has a mutation that the suite kills:
- every CHECK;
- every trigger condition;
- the gate and its `parameter_kind = 'none'` condition;
- the expiry and erasure conditions;
- each new T8 branch;
- the audience predicate;
- the recompute comparison;
- the pair's distinctness;
- the limits block;
- the hiding of `field_observation` values from a club admin.

### 9.6 Tiers

- During development, only the files that changed are run.
- Before each review, the mapping suites are run: `source-metric-mapping-m2`, `-transitions-7b`, `mapping-activations-7d`, `-v35`, `source-metric-preview-7e`, and the new suites. `test:gpexe` and `test:frontend:fast` are run as well.
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

**What a club sees for any other field.** The column with its reason: "OptiMove has not confirmed this column yet." or "Map zones and thresholds in Mappings.".

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
- Only the session level is checked. Drill values use the same extractor, but they are not compared.
- The GPEXE screen rounds seconds inconsistently (±1 s, `gpexe-c97-unit-evidence.md:146`).

### (d) Where the evidence is stored

| Option | What it means | Cost |
|---|---|---|
| **d1 (recommended)** | The new append-only T9, T9s and T9i (section 5), written in the save's transaction. Exact values sit in a separable column set with a database digest. No athlete identity is stored. Values are hidden after N days and removed by an audited act, or erased earlier on request. Readers are as in section 6.2. | A new copy of personal performance data. They are the same athletes' GPS values that OptiMove imports. It needs guards, tests, and backup handling. Until a platform admin removes them, expired values stay stored but hidden, in the database and its backups. |
| d2 | Values in a `docs/` document, as for C97 | A pull request per confirmation, and athletes' values in the repository. Not possible. |
| d3 | Values in T8 | D10 refuses it: T8 has no value column, and its rows cannot be erased (`discovery:1763-1768`). |
| d4 | Only a digest, no values | Nothing readable is kept. "Ove dve vrednosti" is what the owner's sketch asked to keep. |

**Why d1.** It keeps exactly what the owner named: who, when, and the two values. It shows them only to administrators. Names are never stored. It respects D2's and D10's reason, that values must not sit in rows that cannot be erased: here the values can be removed while the act stays.

---

## 11. Owner decisions

### 11.1 For the owner (Q1–Q13)

Each of Q1–Q11 and Q13 becomes the decision named here when decided. It is written into section C of the discovery document before any code (plan rule A3).

- **Q1 → C113. Accept J18** as the contract of C112, with the effects listed in section 8.6. Recommended.
- **Q2 → C114. (a):** a1, a2 or a3. Recommended: a2.
- **Q3 → C115. (b):** b1 or b2, and b3 as an add-on or not. Recommended: b1, without b3 for now.
- **Q4 → C116. The floor of a global confirmation from an observation** (only with a2 and b1): two sessions with two athletes each, or one session as the pilot's precedent. Recommended: two sessions.
- **Q5 → C117. (c), for a club:** one stored session, two athletes, the same pair for all rows, chosen by the server, values non-zero and different. Recommended.
- **Q6 → C118. (d) and its bounds:**
  - d1, with N days. Recommended: 90.
  - Removal of expired values by a platform admin's audited act, the 6-hour run only counting them. This is recommended, and it matches "purge only with an actor and a T8 row". Its cost: until a platform admin acts, expired values stay stored but hidden, in the database and in its backups. The security lens's "no indefinite retention" depends on that act.
  - Or the alternative: the scheduled run removes the values itself, with no actor. That is technically bounded but departs from the database lens.
  - Erasure by a platform admin who is not the confirmer, with a fixed reason code (`erasure_request` or `wrong_confirmation`), never typed text.
- **Q7 → C119. The two-athlete panel** as a scoped exception to C28, J11's OD2 and OD3, and J16 sections 7 and 9. It applies to the board and its audience only. Recommended.
- **Q8 → C120. The requirement on the board:** a visible per-row toggle, prefilled *Required* (the owner's pilot choice), explicit in every saved row. The database keeps no default, so C23 stays there. Alternative: no prefill, one tap per row. Recommended: the prefill.
- **Q9 → C121. What "automatic" switch-on means:** pre-placed and switched on by the same click, under the admin's identity. No background job, no system actor, never a future binding. Recommended. A truly unattended form needs its own decision (section 7).
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
  - Recommended: option one. It matches step 10's `mapping_version_active` ("Disable it in Mappings first"), and option two can be added later.

### 11.2 For the *Rukovodilac* (R1–R8)

- **R1.** The PR split of section 2. Recommended: as written.
- **R2.** The route names and shapes of section 4.2. Recommended: as written.
- **R3.** In a club workspace, the board is the main path for fields without parameters. J16's flow and its card stay. Recommended: yes.
- **R4.** Pre-place the club's own active mappings on another team's board, beside system mappings. Recommended: yes.
- **R5.** The display registry's first entries (`total_time`, `total_distance`, `max_v`; counts later), and the GPEXE display-unit choice from the handbook's page 11. Each rule is added only with evidence and a test.
- **R6.** With fewer than two athletes OptiMove can name, either name an athlete by its GPEXE screen distance (the C97 pairing), or refuse with the way to Link athletes. Recommended: the refusal, with the way to Link athletes. The distance fallback stays an option, only when the distance column is proven and its two values differ.
- **R7.** At most 20 rows per save; History as a secondary tab; *Switch off* as a separate act. Recommended: yes.
- **R8.** If the one-transaction test of 18-3 fails: two keyed operations behind one button. First the mapping writes, then the confirmation and the starts. Each has its own lost-answer handling, and nothing is shown as switched on until both settle. Recommended as the fallback only.

---

## 12. Risks

- **A wrong confirmation imports wrong values.** C13 forbids reinterpreting a fact afterwards. Mitigations:
  - only verified fields can be placed;
  - the server proposes the conversion;
  - the limits block;
  - a distinct, non-zero pair;
  - approval per candidate, while the import switch stays off;
  - one-tap *Switch off*;
  - the undo runbook for anything already imported.
- **The one-transaction save is designed against the guards, not proven.** The test comes first, and R8 is the fallback.
- **Each user's GPEXE display units differ** (page 11). The third column follows the unit the admin chooses. A wrong choice makes the admin refuse to confirm, which is the safe direction.
- **Only the session level is checked.** Drill values use the same extractor but are not compared.
- **A second copy of personal data.** It is bounded by expiry and erasure. Backups keep values for their own retention (section 6.3).
- **Clubs may wait for the platform.** A new field waits for one platform act. That is the honest limit of "no hassle" under b1.
- **Dependencies:** 7h, O16 and 9-B; the M6 freeze; a plan order that needs the owner's direct word.
- **T5 collisions** between system and club mappings on one team. The board shows them before saving.
- **The snapshot lives 30 days after it was last seen.** The board needs a recent search and never sends a GPEXE request.
- **C9 pinning.** A club's active version pins its own variable, so a unit change becomes a new variable (C111). C61 is kept, so no club can freeze a system variable.
- **Migration size.** T8's revision guard and v48's actor guard are replaced, and T2b too under a2. Each replacement is md5-checked. The rollback refuses once the tables are used.
- **The pair must be findable.** Without links or GPEXE names, the board refuses and points to Link athletes (R6). Only R6's distance option would help there.

---

## 13. Not in this contract

- C111's contract (J19), except the touch points of section 8.4.
- 7h (J14) and 7i (J15), except what J18 needs from them.
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

*Empty.* This section will record the internal reviews (`code-reviewer`, `db-reviewer`, `security-reviewer`), then the *Rukovodilac*'s and the *Nezavisni revizor*'s ★★ reviews, and the owner's decisions on Q1–Q13.