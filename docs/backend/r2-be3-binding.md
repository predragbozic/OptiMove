# BE-3 — exercise media binding and private playback

Branch: `codex/r2-be3-binding`.
Integrated base: origin/main `57d97e2`, containing merged BE-2 #187,
FE-2 #186 (including its H1 save-payload fix) and Builder image fix #188.
PR #189 now targets main. BE-2 ancestry is shared with main; its commits and
migration are not repeated in the BE-3 diff. No merge of PR #189, deployment or
feature activation is authorized.

## Scope and storage

No new migration, packages, quota owner type, billing or transcoding. Existing
BE-1 selection columns on exercises/plan_items and BE-2 verified upload records
are used. BE-2's migration must have succeeded before enabling this code.
Same backend DB owner/SELECT/UPDATE privileges are needed; no new grants, views,
RLS policies, functions or exposed schemas. No production DB was inspected.

An exercise save validates `media` in the existing transaction, after the existing
edit/copy/block gates. A ready asset must have a completed upload by the actor,
the correct kind, storage owner and upload context. Private content stays charged
to its individual owner, club content to its existing club, system uploads to the
uploading administrator. No capability is inferred from role_hint.

`exercise_edit` binds only its original target. The first `exercise_create`
binding atomically writes `context.boundExerciseId` under the upload row lock;
only the new user-owned exercise/copy/custom creation can claim it. Repeated
binding to that target is allowed. Other targets need an authorized existing
Builder reuse/copy flow or their own upload. Copying a library exercise still
requires its own media, as before; source asset IDs cannot bypass that rule.

Replace/remove changes only the exercise selection. Existing legacy columns stay
stored when selecting asset/none, but are suppressed in active descriptors and
response URLs. Omitted slots stay unchanged. Legacy videoUrl/imageUrl inputs
remain supported; temporary R2 signatures are rejected as persistent inputs.
Inherited legacy fallback stops at an ancestor's explicit asset/none selection.

The Builder add path takes a shared exercise-row lock and snapshots into only
the inserted item. Custom creation binds its new library exercise and item in
one transaction; any denied attachment rolls both back. Node, session, legacy
session, batched program/session copy paths retain all four independent media
selection fields. They do not refresh old snapshots from exercise_id. Existing
reuse/revoke gates remain in place; no ownership/assignment rule was widened.
No objects are deleted or quota bytes released on replace/remove.

## Wire contract

Normative payloads: `r2-upload-api-v1.md`, Q5–Q11. Existing POST/PATCH/copy and
Builder custom-exercise routes accept:

```json
{"media":{"video":{"source":"asset","mediaId":"<ready UUID>"},"image":{"source":"none"}}}
```

Slots also support `{source:"legacy",url:"https://..."}`. Same-slot legacy and
media fields conflict (400 invalid_request). Unknown/foreign/wrong-context media
returns 404 resource_not_found; not-ready own upload 409 media_not_ready; wrong
kind 415 media_kind_mismatch. Existing route errors remain unchanged.

Exercise list/detail/save, Builder draft items, plan/athlete program/weekly rows
and R2 coverSlides carry `media:{video,image,accessContext}`. Each slot is asset
(`mediaId`, `kind`), legacy (`url`) or none. No R2 object key or signed URL appears
there. Legacy covers retain their existing shape; FE-1 already accepts that.
Descriptors are decorated with one bulk query per response, without altering
legacy database views or importers. Asset/none selections remain fail-closed even
when the feature is disabled; disabling must not revive stored old links.

POST `/api/media/access`:

```json
{"context":{"type":"exercise|plan_item|upload","id":"<UUID>"},"slots":["video","image"]}
```

Response has only selected asset slots:
`{video?:{source:"asset",mediaId,mimeType,url,expiresAt},image?:{...}}`.
Legacy/none slots are omitted; their existing UI already knows the legacy link.
Invalid body 400, unauthenticated 401, missing/foreign/revoked/not-ready 404,
disabled 503 media_storage_disabled, unavailable R2 config/provider 503.

POST `/api/media/access/batch` takes `{requests:[{context,slots}]}` (1–50).
Response `{results:[{index,media}|{index,error:{code,status,retryable}}]}`.
Every context is authorized separately; one denial does not disclose another
context or grant a URL. Responses are Cache-Control:no-store.

Exercise access uses existing Library read/block/copy ancestry gates and an
active exercise. Plan-item access uses its own retained reference and existing
plan access/athlete assignment/approval checks, without requiring new Library
access. Archived/inactive plans are denied; existing edit drafts remain usable.
Upload preview is restricted to its uploader and a completed ready object; after
binding (or for exercise_edit), current exercise read access is also required.
Asset IDs alone never grant access. Only ready assets of the selected kind sign.

## Playback and limits

Private presigned GetObject permissions last 600 seconds. Credentials remain on
the backend. URLs are bearer permissions: a previously issued URL can remain
usable until expiry after a revoke/replace; new issuance rechecks authorization.
Immediate revocation would require a proxy/Worker and is outside this contract.

