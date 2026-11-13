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
column additions are catalog-only; the eight CHECKs are added directly and validated in the same `ALTER TABLE` (not
`NOT VALID` followed by a separate `VALIDATE`), under that lock, over at most 30 days of rows - preflight block 3 shows
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
  without a user (200 an hour in all). All writers of one kind of error then also share one lock, so in a burst some
  reports are dropped after 2 s. The line in the log is written at the server's start. So that one person cannot use
  up that shared cap, each user's reports are then counted in memory (by the id, never stored) and dropped silently
  beyond 40 an hour (`NO_KEY_REPORTS_PER_USER_WINDOW`; per server process). "Show person" (AH-3) fails closed without the ring.
* **Old rows** keep version 1 and their unkeyed hash until they age out (30 days). For that time one person may be
  counted twice in a group (once per version). AH-3 resolves a version 1 row by the old formula and a keyed row by
  its own version's key.
* **Rotation:** add the new key with the next version and keep the old one in the ring for 30 days, then remove it.
  A version whose key has left the ring can no longer be resolved to a person; its rows are still counted.
* **One hour of repeats** is counted on a row only when the fingerprint, the hash, its version and the six device
  facts are all the same, so one kind of error on two devices is two rows of the same group.

## The devices on the screen (AH-2, no migration)

`GET /api/app-errors/groups` gives each kind of error, for the same period as its counts:

* `devices`: at most three `{ class, os, browser, major, occurrences }`, most frequent first, of the browser reports
  only. The viewport and the touch flag do not split a device here (they stay in the table for a later question);
* `otherDevices`: how many further combinations there are;
* `deviceNotRecorded`: how many occurrences of browser reports carry no device (rows from before v70, an older page).

A server error has an empty list and zeros. Nothing else is added to the answer: no hash, no id, no viewport.
App health shows one line in the row of a browser error: "On iPhone · Safari 17 · 3 times; Windows · Chrome 131 ·
1 time; 2 other devices; not recorded · 1 time", or "Device not recorded" when no report of the kind carried one.
A word outside the lists is shown as "Unknown device", never as it is. Only a platform admin has the screen and the read.

## Deploy

1. **The owner sets the secret on Render, before the deploy, himself** (Render dashboard, the service's Environment;
   never through a chat, a terminal someone else reads, a screenshot or the repository):
   * name: `APP_ERROR_USER_HASH_KEYS`;
   * value: `2:` followed by the base64 of 32 random bytes, for example the one line printed by
     `node -e "console.log('2:' + require('crypto').randomBytes(32).toString('base64'))"`
     (or `openssl rand -base64 32` with `2:` typed in front);
   * the value is kept by the owner like any other secret of the service; whoever has it and the user list can
     tell which user a hash is. Losing it loses only the link from stored hashes to people; a new key is then a
     rotation (version 3).

   If it is not set at the deploy, or is not readable (a version below 2, a key shorter than 32 bytes, a stray
   character - the whole ring is then refused): the app starts and records errors as before, each new row
   **without a user hash** and never with the old unkeyed one; people are not counted for those rows; App health
   says so in one line; "Show person" (AH-3) is refused. Setting the variable later and restarting is enough;
   rows written meanwhile stay without a hash.
2. The owner's order naming the v70 file.
3. The Rukovodilac runs `app-error-events-v70-preflight.sql` read-only, block by block. The file-name prefix is
   re-checked against `main` at that time (the runner refuses a shared prefix; it applies by file name and does not
   refuse a file older than the last one applied).
4. Deploy; the migrator applies v70 before the server starts.
5. The Rukovodilac runs `app-error-events-v70-postcheck.sql` read-only. Block 4 with `signed_in_without_hash > 0` on
   version 2 **is a failure to act on, not a note**: the key is missing or unreadable, every such row stays without a
   hash for good, and the owner sets or corrects `APP_ERROR_USER_HASH_KEYS` and restarts the service.

## Rollback

`app-error-events-v70-rollback.sql`: one transaction; refuses while the migrator runs, when v70 is not recorded, when a
migration with a later file name is recorded (one with an earlier name applied after v70, such as v66, v68 or v69, does not
block it), **once a keyed hash is stored** (without the version column it would read as unkeyed -
from then on v70 is forward-only) and once a lookup is recorded. Otherwise it drops the seven columns, restores v58's
guard body (md5 `1737e2dd01bcdb74f02a006a65cb5389`), drops the lookups table and its functions and removes the record.
It locks both tables before its checks. The deployed commit must first no longer contain the migration file or write the new columns. Rehearsed in
`app-error-events-v70.test.mjs`.

## Limits

* For the 30 days in which a person's version 1 and version 2 rows coexist, whoever holds a copy of the table can
  often match the two by kind of error, role and release, and the version 1 hash can be recomputed from the user list.
  The keyed hash stays the same until a rotation, so that match outlives the 30 days. If a copy of the database is the
  concern, rotate to version 3 once the version 1 rows have aged out (the owner's decision).
* The device is reduced from the User-Agent string, the touch-point count and the window's width only;
  `navigator.userAgentData` is not read (a deviation from plan 2.1). A Chromium browser that calls itself Chrome is
  stored as `chrome`; `touch` is left out when the browser gives no touch-point count.
* For AH-3: a lookup's `outcome` is `answered` or `key_missing` only; recording a refused or rate-limited look needs
  a new migration. `looked_at` defaults to the clock and must be within a minute of it.
* `backend/tests/_gpexe-disposable-db.mjs`'s shared list does not carry v70 (suites that need error rows append it
  themselves); a suite on the plain list that provokes a 5xx logs "not recorded". Follow-up: add it to the list once
  v66 is merged.

* The device words come from the browser: a hostile signed-in client can send any word of the lists. They are a
  bounded shape, not a proof.
* A keyed 12-hex hash still is not a secret identity: whoever holds the key and the user list can resolve it. That is
  what AH-3 does, for a platform admin, with a record of every look.
* A tab-load started by a click and not awaited reports its failure with the fixed action word `open-tab`.
