# Drive media import into R2 — plan

Status: **approved by the owner on 2026-10-21**: a platform account of 15 GB; exercise images from R2 too, a slower
first load accepted. PR 1 (backend, migration `202610211000_media_drive_copies.sql`) is implemented on branch
`feature/drive-media-import`. It is not merged and not applied to any persistent database. PR 2 (the import screen)
has not started.

## Why

Most exercise media are Google Drive links: 1190 of 1249 exercises in the local OPTIMOVE database have a Drive
video, and 1226 have a Drive image. OptiMove shows a Drive video through Drive's `/preview` iframe
(`frontend/media-modal.js`). Two facts were established on 2026-10-21:

- **Drive's player plays a video only for a browser signed in to Google.** The owner saw this in Edge: no Drive video
  played until he signed in, then every video did.
- **On iPhone, Drive videos do not play at all,** even when signed in. Safari's cross-site tracking prevention keeps
  the Google session away from Drive's video host. Athletes on iPhone therefore cannot watch any exercise video.

A browser cannot fetch the file itself either. `drive.usercontent.google.com/download` answers `403` to a cross-site
`<video>` or CORS request and sends `Cross-Origin-Resource-Policy: same-site`. Only a non-browser client gets
`206` with byte ranges. So the fix is to hold a copy of every Drive file in OptiMove's own R2 storage and play it
with the existing R2 player, which needs no Google account.

## Owner decisions (2026-10-21)

1. Every Drive video and image that the exercises use is copied into R2.
2. The copies are converted to a reliable format and may be made smaller:
   - videos: H.264 High with AAC-LC MP4, long side at most 1280 px, at most 30 fps, faststart;
   - images: JPEG, or PNG for drawings.
3. Long videos (86 are longer than 30 s, the longest 154 s) are kept whole, never trimmed.
4. The copies are charged to a **system (platform) account, never to a coach's quota**.
5. When someone opens such an exercise, the R2 copy plays.
6. The 29 exercises whose video field holds a picture, and the 2 unavailable Drive files, are listed for the owner to
   fix by hand.

## Phase 1 — preparation (running on the owner's PC)

The script `drive-r2-prepare.mjs` (session scratchpad, not in the repository) does the following:

- reads every Drive file the exercises name, by ranged and full GETs. Nothing on Drive is changed;
- converts and checks each file with ffmpeg/ffprobe: codec, pixel format, duration and size;
- writes the copies to `D:\OptiMove-R2-uvoz\{videos,images}\<driveFileId>.<ext>`;
- writes `manifest.json`, keyed by **Drive file id**, with the bytes, sha256, MIME type, dimensions, duration and the
  exercises that use each file.

The list of exercises came from the local database (exercises created up to 2026-08-18). Production may hold newer
exercises; phase 2 reports any Drive id that production uses and the manifest lacks, so those files can be prepared the
same way.

## What the code has today (origin/main `8da6442`)

| Area | Fact | Source |
|---|---|---|
| Storage accounts | `media.storage_accounts` owners are exactly one of a user or a club | `migrations_v2/202610191100_media_storage_foundation.sql:20-30` |
| System exercises | a platform exercise's upload is charged to the uploading admin; there is no platform account | `backend/src/mediaUploads.js:29-48`; `docs/backend/r2-be2-upload.md:79-81` |
| Video length | 30 s is a hard product maximum; an env var can only lower it | `backend/src/mediaInspection.js:13-16` |
| Format | MP4 must be AVC Baseline, Main or High, 8-bit 4:2:0, with AAC-LC; images must be JPEG, PNG or WebP, ≤ 16 MP and ≤ 10 MiB | `mediaInspection.js:23-44`, `mediaInspectionWorker.js:16-23` |
| Binding | `video_source` / `image_source` in `('legacy','asset','none')` with `*_asset_id`, on both `library.exercises` and `plans.plan_items` | foundation migration:113-132 |
| Plan items | each item keeps a snapshot of the media it was added with. Playback signs only when the item's own source is `asset` | `backend/src/exerciseMedia.js:106-109, 120-146` |
| Private copies | a copy with no URL inherits an ancestor's **legacy** URL; the inheritance stops at an ancestor whose source is `asset` | `backend/src/exercisePersonalization.js:44-45` |
| Cleanup | the hourly cron only touches unfinished `media.uploads` rows and never deletes ready assets | `backend/src/mediaUploads.js:170-190` |

