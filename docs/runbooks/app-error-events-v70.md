# App health: the device of an error and the keyed user hash (migration v70, AH-1)

Plan: `docs/ai/app-health-device-person-plan.md` (sections 2, 4.4, 10 and 10.1). Base: `app-error-events-v58.md`.
Migration: `migrations_v2/202611131400_app_error_events_v70_device_and_keyed_hash.sql`. Files beside this runbook:
`app-error-events-v70-preflight.sql`, `app-error-events-v70-postcheck.sql`, `app-error-events-v70-rollback.sql`.
Code: `backend/src/appErrorTracking.js`, `backend/src/routes/appErrors.js`, `frontend/app-errors-capture.js`.
Tests: `backend/tests/app-error-events-v70.test.mjs`, `frontend/tests/app-errors-capture.test.mjs`.

AH-1 stores; it shows nothing new. The device breakdown on the screen is AH-2 and "Show person" is AH-3.

## What v70 changes

* `public.app_error_events` gains seven columns, final from the insert (the update guard's body is replaced; the
  migration refuses unless the body it replaces is v58's, by md5):

  | Column | Shape |
  |---|---|
  | `device_class` | `phone`, `tablet`, `desktop`, `unknown` |
  | `os_family` | `ios`, `android`, `windows`, `macos`, `linux`, `chromeos`, `other` |
  | `browser_family` | `safari`, `chrome`, `firefox`, `edge`, `samsung`, `webview`, `other` |
  | `browser_major` | 1 to 999, only with a family |
  | `viewport_bucket` | `lt_360`, `360_479`, `480_767`, `768_1023`, `1024_1439`, `ge_1440` |
  | `touch` | boolean |
  | `user_hash_version` | 1 = the unkeyed hash of v58 (every existing row); 2 and later = keyed |

  All six device facts are null for a server error (a CHECK), for a row from before v70 and for a report of a page that
  predates the change. They are chosen in the browser from the User-Agent, `maxTouchPoints` and the window's width;
  **the User-Agent string is never sent and never stored**. The server accepts `device` on a report only as exactly the
  keys `class`, `os`, `browser`, `major`, `viewport`, `touch`, each a word of its list; anything else is
  `400 invalid_error_report` and nothing is stored.
* `public.app_error_person_lookups`: who used "Show person" (AH-3), when, on which kind of error, how many people were
  named. No name and no hash. Append-only; a row is deleted only once older than 365 days (`purgePersonLookups()`, run
  with the 30-day purge of the events). Nothing writes to it before AH-3.

No existing row is rewritten. Locks: `ACCESS EXCLUSIVE` on `public.app_error_events` until the migration's COMMIT (the
column additions are catalog-only; the eight CHECKs are validated over at most 30 days of rows - preflight block 3 shows
how many).

## The keyed user hash

`user_hash` of a new row is the first 12 hex characters of `HMAC-SHA256(key, "app-error-user:" + user id)`, computed by
the server. The key never reaches the database, a log or an answer.

* **The key ring** is the server's environment variable `APP_ERROR_USER_HASH_KEYS`:
  `2:<base64 of at least 32 random bytes>`; after a rotation `2:<old>;3:<new>`. The highest version is the one new
  rows get. Version 1 is the unkeyed hash and can never be a key's version. Make a key with
  `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`; it is set in the Render environment by
  the owner, never in the repository or a chat.
* **Without a usable ring** (unset, or any part malformed - the whole ring is then refused): a new row is stored
  **without a hash** (`user_hash` null, version 2), never with the unkeyed one. The server says so once in its log,
  naming the variable only, and `GET /api/app-errors/groups` answers `people: "not_configured"`, which App health shows
  as one line. Errors are still recorded and grouped; people are not counted for those rows, one user's repeats are not
  told apart (they raise the count of one row per kind of error and device), and such rows fall under the cap of rows
  without a user (200 an hour in all). "Show person" (AH-3) fails closed without the ring.
* **Old rows** keep version 1 and their unkeyed hash until they age out (30 days). For that time one person may be
  counted twice in a group (once per version). AH-3 resolves a version 1 row by the old formula and a keyed row by
  its own version's key.
* **Rotation:** add the new key with the next version and keep the old one in the ring for 30 days, then remove it.
  A version whose key has left the ring can no longer be resolved to a person; its rows are still counted.
* **One hour of repeats** is counted on a row only when the fingerprint, the hash, its version and the six device
  facts are all the same, so one kind of error on two devices is two rows of the same group.

## Deploy

1. The owner's order naming the v70 file. Before the deploy the owner sets `APP_ERROR_USER_HASH_KEYS` on the service
   (step 2 works without it, with the behaviour above).
2. The Rukovodilac runs `app-error-events-v70-preflight.sql` read-only, block by block. The file-name prefix is
   re-checked against `main` at that time (the runner refuses a shared prefix; it applies by file name and does not
   refuse a file older than the last one applied).
3. Deploy; the migrator applies v70 before the server starts.
4. The Rukovodilac runs `app-error-events-v70-postcheck.sql` read-only. Block 4 with `signed_in_without_hash > 0` on
   version 2 means the key is missing or unreadable.

## Rollback

`app-error-events-v70-rollback.sql`: one transaction; refuses while the migrator runs, when v70 is not recorded, when a
later migration is recorded, **once a keyed hash is stored** (without the version column it would read as unkeyed -
from then on v70 is forward-only) and once a lookup is recorded. Otherwise it drops the seven columns, restores v58's
guard body (md5 `1737e2dd01bcdb74f02a006a65cb5389`), drops the lookups table and its functions and removes the record.
The deployed commit must first no longer contain the migration file or write the new columns. Rehearsed in
`app-error-events-v70.test.mjs`.

## Limits

* The device words come from the browser: a hostile signed-in client can send any word of the lists. They are a
  bounded shape, not a proof.
* A keyed 12-hex hash still is not a secret identity: whoever holds the key and the user list can resolve it. That is
  what AH-3 does, for a platform admin, with a record of every look.
* A tab-load started by a click and not awaited reports its failure with the fixed action word `open-tab`.
