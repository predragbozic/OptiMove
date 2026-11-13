# App error tracking, backend (migration v58, Option A / A1)

A sanitized record of the errors the app hit, in the browser and on the server, for a platform admin to read.
Migration: `migrations_v2/202611091000_app_error_events.sql`. Files beside this runbook:
`app-error-events-v58-preflight.sql`, `app-error-events-v58-postcheck.sql`, `app-error-events-v58-rollback.sql`.
Code: `backend/src/appErrorTracking.js`, `backend/src/routes/appErrors.js`, the hook in the global error handler of
`backend/src/server.js`. Tests: `backend/tests/app-error-tracking-a1.test.mjs`. The browser side is A2 (not part of this change).

## What is stored, and what never is

One table, `public.app_error_events`. Every text column is a closed shape, enforced twice: by the code that sanitizes and
by a CHECK in the table, so a buggy writer cannot store free text.

| Column | Shape |
|---|---|
| `source` | `client` or `server` |
| `screen` (client) / `route_template` (server) | a lower-case word, or a route pattern with every id replaced by `:id`, no query string, at most 120 characters |
| `action`, `error_code` | `[a-z0-9_.-]`, at most 60 characters (an error code is a stable code, never a message) |
| `http_status` | 100 to 599 |
| `role` | `platform_admin`, `coach`, `athlete`, `user`, `none`; derived by the server from the session, never from the report |
| `release_commit` | 7 to 40 hex characters (the browser may send its build; anything else is replaced by the server's commit) |
| `user_hash` | 12 hex characters of `sha256('app-error-user:' || user id)`; never the id, never a name or e-mail |
| `stack_signature` | the grammar `fn@file( > fn@file){0,3}` (function and file names, no line numbers, no message), at most 200 characters; a browser report whose `stackSig` does not match is refused (`400`). The grammar removes the accidental path (an error message in the field); it cannot stop a hostile client that encodes words as `fn@file`, so the column is a bounded shape, not a proof of "no text" |
| `fingerprint` | sha256 of source, screen or route, action, code, status and the signature |
| `repeat_count`, `first_seen_at`, `last_seen_at` | counters; the only columns that ever change |

Never stored: names, e-mails, request bodies, query strings, content, tokens, an error's message, anything a source returned.
A server error is recorded only for a 5xx; a pool checkout timeout is not recorded. A failure to record is logged by its
code only and never changes the answer.

## Routes (`/api/app-errors`, sign-in required)

* `POST /` one browser report: exactly the keys `screen`, `action`, `code`, `status`, `stackSig`, `release`, `reason`, each in its closed
  shape, or `400 invalid_error_report` (nothing stored, the answer never repeats the report). The route parses at most 4 KB (`413 body_too_large` beyond it); `429` after 20 reports a minute from one user; success is an empty `204`.
* `GET /groups?days=1..30` for an active platform admin: the errors grouped by fingerprint (occurrences, distinct users, first and
  last seen, latest release, roles). Anyone else gets the same 404 as an unknown route.

### What failed (`reason`)

A native rejection — an aborted request, a refused `play()` or full screen — carries no script frames, so its
`stack_signature` is empty and the row says nothing about itself. The browser therefore sends one more word: `reason`,
the `name` of the error or of the rejection's reason, lower-cased, and only when it is one of
`aborterror`, `notallowederror`, `notsupportederror`, `invalidstateerror`, `securityerror`, `networkerror`,
`timeouterror`, `quotaexceedederror`, `typeerror`, `referenceerror`, `rangeerror`, `syntaxerror`, `other_error`
(an error object with any other name), `non_error` (the reason is not an error object), `none` (there is no reason),
`script_error` (the browser hid a foreign script's error) or `no_error_object`. A message is never sent.

It is accepted only with `unhandled_rejection`, `js_error` and `handler_error`, and is stored as the second part of
`error_code` (`unhandled_rejection.aborterror`): no column is added, and two reasons are two kinds of error in the
grouping. A report without it is stored as before, so a page still open from an older release keeps working. Any other
word, or one with another code, is `400` and nothing is stored.

`handler_error` is the app's own click handler failing (`guardHandler` in `frontend/app-errors-capture.js`): it is
reported once, with the control that was really used and the handler's own frames, instead of surfacing later as an
anonymous rejection labelled with whatever was tapped last.

## Throttle and size

The same user repeating the same fingerprint inside one hour raises `repeat_count` on the existing row (one transaction under an
advisory lock per user and fingerprint, so concurrent reports count instead of duplicating). A user's new rows are capped at
100 per hour, and rows with no user (a server error before sign-in) at 200 per hour in all; a report over the cap is dropped silently.
A server error repeating the same fingerprint within a minute is dropped in memory before it reaches the database, and at most 10 server-error writes are in flight at once.

## Retention

Rows whose `last_seen_at` is older than 30 days are deleted in batches of 5000, each in its own transaction with a 10 s statement timeout and a 2 s lock timeout, by `purgeAppErrorEvents()`, run by the server on
start (after 60 s) and every 6 hours (`startAppErrorRetentionSchedule`). A row is never updated except `repeat_count` and
`last_seen_at`; `TRUNCATE` is refused. There is no separate run table: the purge logs only its failure code.

## Deploy

1. The owner's order naming `202611091000_app_error_events.sql`; the Rukovodilac runs `app-error-events-v58-preflight.sql`
   (read-only, block by block, all `ok`).
2. Deploy. The migrator applies v58 before the server starts (`npm start`). Nothing is stored until a browser reports (A2) or a
   server error occurs.
3. The Rukovodilac runs `app-error-events-v58-postcheck.sql` read-only.

## Rollback

`app-error-events-v58-rollback.sql`: one transaction, refuses while the migrator runs, when v58 is not recorded, or when a later
migration is applied; otherwise drops the table (the rows are telemetry) and its three functions and removes the record. The
deployed commit must no longer contain the migration file or import `appErrorTracking.js` first. Rehearsed in test 7 of the suite.

## Limits and notes

* `role` is derived from the session's roles: a club admin or a team coach is recorded as `coach` (a pilot simplification).

* The user hash is a short, unsalted one-way hash of a random UUID: it lets one user's repeats be counted and distinct users
  be counted; it is not a defence against someone who already holds the user list (who can recompute it).
* The in-memory rate limit is per server process.
* The Supabase Data API is off for this project (checked at the v38 deploy), so the new table is not exposed through it; the table
  has no row-level security, like the v36 and v38 tables.
* `route_template` for a server error comes from the Express route pattern; a request that matched no route is recorded as
  `/unmatched`, never by its URL.
* Row-level security is on with no policy, nothing is granted to PUBLIC (table and trigger functions), and every privilege on the table is revoked from `anon` and `authenticated` (when those roles exist), so a Supabase data API could not read it even if it were switched on for `public`; the post-check asserts all of it. The application's own role owns the table and is not subject to the row-level security.
* The table's triggers also refuse a time in the future (a raw write could otherwise defeat the purge) and a `last_seen_at` that moves back.