**How much the import touches.** In the local database, 11,078 plan items hold a Drive video link (513 exercises)
and 11,706 hold a Drive image link. Production holds at least as many.

## The approach: map Drive ids to R2 copies, rewrite no rows

Flipping each exercise to `video_source='asset'` would have two consequences:

- it would orphan every plan item, because items keep their legacy snapshot;
- it would break every private copy that inherits the legacy URL.

Rewriting more than 20,000 plan and copy rows would be a large production data rewrite.

Instead:

- **A mapping table** `media.drive_copies (drive_file_id, kind, asset_id, created_by_user_id, created_at)`, unique
  per `(drive_file_id, kind)`.
- **Reads:** wherever a row's slot is `legacy` and its URL (own, inherited or snapshot) names a Drive file that has a
  mapping, the API describes the slot as `{ source: 'asset', mediaId, kind }`. This applies to exercises, plan items,
  private copies and block covers.
- **Playback access:** the media access service signs the mapped asset in that case too, under the same
  authorization of the row's context (exercise or plan_item) as today. Nothing new is exposed: the Drive files were
  public links already.
- **No exercise, copy or plan-item row is changed.** The Drive link stays in place as the record and the fallback.
- **Rollback:** deleting a mapping row makes that file play from Drive again, immediately. Deleting all of them
  reverses the whole import. The copies stay in R2, charged to the platform account, until a later cleanup.

## Phase 2 — code, in two PRs

### PR 1: backend (migration, import routes, mapping-aware reads)

**Migration** `202610211000_media_drive_copies.sql` (db-reviewer):

- **Platform owner.** `media.storage_accounts` gains a platform owner: a nullable `owner_platform boolean`, which may
  be only true or null. The check becomes exactly one of user, club or platform, and a unique partial index allows
  only one platform account.
- **Import purposes.**
  - `media.uploads` accepts the purposes `drive_import_video` / `drive_import_image`, and only with a `drive_import`
    context (a check; the service refuses the pair too).
  - A unique partial index allows one import of a Drive file in flight.
- **Copies and their events.**
  - `media.drive_copies` as above. A copy row is added or removed, never updated (trigger).
  - Each addition and removal is recorded in the append-only `media.drive_copy_events`. A removal always carries a
    reason (check).
- **Rollback.** The script is `docs/runbooks/media-drive-copies-rollback.sql`, rehearsed on a disposable database.
  It works only before the platform account exists and before anything was imported. After that, undo an import by
  removing its copies and keep the additive schema.

**Platform-admin routes** `/api/admin/media/drive-import` (security-reviewer):

| Route | What it does |
|---|---|
| `GET /status` | every Drive id that production rows use (video and image), and whether each has a copy. This finds files the manifest lacks |
| `POST /uploads` `{ driveFileId, kind, bytes, mimeType }` | refused unless production really uses that Drive id; reserves on the platform account under the import's own limits (video ≤ 200 MiB and **≤ 180 s**; image ≤ 10 MiB); returns a presigned PUT, the same as the normal upload |
| `POST /uploads/:id/complete` | HEAD plus the existing inspection with the import's duration limit → asset `ready` → the mapping row, in one transaction, idempotent per Drive id |
| `DELETE /copies/:kind/:driveFileId` | rollback of one mapping, with a reason, audited |
| `DELETE /uploads/:id` | cancel an import in flight (its reservation is freed) |

