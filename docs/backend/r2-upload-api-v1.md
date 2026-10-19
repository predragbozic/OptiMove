# OptiMove Exercise Media Upload API — v1.0.0

Status: normative FE-2 / BE-2 contract, 2026-10-19.
Backend branch: `codex/r2-be2-upload` (PR #187).
Frontend questions: `docs/ai/exercise-media-r2-fe2-upload-contract.md` on
`feat/exercise-media-r2-fe2` (PR #186), questions 1–11 answered below.

This document defines the agreed interface, not a claim that every phase is
implemented. Availability is explicit:

| Area | Phase / availability |
|---|---|
| Upload initiation/status/renew/complete/cancel, quota settlement | Implemented in BE-2 |
| Target-aware storage usage, verification-expiry race fix | BE-2 follow-up implementing this contract |
| Attach/replace/remove on exercise/copy/Builder save, read descriptors | Reserved contract for BE-3, NOT implemented by BE-2 |
| `/api/media/access` and `/access/batch` | FE-1 contract; backend BE-3, NOT implemented by BE-2 |
| Deleting unused ready assets / reference-aware GC | Separate lifecycle work; NOT an upload cancellation |

Do not enable end-user R2 save/replace merely because upload endpoints exist.
Keep transport/save integration gated until the required binding/access routes
are deployed. GET storage 200 is quota availability, not proof of R2 credentials,
binding support, CORS, or playback readiness. Default feature flag remains off.

## Common conventions

All JSON calls use the existing OptiMove session and api() helper. Media routes
require authentication; write/reuse rights remain the existing exercise/Builder
rules. User IDs, roles and billing owner are never accepted from the client.

UUIDs are strings. Bytes are nonnegative decimal strings. Timestamps are UTC ISO
strings. Responses use Cache-Control:no-store. Browser holds signed URLs only in
memory; database/save payloads contain permanent mediaId, never signed URLs.

Error envelope: `{error:string, code:string, retryable:boolean, details:object}`.
Use `code` for behavior; use local translated text for display. Provider errors,
secrets and R2 keys are not status/completion fields.

Upload context and access context are DIFFERENT wire formats:

- existing exercise upload: `{type:"exercise_edit",exerciseId:"<uuid>"}`;
- new private exercise/copy upload: `{type:"exercise_create"}`;
- FE-1 access: `{type:"exercise",id:"<uuid>"}` or
  `{type:"plan_item",id:"<uuid>"}`; ready unsaved upload preview will use
  `{type:"upload",id:"<uploadId>"}` in BE-3.

Never send FE-1 `{type:"exercise",id}` directly to the upload endpoint. The
FE-2 adapter translates it into the appropriate upload context.

## Q1 — Initiation, reservation and request/response

POST `/api/media/uploads`
Header: `Idempotency-Key: <new UUID for this file/upload attempt>`.

```json
{
  "context": {"type":"exercise_edit","exerciseId":"<uuid>"},
  "kind": "video",
  "purpose": "exercise_video",
  "file": {"name":"squat.mp4","mimeType":"video/mp4","sizeBytes":"52428800"}
}
```

Image: `kind:"image",purpose:"exercise_image"`. Captured frame:
`purpose:"video_frame"`; automatic thumbnail: `purpose:"automatic_thumbnail"`.
The latter two also require top-level `sourceMediaId` (ready R2 video belonging
to the resolved storage owner) and finite nonnegative `frameTimeSeconds`.

201 response while pending:

```json
{
  "uploadId":"<uuid>", "mediaId":"<uuid>", "status":"pending",
  "expiresAt":"<ISO>", "errorCode":null,
  "upload": {
    "method":"PUT", "url":"<presigned R2 URL>",
    "headers":{"Content-Type":"video/mp4","If-None-Match":"*"},
    "expiresAt":"<ISO>"
  },
  "reservation":{"bytes":"52428800","expiresAt":"<ISO>"}
}
```

Server validates current edit rights, resolves owner, enforces policy, and
atomically reserves exact declared bytes plus one active slot. Video and image
are separate upload sessions/reservations. Thumbnails are charged too.

Network retry uses the SAME idempotency key and identical payload. It returns
the same uploadId/mediaId without double reservation. Changed file/context with
the same key returns 409 idempotency_conflict. A terminal/verifying session
returns its existing status/identity without a PUT permission; a completed one
also returns `media`. Do not assume every successful initiation has `upload.url`.

## Q2 — Sending bytes, progress and retries

Single PUT, not multipart. Use XMLHttpRequest with raw File/Blob, and exactly
the returned method/headers. No FormData, cookies or OptiMove Authorization
header to R2. XHR progress describes bytes transferred, NOT server verification.

Content-Length is signed to the exact size. Browser supplies it automatically
for File/Blob; JavaScript MUST NOT manually set this forbidden header.
Content-Type and If-None-Match:* are mandatory returned headers. Do not add an
ETag, client object key or metadata header. The backend never trusts client ETag.

CORS must allow exact app origins, PUT, Content-Type and If-None-Match. Exposing
ETag is optional for diagnostics, not required by this single-PUT protocol.
No browser/R2 interoperability check or configuration change is implied by this
document; signed size and create-only behavior remain an activation gate.

- HTTP 2xx: call completion, not exercise save yet.
- HTTP 412: object already exists; query status/complete, do not overwrite.
- HTTP 403 / network or CORS failure: outcome can be unknown. Query OptiMove
  status first. Do not declare that zero bytes were uploaded.
- Interrupted request: retry the whole same File/Blob, not byte-range resume.
  If object already committed, the create-only retry returns 412; complete it.
- A terminal failed/cancelled attempt needs a new idempotency key/session.

## Q3 — Completion and verification

POST `/api/media/uploads/:uploadId/complete`, body `{}`.
The uploader owns the session; edit rights/owner are checked again. The backend
HEADs its own key, checks exact actual size and MIME, and parses actual content.
It does not trust PUT response headers, extension, browser metadata or ETag.

200 response:

```json
{
  "uploadId":"<uuid>","mediaId":"<uuid>","status":"completed",
  "expiresAt":"<ISO>","errorCode":null,
  "media": {
    "source":"asset","mediaId":"<uuid>","kind":"video","status":"ready",
    "mimeType":"video/mp4","sizeBytes":"52428800",
    "metadata":{"durationSeconds":42.8,"width":1920,"height":1080,
                "videoCodec":"h264","audioCodec":"aac"}
  }
}
```

Image metadata: width, height, origin (manual/frame/automatic), optional
sourceVideoMediaId and frameTimeSeconds. Optional audioCodec is null if absent.

First completion normally waits for verification. Concurrent completion returns
202 with `{uploadId,mediaId,status:"verifying",expiresAt,errorCode}`. Poll GET
`/api/media/uploads/:uploadId`; it returns the same status envelope, plus `media`
when completed. Do not save while pending/verifying. A timeout is unknown state:
poll before retrying. Allow a longer completion request bound than playback;
inspection alone has a 30-second bound, with network/DB overhead in addition.

Status "completed" is the upload session; media.status "ready" is the stored
asset. These are intentionally distinct. All completion retries settle quota
and terminal audit once. Active verification is not cancelled merely because
the original PUT permission expires while verification is already running.

Formats: MP4/H.264 Baseline/Constrained Baseline/Main/High, 8-bit 4:2:0,
optional AAC-LC; WebM/VP8, optional Opus/Vorbis; JPEG/PNG/WebP single image.
HEVC, VP9, unsupported tracks/profiles and unverifiable input are rejected.
There is no transcoding. Video inspection is bounded metadata/container parsing,
not full frame-by-frame decode. Detailed resource bounds: r2-be2-upload.md.

## Q4 — Cancel, expiry, cleanup and quota

DELETE `/api/media/uploads/:uploadId`, no body. Stop XHR locally AND call this
route; AbortController/XHR.abort alone cannot release server quota.

200 response: `{uploadId,mediaId,status:"cancelled",expiresAt,errorCode:null}`.
A previously failed/expired session can instead return status failed with its
stored errorCode. Repeat cancellation is idempotent. Provider cleanup failure
returns 503; GET status can show cancelling. Keep quota reserved until backend
confirms terminal cancellation/failure. Uploader may cancel after losing edit
rights; completed sessions return 409 upload_already_completed and are not deleted.

Initial reservation/PUT permission lasts 10 minutes. Before expiry, renew with
POST `/api/media/uploads/:uploadId/renew`, body `{}`. It returns the upload
permission envelope with the same identity/reservation. Renewal is allowed only
while pending/unexpired and during the first 20 minutes; last expiry is therefore
about 30 minutes after creation. Renew extends session expiry; it does not revoke
older permissions or require aborting a PUT already in flight.

Expiry is NOT proof of cleanup. The bounded cleanup job handles abandoned,
expired and crashed-verifier sessions. No countdown in FE may credit space.
GET status does not itself perform cleanup. Before dropping reservation the
backend writes/confirms a retained zero-byte tombstone; create-only late PUTs
cannot resurrect unaccounted bytes. Failed cleanup retains slot and reserved
bytes. The operator must schedule the cleanup CLI; this document creates no job.

After lost initiation response, retry identical initiation with the same key to
recover uploadId. After closed tab/reload without that key, the sweeper recovers
the reservation. A ready/completed but unsaved file remains charged; it is NOT
an abandoned pending upload. Reference-aware deletion of unused ready assets is
not implemented by BE-2. Do not promise immediate quota recovery for that case.

## Q5 — Exercise save, attach and remove (BE-3 contract, NOT BE-2 availability)

Existing routes: POST `/api/exercises`, PATCH `/api/exercises/:exerciseId`,
POST `/api/exercises/:exerciseId/copy`. Additive `media` save payload:

```json
{
  "media": {
    "video":{"source":"asset","mediaId":"<ready UUID>"},
    "image":{"source":"none"}
  }
}
```

Each slot is one of:
- `{source:"asset",mediaId}`: attach authorized ready asset of matching kind;
- `{source:"legacy",url}`: activate an explicitly chosen legacy link;
- `{source:"none"}`: remove active selection, WITHOUT deleting its object;
- omitted slot: unchanged. Omit the entire media object for no media change.

Do not invent videoMediaId/removeVideoMedia/imageMediaId fields. Retain current
legacy videoUrl/imageUrl behavior. Never send both formats for the SAME slot;
for asset/none selection omit that slot's legacy field from the save body.
Unchanged legacy slots may keep their existing fields. Old URLs are retained
for compatibility, but source none/asset must not fall back to those old values.

BE-3 must atomically validate owner, readiness, context and target edit/copy rights
with saving the exercise. Unknown/foreign or wrong-context asset -> 404
resource_not_found; owned but not ready -> 409 media_not_ready; wrong kind ->
415 media_kind_mismatch; conflicting payload -> 400 invalid_request.

Ready upload from exercise_edit is bindable only to that exercise, same current
owner and authorized uploader. exercise_create is bindable to a new user-owned
exercise/copy created by that uploader; its first successful binding fixes its
creation target (retries to that same target stay valid). Further reuse is only
through existing permitted backend copy/add flows, never arbitrary client IDs.
The binding transaction must serialize against other binding attempts and preserve
existing private-copy restrictions. No client can reassign the asset's quota owner.

IMPORTANT: today's BE-2 does not process media save fields. Do NOT enable an FE
save path assuming a 2xx legacy save means an asset was attached. This is a
required BE-3 integration boundary, not an optional safety check in the browser.

## Q6 — New exercise and copy

Supported upload context is option (c): exercise_create. No exercise ID/draft
row is needed for uploading into the current user's private quota. A copy also
uses exercise_create and must upload its own selected files; do not attach the
original application's asset IDs or obtain a signing grant through the original
exercise_edit context unless actually editing that original.

After BE-3 binding support, POST new exercise/copy with the media payload in Q5.
Before then, FE may keep "save first" and transport disabled; neither a created
exercise nor a successful upload alone implies full R2 save/playback availability.
Existing copy/block/revoke rights still decide whether the copy may be saved.

## Q7 — Builder custom exercise

Current Builder custom-exercise route creates a user-owned library exercise and
its plan item. Upload context can be exercise_create for that user's own file.
However, the existing custom-exercise POST has no asset-binding support in BE-2.
Keep its legacy link inputs unchanged for this phase. Its BE-3 integration must
accept the same media selection object and snapshot the selected references into
BOTH the new library exercise and plan item, in a transaction, after current
Builder checks. Do not update existing plan items by exercise_id afterward.

## Q8 — Quota owner and usage row

- Private exercise: existing individual content owner, not the viewer/athlete.
- New exercise/private copy/Builder custom: creating individual user.
- Club exercise: existing club; only actors already allowed to edit may upload.
  BE-2 does not create club/team exercise edit grants.
- Application/system exercise: individual uploading platform administrator's
  quota in this version; no shared platform account is implied. UI label:
  "Personal storage (uploading administrator)".

GET `/api/media/storage` keeps the BE-1 `{accounts:[...]}` shape. For new/copy
select the row with owner.type=user and owner.id=current authenticated user ID.

For an existing exercise, use the additive BE-2 selector:
GET `/api/media/storage?exerciseId=<uuid>` ->
`{accounts:[<resolved-owner usage row>],selectedStorageAccountId:"<uuid>"}`.
It uses the SAME ownership/edit resolver as initiation, not a client owner ID.
This avoids showing an admin's own limit while charging another private owner
or club. No query preserves the old BE-1 behavior. Availability is in the table
above; until available, don't guess from the active workspace or first row.

Usage fields remain BE-1: storageAccountId, owner:{type,id}, usedBytes,
reservedBytes, limitBytes, availableBytes, limitSource, overLimit, activeUploads,
maxParallelUploads, maxVideoBytes, maxImageBytes, allowedMimeTypes,
overrideLimitBytes and revision. Re-read after initiation/completion/cancellation;
only backend values are authoritative. Counter changes can lag a failed cleanup.

## Q9 — Replace and physical deletion

Selecting/uploading a replacement DOES NOT change the existing exercise or plan
item. Keep old media active until a successful BE-3 save atomically changes that
exercise slot. Closing/cancelling Replace before save leaves old selection intact.

An active new upload can be cancelled through Q4. A completed new file cannot be
cancelled/deleted with the upload endpoint; it remains an unused ready asset and
charged until explicit reference-aware deletion/GC exists. FE must not call a
nonexistent delete endpoint or claim its storage was freed.

The old object stays charged to its original owner while any preserved reference
requires it. Programs keep their independent media IDs, including overrides.
Physical deletion is a backend lifecycle operation only after checking all
required references. It is never inferred from replacing/removing one exercise.

## Q10 — Errors and recovery

| HTTP | code | FE action |
|---|---|---|
| 400 | invalid_request | Fix payload/key; don't repeat unchanged |
| 401 | authentication_required | Reauthenticate; keep local file if possible |
| 403 | operation_not_allowed | Stop new capabilities; do not bypass with another context |
| 404 | resource_not_found | Missing/foreign/revoked context or upload; no ownership details disclosed |
| 409 | idempotency_conflict | Different attempt needs new key |
| 409 | upload_expired | No renewed permission; query/cancel old session and start new attempt |
| 409 | upload_not_present | PUT outcome unknown/not committed; retry whole PUT or completion as appropriate |
| 409 | state_conflict | Re-read status before changing the session |
| 409 | upload_already_completed | Do not cancel; use ready media/status |
| 413 | file_too_large | Choose smaller file |
| 415 | unsupported_media | Unsupported MIME/container/codec; choose supported file |
| 422 | media_verification_failed | Invalid actual bytes/size/type/inspection; no attachment |
| 429 | storage_quota_exceeded / parallel_upload_limit | Refresh usage; wait/change file/ask admin |
| 429 | upload_rate_limit | Back off; caps currently 20 initiation/renew requests/min and 200/day per uploader |
| 503 | media_storage_disabled | Keep current legacy UI; don't start transport |
| 503 | media_storage_unavailable | Missing config/provider unavailable; retryable, no claim space was freed |
| 503 | media_storage_busy / media_inspection_busy | Back off, query status and retry |

Always inspect retryable/status; no tight polling/retry loop. Poll verifying or
cancelling with a short increasing delay (e.g. 1,2,4 seconds), stop on terminal
state, authentication failure or editor close. The cleanup worker recovers
expired verification claims after its 2-minute lease, not through browser clocks.
Raw R2 HTTP 403/412 have no OptiMove error JSON; translate as described in Q2.

## Q11 — Preview and FE-1 access compatibility

Use the local object URL for a newly selected/uploading/just-completed file while
it remains in editor state. Revoke the local URL when replaced/closed and no
longer used. Do not store it or the signed PUT URL as exercise media.

Only ready assets can receive future BE-3 playback/image GET permissions.
Pending/verifying/failed media never receive playback URLs. A ready unsaved
upload uses access context `{type:"upload",id:uploadId}`, owner-scoped; attaching
it later uses the exercise/plan-item context, not the same cache entry.

FE-1 remains unchanged:
POST `/api/media/access` `{context:{type,id},slots:["video"|"image"]}` ->
`{video?:{source,mediaId,url,expiresAt,mimeType},image?:{...}}`;
batch uses `{requests:[{context,slots}]}` -> `{results:[{index,media}|{index,error}]}`,
maximum 50 requests. URLs live only in memory, cache is session/context/slot scoped.
No public thumbnails or fallback to a private legacy URL after denial.

Exercise list/detail, plan-item and coverSlides descriptors share
`media:{video,image,accessContext}`. A plan item's context authorizes against its
program/assignment and retained reference, not newly granted access to the source
exercise. Upload/edit denial does not revoke an existing assigned program's
independent media right. No BE-2 endpoint changes those Builder semantics.
