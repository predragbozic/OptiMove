# Exercise media on R2 — activation runbook

The order in which the pieces already merged are switched on, who does each step, what proves it, and
how each step is rolled back. Nothing in this document is performed by a Claude session: every
switch, credential and cloud setting is the owner's (or a named operator's), and **every phase change
is a separate, explicit owner approval**. Credentials never travel through chat, a terminal transcript,
a screenshot or a log.

Sources: `docs/backend/r2-be1-storage.md` (BE-1, the deployment / migration gate),
`docs/backend/r2-be2-upload.md` (BE-2: "Configuration / activation gate", the cleanup job),
`docs/backend/r2-upload-api-v1.md` (the contract), `docs/ai/exercise-media-r2-fe2-upload-contract.md`
(the two frontend guards; "Thumbnails (PR 3)").

## What is live today, and what each switch does

| Piece | State | Switch |
|---|---|---|
| BE-1 storage foundation (#184) | merged, deployed, migration applied | `MEDIA_STORAGE_ENABLED` (Render environment variable, default `false`): every media route answers 503 `media_storage_disabled` while off |
| FE-1 player and adapter (#185) | merged, deployed | none |
| FE-2 upload UI and transport (#186) | merged, deployed, both guards off | `UPLOAD_TRANSPORT_ENABLED` in `frontend/exercise-media-upload.js` — a code change, this runbook's companion PR (#192) |
| BE-2 upload lifecycle (#187) | merged, deployed, flag off | the same `MEDIA_STORAGE_ENABLED`; its migration `202610191300_media_upload_lifecycle.sql` ran at the deploy |
| BE-3 binding on save (#189) | merged, deployed | `MEDIA_SAVE_ENABLED` in `frontend/exercise-media-upload.js` — a second, separate flip PR (phase E) |
| Settings → Storage (#190) | merged, deployed | none: a platform administrator sees it; it reads 503 while the backend flag is off |
| Thumbnails (#191) | merged, deployed | both guards: a frame is offered only with `MEDIA_SAVE_ENABLED` on — inert through phases A–D |

**Status (2026-10-19):** phases A, B and C are done — see "Phase C — result" below. `MEDIA_STORAGE_ENABLED=true`
on `OptiMove-eu` (`optimove-eu.onrender.com`) only; the old service `optimove.onrender.com` stays off; the
cleanup cron `optimove-media-cleanup` runs hourly; the pilot account has a 1 GB override; both frontend
guards are still off in the deployed bundle (#192 not merged). Phase D waits for the owner's approval 3.

## The owner's decision (2026-10-19): gradual activation, pilot first

First the pilot with the transport on and the save off; only after the real R2 upload, the quota, the
verification, the cancellation and the cleanup are checked does the integration pilot with both guards
follow. During the transport pilot, by design:

- a file uploaded by the pilot account is charged to the quota but **not** saved with the exercise (the
  editor says "Saving it with the exercise is not available yet." and blocks Save until the file is
  removed);
- no thumbnail and no frame is offered (#191 needs the save guard);
- only the owner uploads, on a test exercise; nothing is announced to coaches before phase E.

## How the guards are switched — build time against runtime

- `UPLOAD_TRANSPORT_ENABLED` and `MEDIA_SAVE_ENABLED` are **module constants** in
  `frontend/exercise-media-upload.js` (`DEFAULT_UPLOAD_TRANSPORT_ENABLED`, `DEFAULT_MEDIA_SAVE_ENABLED`),
  compiled into the frontend bundle by `vite build`. A change is a **code change, a merge and a
  deploy** — never an environment variable, a runtime switch or a database value. The exported
  `setUploadTransportEnabled()` / `setMediaSaveEnabled()` exist for the tests and would act only inside
  one open page, never persisted. `frontend/tests/exercise-media-pilot-mode.test.mjs` pins the shipped
  defaults of #192 and that no runtime source feeds them.
- `MEDIA_STORAGE_ENABLED` is the opposite kind: a **runtime** environment variable of the backend on
  Render, read at start; `false` makes every media route answer 503 whatever the frontend says.
  Changing it is an environment change and a service restart, no build.

So the two levers differ in speed and blast radius: the backend flag stops or starts everything at once
within a restart; the frontend guard needs a build and a deploy and changes only what the editor offers.

## Environments: no staging — a controlled production pilot

The project has one deployed environment (the Render web service with the Supabase database), local
development, and the read-only `monitoring2` reference database. **There is no staging service.**
Phases B and C therefore run **in production with the frontend guards OFF**: the media routes exist and
answer, but no screen calls them except the platform administrator's Settings → Storage tab, and every
coach's editor stays exactly as today (`frontend/tests/exercise-media-pilot-mode.test.mjs`). Each phase
below starts only after the owner's explicit approval for that phase; a phase that does not end as
expected is rolled back (its own rollback line) before anything else is tried.

If a staging service is created later: run phases B–D there first with the same checklist, then repeat
B–D in production. The runbook does not change.

## The phases, in order

### Phase A — preparation (no runtime effect on the app)

| # | Step | Where | Expected result (record it) |
|---|---|---|---|
| A1 | #184, #185, #186, #187, #189, #190, #191 merged and deployed | GitHub, Render | `/api/health` serves the current merge commit three times with `ok: true` |
| A2 | The BE-2 migration applied at its deploy | Render deploy log | `202610191300_media_upload_lifecycle.sql` applied, the server started |
| A3 | R2 bucket `optimove-exercise-videos`, **private** (no public URL, no custom domain, no `r2.dev`), **no lifecycle rule on `pending/`** (BE-2 keeps zero-byte tombstones there on purpose) | Cloudflare | the bucket settings read once |
| A4 | An R2 API token with **Object Read & Write on this bucket only**; the account id noted | Cloudflare | the scope read once; the secret in the password manager only |
| A5 | CORS on the bucket for the exact app origins (section "CORS" below) | Cloudflare | the rule as saved |
| A6 | `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET=optimove-exercise-videos` on the web service; **`MEDIA_STORAGE_ENABLED` unset or `false`**; nothing as `VITE_*` | Render | the four present, the flag off; the service restarted and healthy |
| A7 | Node ≥ 20.9 on the service (`sharp`) | Render deploy log | the version line |
| A8 | The cleanup cron job: `npm --prefix backend run media:cleanup` every five minutes, the same variables (a no-op while the flag is off; bounded; safe to overlap) | Render | the job exists; its first run logs a no-op |
| A9 | A test exercise for the pilot: a private exercise of the owner's account, in no program | the app | its id noted |

CORS, phase A5 (S3-style rule on the bucket; the origins are the Render URL and the custom domain,
nothing wildcarded):

```json
[
  {
    "AllowedOrigins": ["https://<render-service>.onrender.com", "https://<custom domain, if any>"],
    "AllowedMethods": ["PUT"],
    "AllowedHeaders": ["Content-Type", "If-None-Match"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3600
  }
]
```

Phase E adds `GET` and `HEAD` to `AllowedMethods` and `Range` to `AllowedHeaders` (playback through the
player needs no CORS; a frame of a stored video read by the canvas does).

Rollback of phase A: nothing runs yet; unset the variables or leave them.

### Phase B — controlled backend enablement for the pilot test (owner approval 1)

Precondition: the deployed bundle still has both frontend guards off (#192 **not** merged).

| # | Step | Where | Expected result |
|---|---|---|---|
| B1 | `MEDIA_STORAGE_ENABLED=true` on the web service **and** the cron job | Render | the service restarted; `/api/health` three times |
| B2 | Signed out: `GET /api/media/storage` | curl / browser | 401 (the flag no longer hides the route; authentication still does) |
| B3 | A coach's editor on an existing exercise | the app | unchanged: the two link fields, no storage line, no upload offered (the guard) |
| B4 | Settings → Storage as a platform administrator | the app (#190) | the defaults card and the accounts load (no 503 any more); the default limit is **0 bytes** |
| B5 | The pilot account's limit above 0 through *Change limit…* with a reason (or the default limit, if every account should get one now) | the app (#190) | the limit and the reason in the History |
| B6 | The cleanup cron's next run | Render cron log | a bounded run with nothing to settle |

Rollback of phase B: `MEDIA_STORAGE_ENABLED=false` on the web service and the cron, a restart — every
media route back to 503, the Storage tab says the storage is switched off, nothing else changes.

### Phase C — the real browser PUT test, quota, verification, cancellation, cleanup (owner approval 2)

From the browser console **on the app origin**, signed in as the pilot account; the test exercise A9;
a small real MP4 (H.264). The frontend guards are still off: these calls prove the backend and R2, not
the editor. Record the status codes, the object key and the date — never a signed URL, never a token.

| # | Step | Expected result |
|---|---|---|
| C1 | `POST /api/media/uploads` with an `Idempotency-Key` (a UUID), body `{ context: { type: "exercise_edit", exerciseId }, kind: "video", purpose: "exercise_video", file: { name, mimeType: "video/mp4", sizeBytes } }` | **201**, `status: "pending"`, `upload.url`, `upload.headers` (`Content-Type`, `If-None-Match: *`), `reservation` |
| C2 | `fetch(upload.url, { method: "PUT", headers: upload.headers, body: file })` with the raw File | **200** — CORS and the signed `Content-Length` hold |
| C3 | The same PUT again | **412** — the create-only `If-None-Match: *` holds, nothing overwritten |
| C4 | `POST /api/media/uploads/:id/complete` | **200**, `status: "completed"`, `media.status: "ready"` (the HEAD, the inspection and the quota settlement work); a 202 means verifying — poll `GET /api/media/uploads/:id` until completed |
| C5 | Settings → Storage | the pilot account's used bytes = the file; the limit as set in B5 |
| C6 | A second session: C1, C2, then `DELETE /api/media/uploads/:id` | **200**, `status: "cancelled"` |
| C7 | A third session: C1, then `POST …/uploads` again with the **same** key and body | the same `uploadId` / `mediaId`, no second reservation (idempotency) |
| C8 | A file larger than the remaining limit: C1 | **429** `storage_quota_exceeded`, no PUT permission issued |
| C9 | The cleanup cron's next run | the cancelled session settled, its reservation released, the zero-byte tombstone under `pending/` in the bucket; the ready file untouched |
| C10 | Settings → Storage again | the used bytes = the one ready file only |

The ready file of C4 stays charged to the pilot account and bound to nothing until phase E (no delete
endpoint exists by design); that is expected. Any other outcome than the expected one is a **stop**:
rollback B (the flag off), fix, and start phase C again.

Rollback of phase C: the same as phase B. Objects already written stay in the bucket (a ready file or a
tombstone), the quota rows stay; nothing is deleted by a rollback.

### Phase C — result (2026-10-19, `OptiMove-eu`, commit `2798faa`)

Run from the browser console of `https://optimove-eu.onrender.com` signed in as the pilot account (user
`267c7e75…`, platform workspace, 1 GB override), context `exercise_create`, on the owner's approval of C1–C4
and then of C5–C7. The test file was made in the page: `optimove-r2-pilot-clip.mp4`, H.264 (`avc1.42E01E`,
Constrained Baseline), 640 × 360, 5.9 s, **no audio track**, 189 793 bytes. No signed URL, cookie or token
was recorded. Every step answered as expected; nothing was repeated.

| Step | Request | Answer |
|---|---|---|
| C1 | `POST /api/media/uploads` with an `Idempotency-Key` | **201**, `status: "pending"`, `upload.headers` = `Content-Type`, `If-None-Match`; reservation 189 793 B, expiry 10 min; quota before: 1 000 000 000 B free |
| C2 | the signed `PUT`, raw File | **200** in 0.9 s, `ETag "b6b154068773cd7d724ed3eb0423d63b"`; R2 exposed `etag`, `content-type`, `content-length` through CORS |
| C3 | the same `PUT` again | **412** |
| C4 | `POST …/complete {}` | **200** in 2.0 s, `status: "completed"`, `media.status: "ready"`, metadata h264 5.884 s 640 × 360, audio `null`, 189 793 B; no 202, no polling |
| C5 | `GET /api/media/storage` | used **189 793 B**, reserved **0**, active uploads 0, free 999 810 207 B |
| C6 | a second session: C1 (201, reserved 189 793, active 1) → PUT (200, the same ETag) → `DELETE …/:id` | **200** `status: "cancelled"` in 1.0 s; status read again `cancelled`; reserved back to **0**, used unchanged, active 0 |
| C7 | the owner's Render "Trigger run" of `optimove-media-cleanup` | `{"cleaned":0,"failed":0}`, "Cron job run finished successfully"; afterwards the C4 asset still `ready`, the C6 session still `cancelled`, quota unchanged (read at 14:37:33 and 14:39:31 UTC) |

Identifiers (not secrets): C4 upload `e4db8e48-3352-42ae-a1e3-c170d8bfaf28`, media
`12c935d7-2ab8-4add-9e95-2f071619c8c1`, object `pending/e4db8e48-3352-42ae-a1e3-c170d8bfaf28`; C6 upload
`a529c990-d552-430b-bdab-5a514badf639`, media `f6b17f5f-a781-46aa-a462-1f023ab20440`, tombstone
`pending/a529c990-d552-430b-bdab-5a514badf639` (0 B).

**What stays:** the C4 test video remains in R2 as a `ready` asset bound to no exercise and **occupies
189 793 B of the pilot account's 1 GB** (no delete endpoint by design); the C6 tombstone (0 B) stays; two
`media.uploads` rows, two `media.assets` rows and their `upload_events`. No exercise was changed.

**Limits of this test:**

- the MP4 had **no audio track** and was a fragmented MediaRecorder file; a standard phone or exported MP4
  with AAC audio was not sent, so the AAC-LC rule of the inspection is untested on production;
- the cleanup run was a **no-op**: C6 was cleaned inside its own `DELETE`, so the sweep of an expired or
  crashed session was not exercised (that is negative test N4);
- the tombstone was proven by the server's `200 cancelled` (the server writes it and reads it back with HEAD
  before answering), **not seen in the Cloudflare panel**;
- C2 was read from the console of one origin; the second app origin, if any, was not tested;
- the negative tests were run later the same day (N1, N2, N4, N5 — see "Negative tests — result" below;
  N3 is C6); the rollback was not run (not approved).

### Negative tests — result (2026-10-19, `OptiMove-eu`, the same pilot account)

Run from the same console, `exercise_create`, on the owner's approvals (N1, N2, N5 together; N4 alone).
Quota before each group: used 189 793 B, reserved 0, active sessions 0. Nothing unexpected; no PUT was
sent in any of them. N3 (cancel) is covered by C6.

| Test | Request (`POST /api/media/uploads`) | Answer | Quota after |
|---|---|---|---|
| N1a | `mimeType: "video/quicktime"` | **415** `unsupported_media` | unchanged, nothing reserved |
| N1b | `kind: "video"` with `mimeType: "image/png"` | **415** `unsupported_media` | unchanged |
| N2a | video, `sizeBytes: "300000000"` (over 200 MiB) | **413** `file_too_large` | unchanged |
| N2b | image, `sizeBytes: "20000000"` (over 10 MiB) | **413** `file_too_large` | unchanged |
| N2c | video, `sizeBytes: "2000000000"` (over the quota too) | **413** `file_too_large` | unchanged |
| N5a | a new key, 189 793 B | **201** pending, upload `c5e02071-904b-4a64-b5bc-f4b6b61caf94`, media `457e9b46…` | reserved 189 793, active 1 |
| N5b | the same key, the same body | **201**, the **same** `uploadId` and `mediaId` | still one reservation (189 793, active 1) |
| N5c | the same key, another `sizeBytes` | **409** `idempotency_conflict` | unchanged |
| N5d | the same key, another file name | **409** `idempotency_conflict` | unchanged |
| N5 close | `DELETE …/c5e02071…` (no PUT ever sent) | **200** `cancelled` (the server's tombstone) | reserved 0, active 0 |

**429 `storage_quota_exceeded` was not reachable** on this account: with 1 GB free and the per-file ceilings
of 200 MiB (video) and 10 MiB (image), `reserveUpload` refuses the size (413) before it compares the quota,
and no single file can exceed a quota larger than the ceiling. That path stays covered by the backend and
frontend test suites; in production it appears only on an account whose remaining space is below the
ceiling.

**N4 — the expired session, by the real deadlines of the code** (`ttlSeconds: 600`; renew until the expiry
and at most 20 minutes after creation):

| When (UTC) | Step | Answer |
|---|---|---|
| 14:46:37 | initiate, 189 793 B, **no PUT** | **201** pending, upload `ba6358b0-61f4-44cd-9451-ceaa21605355`, media `09cc1a2e…`, `expiresAt` 14:56:37; reserved 189 793, active 1 |
| 14:57:31 | `POST …/renew` after the expiry | **409** `upload_expired`, `retryable: false` |
| 14:57:31 | `GET …/:id` | still `pending`, `expiresAt` in the past; the reservation and the slot still held — by design, expiry alone releases nothing |
| 15:00 | the **automatic** hourly cron run (`0 * * * *`) | swept the session (the only path that yields the state below without a `complete` call) |
| after 15:00 | the owner's manual "Trigger run" | `{"cleaned":0,"failed":0}` — correct for a run that came second and found nothing left |
| 15:09:51 | `GET …/:id`; `GET /api/media/storage` | session **`failed`**, `errorCode: upload_expired`; **reserved 0, active 0**, used 189 793 unchanged; the C4 asset still `ready` |

The expired session's final state is `failed` + `upload_expired` (the sweep sets the error code, then
`releaseAfterCleanup` turns an error-coded session into `failed`, never `cancelled`), its reservation and
slot are released, and a zero-byte tombstone stands on `pending/ba6358b0-…`. **Still to confirm in the Render
log of the 15:00 UTC run: `{"cleaned":1,"failed":0}`** — the session's own state proves the sweep, the log
proves which run did it.

Objects in the bucket after phases C and the negatives: `pending/e4db8e48-…` (the ready C4 video,
189 793 B) and three zero-byte tombstones, `pending/a529c990-…` (C6), `pending/c5e02071-…` (N5),
`pending/ba6358b0-…` (N4). Nothing else was written.

**Before phase D (the owner's approval 3), the remaining checks:** one C1–C4 pass with a real MP4 **with
an AAC audio track** (any exercise video coaches use, under 50 MB); a look at the bucket for the four
objects above (the three tombstones at 0 B with the `optimove-tombstone` metadata); the Render log of the
15:00 UTC run. Phase D's own criteria are in its table: D1 health and 401, D2 a coach's editor unchanged
until a file is chosen, D3 the pilot upload through the editor, D4 / D5 the two cancels, D6 / D7 the
legacy exercise and the Builder unchanged, D8 the cleanup run.

### Phase D — frontend transport activation, the editor pilot (owner approval 3)

| # | Step | Expected result |
|---|---|---|
| D1 | Merge #192 (the transport guard `true`, nothing else), deploy | `/api/health` three times; signed out, a media route answers 401 |
| D2 | A coach's editor on an existing exercise (not the pilot account) | the storage line and *Upload video… / Upload picture… / Use a link* are now offered; nothing changes until a file is chosen; Save of a renamed legacy exercise sends the links as before (`exercise-media-pilot-mode.test.mjs`) |
| D3 | The pilot account, the test exercise: upload the small MP4 | progress → "Uploaded and verified. Saving it with the exercise is not available yet."; Save blocked with the sentence; Settings → Storage shows the bytes |
| D4 | **Cancel during the PUT**: upload again, press Cancel while the bar moves | the PUT aborted at once, "Cancelling…", `DELETE`, "Upload cancelled." with *Upload again* |
| D5 | **Cancel during verification**: upload again, press Cancel right after the bar reaches 100 % | "Cancelling…" **may last up to 4 s** — the verification poll sleeps 1, 2, 4 s and the cancel is honoured at the end of the current sleep (`exercise-media-pilot-mode.test.mjs` test 6; the FE-2 nit on #186) — then `DELETE` → "Upload cancelled."; if the verification completed meanwhile, the cancel came too late and the ready file comes back as "Uploaded and verified." — both are correct, nothing is lost or charged twice |
| D6 | Remove the uploaded file in the editor, Save the exercise | the save body as before; the exercise unchanged |
| D7 | A legacy exercise (a Drive or YouTube link) opened and saved with a name change; the Builder's cards and the player | the links unchanged after the save, the Builder as before |
| D8 | The cleanup cron's next run; Settings → Storage | the cancelled sessions settled; the used bytes = the ready files of C4 and D3 |

Nothing is announced to coaches after phase D: the uploads they could make would be charged and unsaved.
If the owner prefers that no coach sees *Upload* before phase E, phase D is merged together with phase
E's PR instead (the owner's call at that time).

Rollback of phase D, two levers:

- **immediate stop** — `MEDIA_STORAGE_ENABLED=false` (runtime, a restart): the editor reads the 503 as
  "storage switched off" and shows the link fields, with no error for the coach; uploads in flight end
  with their sentences;
- **the guard itself** — a PR that sets `DEFAULT_UPLOAD_TRANSPORT_ENABLED` back to `false`, a build and
  a deploy (minutes, a deploy): the editor returns to the link fields with the backend still on.

### Phase E — the integration pilot: `MEDIA_SAVE_ENABLED` (owner approval 4, later)

A separate PR flips `DEFAULT_MEDIA_SAVE_ENABLED` to `true` after: CORS `GET` / `HEAD` / `Range` added
(A5); the BE-3 routes checked signed out (401). Then, as the pilot account on the test exercise: an
upload saved with the exercise (`media.video = { source: "asset", mediaId }`), the FE-1 player plays it,
a frame chosen and an automatic thumbnail (#191), Replace and Remove of a stored file, the Builder's
cards. Only after that the announcement to coaches. Rollback: the same two levers as phase D (the save
guard back to `false` by a PR, or the backend flag off).

## Never, at any phase

Drop the media tables, delete objects, add a lifecycle rule on `pending/`, rewrite legacy URLs, put an
R2 secret in a `VITE_*` variable or a log, or flip both frontend guards in one step.

## What to watch after phases B–D

- The cleanup job's runs (Render cron log): expired / cancelled sessions settled, no repeated failures.
- Rate caps: 20 initiation / renew requests per minute and 200 per day per uploader (429
  `upload_rate_limit`).
- Quota: Settings → Storage, the accounts over their limit.
- Render memory during verification (`sharp` and the video inspection; BE-2 bounds the inspection to
  30 s).

## What the tests pin for the pilot

- `frontend/tests/exercise-media-pilot-mode.test.mjs`: the shipped defaults (transport on, save off)
  and no runtime source; a legacy exercise's save body byte-identical with the transport on and off,
  without a `media` key; the Builder's Edit uses the same editor and its custom-exercise modal keeps the
  link fields; a stored R2 file is Preview only with its legacy key omitted (BE-3 keeps it); an upload
  during the pilot is never saved; Cancel during verification honoured at the end of the current poll
  sleep (1, 2, 4 s) and the server told.
- `frontend/tests/exercise-media-upload.test.mjs` and `frontend/tests/exercise-editor-media.test.mjs`
  (FE-2): the transport, the codes, the faces, cancel during the PUT, the H1 rule.