- **Completion:**
  - The copy row commits with its asset or not at all.
  - A copy of the same file that landed first ends the import at once (`409 already_copied`, nothing charged, its
    parallel-upload slot freed).
  - The COMMIT's answer is awaited at most 15 s. A lost answer is resolved on another connection under the upload's
    own row lock:
    - written → `200` with `verifiedAfterCommitError`;
    - not written → a retryable `503`, and the upload can be completed again;
    - unreadable → `503 import_outcome_unknown`.
  - Never a guess.
- **Reads and access:** `describeMedia` / `decorateMediaRows` and the access service resolve mapped legacy slots
  (above). An exercise save that echoes the blank link of a copied slot leaves the stored Drive link as it is, as for
  an asset. A new link still replaces it.
- **Tests** on disposable databases, covering:
  - access per context (athlete via `plan_item`, coach via exercise, another club, a revoked role);
  - the 404 info-hiding rule;
  - idempotent repeats;
  - the 180 s limit;
  - an unreferenced Drive id refused;
  - rollback.

### PR 2: the import screen (frontend; code-reviewer, mobile-qa)

The screen lives in Settings → Storage and only a platform admin sees it.

- The admin chooses the folder `D:\OptiMove-R2-uvoz`. The browser reads `manifest.json` and the files.
- The screen shows the counts, Start and Pause, two uploads at a time, and progress. It is resumable: `/status` tells
  which files are done.
- It ends with a report: done, failed with the reason, Drive ids production uses that the manifest lacks, and the
  29 + 2 manual cases.
- The owner's own sign-in does the work; no credential passes through anyone else.

## Phase 3 — production (only on the owner's explicit order)

1. **Migration and deploy:** the migration is applied by the deploy, after the owner's order.
2. **Set the quota:** set the platform account's limit, for example 15 GB, through the existing storage-account
   admin route (extended to the platform owner).
3. **Pilot:** import 5 files, including the adductor clip. Check them on iPhone in OptiMove, both in an athlete's
   plan and in the library.
4. **Full import:** import the rest from the screen.
5. **Newer files:** prepare the files production uses that the manifest lacks (from `/status`) with phase 1, then
   import them.

Expected size: about 7.5 GB of video and under 1 GB of images. R2 storage costs well under 1 USD a month, and R2
charges nothing for downloads.

## What a copy means (security notes)

- **A copy is played by its Drive file id.** Any row the caller may already read whose legacy link names that id
  plays the copy. A coach who pastes a Drive link into their own exercise gets the copy of that file. This is the same
  reach as the public Drive link itself (the ids are not guessable). The row authorization decides before any copy is
  signed.
- **Revoking a copy.** Remove its copy: `DELETE /copies/:kind/:driveFileId`, with a reason. The Drive link plays
  again. Un-sharing or deleting the file on Drive does not stop the R2 copy.
- **The removed object stays in R2,** charged to the platform account, until a later cleanup (separate work). That
  cleanup must delete the mapping row before it touches the asset.
- **No Drive fallback on an R2 failure.** A copied slot no longer offers its Drive link in the API, so if R2 signing
  fails the player shows its error.

## Known limits of PR 1

- **Block cover slides** (`exerciseCollections.js`) build their own descriptor and still show Drive thumbnails.
- **"Replace with a frame" from a copied video** is refused (404): a frame source must be in the uploader's own
  storage account, and a copy is in the platform account.

## Safety gates

- **External review is required before merge.** This change touches a migration and a persistent database write
  (trigger 1) and access authorization (trigger 2). The owner reviews the package; neither PR is merged before that.
- **No production write except through the deployed routes,** after the owner's order. No direct SQL.
- **No coach quota changes.** The cleanup cron must not touch import uploads: they complete or are cancelled like
  normal uploads.

## Open points for the owner

1. **Limit of the platform account.** Suggested: 15 GB.
2. **Library thumbnails.** The library currently loads Drive thumbnails directly with no API call. With the mapping
   they come through the R2 batch access route (up to 50 per request). This is slower on the first load of a large
   library page, and is the price of not depending on Google. Agree?
3. **Later, optional:** once everything plays from R2, flip the exercises themselves to `asset` and drop the Drive
   fallback. That is a separate, later decision.
