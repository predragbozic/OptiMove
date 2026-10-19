# Exercise media — FE-2 upload UI and the open BE-2 contract questions

Status: FE-2 as built on `feat/exercise-media-r2-fe2` (2026-10-19), frontend only. The backend of
the upload (BE-2, direct upload to the private R2 bucket) is being built by Codex in parallel; at
the time of writing its routes are not defined in any document or branch the frontend can read.
The owner's rule for this case: report the open questions first, implement only what does not
depend on them, and keep every contract-dependent line in one place.

## What FE-2 implements without the upload contract

- **The media fields of the exercise editor** (`frontend/exercise-editor.js`, `renderExerciseMediaFields()`):
  one box per slot (Video, Image) with the faces of the plan's section 2 — a link (Preview, Edit
  link, Replace with a file, Remove), a stored R2 file (Preview through the FE-1 player, Replace,
  Remove, the media id under Technical details), an upload in flight (file name, size, a progress
  bar and "42 % · 77 MB of 184 MB", Cancel), an uploaded file (Preview of the local file, Replace,
  Remove), a failure (the sentence, Retry with the same file, Choose another file, Use a link,
  Clear) and a cancelled upload (Upload again, Use a link). Save is disabled while an upload
  runs; closing the editor, a reload or a closed tab asks first and cancels on "yes".
- **Who sees the upload controls** (`uploadsOffered()`): only while BE-1's `GET /api/media/storage`
  answers 200 — a 503 `media_storage_disabled` (the flag off, today's production) or a 403
  `operation_not_allowed` leaves the editor exactly as it is today, links only — and only for an
  exercise that already exists (see Q6). The right to edit is the existing one: the editor opens
  only when `canEdit` is true (platform admin for application exercises, the owner for private
  ones), and a copy starts without the original's media, as with links.
- **Limits and quota** (`frontend/exercise-media-upload.js`): the usage line "Storage (personal
  storage): 1.2 GB used of 5 GB · 3.8 GB free · one video up to 200 MB, one picture up to 10 MB"
  from BE-1's usage row (decimal strings), re-read with "Read again" on failure; `validateFile()`
  refuses locally, before any request, a type outside the slot's and the server's allowlist, a
  file over `maxVideoBytes` / `maxImageBytes`, a file larger than `availableBytes` or an account
  `overLimit`, and a start while `activeUploads >= maxParallelUploads`; `describeUploadError()`
  renders BE-1's codes (`file_too_large`, `unsupported_media`, `storage_quota_exceeded`,
  `parallel_upload_limit`, `media_verification_failed`, `media_storage_disabled`,
  `media_storage_busy`) as sentences, never "nothing was uploaded" after a lost answer.
- **Drive, YouTube and direct links**: unchanged — the same `videoUrl` / `imageUrl` fields, the
  same save body, the same FE-1 player.
- **The Builder**: Edit on a library result or an added item opens this same editor, so it gets the
  upload fields; the "Add custom exercise" modal keeps its link fields (its stale "File upload will
  be added when Supabase Storage is connected" note is removed) — see Q7.

## The seam (`frontend/exercise-media-upload.js`)

- `startUpload({ file, slot, context }, { onProgress, signal })` — the one function BE-2's contract
  fills in. Until then it refuses locally with `upload_contract_pending` ("Uploading files is not
  available yet in this version. Use a link for now.") and **sends nothing**.
- `mediaSavePayload(media)` — the fields of `POST` / `PATCH /api/exercises` that carry a new or a
  removed media. Until the contract names them it returns `{}`, so the save body is byte-identical
  to today's.
- The editor's state machine, progress patching, cancel (`AbortController`), retry (the `File`
  stays in state), validation and messages are complete and tested against a fake transport.

## Open questions for BE-2 (each blocks exactly the line it names)

1. **Start of an upload.** Route and body to reserve an upload for a context (`{ context: { type:
   "exercise", id }, slot, fileName, mimeType, sizeBytes }` is the proposal); the answer's shape
   (`uploadId`, the presigned `PUT` URL and the headers to send, its expiry, multipart or single
   `PUT`, the part size and the per-part URLs if multipart).
2. **The bytes.** Is the `PUT` a single request up to `maxVideoBytes` (200 MiB today)? The bucket's
   CORS must allow the app's origin, `PUT` and `Content-Type`, and expose `ETag` for multipart. The
   frontend sends the object with `XMLHttpRequest` for progress; the JSON calls use `api()`.
3. **Completion.** Route and body to tell the server the bytes are in (`{ uploadId, etag? }`), the
   verification step (422 `media_verification_failed`) and the answer: the media record
   `{ mediaId, status, mimeType, sizeBytes, durationSeconds?, width?, height? }`. Does the server
   verify synchronously, or does the record carry a `pending` status the editor must wait for?
4. **Cancel / abort.** Is there a route to abandon a reserved upload (and free the reservation and
   the parallel slot), and what happens to a reservation the browser never completes (TTL, sweeper)?
   The frontend can only stop sending.
5. **The exercise save.** Which fields of `POST` / `PATCH /api/exercises` attach the uploaded media
   (`videoMediaId` / `imageMediaId`?) and which remove a stored one (`removeVideoMedia` /
   `removeImageMedia`, or `videoMediaId: null`?). Does attaching a media that belongs to another
   context, or to another owner, answer 404 like the exercise itself?
6. **A new exercise.** An upload needs a context, and a new exercise has no id until it is saved.
   Options: (a) save first, then upload (what FE-2 offers now: "Save the exercise first, then add a
   video or picture file"); (b) a draft context the server issues before the save; (c) upload to
   the user's context and attach on save. The same question for a copy.
7. **The Builder's custom exercise.** Same as 6: the modal creates the exercise on submit, so a file
   can only follow the creation unless (b) or (c) exists.
8. **Charging.** BE-1 charges private content to its owner and club content to its club. Which
   storage account does an **application** exercise's media (edited by a platform administrator)
   count against, and which account should the editor's usage line show in that case?
9. **Replace.** When a stored media is replaced, does the old object stay until the exercise is
   saved with the new id (so a cancelled Replace changes nothing), and who deletes the old object?
10. **Error codes of the upload routes** beyond BE-1's list: an expired presigned URL, an upload id
    the context does not own, a size that differs from the reservation.
11. **The access route after an upload.** Does `POST /api/media/access` (FE-1) serve a media whose
    record is `pending` verification, or only `ready` ones (the editor's Preview of a freshly
    uploaded file uses the local object URL meanwhile)?

## How the answers land

Every answer changes `frontend/exercise-media-upload.js` (`startUpload`, `mediaSavePayload`, the
error map) and the fake transport in `frontend/tests/exercise-editor-media.test.mjs`; the editor's
faces and the state machine stay as they are.
