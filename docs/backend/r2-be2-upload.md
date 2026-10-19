# BE-2: private R2 upload lifecycle

## Scope / compatibility

Backend only, based on fresh origin/main after BE-1 and FE-1. No frontend,
exercise save/copy, Builder authorization, legacy URLs, Training Load, billing,
playback/access routes or transcoding changes. BE-3 will connect ready media to
exercise/program descriptors and implement access/preview. BE-2 completion does
not attach anything to an exercise; existing programs retain their own media.

`MEDIA_STORAGE_ENABLED` is still opt-in (`true` exactly). Credentials are lazy:
app startup and disabled routes do not need them. No cloud settings or objects
were changed during implementation. Tests use disposable local PostgreSQL and
an in-memory R2 adapter, plus real local image/video inspection and presigning.

## API contract for frontend

All endpoints use the existing OptiMove session; responses `Cache-Control:no-store`.
IDs are UUID strings, sizes decimal byte strings, dates UTC ISO. Raw storage keys,
credentials and provider error payloads never appear in status/completion/errors.
Signed upload URL necessarily identifies its one object; it grants no read/list.

- `POST /api/media/uploads`, header `Idempotency-Key:<uuid>`:
  `{context:{type:"exercise_create"}|{type:"exercise_edit",exerciseId},
  kind:"video"|"image",purpose,file:{name,sizeBytes,mimeType}}`.
  Purpose: exercise_video, exercise_image, video_frame, automatic_thumbnail.
  Frame/thumbnail purposes also require `sourceMediaId` and nonnegative
  `frameTimeSeconds`; source must be a ready video in the resolved owner's quota.
  Repeating a terminal/verifying session returns its existing status/identity
  without another PUT permission. Response 201 for an active pending session: `{uploadId,mediaId,status:"pending",expiresAt,errorCode:null,
  upload:{method:"PUT",url,headers,expiresAt},reservation:{bytes,expiresAt}}`.
- PUT raw File/Blob to returned URL with every returned header. Do NOT use
  FormData or send the OptiMove Authorization header/cookie to R2.
  `Content-Type` and `If-None-Match:*` are returned; the browser automatically
  supplies exact Content-Length for the File/Blob. Content-Length is signed but
  MUST NOT be manually set by frontend JavaScript (it is a forbidden header).
  A different actual body length cannot use the signed permission. Existing
  object yields 412: query status/complete; do not overwrite it.
- `GET /api/media/uploads/:id` -> `{uploadId,mediaId,status,expiresAt,errorCode}`;
  completed uploads additionally include `media` (below). Uploader only.
- `POST /api/media/uploads/:id/renew`, `{}` -> same upload envelope, with refreshed
  permission. Only pending/unexpired uploads; renewal window ends 20 minutes
  after creation, so the last signed URL expires within about 30 minutes.
- `POST /api/media/uploads/:id/complete`, `{}` -> 200
  `{uploadId,mediaId,status:"completed",expiresAt,errorCode,media}`; a concurrent
  verifier returns 202 with `status:"verifying"`. Complete/status are idempotent.
  Verification may take up to 30 seconds; after a client timeout, poll status
  before retrying. Missing object is retryable 409 upload_not_present.
- `DELETE /api/media/uploads/:id` -> 200 status cancelled, or failed with the
  stored verification/expiry error. Cleanup/provider failure returns retryable
  503 while session remains cancelling and its reservation stays charged.
  Completed upload returns 409 upload_already_completed. Cancellation/status
  allow the uploader to clean up even if exercise edit access was revoked.

Ready media is `{source:"asset",mediaId,kind,status:"ready",mimeType,sizeBytes,
metadata}`. Video metadata: durationSeconds, width, height, videoCodec, audioCodec
(or null). Image metadata: width, height, origin (manual/frame/automatic), optional
sourceVideoMediaId/frameTimeSeconds. No playback URL is returned by BE-2.

Errors follow BE-1 `{error,code,retryable,details}`. 400 invalid_request;
401 authentication_required; 403 operation_not_allowed; 404 resource_not_found;
409 state_conflict/upload_expired/idempotency_conflict/upload_not_present;
413 file_too_large; 415 unsupported_media; 422 media_verification_failed;
429 storage_quota_exceeded/parallel_upload_limit/upload_rate_limit;
503 media_storage_disabled/media_storage_unavailable/media_inspection_busy.
Retryable provider/busy errors do not free uncleaned reservations.

## Authorization / ownership

Existing coachWorkspace capability is required before initiating or completing.
Existing exerciseLibraryScopeSql and hasExerciseAdministration govern edits,
including private-copy ancestry, block grants and platform workspace checks.
A role hint or merely switching workspace does not create edit rights.

Creation follows current POST /exercises: user-owned, charged to the uploader.
Editing private content charges its existing individual owner. Club-owned rows
charge the existing club, but only callers already permitted by current exercise
edit rules (currently exercise admins) can upload for them. This does NOT add
club/team exercise creation or broaden club role permissions. Platform system
exercise uploads charge the individual uploading admin until a platform-owned
quota model is explicitly agreed. Renew/complete recheck edit access and owner;
completion checks again after inspection. Every upload ID is uploader-scoped.

## Immutable storage and cleanup

