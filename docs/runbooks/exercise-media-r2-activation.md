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
