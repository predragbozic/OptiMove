# App health: the device, and who hit an error (plan note)

**Status: accepted as the plan** (the *Rukovodilac*, 2026-11-13), with the decisions of section 10. No code, migration
or route exists yet for anything below; the slices are built in the order AH-1, AH-2, AH-3, each with its own reviews.

| | |
|---|---|
| Owner's order | 2026-11-13: App health must help debugging. Show the device and, for a platform admin, who hit an error. |
| Last verified against commit | `b0cae3af` (`origin/main`) |
| Files read | `migrations_v2/202611091000_app_error_events.sql` (v58), `backend/src/appErrorTracking.js`, `backend/src/routes/appErrors.js`, `frontend/app-errors-capture.js`, `frontend/app-health-{data,view,actions}.js`, `docs/runbooks/app-error-events-v58.md` |
| Related | PR #528 (the `reason` word, `handler_error`); `.claude/rules/frontend.md`, "Interaction principles" |
| Review triggers | 1 (migration) and 2 (audience, identity). Reviews: db, security, code, ux; both ★★ GOs; the owner's order naming the migration |

## 1. What exists today

- **One table**, `public.app_error_events` (v58). One row is one (user, kind of error) pair inside one hour; a repeat
  raises `repeat_count` and `last_seen_at`. Every text column is a closed shape with a CHECK. Rows are deleted 30 days
  after their last sighting.
- **What a row says:** where (`screen` or `route_template`), the last control used (`action`), a code, a status, a
  stack signature, the release, a coarse `role` (`platform_admin`, `coach`, `athlete`, `user`, `none`) and
  `user_hash`.
- **Nothing about the device.** No User-Agent, no screen size, nothing.
- **`user_hash`** is the first 12 hex characters of `sha256("app-error-user:" + user id)`
  (`appErrorTracking.js`, `userHash`). It is **not keyed**. It exists so the screen can count distinct people.
  - It is a pseudonym, not anonymity: anyone who can read both `app_error_events` and `public.users` can recompute it
    for every user and match. No secret is involved.
  - 48 bits: a chance collision between two users is negligible at this size, and must still be handled (section 4).
- **Who reads it:** `GET /api/app-errors/groups` for an active platform admin only; everyone else gets the same 404 as
  an unknown route. The screen (Settings, App health) is offered to a platform admin only.
- **Server errors** (`source = 'server'`) carry the same `user_hash` and `role`, taken from the signed-in request.

## 2. Device facts on every browser report

### 2.1 What is recorded

Six facts, each a word of a closed list, derived in the browser and reduced there. **The User-Agent string is never
sent and never stored.**

| Column | Values | From |
|---|---|---|
| `device_class` | `phone`, `tablet`, `desktop`, `unknown` | `navigator.userAgentData.mobile` where it exists; else the User-Agent's own words (iPhone, iPad, Android + Mobile) and, for an iPad that says it is a Mac, touch points |
| `os_family` | `ios`, `android`, `windows`, `macos`, `linux`, `chromeos`, `other` | `userAgentData.platform`, else the User-Agent |
| `browser_family` | `safari`, `chrome`, `firefox`, `edge`, `samsung`, `webview`, `other` | `userAgentData.brands`, else the User-Agent. `webview` is an app's built-in browser (a link opened inside a chat app): it is the one fact that would have separated the candidates of the production case |
| `browser_major` | 1 to 999, or null | the family's major version only |
| `viewport_bucket` | `lt_360`, `360_479`, `480_767`, `768_1023`, `1024_1439`, `ge_1440` | `window.innerWidth` at the moment of the error |
| `touch` | true, false, or null | `navigator.maxTouchPoints > 0` |

- **Connection type: left out for now.** `navigator.connection.effectiveType` exists only in Chromium, so the column
  would be empty for every iPhone. It can be added later as one more nullable column if a case needs it.
- **What these facts are not:** not a fingerprint of a device. Each is a coarse bucket shared by very many people;
  together they still narrow a small club's athletes, which is why the screen shows them per kind of error and, by
  person, only through section 4.

