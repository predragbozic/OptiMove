# Exercise media — FE-2 upload UI, the BE-2 transport and the integration guards

Status: FE-2 as built on `feat/exercise-media-r2-fe2` (PR #186), frontend only, integrated with
the normative contract `docs/backend/r2-upload-api-v1.md` (v1.0.0, commit `5aa5589` on
`codex/r2-be2-upload`, draft PR #187), which answered the eleven questions of the first version of
this document. The questions are kept at the end for the record.

## What FE-2 does

- **The media fields of the exercise editor** (`frontend/exercise-editor.js`,
  `renderExerciseMediaFields()`): a link as before (Preview, Edit link, Replace with a file,
  Remove); a stored R2 file (Preview through the FE-1 player with the row's access context;
  Replace / Remove only behind the BE-3 guard); an upload in flight (name, size, a progress bar
  patched in place, Cancel); "Cancelling..." until the server answered the DELETE; an uploaded
  and verified file (local Preview, Replace, Remove); a failure (the sentence, Retry, Choose
  another file, Use a link, Clear); a verification still pending after the budget (Check again
  reads the same session, never a new upload); a cancelled upload (Upload again, Use a link). Save
  is held while an upload runs; closing the editor, a reload or a closed tab asks first and
  cancels on yes, on the server too.
- **The transport** (`frontend/exercise-media-upload.js`, `startUpload()`), exactly the contract:
  `POST /api/media/uploads` with an `Idempotency-Key` (a fresh UUID per attempt; a lost answer
  retried once with the same key; a resumable failure — the PUT or the completion did not land —
  continues the same session with the same key; a terminal failure is a new attempt with a new
  key); the raw `File` by `XMLHttpRequest` to the presigned URL with exactly the returned method
  and headers (`Content-Type`, `If-None-Match: *`; never `Content-Length`, never OptiMove's
  session), progress from `xhr.upload`; 2xx → completion, 412 → completion (the object exists,
  never overwritten), a 403 / network / CORS failure → the server's status decides, then one whole
  PUT of the same File, never byte ranges; a permission within 60 s of its expiry is renewed first
  (`/renew`); `POST /complete` with a 90 s bound (the server's HEAD, 30 s inspection and commit), 202 → the status polled at 1, 2, 4, 4 … s inside
  a 120 s budget; a timed-out completion is an unknown state → the status before anything is
  repeated (a session still pending gets one more completion); Cancel = stop the request **and**
  `DELETE /api/media/uploads/:id` (quota is the server's; `cancel_unconfirmed` when it did not
  answer; a cancel that came too late returns the ready media). Error codes map to one sentence
  each; never "nothing was uploaded" after a lost answer.
- **Contexts**: `{ type: "exercise_edit", exerciseId }` for an existing exercise,
  `{ type: "exercise_create" }` for a new one or a copy; FE-1's access context
  `{ type: "exercise", id }` is refused before any request.
- **Storage usage, target-aware** (Q8): an existing exercise reads
  `GET /api/media/storage?exerciseId=` and shows the server's `selectedStorageAccountId` row; a new
  exercise or a copy reads the plain route and shows the signed-in user's own row; the label says
  "personal storage", "personal storage (uploading administrator)" for an application exercise, or
  "club storage of …"; `validateFile()` refuses locally, before any request, a type outside the
  slot's and the server's allowlist, a file over `maxVideoBytes` / `maxImageBytes`, a file larger
  than `availableBytes` or an account `overLimit`, and a start while `activeUploads >=
  maxParallelUploads`.
- **Drive, YouTube and direct links**: unchanged fields, unchanged save body, the FE-1 player.
- **The Builder**: Edit on a result or an added item opens this same editor; the custom-exercise
  modal keeps its links (Q7: no asset binding in BE-2).

## The two integration guards (owner's order; contract preamble)

Both are module-level defaults in `frontend/exercise-media-upload.js`, `false`, changed only by a
deliberate code change — never by a server answer. `GET /api/media/storage` = 200 is quota
availability, not proof of R2 credentials, CORS, binding or playback.

| Guard | Off (today, production) | On |
|---|---|---|
| `UPLOAD_TRANSPORT_ENABLED` | no media request at all from the editor; the two link fields exactly as before; a stored file shows Preview only; `startUpload()` refuses with `upload_transport_disabled` and sends nothing | the editor reads storage, offers Upload / Use a link and runs the transport above |
| `MEDIA_SAVE_ENABLED` (BE-3) | a completed upload is **never** presented as saved: "Uploaded and verified. Saving it with the exercise is not available yet."; Save is disabled and refused while such a file is in the editor; Replace / Remove of a stored file are not offered; the save body is byte-identical to today's | the Q5 selection travels in the save body (`media: { video: { source: "asset", mediaId } \| { source: "none" } \| { source: "legacy", url } }`, the legacy field of a selected slot omitted); a new exercise or a copy may upload (`exercise_create`) |

Production behaviour stays unchanged while both are off: with the flag off the server answers 503
`media_storage_disabled` anyway, and with the guard off the editor never asks.

**One rule holds whatever the guards say (review finding H1 of BE-2 #187 / BE-3 #189):** a slot
that holds the exercise's stored R2 file — untouched, or a Replace that failed or was cancelled —
sends **no** `videoUrl` / `imageUrl` in the save body (`applyMediaToSavePayload()`). BE-3 reads a
present legacy field, even an empty one, as a legacy selection that would switch the slot's source
and detach the stored file; "omitted slot: unchanged" (Q5) is the only safe shape. On a backend
without BE-3 no exercise has a stored file, so nothing changes there. The matching BE-3 hardening
(treat an implicit legacy equal to the stored URL, or empty while the source is `asset`, as
unchanged) is recommended in the review.

## Integration dependencies before each guard is flipped

Transport (`UPLOAD_TRANSPORT_ENABLED`), from `docs/backend/r2-be2-upload.md` "Configuration /
activation gate": BE-2 (PR #187) merged and deployed with its migration; R2 credentials and the
private bucket; CORS for the exact app origins with `PUT`, `Content-Type`, `If-None-Match`; the
signed `Content-Length` and the create-only `If-None-Match` proven on a controlled non-production
object from a real browser; the cleanup CLI scheduled; `MEDIA_STORAGE_ENABLED=true` on the services.
Without the cleanup job an abandoned upload keeps its reservation.

Save (`MEDIA_SAVE_ENABLED`): BE-3 — binding on `POST` / `PATCH /api/exercises` and `/copy` with the
Q5 `media` selection; `POST /api/media/access` for `{ type: "upload", id }` so a ready unsaved file
can be previewed from the server; the Builder custom-exercise route accepting the selection.

Still open after BE-2: reference-aware deletion of unused ready assets (a replaced or removed file
stays charged; the UI does not promise freed space). The thumbnail purposes `video_frame` /
`automatic_thumbnail` are PR 3 (next section).

## Thumbnails (PR 3)

Branch `feat/exercise-media-r2-thumbnails`, stacked on FE-2; frontend only. Owner decisions
(2026-10-19): browser-only, no transcoding; R2 only (a Drive / YouTube link has no frame the browser
may read); behind the existing guards.

- **A frame as the picture** (`frontend/exercise-media-thumbnail.js`): a detached `<video>` seeks to
  the moment and a `<canvas>` draws it, scaled to at most 1280 px wide, as a JPEG (quality 0.85)
  named `<video>-frame-<moment>s.jpg`; every step bounded (15 s); the refusals
  `frame_capture_unsupported`, `frame_source_unreadable`, `frame_source_unavailable`,
  `frame_source_cross_origin`, `frame_capture_timeout` and `frame_capture_failed`, one sentence each.
- **The picker** (in the image field: *Choose a frame of the video…*, *Replace with a frame…*,
  *Choose another frame…*): the video with its own controls opened a quarter in, a slider to a tenth
  before the end (the slider moves the video; no redraw), *Use this frame* takes the moment the coach
  left the video at and uploads it through the FE-2 transport as `kind: "image"`,
  `purpose: "video_frame"` with the top-level `sourceMediaId` (the ready R2 video) and
  `frameTimeSeconds` (contract Q1); the picture then says "Frame of the video at m:ss."; a failed
  capture keeps the picker with its sentence; Cancel closes it.
- **The automatic thumbnail**: after a video upload that left the picture empty (no file, no link), a
  frame a quarter into the video — the server's verified `durationSeconds` when the completion
  answer carries it, else the file's own metadata — uploads as `purpose: "automatic_thumbnail"`; the
  picture says "Thumbnail made from the video at m:ss, a quarter in." and may be replaced like any
  picture; a failed capture leaves one muted sentence and the picture empty, never a red error. An
  automatic thumbnail belongs to its video: it goes when the video is removed or replaced (a frame
  the coach chose stays).
- **Where**: only when uploads are offered (the transport guard, storage readable, an existing
  exercise or — with BE-3 — a new one or a copy) **and** `MEDIA_SAVE_ENABLED` is on (an upload nobody
  can save would only be charged), and never while something uploads. The uploaded video is read
  through its own object URL; the stored video (BE-3 only) through its signed playback address
  (`loadPlayback()`, FE-1) with `crossorigin="anonymous"` — **the bucket's CORS must allow GET from
  the app origin** for that, or the canvas is tainted and the sentence says so (an activation gate,
  not a code path that guesses).
- **The save body**: a frame is an uploaded picture like any other — `media.image = { source:
  "asset", mediaId }` with the legacy field omitted (Q5); nothing of the origin travels on the save
  (the server recorded it at the upload).
- **Unchanged**: the backend, the two guards' defaults, the link fields, the FE-1 player, the Builder.
- Tests: `frontend/tests/exercise-media-thumbnail.test.mjs` (the capture against a fake video and
  canvas, the moments, the sentences, the picker's markup, the transport's two extra facts) and
  `frontend/tests/exercise-editor-thumbnail.test.mjs` (the editor: nothing without BE-3 or over a
  link video, the automatic thumbnail, the failure sentence, the picker, the stored video, what goes
  with the video).

## Tests

`frontend/tests/exercise-media-upload.test.mjs` (the transport against a fake API and a fake
`XMLHttpRequest`, the storage read, the local checks, the sentences, the guards) and
`frontend/tests/exercise-editor-media.test.mjs` (the editor against a fake transport: production
unchanged, the faces, the BE-3 boundary, the cancel / retry / check flows, the guards, a new
exercise, a failed storage read).

## The eleven questions, as answered by `r2-upload-api-v1.md`

1. Initiation: `POST /api/media/uploads` + `Idempotency-Key`; single presigned `PUT`; 10-minute
   permission; the same key returns the same session; a changed payload is 409.
2. Bytes: single `PUT` of the raw File with the returned headers; 412 = exists; unknown outcomes
   go through the status; whole-file retry.
3. Completion: `POST …/complete` → 200 completed + `media` (`status: "ready"`) or 202 verifying,
   polled through `GET …/:id`; verification inside 30 s; H.264 / VP8 only, no transcoding.
4. Cancel: `DELETE …/:id`; renew `POST …/renew` within 20 minutes; expiry is not cleanup; the
   sweeper handles abandoned sessions; a ready unsaved file stays charged.
5. Save: the additive `media` selection (BE-3); never both formats for one slot; no invented
   `videoMediaId` fields.
6. New exercise / copy: `exercise_create`, no draft id; the copy uploads its own files.
7. Builder custom exercise: links for now; BE-3 snapshots the selection into both rows.
8. Quota owner: private → owner, new / copy → creator, club → club (edit rights only), application
   → the uploading administrator; the target-aware storage selector.
9. Replace: the old media stays until a successful BE-3 save; no delete endpoint; no promise of
   freed space.
10. Errors: the table of codes; polling with increasing delays; rate limits 20/min, 200/day.
11. Preview: local object URL while in the editor; `{ type: "upload", id }` access context in BE-3;
    FE-1 unchanged.
