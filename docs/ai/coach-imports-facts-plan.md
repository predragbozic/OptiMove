# Server facts for the coach Imports screen: plan note

Status: **Accepted** (the *Rukovodilac*, 2026-11-13). Asked for on the same day for the design executor's coach
prototype. Checked against `main` `cbede24b`.

## Decisions

- **`athleteStates` (per-athlete counts on a session): dropped.** The owner does not want per-athlete marks; a session
  carries one state.
- **"Later": device-local**, in the frontend only, built by the design executor. There is no server version and no
  migration.
  - A new content version is a new candidate id, so it starts as not-later.
  - An imported or replaced candidate leaves the list anyway.
  - The browser keeps the ids and prunes those no longer listed.
- **`lastSucceededCheck`: built**, as below, as one tiny backend PR right after MT-B is merged.

## `status.lastSucceededCheck`

`lastSucceededCheck: { id, window: { from, to }, finishedAt } | null`, beside `lastCheck`, with no error fields and no
counts.

- **The read:** one more query in the status route's `Promise.all`:
  `select id, window_from, window_to, finished_at from training_load.gpexe_import_checks where owner_team_id = $1 and
  status = 'succeeded' order by started_at desc limit 1`. The index `gpexe_import_checks_team_idx (owner_team_id,
  started_at desc)` serves it.
- **Audience:** everyone who sees the team's status. A coach already gets the window and the time through `lastCheck`.
- **Files:**
  - `backend/src/gpexeImportService.js`: `lastSucceededCheck()` next to `latestCheck`;
  - `backend/src/routes/gpexeImport.js`: the status route.
- **Tests:**
  - `null` before any succeeded check;
  - the succeeded check is still returned after a later failed one;
  - a running check is not returned;
  - another team's check is not returned;
  - the same answer for a coach and an admin;
  - a mutation of the status filter.
- **Review:** none of the five triggers; `code-reviewer` only. No migration, no preflight.