### 2.2 Storage (migration, ★★)

- Six **nullable** columns on `public.app_error_events`, each with a CHECK of its closed list, as v58's columns have.
  An older page (a bundle cached before the deploy) sends none and its rows keep nulls.
- v58's update guard lets only `repeat_count` and `last_seen_at` change. The new columns are final from the insert, so
  the guard's function is replaced: an md5 gate on its body, a rollback that restores it, a rehearsal on a disposable
  database.
- `ADD COLUMN` of nullable columns without a default takes `ACCESS EXCLUSIVE` briefly and rewrites nothing. The CHECKs
  are added `NOT VALID` and validated in the same migration (the table is small: 30 days of rows).
- The number is the next free one at the time it is built. Today the last migration on `main` is v67, with v66 waiting
  for its deploy; this one comes after both.

### 2.3 The fingerprint and the one-hour row

- **The fingerprint stays as it is** (the *Rukovodilac*'s default, which I recommend): the same error on two devices
  is one kind of error, and the screen breaks it down by device.
- **The one-hour row gets the device added to its match.** Today a repeat is "the same user and the same fingerprint
  within an hour". With devices, the same person hitting the same error on a phone and on a laptop within an hour
  would be counted on whichever row came first, and the second device would never be seen. Proposed: a repeat is
  the same user, fingerprint **and device facts**. The per-user cap of 100 new rows an hour is unchanged.

### 2.4 The server's own errors

- A 5xx recorded by the server has no browser report behind it. The server could reduce the request's `User-Agent`
  header to the same words with the same reducer and store them the same way; the header itself would not be stored
  or logged.
- **Recommendation:** not in the first step. A server error is about the server; the device rarely matters. It is an
  open point (O4).

## 3. The screen

Per kind of error, under the existing sentence and counts:

- **A device line**, at most three, most frequent first: "iPhone · Safari 17 · 3 times", "Android phone · Chrome 142 ·
  1 time". When every row of the kind predates the change: "Device not recorded". A count, never a colour alone.
- **For a platform admin, one button: "Show person"** (section 4). No explanation before it; what it does is said
  in one sentence under the answer.
- **Unchanged:** the details (function names, the short fingerprint, the release) stay folded under Technical details.
- **A coach and a club admin see nothing new.** They have no App health screen today and get none. Nothing of this
  reaches any other screen.

## 4. "Show person", for a platform admin only

### 4.1 What it answers

For one kind of error: the people behind its rows, each as a **display name and a role**, with how many times and
when last, and the device line of their rows. Nothing else of the person: no e-mail, no id, no club, no team, no date
of birth.

### 4.2 How the server finds the person

- No name is stored with an error, now or after this change.
- On the request, the server reads the distinct `user_hash` values of that kind's rows (at most 20), then makes
  **one bounded read** of `public.users`, computing the same hash for each user in SQL
  (`left(encode(sha256(convert_to('app-error-user:' || id::text, 'UTF8')), 'hex'), 12) = any($1)`), under a short
  statement timeout. The table is small; the read is a scan.
- **A hash that matches two users** is answered as "cannot be told apart" for that row, never as either name.
- **A hash that matches nobody** (the user was deleted): "no longer a user".
- More than 20 people behind one kind: the 20 most recent, and the count of the rest.

### 4.3 The route

- `POST /api/app-errors/groups/:fingerprint/people`, with a request key. POST because every call writes an audit row.
- An active platform admin only. Everyone else, and an unknown fingerprint, get the same 404 as an unknown route.
- `Cache-Control: no-store`. The answer is never logged.
- A limit per admin (for example 30 lookups an hour), so the route cannot be used to walk the whole table.

### 4.4 The audit

- Every use is recorded: **who looked, when, which kind of error** (its fingerprint), how many people the answer
  named, and the request key. Never the names it returned, and never the hashes.
- **Where:** there is no app-wide audit table to reuse. The existing ones belong to their own domains (source
  connections, metric mappings, media storage), each with its own columns. Proposed: one small append-only table in
  the same migration, `public.app_error_person_lookups`, with a guard that refuses UPDATE and DELETE except by the
  retention purge.
- **How long:** longer than the errors themselves, because the question "who looked at whom" outlives the rows.
  Proposed: one year (O3).
- **Who reads the audit:** nobody through the app in the first step; it is read by SQL on the owner's order. A list
  on the screen can follow.

### 4.5 The privacy trade-off, plainly

- **Today** an error row is pseudonymous. Turning it into a name needs database access and a deliberate query.
- **After this change** a platform admin can turn a kind of error into names with one button. That is the purpose:
  ask the person what they did, or look at their device. It also means App health stops being a screen about the app
  only and becomes, on request, a screen about people, some of them minors.
- **What limits it:** platform admins only; display name and role only; one kind of error at a time; a limit per
  hour; every use recorded; nothing stored that was not stored before; the 30 days unchanged, so a name can be shown
  only for an error of the last 30 days.
- **What it does not fix:** the hash is still unkeyed, so database access alone still re-identifies everyone. See O2.

## 5. Whether the hash should become keyed

- A keyed hash (an HMAC with a secret in the server's environment) would mean a copy of the database alone no longer
  re-identifies anyone; the resolution of section 4 would still work, because the server holds the key.
- The cost: the existing rows cannot be recomputed (the user id is not stored), so for up to 30 days old and new rows
  of the same person would not match; the secret becomes one more thing to keep and rotate; a rotation breaks the
  one-hour match the same way.
- **Recommendation:** decide it with this change, not after it (O2). If the owner wants it, it goes into the same
  migration window with a `user_hash_version` column, so old and new rows are told apart instead of silently
  mismatching.

## 6. Proposed slices

| Slice | What | Migration | Reviews |
|---|---|---|---|
| AH-1 | The six columns, the guard's new body, the audit table; the browser derives and sends the six words; the server accepts and stores them; the one-hour match takes the device | Yes, ★★ | db, security, code; both GOs; the owner's order |
| AH-2 | The groups read returns the device breakdown; the screen's device line | No | code, ux, mobile |
| AH-3 | The people route with its audit and limit; the "Show person" button | No | security, code, ux; ★★ (audience, identity) |

AH-2 and AH-3 are independent of each other after AH-1. AH-1 is useful alone: the facts start to collect.

## 7. Tests the slices owe

- **The reducer:** a table of real User-Agent strings and `userAgentData` shapes (iPhone Safari, iPad that says Mac,
  Android Chrome, Samsung Internet, an in-app browser, desktop Firefox, an empty string, a hostile string) each to
  its six words; nothing outside the lists ever comes out; the raw string appears in no report.
- **The table:** each CHECK refuses a word outside its list; only the count and the last-seen time may change; the
  rollback restores v58's guard by md5 and the migration applies again.
- **Ingest:** a report without device facts is stored as before; one with a word outside a list is 400 and stores
  nothing; the same user and error from two devices within an hour makes two rows; the cap of 100 an hour holds.
- **People:** a platform admin gets names and roles only; a coach, a club admin, an athlete and a signed-out caller
  get the identical 404, with and without a real fingerprint; a planted hash collision answers "cannot be told
  apart"; a deleted user answers "no longer a user"; every call writes exactly one audit row and a refused call
  writes none; the limit per hour refuses the next call; no answer or log line carries an e-mail, an id or a hash.
- **Mutations** on the audience check, the collision rule, the audit write and each list.

## 8. What I did not check

- How many rows production holds and how many distinct people: the *Rukovodilac* can count them read-only if a slice
  needs it.
- Whether the deployed database's `pgcrypto` or built-in `sha256()` is the one section 4.2 assumes: `sha256(bytea)`
  is built in from PostgreSQL 11; the preflight would assert it.
- The legal side of naming a minor on a debugging screen. That is the owner's to decide (O1).

## 9. Open points for the owner (as asked; decided in section 10)

| | Question | My recommendation |
|---|---|---|
| O1 | May a platform admin see the name of a person, minors included, behind an error, with every use recorded? | Yes, with section 4's limits. It is the order's own purpose; the alternative is asking by phone who had a problem |
| O2 | Should the hash become keyed in the same step? | Yes, if any copy of the database ever leaves the provider (backups, exports). Otherwise keep it and record the fact |
| O3 | How long is "who looked" kept? | One year |
| O4 | Device facts for the server's own errors too, from the request's User-Agent? | Not in the first step |
| O5 | The device in the one-hour match (two devices, two rows)? | Yes |
| O6 | Connection type as a seventh fact? | No; Chromium only |

## 10. Decisions (2026-11-13, relayed by the *Rukovodilac*)

| | Decision |
|---|---|
| O1 | **Yes.** The owner said yes to "Show person" for a platform admin. Every limit of section 4 is mandatory: platform admins only, display name and role only, one kind of error at a time, a limit per hour, every use recorded. **Standing precondition, the owner's to state, like C123:** the legal side of showing a minor's name on a debugging screen. AH-3 is not used in production before the owner states it |
| O2 | **Yes: a keyed hash with a version column, in AH-1** (section 10.1) |
| O3 | The audit of "who looked" is kept **one year** |
| O4 | Device facts for the server's own errors: **not now** |
| O5 | **Yes:** the device enters the one-hour match, so two devices are two rows |
| O6 | Connection type: **no** |
| Slices | AH-1, then AH-2, then AH-3; AH-1 first |
| Migration | **v70**, with a prefix after `202611131310` (v66 is J18's, v67 is on production, v68 and v69 are MT-D's, in review). Re-checked when the pull request is opened |
| Follow-up inside AH-1 | The tab loads handed to `detached()` (PR #528) carry the fixed action word `open-tab` |

### 10.1 The keyed hash (O2), as it will be built

- **Two versions, told apart by a column.** `user_hash_version` (smallint, not null, default 1) on
  `public.app_error_events`:
  - **1** is today's: the first 12 hex of `sha256("app-error-user:" + user id)`, no key. Every existing row is version 1.
  - **2** is keyed: the first 12 hex of `HMAC-SHA256(key, "app-error-user:" + user id)`.
- **The key** comes from a server secret, an environment variable holding a small key ring in the shape the source
  credentials already use (`<version>:<base64 key>`, one or more, the highest version is the one new rows get; at
  least 32 random bytes each). It is read when a hash is computed, never logged, never sent to the database: the hash
  is computed in the server, not in SQL, so the key cannot reach a statement log.
- **How old rows resolve.** A version 1 row is resolved as section 4.2 says, by the unkeyed expression, until it ages
  out: after 30 days no version 1 row is left and that path can be removed. A version 2 row is resolved by the server
  computing the keyed hash for each user of one bounded read of `public.users` and matching in memory.
- **The same person across the change** is two people in the counts for at most one hour of rows and up to 30 days
  of history: a version 1 row and a version 2 row of one user never match each other. Accepted; the screen says
  "people" as a count of hashes, as it does today.
- **When the key is missing or unreadable** (my recommendation, for the *Rukovodilac* to confirm in AH-1's review):
  - **Show person fails closed:** it answers that the person cannot be shown and names nobody, for version 2 rows.
    Version 1 rows still resolve while they exist.
  - **Ingest still records the error, without a hash** (`user_hash` null, version 2). It never falls back to the
    unkeyed scheme: a silent return to the weaker hash is exactly what the key is there to prevent. The error itself
    stays visible; only the count of distinct people is lost for those rows, and the existing cap for rows without a
    user applies to them.
  - The server says so once at start-up, by a fixed line without the variable's value, and App health shows one
    sentence for the platform admin ("People cannot be counted or shown: the hashing key is not set").
- **A rotation** adds a key with the next version to the ring and keeps the old one for 30 days, so rows of both
  versions resolve; removing the old key after that loses nothing.
- **The rollback** of v70 refuses once a version 2 row exists (it cannot be turned back into version 1: the user id
  is not stored), which makes the migration forward-only from the first keyed row; the runbook says so.