Create-only presigned PUT binds Content-Length, Content-Type and If-None-Match.
This closes the replay-overwrite problem: once an object exists, neither an old
nor renewed browser permission can replace it. The pending key is logically
promoted by updating the asset's key/status inside quota settlement, rather than
copying a large object to a second key. This is an INTERNAL storage refinement;
mediaId and the agreed HTTP contracts do not change. No R2 copy/transcode occurs.

Cancel/expiry replaces the pending object with a permanent **zero-byte tombstone**.
It fences issued and already-started create-only PUTs. Only after HEAD confirms
the sentinel is quota released. Tombstones are deliberately retained; expiry of
an URL alone does not prove every in-flight write has finished. Never add an R2
lifecycle rule that deletes `pending/`: ready assets can use that prefix and
removing sentinels could permit a late write. Object/operation counts remain an
operational cost; per actor caps are 20 initiation/renew requests/minute and
200/day, transactionally enforced before further capabilities are issued.

A short account/upload transaction claims verification with a random token and
2-minute lease. No DB transaction spans R2 reads or inspection. Completion CAS
checks token/state; cancellation or crash-recovery invalidates it, preventing
late activation. Counters and terminal audit insert commit atomically. A failed
provider operation retains the slot/bytes for safe retry.

Run `npm --prefix backend run media:cleanup` in the configured server environment
(or node src/mediaUploadCleanupCli.js from backend). Default disabled flag makes
it a no-op without opening a database connection. An authorized operator must
schedule this bounded job periodically (e.g. every five minutes) before enabling
uploads. This PR does not create a Render cron/service or automatic startup job.
It processes up to 20 expired/cancelling sessions per run, including crashed
verifiers, and may safely overlap between both services. Failed cleanups retain
quota. Ready assets are never deleted by this job.

## Validation and resource bounds

- MP4: MPEG-4 container, H.264/AVC Baseline/Constrained Baseline/Main/High,
  8-bit 4:2:0, optional AAC-LC audio.
- WebM: VP8, optional Opus/Vorbis audio. HEVC/H.265, VP9, unsupported profiles,
  extra tracks, unknown metadata/containers are rejected; no transcoding.
- At most 4096 pixels per dimension, 16 megapixels, four hours, one video and
  at most one audio track. These are decoder support bounds, not billing plans.
- JPEG/PNG/WebP: actual format and full decode checked, single image (no animated
  multi-page files), 16 megapixels and at most 10 MiB inspected bytes.
- Video metadata is parsed using bounded Range/If-Match reads, max 8 MiB/128
  reads; unsupported/unprovable input fails closed. This inspects container and
  codec metadata, not a full decode of every video frame or malware scanning.
- Native/WASM parsing runs in a worker thread, 30-second wall bound and 64 MiB
  JS heap bound, one inspection per server process. Native/WASM allocations are
  also outside that JS heap bound; byte/pixel limits are additional safeguards.
- R2 operations have time-bounded requests. A transport failure is not treated
  as proof an object is absent or safe to release.

## Configuration / activation gate

Server-only secrets: R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY.
R2_BUCKET must be optimove-exercise-videos; S3 endpoint is derived from the account
ID with region auto. No custom URL/host is accepted from the client. Bucket must
remain private. Grant only bucket-scoped Object Read & Write (needed for signed
PUT, HEAD, range GET and tombstone PUT); no account administration/list grants
are required by application code. Do not put these in VITE_ variables or logs.

CORS: exact OptiMove origins, PUT, Content-Type and If-None-Match; later BE-3 adds
GET/Range and private image access. JS must upload raw Blob/File so the browser's
Content-Length matches the signature. Real R2/browser interoperability for
signed Content-Length and atomic If-None-Match MUST be checked on a controlled
non-production object before activation; local tests prove the generated
signature, not browser/R2 behavior. No live R2 upload was performed here.

New migration 202610191300_media_upload_lifecycle.sql adds verification token,
lease/error fields and append-only upload_events. Existing BE-1 migration is
untouched. Same runner/DB owner needs ALTER on media.uploads and CREATE in media;
new table revokes PUBLIC/Supabase API roles and enables RLS. Event audit trigger
uses the existing immutable-audit function. No business data backfill.

GO for code merge with flag disabled after review. NO-GO for activation until
credentials/private bucket/CORS, signed size and create-only semantics, cleanup
scheduling and resource limits on the Render plan are confirmed. No merge,
deploy, cloud configuration, production migration or R2 writes were performed.

## Tests

Set MEDIA_TEST_DATABASE_URL to LOCAL PostgreSQL and run from backend:
`node --test --test-concurrency=1 tests/media-storage-be1.test.mjs tests/media-upload-be2.test.mjs`

Both suites use random disposable databases; BE-2 migration runs as a non-superuser
owner. BE-2 covers HTTP/session ownership, block revocation, club accounting,
quotas, duplicate/concurrent completion, cancelled/verifier races, cleanup failure,
crash/expiry recovery, real PNG decode and actual generated WebM VP8 inspection,
codec rejection, exact signed headers, immutable audit and missing configuration.
R2 network operations are faked; no full suite or frontend tests are required.

Validation result: 35/35 targeted tests passed (14 BE-1 + 21 BE-2).
