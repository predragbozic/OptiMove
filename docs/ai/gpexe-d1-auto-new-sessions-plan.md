# Plan D1: OptiMove looks in GPEXE by itself and says how many new sessions are waiting

Status: **plan only.** No code, no migration, no GPEXE request. The owner said yes to D1 on 2026-11-11 (relayed by the
*Rukovodilac*): "OptiMove checks GPEXE by itself and shows 'N new sessions are waiting in GPEXE since …' without a search".
It stays at the end of the GPS queue (after U6b). Each choice in section 8 is the owner's or the *Rukovodilac*'s.

Last verified against commit: `b9460a0` (main after #492). Paths are under `backend/src/` unless written otherwise.

## 1. What exists today

- A check (*Find new sessions*) is started by a person only (`POST …/gpexe/teams/:teamId/checks`, `startCheck`). It reads the
  window's session list twice through the server's date filter (PR #214: 2 requests for a 14-day window ending today), then
  every session of the window in full (rows, `/more/`, tracks, details, drills), previews each under the team lock and stages
  candidates. The last measured First-team check: 786 GPEXE requests, about 6 minutes (`docs/ai/CURRENT_STATE.md`, PR #215).
- The only in-process schedules are retention ones: `startGpexeRetentionSchedule` (a `setTimeout` at start, then a
  `setInterval` every few hours, `gpexeImportService.js`) and the app-error purge. There is a CLI for an external scheduler
  (`npm run gpexe:retention`), and no Render cron job is configured in the repository.
- GPEXE answers a burst with 429. PR #209 bounds one check (one repeat at most). The per-connection pause after a rate-limit
  stop is a plan, not built (`docs/ai/gpexe-connection-cooldown-plan.md`, its section 3 open).

## 2. Count only, not a whole check (recommended)

| | Whole check on a schedule | **Count only (recommended)** |
|---|---|---|
| GPEXE requests per team per run | about 786 for 14 days on First team (2 list + about 60 per session) | **1** (the window's list, through the server's date filter, one page for up to 100 rows) |
| Time | about 6 minutes | about 8–11 s (the filtered page took 7.2–11.3 s in the probe of 2026-10-24) |
| Database | stages candidates, previews under the team lock, writes a check row | one small row of facts per run; no candidate, preview, check row or team lock held across the request |
| 429 risk | high (a burst of reads) | low (one request) |
| What the coach still does | nothing | presses *Find new sessions* when the banner says something is waiting |

A whole check without a person also writes candidates a coach did not ask for, takes the team lock for minutes (an approval
or a link waits), and spends GPEXE's limit when nobody looks. The count gives the owner's sentence at almost no cost; the
real check stays the coach's one click.

**What "new" means.** A parent session of the window (the list's own classification: parents, not drill rows) whose GPEXE id
has no candidate of this team in any status. A session already found but changed in GPEXE is not counted (telling that needs
the bundle); the first version says only "new". The list read once is enough: nothing is staged, so the two-read agreement of
the check (`source_list_changed`) is not needed; a row that moves between two runs is simply counted in the next one.

## 3. When and how often

- **Twice a day per bound team**, at **06:40** and **18:40** in the team's time zone (v62's zone when set, else
  Europe/Sarajevo), each with a per-team offset of 0–10 minutes so teams of one connection never ask at the same minute.
  Outside a usual training window, and early enough that the coach sees the banner before the day's work.
- **Window:** the last 14 days ending today (the same default as *Find new sessions*).
- **Skipped** when, for that team, a check started or finished in the last 6 hours (the coach looked already), a check or an
  identity load is running, the binding is not active, the connection is not *Verified*, the team or club is archived, or the
  per-team switch is off.
- **One run at a time per connection**: teams bound through one GPEXE account are asked one after another, at least 30 s
  apart.
- **A missed run is not caught up** (after a restart or downtime the next due time is used; one run, never a burst).

**The switch per team.** Off by default. A platform admin (and, if the owner wants it, the team's club admin as with U2a)
turns it on in Settings → Data sources next to the pair and the time zone, with a reason, kept in a history. A global
environment switch (`GPEXE_AUTO_COUNT_ENABLED`, default off) stops every run at once without a deploy of code.

## 4. The 429 limit and the per-connection pause

- A count run is a source operation through the connection (`openImportSource`, the same resolver and re-validation as a check:
  binding, connection state, credential fingerprint, host), GET only, no retry.
- **Any 429 ends the run for that connection**: no further team of that connection is asked in this run, and the outcome is
  recorded (`rate_limited`, with the `Retry-After` kind and seconds, never the text).
- **With the pause built** (the cooldown plan, option A, a ★★ PR of its own): a count is one more operation in its matrix
  (section 2a) — refused while a pause is active, and a 429 it meets starts a pause like the identity load's. **Recommendation:
  build the pause before D1-B.** Without it, D1-B keeps its own narrower rule: after a 429 the connection's next count waits for
  its next scheduled slot (at least 12 hours), and a coach's check is not blocked by it.
- A 401 moves the connection to *Needs reconnect* through the existing auto-invalidate path, as a check does; a 403 changes
  nothing. Neither is retried.

## 5. Where it runs, and restarts

| Option | For | Against | Recommendation |
|---|---|---|---|
| **A. An in-process tick (every 15 min) that claims due teams from the database** | No new Render service; uses the server's own credential keys and pool; the state is in the database, so a restart loses nothing; `FOR UPDATE SKIP LOCKED` on the due rows makes two instances safe | Runs only while the web service runs (it does); a long count must not block the event loop (it is one awaited request) | **yes** |
| B. A Render Cron Job running a CLI (as `gpexe:retention` was meant to) | Independent of the web process | A second service with the credential key ring and the database URL; its own deploy; Render cost; nothing in the repository configures one today | no (possible later) |
| C. Extend `startGpexeRetentionSchedule` | One timer | Retention and network work in one tick; a slow GPEXE would delay purges; the interval is hours, not the team's local time | no |
| D. `setInterval` with the schedule only in memory | Simplest | Lost on every restart and deploy, duplicated with two instances | no |

**Option A in detail.** A table holds, per team, `next_run_at` (computed from the team's zone and offset). The tick, in one short
transaction, takes `select … where next_run_at <= clock_timestamp() and enabled for update skip locked limit 10`, moves each
row's `next_run_at` to its next slot **before** any request (so a crash never repeats a run), commits, then runs the counts
outside any transaction, one connection at a time, and records each result in its own short transaction. Order of locks: the
due row only (never the team import lock across a request; the "is a check running" test is a plain read).

## 6. Cost in GPEXE requests

| Per team per day | Count only, twice a day | One whole check |
|---|---|---|
| Requests | **2** | about 786 (14 days, First team, measured 2026-10-24) |
| Time against GPEXE | about 20 s | about 6 min |

A club with 5 bound teams on one account: 10 requests a day for the counts against about 3,900 for one check of each.

## 7. The banner

- **Where:** the GPEXE source card of the Imports screen, above *Find new sessions*; for the coach and the administrators of
  the team. No session id, no GPEXE name.
- **Text:** "3 new sessions are waiting in GPEXE since 10.11.2026 · looked 06:40" with *Find new sessions* as the one action
  (its dates pre-filled to cover the oldest waiting session when it is older than the default 14 days). One session: "1 new
  session is waiting in GPEXE since 10.11.2026". "Since" is the day of the oldest waiting session.
- **Disappears** when a check of this team finishes after the count and its window covers those sessions, or the next count
  finds 0. A count older than 36 hours is not shown (the source card shows "GPEXE was last looked at …" instead, for an
  administrator only). A failed count shows nothing to a coach; an administrator sees "Could not look in GPEXE (rate limited /
  needs reconnect) at …" in the source card's details.
- **Never** a notification or an e-mail in this plan (a later decision).

## 8. Split into pull requests

| PR | What | Mark |
|---|---|---|
| D1-0 | This plan, then its accepted contract (section 9's answers) | ★ (docs) |
| (prerequisite) | The per-connection pause after a rate-limit stop (`gpexe-connection-cooldown-plan.md`, its section 3 decided first) | ★★ (migration, retry, concurrency) |
| D1-A | Migration: the per-team switch with its history and the due state (`next_run_at`, offset, last outcome) and the count rows (team, looked at, window, count, oldest waiting day, outcome); the switch route (platform admin, optionally club admin), no network; preflight, post-check, rollback | ★★ (migration, a new write path with its actor rules) |
| D1-B | The count: the adapter's list-only read (no bundle), the in-process tick with the `SKIP LOCKED` claim, the 429 / 401 handling, the global switch, the status route's count fields; behind `GPEXE_AUTO_COUNT_ENABLED=false` | ★★ (a scheduler, concurrency, a source request without a person) |
| D1-C | The banner on the Imports source card and the switch in Settings → Data sources | ★ (frontend: code, ux, mobile) |

D1-B is deployed with the global switch off; the owner turns it on for First team after a day of watching the log line (one
line per run: team count, requests, outcome; no id or name).

## 9. Decisions for the owner

1. **Count only** (recommended) or a whole check on the schedule.
2. **Times:** 06:40 and 18:40 in the team's zone (or others), twice a day.
3. **Who turns it on per team:** platform admin only, or also the club admin (U2a).
4. **The pause first:** build the per-connection pause before D1-B (recommended), or D1-B's narrower rule until then.
5. **The banner's audience:** coach and administrators (recommended), or administrators only.
6. **Where it runs:** the in-process tick with the database claim (recommended), or a Render Cron Job.
