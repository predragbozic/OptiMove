# Exercise media on R2 — activation runbook

The order in which the pieces already merged (or waiting) are switched on, who does each step, and what
proves it. Nothing in this document is performed by a Claude session: every switch, credential and
cloud setting is the owner's (or a named operator's), and every step that touches production is a
separate decision. Credentials never travel through chat, a terminal transcript, a screenshot or a log.

Sources: `docs/backend/r2-be1-storage.md` (BE-1, the deployment / migration gate),
`docs/backend/r2-be2-upload.md` on the BE-2 branch (the "Configuration / activation gate" and the
cleanup job), `docs/backend/r2-upload-api-v1.md` (the contract),
`docs/ai/exercise-media-r2-fe2-upload-contract.md` (the two frontend guards, PR 3).

## What is live today, and what each switch does

| Piece | State | Switch |
|---|---|---|
| BE-1 storage foundation (#184) | merged, deployed, migration applied | `MEDIA_STORAGE_ENABLED` (Render env, default `false`): every media route answers 503 `media_storage_disabled` while off |
| FE-1 player and adapter (#185) | merged, deployed | none: a stored asset only exists once BE-3 binds one |
| FE-2 upload UI and transport (#186) | open, guards off | `UPLOAD_TRANSPORT_ENABLED` in `frontend/exercise-media-upload.js` (a code change, this runbook's flip PR) |
| BE-2 upload lifecycle (#187, Codex) | open | the same `MEDIA_STORAGE_ENABLED`; needs its migration and the R2 configuration below |
| PR 5 Settings → Storage (#190) | open, stacked on FE-2 | none: visible to a platform administrator; reads 503 while the flag is off |
| PR 3 thumbnails (#191) | open, stacked on FE-2 | both guards: a frame is offered only with `MEDIA_SAVE_ENABLED` on |
| BE-3 binding on save (#189, Codex) | open | `MEDIA_SAVE_ENABLED` in `frontend/exercise-media-upload.js` (a second, separate flip PR) |

**Sequencing decision (owner, 2026-10-19): pilot first.** The transport guard is flipped alone (this
runbook's companion PR), and only after steps 1–4 below are done and recorded; BE-3 and the second
flip (`MEDIA_SAVE_ENABLED`) come later as their own PR. Consequences during the pilot, by design:

- with the save guard off, a file uploaded by the pilot account is charged to the quota but is **not**
  saved with the exercise (the editor says "Saving it with the exercise is not available yet." and
  blocks Save until the file is removed);
- no thumbnail and no frame is offered (PR 3 needs the save guard);
- only the owner uploads, on a test exercise; nothing is announced to coaches before BE-3.

What the pilot proves: the signed PUT from a real browser (CORS, the signed `Content-Length`, the
create-only 412), verification and quota settlement, the Storage tab's numbers, the cleanup job.

## How the guards are switched (build time, not runtime)

`UPLOAD_TRANSPORT_ENABLED` and `MEDIA_SAVE_ENABLED` are **module constants** in
`frontend/exercise-media-upload.js` (`DEFAULT_UPLOAD_TRANSPORT_ENABLED`, `DEFAULT_MEDIA_SAVE_ENABLED`).
They are compiled into the frontend bundle by `vite build`: a change is a **code change, a merge and
a deploy** — never an environment variable, never a runtime switch, never a database value. The
exported `setUploadTransportEnabled()` / `setMediaSaveEnabled()` exist for the tests (and would act
only inside one open page, never persisted). The test `frontend/tests/exercise-media-pilot-mode.test.mjs`
pins the shipped defaults of this branch and that no runtime source feeds them.

The backend's `MEDIA_STORAGE_ENABLED` is the opposite kind: a **runtime** environment variable on
Render, read at start; `false` makes every media route answer 503 whatever the frontend guards say.

## Pilot prerequisites — the checklist (owner, before the flip PR is merged)

Each line names the step below, who does it, and the expected result to record. Nothing of this is
done by a Claude session.

| # | Prerequisite | Where | Expected result (record it) |
|---|---|---|---|
| P1 | BE-1 (#184), FE-2 (#186), BE-2 (#187), BE-3 (#189) merged and deployed; `/api/health` serves the current merge commit | GitHub, Render | the commit three times with `ok: true` |
| P2 | The BE-2 migration applied at the deploy (the start log after `node src/migrate.js`) | Render deploy log | `202610191300_media_upload_lifecycle.sql` applied, the server started |
| P3 | R2 bucket `optimove-exercise-videos`, private, no lifecycle rule on `pending/` | Cloudflare | bucket settings read once |
| P4 | R2 API token: Object Read & Write on that bucket only | Cloudflare | the token's scope read once; the secret in the password manager only |
| P5 | CORS on the bucket: the exact app origins, `PUT`, `Content-Type`, `If-None-Match`, `ETag` exposed (section 1.4) | Cloudflare | the rule as saved |
| P6 | `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET` on the web service; `MEDIA_STORAGE_ENABLED` still unset / `false` | Render | the four present, the flag off |
| P7 | Node ≥ 20.9 on the service (`sharp`) | Render deploy log | the version line |
| P8 | The cleanup cron: `npm --prefix backend run media:cleanup` every five minutes, same variables | Render cron job | the job exists; its first run logs a no-op while the flag is off |
| P9 | Quota: the pilot account's limit above 0 (Settings → Storage, PR 5 #190), or the default limit | the app, a platform admin | the limit and the reason in the History |
| P10 | The controlled browser PUT on a non-production object (section 4): initiation 201, PUT 200, the same PUT 412, complete 200 `completed`, a cancelled session 200 `cancelled`, the tombstone under `pending/` after the next cleanup run | a browser console on the app origin, as the pilot account | the five status codes, the object key, the date |
| P11 | `MEDIA_STORAGE_ENABLED=true` on the web service and the cron job — only after P1–P10 | Render | set at the same time as the flip PR's deploy |
| P12 | The flip PR (#192, transport only) merged and deployed | GitHub, Render | `/api/health` three times; a signed-out call to a media route 401 |

#190 (Settings → Storage) and #191 (thumbnails) are independent of the pilot: #190 is needed for P9
through the app (otherwise P9 is a database-side limit by the operator), #191 stays inert during the
pilot (a frame needs the save guard).

## 1. Cloudflare R2 (owner, Cloudflare dashboard)

1. Bucket `optimove-exercise-videos` (BE-2 requires exactly this name), **private**: no public bucket
   URL, no custom domain, no `r2.dev` access.
2. **No lifecycle rule that deletes `pending/`** (BE-2 keeps zero-byte tombstones there on purpose;
   ready assets may use the prefix).
3. An R2 API token with **Object Read & Write on this bucket only** (no account or list permissions).
   Record the account id; keep the access key id and secret in a password manager.
4. CORS on the bucket — exact app origins, nothing wildcarded:

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

   Later, with BE-3 (playback and the frames of a stored video, PR 3), add `GET` and `HEAD` to
   `AllowedMethods` and `Range` to `AllowedHeaders` on the same origins. Without that, playback of a
   stored video still works (a media element needs no CORS), but a frame of a stored video cannot be
   read by the canvas: the picker says "The storage does not let this app read frames of the stored
   video." — expected until the rule is added.

## 2. Render (owner)

1. Environment variables on the web service: `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`,
   `R2_SECRET_ACCESS_KEY`, `R2_BUCKET=optimove-exercise-videos`. **Leave `MEDIA_STORAGE_ENABLED`
   unset or `false` until step 5.** Never as `VITE_*`, never in a log line.
2. Node: BE-2 brings `sharp`, which needs Node ≥ 20.9. Pin the Node version on Render (or
   `engines` in `backend/package.json`) and read the deploy log once after the BE-2 deploy.
3. The BE-1 role preflight (`docs/backend/r2-be1-storage.md`, the SQL under "Deployment / migration
   gate") was the condition of the BE-1 merge; the BE-2 migration
   (`202610191300_media_upload_lifecycle.sql`) runs through the same startup runner at the BE-2
   deploy — a failed migration stops the server even with the flag off, so deploy BE-2 in a window
   where a rollback of the service is acceptable, and read the start log.
4. **The cleanup job** (mandatory before step 5): a Render cron job (same environment variables)
   running `npm --prefix backend run media:cleanup` every five minutes. It is a no-op while the flag
   is off, bounded (20 sessions per run), safe to overlap. Without it an abandoned upload keeps its
   reservation.

## 3. Quota (platform administrator, in the app)

Settings → Storage (PR 5). The default limit is **0 bytes** until set: either raise the default
limit (every account), or give the pilot account an individual limit. Check the largest video /
picture sizes and uploads at once. Every change needs a reason and is in the History.

## 4. The controlled real-browser proof (BE-2 gate; non-production object)

BE-2's local tests prove the signature it generates, not what R2 and a browser do with it. Before
any coach can upload:

1. On a service with `MEDIA_STORAGE_ENABLED=true` and the R2 variables set (a staging service, or
   production **with the frontend guard still off** — the routes exist, no screen calls them):
   signed in as the pilot account, from the browser console on the app origin:
   - `POST /api/media/uploads` with an `Idempotency-Key` (a UUID), context `exercise_edit` of a test
     exercise, `kind: "video"`, `purpose: "exercise_video"` and the file facts of a small real MP4 →
     201 with `upload.url`, `upload.headers`;
   - `fetch(upload.url, { method: "PUT", headers: upload.headers, body: file })` with the raw File →
     expect **200** (CORS and the signed `Content-Length` hold);
   - the same PUT again → expect **412** (`If-None-Match: *`, create-only holds);
   - `POST /api/media/uploads/:id/complete` → 200 `completed` with `media.status: "ready"` (HEAD,
     inspection and quota settlement work);
   - a second session cancelled with `DELETE` → 200 `cancelled`; the cleanup job's next run reports
     it, the bucket shows the zero-byte tombstone under `pending/`.
2. Record: the date, the service, the status codes, the object key — no URL with a signature, no
   token. Any other outcome is a stop: nothing further is switched on.

## 5. Switching the transport on

1. Merge FE-2 (#186), PR 5 (#190) and PR 3 (#191) as the owner decides; deploy; smoke: `/api/health`
   serves the merge commit three times, without a login the media routes answer 401 (the flag off:
   503 from a signed-in administrator's Storage tab, nothing else changes).
2. Merge the **flip PR** (this runbook's companion: `UPLOAD_TRANSPORT_ENABLED` default `true`, one
   line, nothing else) and set `MEDIA_STORAGE_ENABLED=true` on the web service and the cron job;
   deploy.
3. Smoke as the owner, on a test exercise, in this order (record each outcome):
   1. open the editor → the storage line shows the pilot account's numbers;
   2. upload the small MP4 → progress → "Uploaded and verified. Saving it with the exercise is not
      available yet." → Settings → Storage shows the bytes used. With the save guard off the file
      is **not** saved with the exercise (by design): Remove it afterwards or leave it until BE-3;
   3. **Cancel during the PUT**: start the upload again, press Cancel while the bar moves → the PUT
      is aborted at once, "Cancelling…", then `DELETE` → "Upload cancelled." with *Upload again*;
   4. **Cancel during verification**: start the upload again, press Cancel right after the bar
      reaches 100 % (the completion / verification phase) → "Cancelling…" **may last up to 4 s**
      (the verification poll sleeps 1, 2, 4 s and is not interrupted by the cancel — a known FE-2
      nit, see #186), then `DELETE` → "Upload cancelled."; if the verification completed meanwhile
      the cancel comes too late and the ready file comes back as "Uploaded and verified." — both are
      correct, nothing is lost or charged twice;
   5. after the next cleanup run: the cancelled sessions settled, the quota back to the one ready
      file (or to zero after its Remove), the tombstones under `pending/`;
   6. a legacy exercise (a Drive or YouTube link) opened and saved with a name change: its links
      unchanged after the save, the Builder's cards and the player as before (the pilot never
      touches existing media — pinned by `frontend/tests/exercise-media-pilot-mode.test.mjs`).

## 6. Switching the save on (after BE-3)

BE-3 merged and deployed (binding on `POST` / `PATCH /api/exercises` and `/copy`, the `{ type:
"upload" }` access context, the Builder custom-exercise route); CORS `GET` / `HEAD` / `Range` added
(step 1.4); then the second flip PR (`MEDIA_SAVE_ENABLED` default `true`). From then on a coach saves
an uploaded file, a frame or an automatic thumbnail with the exercise, and the FE-1 player plays it.

## 7. Rollback

- **Frontend:** a PR that sets the guard back to `false` — the editor returns to the link fields
  (a stored file keeps Preview). Uploads in flight at the deploy end with their sentences.
- **Backend:** `MEDIA_STORAGE_ENABLED=false` — every media route answers 503; the editor reads it as
  "storage off" and shows the link fields (no error for the coach); the Storage tab says the
  storage is switched off.
- Never drop the media tables, delete objects or rewrite legacy URLs; ready assets stay (BE-1 /
  BE-2 rollback notes).

## 8. What to watch after activation

- The cleanup job's runs (Render cron log): expired / cancelled sessions settled, no repeated
  failures.
- Rate caps: 20 initiation / renew requests per minute and 200 per day per uploader (429
  `upload_rate_limit`).
- Quota: Settings → Storage, the accounts over their limit.
- Render memory during verification (`sharp` and the video inspection; BE-2 bounds the inspection
  to 30 s).
