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

**Sequencing decision for the owner.** With the transport on and the save guard off, a coach can
upload a file that cannot be saved with the exercise (FE-2 shows "Saving it with the exercise is not
available yet." and blocks Save): the file is charged to the quota and stays unused until BE-3. Two
sane orders:

1. **Pilot first (recommended for the proof, not for coaches):** flip the transport, let only the
   owner upload on a test exercise, verify the R2 object, then wait for BE-3 before telling anyone.
2. **Both at once:** merge BE-3, flip both guards in one PR, one deploy, one announcement.

Either way the steps 1–4 below come first and are the same.

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
3. Smoke as the owner: open a test exercise → the storage line shows the pilot account's numbers →
   upload the same small MP4 → progress → "Uploaded and verified." → Settings → Storage shows the
   bytes used. With the save guard still off the file is **not** saved with the exercise (by
   design); Remove it or leave it until BE-3.

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
