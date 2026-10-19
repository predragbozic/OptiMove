# Builder / plan exercise images

This PR changes thumbnail rendering and future snapshots. It does not run a
production data repair, add an automatic migration, change videos, or update
existing non-NULL images. Deploying the code does not run the repair CLI.

## Runtime behavior

Library, Builder results, added cards, section previews, sticky thumbnails and
plan cards share `renderExerciseThumb`: image, public Drive/YouTube video cover,
then initials. FE-1 descriptors and the row's access context stay authoritative;
asset URLs are still obtained by the existing resolver. A direct video without
a public cover stays playable and shows initials. No extra Library lookup is
introduced when an athlete reads a plan.

New Builder additions use the same effective-media ancestry join and read scope
as the Library, inside the existing reuse transaction. A copy may fill a NULL
image only if the target plan creator can currently read the exercise and its
media ancestry, and the snapshot video equals the effective exercise video.
Non-NULL values (including an explicit empty string), different snapshot videos,
notes, instructions, doses and source rows are preserved. This applies to
structured, legacy, batched session/day/program and recursive node copies.

Image completion uses a nonwaiting shared reuse lock and READ COMMITTED. If an
exclusive revoke is already queued or the isolation is unsuitable, completion
leaves the NULL unchanged; existing copy/reuse authorization still decides
whether the copy itself is allowed. This avoids an inner copy transaction
waiting behind a revoke while an outer batch guard holds the shared lock.
Existing authorized snapshots remain available after revoke, as before.

## Separate production approval

The earlier read-only observation was 167 missing snapshots across 16 exercises;
1215 had 10 missing images among 37 items. These are observations, not an apply
allowlist or an expected repair count. Current authorization and video matching
may reduce the eligible count. Do not silently widen the selection to reach 167.

The operator must review the specific item IDs and their provenance. NULL alone
cannot prove that an old omission was accidental. Exclude intentional removals
or uncertain cases. The application has no plan-image edit field, but historical
imports/manual changes still require this review.

1. Run a read-only inventory and obtain an explicitly approved item-ID list.
   The following is an inventory, not permission to change every returned row:

   ```sql
   begin read only;
   select e.exercise_code, e.name, count(*) as missing_items
   from plans.plan_items item join library.exercises e on e.id=item.exercise_id
   where item.item_type='exercise' and item.image_url is null
     and nullif(btrim(e.image_url),'') is not null
   group by e.id order by e.exercise_code;
   select item.id, item.exercise_id, e.exercise_code, item.title, item.video_url,
          item.updated_at, plan.id as plan_id, plan.source_type
   from plans.plan_items item join library.exercises e on e.id=item.exercise_id
   join plans.plan_sessions session on session.id=item.plan_session_id
   join plans.plan_days day on day.id=session.plan_day_id
   join plans.plans plan on plan.id=day.plan_id
   where item.item_type='exercise' and item.image_url is null
     and nullif(btrim(e.image_url),'') is not null
   order by e.exercise_code,item.id;
   rollback;
   ```

2. Save only the reviewed UUIDs in `item-ids.json` (a JSON array). Each run is
   limited to 200 distinct IDs. Set `DATABASE_URL` explicitly using the approved
   operator environment; the CLI never loads `.env` or chooses a database.

   From `backend/`:

   ```text
   node scripts/repair-snapshot-images.mjs dry-run item-ids.json preview.json
   ```

   This transaction is read-only. Review `changedCount`, `skippedCount` and each
   proposed image in `preview.json`. The manifest binds the connected database
   identity, exact IDs, whole-row before hashes and selected URLs. It contains
   media URLs: keep it and the journal in restricted operator storage, outside
   Git. Dry-run writes only the local report, never database rows.

3. Ask the owner to approve this exact preview and eligible count N. Only after
   that separate approval:

   ```text
   node scripts/repair-snapshot-images.mjs apply preview.json journal.json N
   ```

   N must equal the manifest's entry count, not the original inventory count.
   Apply rechecks authorization and URLs under the reuse lock, locks only listed
   item rows and checks their entire before hash. Any stale row, revoked access,
   wrong database/count or changed URL aborts the entire transaction. It changes
   only `image_url` on NULL rows. Repeating the same manifest is a no-op when the
   rows otherwise still match. An already existing report file is never replaced.

4. The journal is flushed to local disk before COMMIT and includes before/after
   hashes. If COMMIT or the process result is uncertain, keep that journal and
   verify/replay the same approved preview with a new output filename; do not
   generate a broader repair. A journal alone does not prove COMMIT succeeded.

5. Verify the approved IDs, count and unchanged video/prescription fields with
   read-only queries. To reverse a committed repair after separate approval:

   ```text
   node scripts/repair-snapshot-images.mjs rollback journal.json rollback.json N
   ```

   Rollback restores NULL only when the whole row still equals the journal's
   after hash and the image still equals the applied URL. It never removes a
   subsequently edited image or overwrites another user edit. Any conflict
   aborts all rollback writes and requires item-specific review. Replaying an
   already completed rollback is a no-op. No video or timestamp is explicitly
   updated in either direction.

No production apply or rollback was executed while preparing this PR.
