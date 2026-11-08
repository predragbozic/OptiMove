# Preparing the first regular import for the First team

| | |
|---|---|
| Status | **Proposed** by the executor on 2026-11-08, on the *Rukovodilac*'s order of that day. Documentation only: no code, no migration, no production read, no GPEXE request. Nothing here switches an import on. |
| Verified against | `origin/main` at `e03f3741` (U5-1 / v57 and U5b deployed). Production facts are quoted from `docs/ai/CURRENT_STATE.md` and the *Rukovodilac*'s reports. |
| Reads with | `docs/runbooks/team-import-switch-v56.md` (the per-team switch), `docs/runbooks/gpexe-backup-verify.md` (the backup and the restore check), `docs/ai/phase9-importer-mappings-contract.md` section 10 (the first window, M6), `docs/runbooks/session-undo-v57.md` (the undo), `docs/ai/gps-import-flow-contract.md` (J19). |
| Decides | The owner, for everything in part A that is a red-zone act (Render, backup, the switch). The *Rukovodilac*, for part B's proposal and part C's checks. |

## 0. In short

- **Today:** one session (GPEXE 190122, First team) was imported on 2026-11-02 through the first window (M6). The environment switch is off. The First team has **no** per-team switch row (v56's post-check: 0 rows), so nobody can approve an import, a platform admin included. No backup date and no restore-probe date is recorded in the app.
- **Two switches must both be on** for an approval: `GPEXE_IMPORT_APPLY_ENABLED` (Render, the whole server) and the team's own switch (the app, immediate). Turning the team switch **on** needs a recorded backup dated within **2 days** and a restore probe within **35 days**.
- **The owner's part** (section 2): read the backup date in Supabase, run the restore probe, record both dates in the app, turn the First team on in pilot mode, and (once) set the environment switch on.
- **The first window's 9-R SQL files** (section 3) were built for a different problem (one environment-wide switch, one approval, a freeze). Most of what they check is now done by the per-team switch, by the undo, or cannot hold for regular imports. Proposal: retire the window procedure for regular imports and issue **one** generic, parameter-free, read-only check instead.
- **The first import** (section 4) goes through the Imports screen: find, link pairs, review, *Import N ready*, with the *Rukovodilac*'s checks before and after.
- **Still open** (section 5): the Supabase plan and its backup options are **not known to this document**; the first production undo has not been run; the backup-freshness mechanism, the legacy token cut-over (F3c4) and the second-club conditions are not done.

## 1. What is true today

| Fact | Source |
|---|---|
| The import switch `GPEXE_IMPORT_APPLY_ENABLED` is off; it was on once, 13:05-13:17 UTC on 2026-11-02, for the M6 window. | J17 section 10.5 |
| One session is imported (190122, 23.10.2026, 39 results, 117 values, 13 athletes). Its 13 athletes still wait for their roster state. | J17 section 10.5; `CURRENT_STATE.md` Separate tasks |
| v56 (the per-team switch) is on production; **0 switch, history and record rows**, so every team is off. | `CURRENT_STATE.md`, U2 |
| v57 and the undo screen are on production; no undo has been run. | `CURRENT_STATE.md`, U5-1 and U5b |
| The First team is bound to GPEXE team 980; three system mappings (duration, total distance, maximal running speed) are switched on for it, each Required. The other seven seeded GPEXE fields have no mapping, so their values are **not imported** (the review says so, per session). | J17 section 10.2 and 10.5 |
| A 14-day check of the First team took 5 min 59 s with 786 GPEXE requests (2026-10-24). | `CURRENT_STATE.md`, check timing |
| The owner's decision O10: the production-use gate for names and dates of birth (legal basis, notice) is **not required**; it is the owner's assessment, not a legal confirmation. | J17 section 12.3 |

## 2. Part A - what the owner does alone

The owner does these steps, in this order. The main session and the *Rukovodilac* never hold the Supabase login, the Render login or the dump.

### A0. Know the Supabase plan

Everything below depends on the plan of the Supabase project. **This document does not know it.** Open the project's *Settings -> Billing* (the plan name) and *Database -> Backups*. Write the plan and what *Database -> Backups* shows into the record row of A4.

### A1. Where the date of the last backup is

What Supabase's documentation says (read in search results on 2026-11-08; **the documentation pages themselves could not be opened from this session**, so confirm each point on the dashboard before relying on it):

| Plan | Automatic daily backups |
|---|---|
| Free | The search result only showed that a FAQ exists for this ([Supabase FAQ](https://supabase.com/kb/faqs/platform/free-plan-backups)); its answer was not read. Treat the Free plan as having **no** automatic backup until the dashboard says otherwise; then only a manual dump exists. |
| Pro | The last 7 days. |
| Team | The last 14 days. |
| Enterprise | Up to 30 days. |

([Database Backups](https://supabase.com/docs/guides/platform/backups).) The dashboard path is *Database -> Backups* of the project, where the list of daily backups with their dates is shown. **If the Point-in-Time Recovery (PITR) add-on is on, Supabase no longer takes daily backups** (same page); then the page shows the PITR window instead, and the date to record is the day of the newest recoverable point.

What the app wants is only a **date** (a day, not later than today, not older than 400 days). The condition is: the recorded backup date is within 2 days of the day the team is turned on.

The owner's own manual dump (`OptiMove-backups/optimove-production-<date>.dump`, taken and verified in M6 with `gpexe-backup-verify.mjs --remote-source`) is a **backup for this purpose too**: its date is the day it was taken. It works on every plan, including Free, and it is the one this repository has already proven (222 tables, 92,490 rows, 0 differences on 2026-11-02). A dump is only as fresh as its day: take a new one for each recording (2 days).

### A2. The restore probe, without touching production

A restore probe means: a backup was **restored somewhere else** and its content was compared with the source. Options that exist (prices and conditions as the documentation states them; confirm on the pricing page):

| Option | What it proves | Touches production? | Cost | Notes |
|---|---|---|---|---|
| **1. The owner's dump and a local restore** (`gpexe-backup-verify.mjs --remote-source`, `docs/runbooks/gpexe-backup-verify.md`, "The deployed database (Supabase), from the owner's computer") | That the owner's own `pg_dump` restores and equals the source (every table's row count and digest, every catalog object). | No: the source is only read, on one exported snapshot. The restore goes into a local `optimove_tests_gpexe_restore_*` database that the script always drops. | None. Needs PostgreSQL 17 client tools on the owner's computer (the script checks `pg_dump` is at least the server's major version). | **Recommended as the probe the app records.** It is the same file the owner already ran. It does not prove that Supabase's own backup restores. |
| **2. "Restore to a new project"** | That a Supabase backup restores, on Supabase's side, into a separate project. | No: the source project is not changed; the copy is a new project in the same region. | A new project bills as a project (compute and disk, by the hour, while it exists). Needs a paid plan and **physical** backups on the source. **The exact bill is not on a page this session could read**; the owner reads it in the restore dialog before confirming. | **Two cautions from the documentation:** the copy includes extensions that act outside the database (`pg_cron`, `pg_net`, wrappers), and their jobs start running as soon as the copy is up; and the copy must be **deleted** afterwards (a paused project can still bill for storage - confirm). Never point the Render service at it. Whether OptiMove uses any such extension is not recorded here: run `select extname from pg_extension` first (read-only). |
| **3. PITR into a copy** | That a precise point in time restores. | The documentation describes restoring in place; whether PITR can target a **new** project is not clear from what this session read. **Do not use an in-place PITR restore as a probe: it replaces the project's data.** | The add-on is billed hourly: about 100 USD a month for 7 days of retention, 200 for 14, 400 for 28 (documentation figures), not covered by the spend cap; **turning it on stops the daily backups**. | **Not recommended for this purpose.** Only if the owner wants PITR for its own sake. |
| **4. Downloading Supabase's daily backup from the dashboard** | The same restore as option 1, but from Supabase's file. | No. | None. | Only a **logical** backup can be downloaded; projects on newer Postgres versions use **physical** backups, which cannot be downloaded directly, and large databases are not offered for download at all. Likely unavailable; option 1 replaces it. |

**Proposal:** record the probe from **option 1** every month (it costs nothing and is already scripted), and do option 2 **once**, before the first regular import, if the plan allows it and the owner wants proof that Supabase's own backup is restorable. If the plan is Free, only option 1 exists and the owner decides whether that is enough (the J17 decision O2 already chose it for the M6 window).

### A3. Recording both dates in the app

OptiMove cannot read Supabase; it stores the date the owner states.

1. Sign in as a platform admin; open *Training Load -> Data & Analysis -> Imports*, choose the **First team**.
2. In *Imports for this team*, open **Record a date**. Choose **Database backup**, the date (today at most), an optional note (the plan, the file name, "verify.json sha256 ..."), **Record**. Repeat with **Restore probe** and the date the probe was done.
3. The same can be sent as `POST /api/training-load/gpexe/import-prerequisites` with `{ kind: "backup" | "restore_probe", recordedOn: "YYYY-MM-DD", note }`; only a platform admin.
4. The dates are global (the platform's, not the team's). The panel lists the conditions with a tick: *Database backup (at most 2 days old)*, *Restore probe (at most 35 days old)*.

The dates are **checked once, when a team is turned on**, not at every approval. A backup that ages out afterwards does not stop an approval by itself (a known limit, `team-import-switch-v56.md`).

### A4. Turning the First team on (pilot mode)

1. Sign in as a platform admin in the First team's workspace (or the platform workspace with the team chosen).
2. *Imports for this team* shows **Imports are off**, the mode **Pilot** and the conditions. Both dated conditions must read met.
3. Write a **reason** (it goes into the history), press **Turn imports on**. In **pilot mode** only a platform admin, or a coach with an explicit approver grant, approves; **team mode** (the club admin and the coaches) is a separate step that also needs the two attestations (*wrong-link procedure available*, *archived team stops a running search*) and is **not** part of the first regular import.
4. Turn it off at any time with **Turn imports off** (immediate; a club admin may too). A batch stops at the session where it turns off.
5. A record row is written in `gpexe-in-app-import.md`'s table (the operational gate), by the owner, **before** the first approval: the backup path or identifier, the `.verify.json` sha256, when it was verified, who confirmed it, switch on at.

### A5. The environment switch

`GPEXE_IMPORT_APPLY_ENABLED=true` in Render is still required: both switches must be on. **A Render environment change takes effect only with a deploy** (J17 section 10.5, departure 4). The owner sets it, deploys, and confirms `importSwitch` on the Imports status and `/api/health` three times in a row on the same commit.

Recommendation: leave the environment switch **on** from then on and use the **team switch as the gate**. A team with no switch row stays off, the team switch turns off at once (no deploy), and the environment switch remains the emergency stop for the whole server. The decision is the owner's.

## 3. Part B - are the 9-R window files still needed?

The two files (`docs/runbooks/gpexe-import-window-preflight.sql`, 14 blocks; `...-postcheck.sql`, 11 blocks) were written for the first window, when the only switch was environment-wide. Their job was to make one approval, of one session, of one team, provable, under a freeze. What each part does today:

| Part of the window procedure | Still needed for regular imports? | Why |
|---|---|---|
| The **freeze** (no merge, no deploy, no mapping or binding change, no check by the coaches) | **No** | It existed because the switch applied to every team. The per-team switch bounds the import to teams that are on. |
| **"Only this team can import"** (block 4: the First team is the only binding with an open activation) | **Replaced** | The team switch row. The preflight of the *switch* is `team-import-switch-v56-preflight.sql` (already merged). |
| **Backup freshness** (block 14: no write since the backup) | **Cannot hold** | Regular imports write. The condition is now "a backup dated within 2 days", checked by the database when the team is turned on. The protection against a wrong import is the **undo** (v57), not a full restore. |
| **The owner accepts each actionable candidate by id** (block 9) | **No** | The coach or admin reviews each session on the Imports screen; the approval's `previewHash` binds the click to what was reviewed. |
| **The owner accepts each platform admin and approver grant** (blocks 11-13) | **Keep, smaller** | Rights still matter: print them once before the first import and again whenever the *Rukovodilac* wishes. |
| **Exactly one approval, then switch off** (steps 14-15) | **No** | Regular imports leave the team on. |
| **The post-import check** (11 blocks: the approval equals the preview, every value has its T6 row, no `gpexe_*` definition, T7 keys set, nothing zero where the preview left a value out) | **Yes, as a generic check** | These are the checks that prove an import wrote what the preview said. They are not specific to one approval. |
| **Pinned to v51** | **Stale** | Both files fail from v52 on (J14's rule: "No window may start on the v51 files"; the *Rukovodilac*'s mandatory re-issue before the next window). |

**Proposal.**

1. **Withdraw the window procedure for regular imports.** The files stay in the repository as the record of the first window (their sha256 values are quoted in J17).
2. **Issue one new read-only file**, `docs/runbooks/gpexe-import-check.sql` (a small PR, tested on a disposable database before and after a real approval, with mutations, as 9-R was), parameter-free, each block one `SELECT`: the last migration and the served commit; no check running; the First team's open activations as decided; **for every approval in the last N days**: counts equal its preview, every value has its T6 row, no `gpexe_*` definition, T7 keys, no zero where a value was left out; the rights list (platform admins and the team's approver grants); the number of imported sessions that have no roster state yet. It fixes the stale pin and the *Nezavisni revizor*'s L1 (post-check block 8 counting ended instances) at the same time.
3. Until that file exists, the first regular import can be checked with the **existing post-check blocks 3-11**, which the *Rukovodilac* has already run once against the M6 approval; they name "the one active First team binding" and one approval, so for a batch they are run per approval id, with the pinned v51 block 1 skipped and its expected value replaced by v57. This is workable for **one** session and clumsy for a batch; hence the proposal above.

## 4. Part C - the first import, through the Imports screen

Everything below is a person on the Imports screen of the First team (a platform admin, in pilot mode). The screen's own names are used.

**Before (owner):** part A is done: both dates recorded, the First team on in pilot mode, the environment switch on and confirmed, the record row written.

**Before (the *Rukovodilac*, read-only, through its connector, each block in a read-only wrapper):**
1. `/api/health` three times in a row on the commit `main` serves; v57 the last migration; no running check; no idle transaction.
2. The switch: the First team's row `enabled`, mode `pilot`, the history row with the owner's reason; **no other team has a switch row**.
3. The conditions: the two recorded dates and their ages (backup at most 2 days at the time of the first approval).
4. The binding: First team <-> GPEXE 980, connection `verified`; the three open activations, each Required; the non-canonical link count 0 (link gate 1).
5. The rights: every active platform admin and every unrevoked approver grant of the team (the owner confirms each).
6. The candidates: how many are pending, their ages, which carry a version 2 preview (the 14 candidates of 05-21.10 from M6's record: their snapshots were retained 30 days and may have expired; they come back only through a new check), and that **none is imported except 190122**.

**The steps (owner or the platform admin):**
1. *Imports -> the five-step guide*: connection, binding, variables, check, links. Steps 1-3 should already read done.
2. **Find new sessions** for a chosen window (start with one week, not the default 14 days; a check of that size takes minutes and about a thousand GPEXE requests). Wait for *succeeded*; a failure shows its own code under Technical details.
3. **Link athletes**: *Suggested pairs* (U3) shows GPEXE name and date of birth against the team's athletes; read each pair, **Confirm all** the exact matches, link the rest by hand. Wrong links are the one thing the undo exists for, so look at the names, not only the count. Find new sessions again after linking (the screen says so).
4. **Review one session**: preview version 3, the athletes imported, the values left out and why, the fields not switched on ("N GPEXE fields are not switched on for this team, so their values are not imported"). Only a session the last successful search confirmed is *Ready*.
5. **Approve the first session on its own** (open it, **Approve import**) rather than the batch, so that one approval can be read back (`GET .../approvals/:approvalId`) before the rest.
6. **The rest:** tick the *Ready* sessions or use **Import N ready** ("Import first 50 ready" above the ceiling), **Review N sessions**, **Import N sessions**. The batch imports each session in its own transaction, one after another; a lost answer reads *Result not confirmed* with **Check again**, never a second import.
7. **Roster:** the imported activities show a Roster tab with athletes waiting for a state (*Participated · no device data* / *Did not participate*). **Do no roster decision on a session until the *Rukovodilac*'s post-import check has passed**: the undo refuses once a roster decision exists.

**After (the *Rukovodilac*, read-only):** the approval read; the candidate `imported` with its approval; the counts equal the preview; every value has its T6 row (the number of rows equals the values written); the T7 keys of the First team are set; no `gpexe_*` definition appeared; no value was written as zero where the preview left one out; no roster decision and no calendar link on the imported activities yet; the number of imported sessions equals the number the owner approved; the environment switch and the team switch still read as the owner left them. Anything else is a stop: the owner decides (an undo, a team switch off).

**If a session was imported under a wrong link:** *Unlink*, then **Undo this import** on that session's review (platform admin; it reads the scope first, asks for a reason, shows *Check the result* if the answer is lost); then link correctly and find new sessions. **The first production undo is owner-run, after a restore-verified backup** (J19 condition 1): this is the point of keeping the backup within 2 days.

## 5. Part D - conditions that are still open

| Open item | Where it is recorded | Needed before the first regular import? |
|---|---|---|
| The Supabase plan and what it offers (backups, PITR, restore to a new project) | this document, A0-A2 | **Yes**: the backup date and the probe depend on it. |
| A fresh **backup** and a **restore probe**, recorded in the app | A1-A3 | **Yes** (the database refuses the switch without them). |
| The **record row** of the operational gate, written before the switch | `gpexe-in-app-import.md` | **Yes** (a person's step). |
| The owner's decision whether the environment switch stays on | A5 | **Yes** (a decision). |
| The first **production undo** has not been run; the wrong-link procedure rests on tests (30 backend, 20 frontend) | `CURRENT_STATE.md` U5-1, U5b | Recommended: owner-run rehearsal on one session after the first import's check, before relying on it. Not a team-mode attestation yet. |
| **Backup freshness at every approval**, or an automatic switch off when the backup goes stale | owner's decision of 2026-11-04 (U2 notes) | Before a **second club** or **regular self-service**; for the pilot the owner turns the team off. |
| **F3c4**: the legacy `GPEXE_API_TOKEN` path retired, `legacy_env` forbidden for new check rows | `CURRENT_STATE.md`, F3c3/F3c4 | Not blocking: the First team reads only through its binding. It is still recorded as part of "F3c complete". |
| **Second club** conditions: a club admin sees only their own club's teams; one GPEXE account = one club; the pair only for visible ids (a migration, ★★) | `CURRENT_STATE.md`, Separate tasks | No for the First team; yes before another club. |
| The **9-R files** re-issue or withdrawal | part B | Recommended before the **second** window of any kind; the first regular import can use the existing post-check per approval. |
| The 14 candidates with a **version 2 preview** (05-21.10) | `CURRENT_STATE.md`, Separate tasks | Only if the owner wants those sessions: they need a new check of their dates. |
| The 13 athletes of session 190122 wait for their **roster state** | `CURRENT_STATE.md` | Not blocking; do it after the post-check of the first regular import. |
| Not run anywhere: `test:backend:shared` on v56 and v57; PostgreSQL 17 for v57; a physical-device check of U5b | `CURRENT_STATE.md` | Not blocking; stated, so nobody assumes it was done. |
| Names and dates of birth: the production-use gate is waived by the owner (O10), not confirmed by a lawyer | J17 section 12.3 | Decided; record it, do not re-open it silently. |
| A check's duration (about 6 minutes for 14 days) and GPEXE's rate limit (a 429 repeats once, then stops) | `CURRENT_STATE.md`, 429 and check timing | Not blocking: start with one week. |

## 6. What this document does not claim

- **Supabase's prices, plans and restore behaviour** come from search-result summaries of its public documentation (2026-11-08). The documentation pages themselves could not be opened from this session. Confirm each figure and condition on the dashboard and the pricing page; where the pages differ from this document, the pages win.
- It does not say which Supabase plan the project is on.
- It sends no GPEXE request, reads no production data and changes no setting.
- The proposed `gpexe-import-check.sql` is not written; it is a separate documents-and-SQL pull request after the *Rukovodilac*'s decision.
