# App health: which request failed, and whether the server had just restarted (migration v73, AH-2b)

Base: `app-error-events-v58.md`, `app-error-events-v70.md`.
Migration: `migrations_v2/202611151500_app_error_events_v73_request_and_restart.sql`. Files beside this runbook:
`app-error-events-v73-preflight.sql`, `app-error-events-v73-postcheck.sql`, `app-error-events-v73-rollback.sql`.
Code: `backend/src/appErrorTracking.js`, `backend/src/server.js`, `frontend/app-errors-capture.js`, `frontend/api.js`,
`frontend/app-health-view.js`.
Tests: `backend/tests/app-error-events-v73.test.mjs`, `frontend/tests/app-errors-request.test.mjs`.

## Why

A browser report "the server did not answer" (`no_response`) said on which screen and after which button, and nothing
about which call it was or what the server was doing. v73 records, for each new row:

| Column | Shape | Whose |
|---|---|---|
| `request_method` | `GET`, `POST`, `PUT`, `PATCH`, `DELETE` | browser reports of a failed call |
| `request_route` | a route pattern, at most 120 characters of `A-Z a-z 0-9 _ / : . -` | with the method, both or neither |
| `server_uptime` | `lt_2m`, `lt_10m`, `ge_10m`: how long the server process had run when it stored the row | every row |
| `page_behind_server` | boolean: the page's build is not the server's | browser reports |
| `delivered_late` | `lt_1m`, `lt_10m`, `lt_1h`, `ge_1h`: how long the page held the report | browser reports |

All five are null on rows from before v73 and are final from the insert (the update guard's body is replaced; the
migration refuses unless the body it replaces is v70's, md5 `13009f97dbedc04be84380baa037ce88`; the new body's md5 is
`05cd59a40237bf6b443d268961409d93`). A server error carries the uptime only (a CHECK): it already has its own route.

## What is and is not sent

* **The request is never a URL.** The page sends `request: { method, route }`, exactly those two keys. It reduces the
  path itself: the query string and the fragment are cut, an id (a UUID, a number, a long hex word, any segment over
  40 characters) becomes `:id`, a segment with other characters `:x`. The server reduces it **again** the same way and
  then keeps only the words its own routes are made of (collected from the Express app at start); every other segment
  becomes `:x`. So a name, an e-mail or a search word that ended up in a path is not stored, whatever page sent it.
  A request of any other shape is `400 invalid_error_report` and nothing is stored.
* **The page's build** is the commit word the production build already carries (`<meta name="optimove-build">`), sent
  as `release`. As before v73, a row's `release` is the report's own build when it names one (now every production
  page does) and the server's otherwise; `page_behind_server` says whether the two differ and is null when either
  is unknown (a development page, a server without `RENDER_GIT_COMMIT`).
* **A report that could not be delivered** (its own request got no answer - the same outage, usually) is kept by the
  page **in memory only**, at most five, and sent **once** after the next call that did get an answer, with `late` set
  to how long it waited. Whatever happens to that one attempt, the report is then dropped: there is no retry loop, no
  storage, nothing survives a reload. A signed-out page sends nothing.

## What it changes for existing data

* No existing row is rewritten. A row without a request keeps the fingerprint it had: the request is part of the
  fingerprint **only when a report carries one**, so from the deploy on "did not answer" on one screen splits into one
  kind per request. For up to 30 days an old kind (no request) and its new kinds (with one) stand side by side.
* One hour of repeats is counted on a row only when the five new facts are the same too, so the counts "around a
  restart" stay true to their rows.
* Locks: `ACCESS EXCLUSIVE` on `public.app_error_events` until the migration's COMMIT; the column additions are
  catalog-only and the six CHECKs are validated in the same `ALTER TABLE` over at most 30 days of rows (preflight
  block 3 shows how many).

## On the screen

`GET /api/app-errors/groups` adds to each kind: `request` (`{ method, route }` or null), `aroundRestart` (occurrences
stored within two minutes of the server's start, or delivered late), `deliveredLate`, `pageBehindServer`. App health
shows the request beside the code ("no_response · POST /api/media/access") and, only when there is something to say,
"↻ Around a server restart · 3 of 6 times (1 delivered late)" and "⇅ Page older than the server · 2 of 6 times". The
detail has a "Request" line. Only a platform admin has the screen and the read.

## Deploy

1. The owner's order naming the v73 file. No new secret and no new environment variable.
2. The Rukovodilac runs `app-error-events-v73-preflight.sql` read-only, block by block. The file-name prefix is
   re-checked against `main` at that time (v71 and v72 are other slices' labels; the runner refuses a shared prefix,
   applies by file name and does not refuse a file older than the last one applied - preflight block 1's
   `nothing_later` is then read with that in mind, as for v70).
3. Deploy; the migrator applies v73 before the server starts.
4. The Rukovodilac runs `app-error-events-v73-postcheck.sql` read-only. Right after the deploy block 3 shows no row
   with the new facts; the first error stored by the new server has an uptime.

A page loaded before the deploy keeps sending reports without a request or a build; they are stored as before.

## Rollback

`app-error-events-v73-rollback.sql`: one transaction; refuses while the migrator runs, when v73 is not recorded and
when a migration with a later file name is recorded. Otherwise it locks the table, drops the five columns (their
CHECKs go with them), restores v70's guard body (md5 `13009f97dbedc04be84380baa037ce88`) and removes the record. The
rows stay; a row that had a request keeps the fingerprint it was stored under. The deployed commit must first no
longer contain the migration file or write the new columns. v70's rollback refuses while v73 is recorded, so the
order is v73's first. Rehearsed in `app-error-events-v73.test.mjs` (refusals, rollback, v70's own post-check true
again, re-apply, the md5 gate).

## Limits

* The uptime is the process's own (`process.uptime()`): "around a restart" is true of a restart of the server process
  (a deploy, a crash, the host waking the service), not of a database or network fault with the server left running.
  A report delivered late is counted there too because the page could not reach the server when the error happened;
  that can also be the person's own connection.
* The request, the build and the lateness come from the browser: a hostile signed-in client can send any value of the
  closed shapes. They are bounded, not proven. The route's words are limited to the server's own.
* The words of the server's routes are collected once, at start. A route word that also happens to be someone's
  name or an ordinary word in a path is kept as that word; nothing longer than a route word of the app can be stored.
* Reports held for late delivery are lost on a reload or when the tab closes, and beyond five. The count of errors
  during an outage is therefore a lower bound.
* `backend/tests/_gpexe-disposable-db.mjs`'s shared list carries neither v70 nor v73 (suites that need error rows
  append them); follow-up as recorded in the v70 runbook.
