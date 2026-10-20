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

**Status (2026-10-19, evening):** phases A, B and C are done — see "Phase C — result" below.
`MEDIA_STORAGE_ENABLED=true` on `OptiMove-eu` (`optimove-eu.onrender.com`) only; the old service
`optimove.onrender.com` stays off; the cleanup cron `optimove-media-cleanup` runs hourly (not to be
changed for the pilot); two user accounts hold a 1 GB override, everyone else the default 0 B. **E-1 is
merged and deployed** (#193: the storage quota gates the upload controls — an account at 0 B keeps the
editor of today whatever the guards say). The deployed bundle still has both frontend guards off. **This
PR (#192) is E-2:** both guards on together, so the complete flow opens for the quota accounts only —
see "E-2 — the pilot activation" below. The transport-only phase D was not taken (owner, 2026-10-19).

## The owner's decisions (2026-10-19): gradual activation, then both guards together for the quota accounts

In the morning: the backend first, the frontend later — phases A, B and C ran with
`MEDIA_STORAGE_ENABLED` on and both frontend guards off, proving R2 from the browser console (phase C). In
the evening, after phase C: a transport-only flip (the former "phase D") would have shown Upload buttons
to every coach while most accounts hold 0 B and nothing could be saved, so **#192 waited for phase E**;
E-1 (#193, merged) made the storage quota the gate of the upload controls; and **E-2 — this PR — flips both
guards together**. During the pilot, by design:

- only accounts with a storage limit above zero (the pilot) can upload, and their uploads are saved with
  the exercise on Save, played through the FE-1 player, replaced, removed and used for thumbnails;
- every account at the default 0 B keeps the editor of today, byte for byte;
- nothing is announced to coaches before the wider activation (the default limit raised by the
  administrator).

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

Checked from the app origin on 2026-10-19 (see E-2): `GET` and the `Range` header are already allowed
(GET 200, Range 206 — a frame of a stored video read by the canvas works; playback through the player
needs no CORS at all); `HEAD` is not allowed and `Content-Range` / `Accept-Ranges` are not exposed — an
optional addition, the frontend sends no HEAD and reads neither header.

Rollback of phase A: nothing runs yet; unset the variables or leave them.

### Phase B — controlled backend enablement for the pilot test (owner approval 1)

Precondition (as it was on 2026-10-19, when phase B ran): the deployed bundle had both frontend guards
off (#192 not yet merged).

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

- the MP4 had **no audio track** and was a fragmented MediaRecorder file; the AAC-LC rule of the inspection
  was proven later the same day with a second clip (see "The H.264 + AAC-LC test — result" below); a
  standard phone or exported MP4 was still not sent;
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

### The H.264 + AAC-LC test — result (2026-10-19, 15:17 UTC, `OptiMove-eu`, the same pilot account)

The missing codec case of phase C: a video **with an audio track**. The file was made in the page
(`MediaRecorder`, `video/mp4;codecs="avc1.42E01E,mp4a.40.2"`, a canvas scene plus a 440 Hz tone) and
**verified before sending** by parsing its MP4 boxes in the browser and loading it into a `<video>`:
`optimove-r2-pilot-av.mp4`, **255 417 B**, 6.93 s, exactly two tracks (`vide`, `soun`); video `avc1` H.264
**Baseline** (profile 66, constrained, level 3.1), 640 × 360; audio `mp4a` **AAC-LC** (`esds` object type
indication 0x40, audio object type 2), 48 kHz, stereo; a fragmented container (`ftyp moov mvex moof mdat`).
Quota before: used 189 793 B, reserved 0, active 0.

| Step | Request | Answer |
|---|---|---|
| C1 | `POST /api/media/uploads`, `exercise_create`, 255 417 B | **201** pending in 0.9 s, upload `b3fecad3-1adc-4083-9303-514dc24ad0ba`, media `f2b66030-bddc-4737-a53c-c2e515d1dcc2`, reservation 255 417 B, expiry 15:27:19 |
| C2 | the signed `PUT`, raw File | **200** in 0.5 s, `ETag "efdfefa53352c309cd2a26e0644a6f19"` |
| C3 | the same `PUT` again | **412** |
| C4 | `POST …/complete {}` | **200** in 1.9 s, `status: "completed"`, `media.status: "ready"`, metadata **`videoCodec: "h264"`, `audioCodec: "aac"`**, 6.859 s, 640 × 360, 255 417 B; no 202 |

After C4: used **445 210 B** (189 793 + 255 417), reserved **0**, active sessions **0**, free 999 554 790 B.
No exercise was touched: the context carried no exercise id, no exercise route was called, and a
read-only look at the library (the first 50 rows and the user's own 50) showed no exercise with an
`asset` source. The ready object `pending/b3fecad3-1adc-4083-9303-514dc24ad0ba` (255 417 B) stays in the
bucket, bound to nothing, like the C4 video.

With this the inspection is proven on production for both accepted shapes of an MP4 — video only and
video with AAC-LC audio — and the AAC-LC rule is no longer an untested limit of phase C.

**Confirmed by the owner (2026-10-19), from the Cloudflare and Render panels, read-only:**

- **Cloudflare R2:** both ready videos are in the bucket (189 793 B and 255 417 B —
  `pending/e4db8e48-3352-42ae-a1e3-c170d8bfaf28` and `pending/b3fecad3-1adc-4083-9303-514dc24ad0ba`) and the
  three tombstones `pending/a529c990-…`, `pending/c5e02071-…`, `pending/ba6358b0-…` are there at 0 B.
  Nothing was deleted or changed.
- **The Render log of the automatic cleanup run of 15:00 UTC:** `{"cleaned":1,"failed":0}` — the expired N4
  session was swept by the scheduled run, as the session's state already showed.

**Phase C is closed.** Everything the pilot was meant to prove on production holds: the R2 variables, CORS
for the `OptiMove-eu` origin, the signed `Content-Length`, the create-only PUT, HEAD and inspection for
video without and with AAC-LC audio, quota reservation and settlement, cancel through the server with a
verified tombstone, idempotency, the refusals by type and size, expiry, and the scheduled sweep. The one
path not reached, 429 `storage_quota_exceeded`, is below the per-file ceiling on this account and stays
covered by the test suites. Phase D's criteria are in its table: D1 health and 401, D2 a coach's editor
unchanged until a file is chosen, D3 the pilot upload through the editor, D4 / D5 the two cancels, D6 / D7
the legacy exercise and the Builder unchanged, D8 the cleanup run — and the readiness section below.

### E-2 — the pilot activation: both guards on, the quota as the gate (prepared 2026-10-19)

**The exact change of #192 against `main` (`7b55344`, after #193):** `DEFAULT_UPLOAD_TRANSPORT_ENABLED` and
`DEFAULT_MEDIA_SAVE_ENABLED` both from `false` to `true` in `frontend/exercise-media-upload.js`, this
runbook, and `frontend/tests/exercise-media-pilot-mode.test.mjs`. Build time only: a frontend build and the
usual start; no backend change, no migration, no environment change, no quota change. The old service is
not touched (its backend flag is off, so its editor shows the link fields whatever the bundle says).

**Who sees what after the merge (the quota gate of #193, pinned by its suite and the pilot-mode suite):**

| Account | Existing exercise | New exercise / copy | Stored R2 file |
|---|---|---|---|
| default **0 B** (every coach today) | the editor of today, byte for byte: the two link fields, no storage line, no Upload, no frame picker; one `GET /api/media/storage` read that shows nothing | the two link fields | Preview; Remove (an explicit `{ source: "none" }` on Save) |
| **pilot** (a limit above 0) | the storage line, *Upload video… / Upload picture… / Use a link*, Replace with a file, the frame picker | the same, charged to the coach's own row | Preview, Replace, Remove |
| pilot, **full** | Preview and Remove; no Upload / Replace; the line says "Storage is full" | the link fields | Preview, Remove |
| a club exercise | the **club's** account decides (the server's selection), never the coach's own row | — | — |
| a storage answer that failed / is loading / 503 / 403 | nothing new, for anyone | nothing new | Preview |

So no coach at 0 B sees anything new; the pilot accounts get the complete flow: upload → R2 → complete →
Save binds the asset (`media.video = { source: "asset", mediaId }`, BE-3) → the exercise reopens with the
stored file → Preview plays it through the FE-1 player (`POST /api/media/access`, a signed GET of 600 s) →
Replace / Remove → the automatic thumbnail and the frame picker (#191). The library card, the Builder's
cards and the Builder's added-item snapshots carry the asset; the Builder's custom-exercise modal keeps its
link fields (Q7).

**The frame picker on iPhone (found in the pilot, 2026-10-20).** iOS Safari loads no media data for a video
that has never played (`preload` is ignored, a `#t=` fragment on a blob: address is not honoured), so the
picker's video stayed dark while the slider moved; Android Chrome draws the moment at once. The picker now
asks its own video for the moment and, when no picture comes within 0.7 s, starts it muted and pauses it at
once (allowed without a tap on iOS), which makes it load; a browser that refuses even that (iOS in Low Power
Mode) shows "If the video stays dark, tap play on it once, then move to the moment." *Use this frame* takes
the frame from the picker's own video when it shows the moment (the frame the coach sees), otherwise from a
video of its own, woken the same way. Checked in Chrome (unchanged: no start, no sentence) and with the iOS
behaviour simulated in Chrome; **not yet checked on a physical iPhone.**

**CORS, checked from the app origin on 2026-10-19** (a signed GET of the C4 video, from the signed-in
pilot account's page; nothing written): `GET` 200 and `GET` with `Range: bytes=0-1` **206** — CORS allows
GET and the Range header, so the frame picker's `crossorigin="anonymous"` read of a stored video works;
a `<video>` element loads the signed address, reports the duration and **seeks** (readyState 4) — playback
and seeking need no CORS at all; the exposed response headers are `content-length`, `content-type`,
`etag` (and the safelisted `cache-control`, `last-modified`). **Not allowed: `HEAD`** ("Failed to fetch");
**not exposed: `Content-Range`, `Accept-Ranges`.** The frontend sends no HEAD and reads neither header, so
the pilot is not blocked. Recommended, optional, on the bucket's CORS rule: add `HEAD` to `AllowedMethods`
and `Content-Range`, `Accept-Ranges` to `ExposeHeaders` (BE-3's stated set), so a future client that
inspects a response does not meet a CORS error. The signed PUT (`PUT`, `Content-Type`, `If-None-Match`)
was proven in phase C.

**The pilot procedure (after approval 3 and the deploy; the pilot account, the test exercise; record each
outcome in this runbook):**

| # | Step | Expected |
|---|---|---|
| E1 | `/api/health` three times with the merge commit; signed out a media route 401; **a 0 B coach's editor unchanged** (open an existing legacy exercise as a coach without a limit: the link fields, no line, no Upload) | as stated |
| E2 | Pilot: open the test exercise → *Upload video…* → the H.264 + AAC-LC MP4 → "Uploaded and verified. It is saved with the exercise when you press Save." → **Save** | the exercise closes; `GET /api/exercises/:id` carries `media.video.source: "asset"`; Settings → Storage shows the bytes. If Save shows an error, see the STOP rule below before saving again |
| E3 | Reopen the exercise → **Preview** (the FE-1 player) → play and seek | the signed address plays; seeking works; the player's address refresh after 10 min (optional wait) |
| E4 | The library card of the exercise; **Builder**: add the exercise to a section → the card's Preview → open the program as the **athlete** of that plan (the athlete page) and play from the session view | the thumbnail / player through the `plan_item` context (BE-3 decorates athlete rows; the athlete page loads the same `app.js` and FE-1 renderer) — **this is the first real athlete-side playback**: if it does not play, record it as a blocker for the wider activation, not for the pilot |
| E5 | Pilot: *Choose a frame of the video…* → a moment → *Use this frame* → Save; reopen | the picture is the frame; the card shows it |
| E6 | Pilot: **Replace…** the video with a second file → Save → reopen; then **Remove** → Save → reopen | the new asset bound; then `{ source: "none" }`, the link fields back; the old objects stay charged (no delete endpoint; the GC is separate work) |
| E7 | Cancel during the PUT; Cancel during verification (the wait of up to 4 s) | "Upload cancelled." both times |
| E8 | A rename of a legacy exercise by the pilot; the Builder custom-exercise modal | the links unchanged; the modal's link fields only |
| E9 | The hourly cron's next run; Settings → Storage | `{"cleaned":N,"failed":0}` where N = the cancelled sessions; the used bytes = the bound assets plus the earlier pilot files |

**STOP rule for the pilot.** Any outcome other than the expected one at E1, E2, E3, E5, E6, E7, E8 or E9 is
a **stop**: no further step is taken; lever (1) below for the pilot account (its limit back to 0) at once;
lever (2) as well when a stored file misbehaves (Preview, Replace or Remove of a bound asset, or a legacy
exercise changed); the step, the HTTP status, the error code and the exercise id are recorded here before
anything is retried; the fix is a separate change, and the pilot starts again from E1. E4 is the stated
exception: its failure stops the wider activation, not the pilot, and is recorded the same way. A
**Save that shows an error** (E2, E5, E6): close the editor and look at the exercise in the library before
saving again — for an existing exercise a second Save is harmless, but for a **new exercise or a copy** a
second Save cannot bind the same file (the first Save, if it landed, already bound it) and will show an
error although nothing is lost.

**Rollback of E-2, from the finest lever:** (1) per account — the limit back to 0 through Settings →
Storage: uploads stop at once, Preview of stored files continues; (2) runtime — `MEDIA_STORAGE_ENABLED=false`
on `OptiMove-eu` and the cron, a restart: every media route 503, every editor shows the link fields with no
error, stored R2 files are unplayable until the flag returns (nothing lost); (3) build — a PR setting both
defaults back to `false`, a build and a deploy. Nothing is deleted under any lever.

**Known limits going into the pilot (not blockers for the pilot itself):** athlete-side playback of an R2
video is wired (BE-3 `plan_item` decoration, the FE-1 renderer in `app.js`) but **not yet exercised in
production** — E4 is its first run, and a failure there blocks the wider activation, not the pilot; a
replaced or removed asset stays charged (reference-aware GC is separate backend work); `HEAD` and the two
range headers in CORS (above); the hourly cron is kept for the pilot (an abandoned upload holds its
reservation up to an hour).

### E-2 — the pilot result (2026-10-19, `OptiMove-eu`, commits `66862a7` then `7806450`; the pilot account, the test exercise)

**Run by the main session in the signed-in pilot account's browser page, on the owner's orders, with the
STOP rule above.** No real exercise, program or athlete was touched; no quota, cron, CORS, Render or R2
change; no R2 object deleted. The test data (to be deleted by the owner after the pilot): the exercise
"R2 pilot test (obrisati posle pilota)" `cb99c1d2-f902-4a17-8a20-3d9becf9ddcd`, the legacy exercise
"R2 pilot legacy test RENAMED (obrisati posle pilota)" `8cac8fca-7cd4-4fb9-8514-30ff2d7d18fe`, and the
unassigned Builder draft "R2 pilot test program" `430ea51d-e39a-4743-aafa-0fe23f929895`. No test athlete
and no test account were created (the owner's decision). Every file was an in-page MediaRecorder MP4
(H.264 Baseline + AAC-LC) handed to the editor's own file input.

| # | Expected | Actual | Verdict |
|---|---|---|---|
| E1 | health ×3 = the merge commit; signed out 401; a 0 B coach's editor unchanged | `/api/health` ×3 served `66862a7` (the merge of #192); signed out, `GET /api/media/storage`, `GET /api/media/uploads/<zero uuid>`, `GET /api/admin/media/storage-policy` and `POST /api/media/access` answered 401. **The 0 B coach's editor was not opened** (it needs another coach account; the owner's check) | PASS (partial) |
| E2 | upload → verified → Save binds | a new exercise through *+ Add exercise*: `Upload video…`, 100 %, "Uploaded and verified…", the automatic thumbnail at 1.7 s, Save; `GET /api/exercises/:id` carried `media.video.source: "asset"` and `media.image.source: "asset"`, `videoUrl` ""; used 710,083 B, reserved 0 | PASS |
| E3 | Preview plays and seeks | the FE-1 player opened the signed address (duration 6.94 s, play, seek to 5.0 s, poster set); the reopened editor showed Preview / Replace / Remove and the storage line | PASS |
| E4 | the library card; the Builder; the athlete view | the card's thumbnail through the batch access (signed, 640 px, the `exercise` context). The Builder: a new draft "R2 pilot test program" (a program without an athlete, which the Builder shows as "Reusable template"), one block, one AM / Training session, one section; the library result card carried the thumbnail and the video id; the added item carried `media.video` / `media.image` `{ source: "asset", mediaId }` with `accessContext { type: "plan_item" }`, its thumbnail resolved and its Preview played. **The athlete view was not run** (no athlete; no test athlete by the owner's decision) | library + Builder PASS; athlete view NOT TESTED |
| E5 (first run, `66862a7`) | the picture is the frame; the card shows it | the frame at 4.0 s uploaded and bound (`media.image.mediaId` changed; used +9,891 B); the reopened editor showed it; **the library card kept the previous thumbnail after the Save and after a new search, until a page reload** — the first unexpected outcome | **STOP** |
| E5 (again, `7806450`, after #194) | the same | the frame at 2.5 s; **without a reload the card showed the new picture at once** (a new media id and object, signed, 640 px); the detail carried the same id, the video unchanged; the reopened editor showed the stored picture; the card's Preview played the video with the new picture as the poster; used +10,565 B, reserved 0 | PASS |
| E6 | Replace → the new asset bound; Remove → `{ source: "none" }`, the link fields back; the old objects stay charged | Replace with a second file (108,942 B): the new video id bound, the card's Preview played the **new** object (4.93 s, not the previous 6.94 s), the frame stayed the poster; used +108,942 B. Remove → Save: `media.video = { source: "none" }`, `videoUrl` ""; the reopened editor showed *Upload video… / Use a link*, the image without *Replace with a frame…*; the card without a video; used unchanged (839,481 B), reserved 0 | PASS |
| E7 | "Upload cancelled." both times | a 10.8 MB file. Cancel at 15 % of the PUT → "Cancelling..." → "Upload cancelled."; Cancel at 100 % (the PUT just finished, before the completion request) → "Upload cancelled." within a second. Both: `POST /api/media/uploads` 201 → `DELETE` 200, no completion request; afterwards reserved 0, active 0, both sessions `cancelled`. **No 202 "verifying" window occurred in the whole pilot** (every completion answered 200 at once), so the cancel during the poll sleep is not exercised in production | PASS (with the note) |
| E8 | a legacy rename: the links unchanged; the custom-exercise modal: link fields only | a new legacy test exercise with a YouTube link, renamed: the `PATCH` body carried `videoUrl` / `imageUrl` as loaded and **no `media` key**; the detail kept `media.video = { source: "legacy", url }`. The Builder's custom-exercise form: name, instruction, sets, reps, load, Image URL, Video URL — no file input, no Upload / Storage text | PASS |
| E9 | the cron's next run `{"cleaned":N,"failed":0}`; the used bytes = the bound assets plus the earlier pilot files | the Render cron run of 20:01:16 UTC (`npm --prefix backend run media:cleanup`) printed `{"cleaned":0,"failed":0}` and finished successfully (the owner's screenshot of the log): nothing was left for the sweep, because both E7 cancels had completed synchronously (`DELETE` 200, the rows `cancelled` and the reservation released at once), so N = 0 is the correct count. Before (19:11 UTC) and after the run (20:05 UTC) the account read the same: used 839,481 B = the phase C files 445,210 + the E2 video 255,600 + the automatic thumbnail 9,273 + the two frames 9,891 and 10,565 + the E6 video 108,942; reserved 0; activeUploads 0; both sessions still `cancelled` | PASS |

**The E5 stop and its fix.** `frontend/media-playback.js` caches a signed address per (context, slot) and
the thumbnail resolver writes the cached object back onto a card; the editor's Save invalidated the
exercises view-cache and read the list again, but never forgot the saved exercise's media access context,
so the redrawn card kept the pre-save answer until the address expired (600 s) or the page reloaded.
Display only; the server was right at once. **The owner waived lever (1) for this stop** — the owner's
reason: a display problem with no sign of a data or authorization risk — so the pilot limit stayed 1 GB; the
owner stopped the pilot at E5 and ordered the fix as its own PR: **#194** (merge `7806450`) — after a
confirmed Save of an existing exercise the editor forgets exactly that exercise's context (both slots; a
failed Save, a private copy and every other context keep their addresses), and an access answer that lands
after a forget is handed to its caller but never kept; pinned by
`frontend/tests/exercise-editor-media-cache.test.mjs` (4 tests; the two mutations of the fix — no forget
after Save, a stale answer kept — each made its test fail). **On the owner's decision the pilot resumed at
E5, not from E1 as the STOP rule prescribes:** `/api/health` ×3 served `7806450` (19:01:48–19:02:09 UTC)
before E5 was repeated; the signed-out 401 checks and the 0 B editor check of E1 were not repeated. Both
deviations are the owner's decisions for this pilot, not a change of the STOP rule.

**Observations, not defects:** a Builder item keeps the media snapshot of the moment the exercise was
added (BE-3): after E5 and E6 the test program's item still carried the first video and the first
thumbnail and resolved them through its `plan_item` context — a later edit of the exercise does not
change an existing item (a product decision to confirm before the wider activation). A program created
without an athlete is a template draft ("Reusable template"). After a video is removed, the image slot
offers no *Replace with a frame…* (there is no video to take a frame from).

**What the pilot leaves open:** the 0 B coach's editor (E1), the athlete-side playback (E4, the stated
blocker for the wider activation), the product decision on the Builder snapshot, the reference-aware GC
(a replaced or removed asset stays charged; cancelled uploads never counted), and the quota policy for
the wider activation. The wider activation itself is a separate owner order; its lever is the quota, not
the code.

### On-device preparation of phone videos (built 2026-10-20, not yet merged)

**Why.** The pilot's S24 FE recording (HEVC, 1080×1920, 51 s, 88 MB) was refused by the inspection after
a full upload; most phones record HEVC by default, and the only way to play one video everywhere is MP4 /
H.264 / AAC-LC. The PoC (`docs` of 2026-10-19, the owner's Samsung run: 51 s HEVC → 720p H.264 in 13.8 s,
audio kept) showed the device can do it without a server or a paid service.

**What it is.** `frontend/exercise-media-prepare.js`, called by the editor before an upload of the video
slot: the chosen file is read (Mediabunny 1.61.1, vendored under `frontend/vendor/mediabunny/`, MPL-2.0,
loaded only when a video is chosen); a file the inspection would accept as it is — MP4, one H.264 track in
Baseline / Main / High, AAC-LC or no audio, nothing else, at most 4096 px a side — is **never re-encoded**
(passthrough first; its picture and sound are sent byte for byte, its rotation metadata is untouched, only
its private metadata is removed — see below); anything else is converted on the device with WebCodecs: the picture is copied when it is
already H.264 (a MOV is remuxed in milliseconds) and re-encoded only for another codec or profile, then at
most 720p on the long side (`VIDEO_PREPARE_RULES`), the audio copied when it is AAC-LC and encoded to AAC
otherwise; the output is MP4 with faststart, read again before it is accepted. The upload then takes the
prepared file: the reservation, the quota, the inspection, the binding and the playback are unchanged.
**Limits (the owner's rules):** an input of at most 100 MB — checked before the file is read — and a video
of at most 30 seconds — checked once the container's header is read, before any conversion or request — and
the 30 seconds again by the server's inspection (`video_too_long`, 415; the longest of the container's
declared durations). No trimming: a longer video is refused with its length. A converted file carries no
descriptive metadata (Mediabunny `tags: {}`). Known gap (narrow re-review, LOW): the device measures the
picture and the sound, the server the longest declared duration including a metadata track or the file's
own header, so a rare file whose metadata track or header declares more than 30 s while its picture and
sound do not is sent whole and then refused (`video_too_long`, nothing charged, the coach chooses another
file).

**Private metadata is removed from every file before it is sent (the owner's decision F2, 2026-10-20).**
`frontend/exercise-media-metadata.js` rebuilds the container of every video the device sends — the compliant
file sent without conversion included — and re-encodes nothing:
- **The rule.** Every box that is kept has a known shape and is rebuilt in its canonical form; a box
  outside a known shape is refused, and the file goes to the remux below. Nothing is masked: a box that is
  left out is not in the sent file at all, and every size above it is recomputed.
- **What goes.** udta (location ©xyz, make, model, software, author, dates), meta (Apple keys / ilst,
  title), XMP uuid, iods, free / skip padding, any vendor box and every timed-metadata / timecode /
  caption / GPS track; track references (tref — one picture and one sound track need none); every
  top-level box other than ftyp / moov / mdat and
  whatever follows the last box (a Samsung `SEFH` trailer, a top-level XMP). The creation and modification
  times and the reserved / QuickTime vendor fields of mvhd / tkhd / mdhd are written as zero; the hdlr keeps
  only its handler type (name, vendor and reserved bytes emptied); dinf is rebuilt as self-contained
  `url ` entries (no location string, no alias record); edts keeps only its elst; the sample description
  keeps exactly one avc1 / avc3 or mp4a entry with its reserved, vendor and compressorname fields zeroed (a
  camera or an encoder writes its name there) and only known codec boxes (avcC and esds parsed to their
  end, btrt, pasp, clap, fiel, colr only nclx / nclc — an ICC profile is refused); sdtp / stps (a free
  byte per sample) are left out. Every mdat byte no kept sample uses (a removed track's samples, stale data)
  is written as zero inside the mdat — raw payload, so a zero there is correct structure — and nothing of it
  can be recovered; every chunk offset moves exactly with its mdat.
- **Exact shapes.** One ftyp (at most 128 bytes, readable brands), one moov, one picture track and at most
  one sound track; inside the moov plain 32-bit box sizes and at most 4,096 children per box; a box that
  may appear once appears once, and the required ones are there (tkhd, mdia, mdhd, hdlr, minf, the media
  header of the track's kind, dinf, stbl, avcC or esds); fixed-size boxes at their exact size; every sample
  table at its exact size (no bytes after its entries), none twice, the chunk map as ISO 14496-12 defines it
  (first run at chunk 1, no empty run, sample description 1); no two tracks sharing a byte; at most 200,000
  samples and chunks, 10,000 gaps and 8 MB of unused media. Anything else is refused, never worked around.
- **What stays.** The picture and the sound byte for byte; rotation (the tkhd matrix), edit lists,
  durations, timescales, language, the codec configuration and the sync / composition tables.
- **Memory.** Only the box headers, the ftyp and the moov are read (10.8 KB of an 86.9 MB file in the
  browser check, 36 ms); the output is slices of the original plus the rebuilt moov and zero fills.
- **The check before sending.** `inspectPrivacy` re-reads the cleaned file. By its own walk it looks for
  every channel listed above (top-level boxes, a trailer, the boxes inside the moov, tracks, times, hdlr
  names, compressorname, dangling references, metadata markers anywhere in the moov); then it requires the
  file to be a fixed point of the cleaning (the cleaning would change nothing: same boxes, the moov byte for
  byte, every unused mdat byte zero, read back) and the used bytes to equal the sample sizes counted on
  their own. It proves the absence of the known channels, not of every conceivable one; the file is then
  read again and must play the same (container, codecs, size, rotation, duration).
- **When the cleaning is not reliable.** A structure it does not handle (fragmented, external data, compact
  sample sizes, an unknown box or shape, a hostile size) is remuxed instead — the tracks copied, nothing
  re-encoded, no metadata — and the remux is cleaned and checked the same way. When that fails too, the
  upload is refused: "The recording details in this video (such as where it was recorded) could not be
  removed safely, so it was not uploaded. Choose another video." (a video tool that could not be loaded
  keeps its own sentence). **The original is never sent**: the cleaning always writes a new file, and a tool
  that hands back the file it was given is not trusted. A converted (HEVC → H.264) file is cleaned and
  checked the same way.
- **Not covered.** Data inside the codec bitstream itself (for example H.264 SEI user data, where x264
  writes its version), deliberately crafted values in numeric fields, and the file name (its base is kept;
  phones put the date and time there — an owner decision). Not verified on a physical iPhone (an iPhone MOV
  takes the remux). Stricter shapes mean more files take the remux; how many real Samsung files are
  cleaned in place is measured in the planned S24 FE check.

**What the coach sees.** "Checking the video..." → "Preparing the video... N %" with Cancel → the upload's
"Uploading the video... N %" → "Uploaded and verified..."; the file line names the prepared size and the
size it came from. Save waits, the editor asks before closing, a reload asks first, like an upload. A
refused video says why in one sentence (over 100 MB, longer than 30 seconds, not readable, cannot be
prepared on this device, the video tool could not be loaded, preparation failed, the recording details
could not be removed safely) and offers another file.
While a video is prepared or uploaded every other media control is shown disabled and only its Cancel is
live; a Cancel that lands while the converted file is read back drops it (nothing is uploaded, a Replace
keeps the stored file). No codec, size or setting is ever asked.

**Devices.** Android Chrome / Samsung Browser: WebCodecs with the platform's HEVC decoder and H.264 encoder.
iPhone Safari 16.4+: the video part of WebCodecs exists (HEVC decode, H.264 encode); the audio part arrives
only with Safari 26, which does not matter while the audio is copied (AAC-LC) — a MOV with H.264 / AAC is
remuxed without any codec. **Not verified on a physical iPhone**: the HEVC decode, the MOV read, the
rotation and the AAC copy were exercised on a desktop Chromium and the Samsung run; a device that cannot
convert gets the sentence and may use a link. ffmpeg.wasm is not used (0.48× real time on a desktop).

**Tests.** `frontend/tests/exercise-editor-video-prepare.test.mjs` through the real editor with a fake
adapter (Node has no WebCodecs): the rules, passthrough of a compliant and of a rotated file, HEVC,
MOV (remux), Cancel, the limits, a device that cannot convert, a failed conversion, Save held and the
guards, the server's `video_too_long`. The real conversion: the browser harness `_qa-media-harness.html`
(untracked) with clips made in the page — compliant H.264 (passthrough, the same samples, metadata
removed), H.264 with rotation 90 (passthrough, plays 360×640), HEVC (re-encoded), H.264 MOV (remuxed, picture copied), HEVC without
audio, WebM VP8, HEVC 1080×1920 25 s (720×1280 in 2.8 s), a 31 s clip (refused), Cancel at 20 %, the
server's 415. `frontend/tests/exercise-media-prepare-glue.test.mjs` runs the Mediabunny glue through a
fake of the library module (what is passed to `Conversion.init`: copy vs re-encode, size, bitrate, AAC,
`tags: {}`; Cancel → `conversion.cancel()`; `isValid`; every `Input` disposed; a failed library load).
Backend: `media-upload-be2.test.mjs` gained the 30-second rule (the longest declared duration), the
ignored metadata tracks (`Other` / `Text` / `Menu`, at most eight; a second video or audio track, `Image`
and any other type still refuse), the override that can only lower the limit, the real worker refusing a
31 s WebM as `video_too_long` with nothing charged, and **two real outputs of the client** made in Chrome
with the vendored Mediabunny (`backend/tests/fixtures/media/`): an HEVC recording with rotation 90 prepared
into H.264 High + AAC-LC, and a compliant H.264 / AAC MP4 with a WebVTT text track sent as it is — both
accepted by the real parser.
The metadata removal: `frontend/tests/exercise-media-metadata.test.mjs` on real bytes built box by box
(`frontend/tests/support/mp4-builder.mjs`, with an independent reader): a phone-like MP4 with the moov at
the end (location, device, software, author, title, Apple keys, XMP, padding, caption / timecode / GPS
tracks, a trailer), the moov first with boxes before the mdat, 64-bit offsets and two mdat boxes, track
references, stale and removed samples zeroed, MOV brand, idempotence, the refused structures, Cancel, a
40 MB file read in under 64 KB, the independent check's findings, the sample tables kept, a camera's name
in the hdlr and the compressorname, 64-bit mdat headers / an mdat to the end of the file / version-1 times,
a private text hidden in every kept box (rebuilt without it, or refused), hostile sizes refused quickly, and
the playable fixtures packet by packet through the real Mediabunny demuxer. `exercise-media-prepare-glue.test.mjs` tests 11–17: the remux fallback, an unclean or differently
playing copy, a remux that fails or cannot be cleaned, a converted file, Cancel, a cleaning tool that hands
back the same file. Backend: the real parser
(mediainfo.js) reads `backend/tests/fixtures/media/phone-like-gps-moov-end.mp4` — a real Chrome-made H.264
/ AAC file with rotation 90, title / date tags, a WebVTT track, injected location / device / software /
author atoms, a top-level XMP and a vendor trailer — before (Title, Performer, Recorded_Date,
Recorded_Location, Encoded_Application, Make, Model, a Text track) and after the client's cleaning (none of
them, no extra field, accepted). Mutations: 38 of 38 killed.

**Review (2026-10-20, before the PR).** `code-reviewer` NOT READY (HIGH: a Cancel while the converted file
was read back did not stop the upload; MEDIUM: no real output through the real parser; MEDIUM: the
Mediabunny glue untested) → all fixed with the tests above. `security-reviewer` READY WITH NOTES (MEDIUM
F1: the 30 s measured on the video track only → fixed; MEDIUM F2: embedded metadata of a file sent as it is
→ removed from every file, the owner's decision above; LOW: `Image` dropped, ignored tracks capped, the override clamped, the
vendored file recorded in `frontend/vendor/mediabunny/VENDOR.md`). `mobile-qa` READY WITH NOTES (MEDIUM:
the other slot's controls dead during a preparation → disabled; MEDIUM: the editor's exits under 44 px and
a long link widening the field → fixed in CSS).

### Phase D readiness — the transport-only variant (reviewed 2026-10-19; superseded by E-2 above)

**The exact change.** Against `main` (`2798faa`) the PR carries one line of code —
`DEFAULT_UPLOAD_TRANSPORT_ENABLED` from `false` to `true` in `frontend/exercise-media-upload.js` — plus this
runbook and `frontend/tests/exercise-media-pilot-mode.test.mjs`. No backend change, no migration, no
environment change: the deploy is a frontend build (`vite build`) and the usual start (the migrator finds
nothing new). `MEDIA_SAVE_ENABLED` stays `false`.

**Who reads the guard.** `uploadsOffered()` and `storageWanted()` in `frontend/exercise-editor.js`: an upload
is offered only for an **existing** exercise (a new exercise or a copy needs the save guard too), only when
the storage read answered (a 503 or 403 leaves the link fields), and never while something uploads; a
stored R2 file keeps Preview only; a frame or thumbnail needs the save guard (#191 stays inert); the Builder's
Edit opens this same editor and its custom-exercise modal keeps its link fields; Settings → Storage is
unchanged by the merge.

**What every signed-in coach sees right after the merge** (the backend flag is already on):

1. Opening an existing exercise in the editor sends one `GET /api/media/storage?exerciseId=…` and shows the
   storage line, e.g. "Storage (personal storage): 0 B used of 0 B · 0 B free · one video up to 209.7 MB,
   one picture up to 10.5 MB", with *Upload video… / Use a link* and *Upload picture… / Use a link*; an
   existing link shows *Preview / Edit link / Replace with a file… / Remove* as FE-2 built it.
2. Choosing a file on an account with **0 B free** is refused locally, before any request: "This file needs
   189.4 KB, but only 0 B of your storage are free. Remove media you no longer use or ask an administrator
   for more storage." — the server would answer the same 429 anyway (phase C, N2).
3. A new exercise or a copy: the two link fields exactly as today.
4. Saving an exercise sends the body of today (pinned by the pilot-mode test, byte-identical with the guard
   on and off); nothing of R2 reaches an exercise until the save guard flips.

**Upload is therefore not restricted to the pilot account by code — it is restricted by the quota.** The
frontend guard is global; every account whose limit is above 0 can upload after the merge, and the file is
charged and stays unsaved. On 2026-10-19 two user accounts carry a 1 GB override (the pilot account
`267c7e75…` and the administrator account `491e8789…`); every other account, and the club account, is at the
default 0 B. Keep it that way through phase D: no default-limit change, no further overrides, nothing
announced. If the owner prefers that no coach sees *Upload* at all before phase E, the alternative is to
hold #192 and merge it together with phase E's PR; otherwise coaches see the buttons and the quota sentence.

**Tests on this branch, merged with `main` (2026-10-19):** `exercise-media-pilot-mode` (6), FE-2's
`exercise-media-upload` (13) and `exercise-editor-media` (10), `exercise-media-thumbnail` (5),
`exercise-editor-thumbnail` (7), `media-storage-admin` (9) and `media-playback` — 58 of 58; `npm run build`
built. The FE-2 and thumbnail suites set both guards explicitly in every test, so the flipped default
changes none of them; the pilot-mode suite is the one that reads the shipped default.

**Activation (phase D), in order:** approval 3 → the owner merges #192 (merge commit, head as reviewed) →
Render deploys `OptiMove-eu` → D1 `/api/health` three times with the merge commit, signed out a media route
401 → D2–D8 of the table below, the pilot account on the test exercise → the results recorded here. The old
service `optimove.onrender.com` also builds the new bundle at its next deploy; with its backend flag off the
editor there shows the link fields (503 read as "storage off"), nothing else.

**Rollback, two levers:** (a) immediate — `MEDIA_STORAGE_ENABLED=false` on `OptiMove-eu` and the cron, a
restart: every media route 503, the editor back to the link fields with no error, uploads in flight end with
their sentences, nothing deleted; (b) the guard itself — a PR that sets `DEFAULT_UPLOAD_TRANSPORT_ENABLED`
back to `false`, a build and a deploy, with the backend still on. The ready pilot videos and the tombstones
stay in the bucket under either lever.

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

### Phase E as first planned — a separate save flip (superseded 2026-10-19 by E-2 above)

Originally a second PR was to flip `DEFAULT_MEDIA_SAVE_ENABLED` after the transport pilot. The owner chose
instead to flip both guards together behind the quota gate (#193) — that is E-2, this PR. Kept for the
record; the checks it listed (an upload saved with the exercise, the player, a frame and an automatic
thumbnail, Replace and Remove, the Builder's cards) are the E-2 pilot steps E2–E6.

## Never, at any phase

Drop the media tables, delete objects, add a lifecycle rule on `pending/`, rewrite legacy URLs, put an
R2 secret in a `VITE_*` variable or a log, or flip a frontend guard without the quota gate (#193) in
place.

## What to watch after phases B, C and E-2

- The cleanup job's runs (Render cron log): expired / cancelled sessions settled, no repeated failures.
- Rate caps: 20 initiation / renew requests per minute and 200 per day per uploader (429
  `upload_rate_limit`).
- Quota: Settings → Storage, the accounts over their limit.
- Render memory during verification (`sharp` and the video inspection; BE-2 bounds the inspection to
  30 s).

## What the tests pin for the pilot

- `frontend/tests/exercise-media-pilot-mode.test.mjs`: the shipped defaults (**both guards on**) and no
  runtime source; a 0 B account's legacy editor byte-identical to the editor with both guards off, and a
  rename sending the links as loaded without a `media` key; the Builder's Edit uses the same editor and
  its custom-exercise modal keeps the link fields; a stored R2 file on a 0 B account shows Preview and
  Remove and a rename keeps it (legacy key omitted, no `media` key); a pilot account's upload **saves as
  `{ source: "asset", mediaId }`** with the legacy key omitted and reopens as stored with Preview /
  Replace / Remove; Cancel during verification honoured at the end of the current poll sleep (1, 2, 4 s)
  and the server told.
- `frontend/tests/exercise-media-quota-gate.test.mjs` (#193): the quota gate — 0 B, the pilot account, a
  full account, Remove's independence, the club exercise's account, every unusable storage answer, the
  legacy links.
- `frontend/tests/exercise-media-upload.test.mjs` and `frontend/tests/exercise-editor-media.test.mjs`
  (FE-2): the transport, the codes, the faces, cancel during the PUT, the H1 rule.