GET signing leaves Range unsigned so HTML5 players may seek using independent
Range requests. Response MIME is verified MIME, disposition inline, caching
private/no-store. Browser tests against actual R2, 206/Content-Range, URL refresh,
codec behavior and iOS/Android have NOT been performed. No cloud configuration
was changed. Before activation, confirm exact-origin CORS supports GET/HEAD/PUT,
Range, Content-Type and If-None-Match; expose Content-Range, Accept-Ranges,
Content-Length and ETag as needed by the client. See Cloudflare's official
[presigned URL documentation](https://developers.cloudflare.com/r2/api/s3/presigned-urls/).

MEDIA_STORAGE_ENABLED defaults off. Startup still does not require R2 credentials.
No new environment settings. BE-2 cleanup scheduling, quotas, credentials,
create-only browser PUT and resource gates remain prerequisites. Ready unused
objects remain charged; reference-aware deletion/GC is still separate work.

## Validation and approval gates

Targeted local disposable PostgreSQL only: 15 BE-3 cases, 38 BE-1/BE-2 cases,
and 53 filtered existing regressions pass (106 total). BE-3
integration cases cover ownership/context/readiness/kind, atomic new-target
claim, new/private copies, replacement and retained program IDs, Builder custom
rollback, Library revoke versus assigned playback, inactive assets, upload preview,
batch/index limits, cover descriptors, node/tree/legacy/batch copying, saved plan
responses, flag-off legacy flow, and local GET signing. Existing Exercise/Builder
copy/revoke/snapshot/cover/custom tests are filtered by relevant names only.
No full suite, frontend changes, agents, actual R2 calls or production writes.

GO for reviewed merge with MEDIA_STORAGE_ENABLED remaining disabled, subject to
explicit owner approval. Dependencies #187/#186 are merged and the #188 conflict
is resolved. Activation is
NO-GO until the approved deployment/preflight and a controlled real R2/mobile
smoke check are completed. Roll back application code/disable the flag without
removing additive DB columns or stored objects; retained legacy URLs are recovery
material, never an automatic fallback after a private-media denial.

## H1 review correction (2026-10-19)

Ordinary metadata saves must not interpret retained URL echoes or empty media
inputs as removal of an existing R2 selection. Implicit legacy selection now
compares normalized input with the exercise row locked BEFORE metadata/URL updates.
Asset/none slots ignore unchanged or blank implicit URLs; both source and retained
URL are preserved. Explicit media selection remains authoritative; a different
nonempty legacy URL still switches only that slot. Genuine legacy slots retain
existing edit/clear behavior. Creation/copy remain separate from editing.

The locked pre-save snapshot is passed to the common binding function so the
route's preceding SQL update cannot hide a real change. Builder custom creation,
private-copy subsequent edits and Builder add/copy snapshots are covered.
H1 validation: BE-3 suite 21/21 passes (six new H1 regression cases); syntax and
whitespace checks pass. Prior BE-1/BE-2 and filtered regression results above were
not rerun for this narrow correction.

Historical pre-integration check: main conflict checked against origin/main f9509b0 (merged PR #188), using merge-tree
only: one content conflict in backend/src/routes/builder.js. BE-3's add-exercise
query with FOR SHARE overlaps main's effectiveExerciseMediaSql query from #188.
The other #188 edits in Builder copy paths/builderTreeBatch merge automatically.
A future conflict resolution must preserve BOTH #188's effective legacy image
snapshot/fill behavior and BE-3's row-lock/independent asset selection snapshots;
the selection-copy helper must not overwrite a resolved legacy image with a raw
null library image. No branch merge or #188 integration was performed here.
At that checkpoint PR #189 was draft and blocked by dependency #187 and the main
conflict; both are resolved by the integration below. BE-2 branch/PR #187 is unchanged. No migration, deployment or production
operation was performed.

## Final main integration

Main integrated at 57d97e2. The only textual conflict was the Builder exercise
query. Resolution uses effectiveExerciseMediaSql from #188 with FOR SHARE OF e
from BE-3. The shared row lock lasts through insertion/selection snapshot, while
legacy inherited images/videos are resolved exactly as #188 intended.

snapshotExerciseMedia preserves already resolved legacy URLs in the newly
inserted item (coalesce(item URL, raw exercise URL)); R2/none selectors and IDs
are copied independently. completeCopiedExerciseImages now restricts inference
to legacy/legacy items: an R2 or explicit none snapshot cannot be filled with a
legacy URL. All #188 copy completion calls and BE-3 four-column copy paths remain.
No repair CLI, production repair or migration was run.

FE-2 H1 compatibility was checked in applyMediaToSavePayload and its committed
payload assertions: stored/failed-replace slots omit legacy fields; uploaded,
removed and link-replaced slots emit the agreed explicit selection and remove
same-slot legacy fields. BE-3 also preserves assets if an older client echoes
unchanged/empty URL fields. Same-slot mixed-format 400 remains unchanged.
Frontend files are identical to origin/main; neither frontend integration guard
nor backend feature flag was enabled.

Current targeted local results: 24 BE-3 cases, 59 Builder exercise/access/copy/
revoke cases, and five #188 snapshot-image cases pass (88 total). This includes
H1, inherited legacy images, R2/none image-copy protection and mixed inherited-image
plus private-R2-video snapshots. No full suite, browser, cloud or repair checks.

GO for merge approval with the feature disabled after normal required GitHub
checks. Real private R2/browser/mobile seek/CORS/refresh validation and the BE-2
cleanup/resource prerequisites remain activation gates, not completed checks.
Signed URLs can remain usable up to ten minutes after revoke; ready unused media
still requires future reference-aware deletion. There is no new BE-3 migration,
environment setting, DB privilege or dependency change.
