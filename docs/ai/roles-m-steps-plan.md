# M steps for module write permissions

## Order and boundaries

The V package is complete (#778). The R4 contract, decision O7, puts Calendar and Training Load first and Imports last. Start with one Calendar-only RISKY PR. Follow with Training Load slices, then the remaining O7 modules. Plan limits follow M.

Every staff write retains the module VIEW check and the current workspace and resource relationship checks. Each M slice adds its write permission and the licence ceiling at the actual operation. A club_view or team_view workspace stays read-only. Existing view-only custom-role accounts do not acquire a writable workspace through a MANAGE word. A different workspace entitlement would need its own contract.

## M package as built

Status snapshot at `66e4d67f` (#816). The release and bridge columns use first-parent merge
commits. “Editable” means the word is exposed in Settings → Roles at this snapshot.

| Slice | Bridge / migration | Editable release | Boundary |
| --- | --- | --- | --- |
| Calendar M-1 | v98, #781 `ef2a8933` | #781 `ef2a8933` | Calendar event management and Calendar Settings are separate rights. |
| Training Load M-2 | v99, #783 `872019a5` | #785 `fc788d58` | External RPE schedule actions. |
| Training Load M-3a | v101, #788 `27f64183` | #789 `5a7f9bf4` | Staff attendance decisions. |
| Training Load M-3b | v102, #790 `7d9ef14d` | #791 `a5229401` | Estimate management. |
| Training Load M-3c | v103, #792 `6b6ddf29` | #793 `007a2be5` | Activity identity management. |
| Dashboards | v105, #795 `e19f9a5e` | #796 `4d7d0ced` | Dashboard Manage includes the v104 Page Copy path. |
| Builder RPE settings | v106, #797 `66220c12`; v107 guard #798 `88788c19`; recovery #799 `cc1c423c` | #800 `d6d9f752` | Planned RPE settings right with explicit recovery for ambiguous older drafts. |
| Exercises | v108, #801 `10a3aaa1` | #803 `200e31cc` | Add and Remove, with existing exercise ownership and scoped reuse rules. |
| Programs Edit | v109, #804 `aa7e62cb` | #805 `58762744` | Edit on actual program changes. |
| Programs Assign and Publish | v110, #807 `2d31d54e` | #808 `a715b164` | Assign and Publish checked separately according to each operation. |
| Tests | v111, #809 `519ad010` | #810 `bc8e3995` | Schedule management, with Calendar-owned writes on their existing path. |
| Variables Rename and Archive | v112, #811 `17008c33` | #812 `904458d0` | Rename, icon, archive and restore. |
| Variables Manage | v113, #813 `e4fd0132` | #814 `7a78d82a` | Canonical variable writes and P3 reference table management under their existing resource checks. |
| Mappings Manage | v114, #815 `70179aa7` | #816 `66e4d67f` | Mapping, activation and Board writes use the scoped native Club check. Settings exposes the same word. |

Sources Connect and Imports remain separate contracts.
Imports still needs a release plan that preserves existing approval and undo authority within the
team-scoped catalogue. The Messages Send word remains outside the enabled registry at this snapshot. Plan Limits follow the M package.

## M-1 Calendar

| Surface | Permission and scope |
| --- | --- |
| Event create, edit, cancel and v93 delete | calendar.events.manage at the active club or team; keep the current event owner and team membership checks |
| Attach, detach or align sessions; attach or detach activities | Same event permission plus the existing relationship and data checks for the session or activity |
| Set event field values and ask, remove or move athlete questions | Same event permission; apply it to manager-only event details, questions, counts and edit controls |
| Calendar Settings types, fields, locations and team defaults | calendar.settings.manage at the active club; team defaults still require a team in that club |
| Club-wide Ask athletes switch | Preserve its existing platform-admin-only rule |
| Athlete question answers and Later | Preserve athlete self access and the existing Training Load licence boundary where applicable |

The Calendar Settings route list is in backend/src/routes/calendarSettings.js. The event list is in
backend/src/routes/calendarEvents.js. Inventory and test every mounted write, including delete and
replay, before freeze. Read-only Calendar remains available under calendar.view. Preserve platform
and independent coach authority and the current missing/foreign responses. An active club admin keeps
authority over team events in that club; the native team workspace is restricted to its own team.

Use operation-specific checks in calendarEventAccess.js, calendarEventService.js, calendarQuestionService.js,
calendarQuery.js and calendarSettingsService.js. The Settings path currently shares eventWriteBasis,
so separate its structural check from event permission before enabling both words. Use the existing
server-derived capabilities to hide controls and manager-only projections. No new role-key checks in the client.

## Database and deployment

One migration is expected. Reserve its number and prefix before writing SQL. It honours both existing
permission words and adds only the seeds that preserve current access. Follow R4 sections 7.4–7.6:
audited migration changes for basic roles, live club versions and live customs of those basic roles;
revision bumps with no pending role-version prompt. Independently created club roles get no new words
through the seed.

Acquire the shared ceiling lock before row locks for club/team writes, then use the SQL permission
twin and lock_permission_actor in the same transaction. Preserve the existing users-first/calendar
row lock order. Event and Settings operations pass distinct permission scopes. Check the v54
lock_event_writer, the v93 delete function and delete/receipt guards, and the Settings command and
switch paths. Check a replay before returning its receipt, including deleted-event receipts. Resolve
permissions and the active workspace from the authenticated actor and the existing server context.

The migration runs while the previous build can still serve. Rehearse its existing signatures and
SQL against the new schema. A temporary compatibility path must preserve its existing authority,
be unavailable as a bypass to the new writer, and be recorded with a removal condition. Do not
replace a shared writer guard with a check that admits a caller-controlled word or workspace.
Pin replaced function bodies, keep the runbook preflight/postcheck and rollback with catalogue
comparison, and document when rollback must refuse. Production migration requires its own order.

### Database cutover and rollback

The migration creates a database-owned activation row, initially false. New application writes
always call the new checked entry points and fail closed if the expected schema is unavailable.
During the rolling deploy the old server still calls the old signatures. They may apply the old
rules only while the activation row is false. The activation state is read under a transaction lock
shared by Calendar writers. The activation transaction takes the conflicting lock and waits for
admitted old transactions to finish. It takes no event or Settings row lock. Verify the ordering of
this lock with the ceiling and writer locks using recorded SQL and a two-connection test.

After the new build is healthy and the operator has verified that the old instances are drained,
the authorized operator activates the database gate as a separate step. Confirm that every old
signature now refuses, including a direct SQL call to the legacy v93 delete function. The v93
delete and receipt guards must recognize the new checked path and independently refuse a legacy
path after activation. Preserve old receipt hashes and payloads, with the current permission check
before serving a replay. Prove Settings team defaults use the active club's Settings permission
under lock, and a club admin acting on a team event uses the active club's event permission and
the event's current club relationship. Preserve existing per-route 403 and 404 behavior including
the platform create refusal when no writable workspace is selected.

Before activation, reverting the application build is possible while the old path remains available.
SQL rollback must refuse after a later migration, a changed function body, a grant or removal of the
new words, a change to a seeded version or custom, or use of the new path that makes the restored
state unsafe. Record the seed and first protected real use so the gates can prove those conditions.
Take an exclusive cutover lock and require old/new writers to be quiescent before attempting rollback.
After activation, treat rollback to the legacy binary as forward-fix only. Do not turn the switch
off to make an old binary accept operations that the new policy refuses. Rehearse apply, pre-activation
rollback, identical catalogue and reapply, and the refusal cases. Production activation requires
its own recorded authorization and postcheck.

## Gate

- Disposable HTTP tests cover existing native club/team, private coach and platform flows, a mixed
  view-only account, closed Calendar licence, word removal, foreign and missing targets, and all
  accepted methods including replay and v93 delete. Assert no mutation and no receipt on refusal.
- Distinguish events permission from Settings permission and prove that Calendar reads still work
  for a viewer. Compare manager fields and controls in responses and at phone and desktop widths.
- Rehearse old/new behavior for a basic role, live club version and live custom. Verify audit rows,
  no pending question, stale revisions, rollback refusal, and earlier build compatibility.
- Race a permission/version or licence change against a write using the normal transaction. Verify
  lock order and prove a replay after revocation is denied. Run the full disposable kind, frontend-fast,
  build and relevant Calendar browser suites. Independent review before production.

## Next slice

Training Load starts with explicit words those flows already define: schedules, activity management,
roster decisions and estimates. The phase plan will distinguish staff writes from athlete self RPE,
and will resolve manual measurements, participant session types and RPE switches against their
resource scopes before implementation. Imports, Dashboard M and the remaining modules stay separate.

## M-2 Training Load external RPE schedules

This RISKY slice enables the existing `load.schedule.manage` word for the seven staff write routes under
`/api/training-load/external-schedules`: POST create, PATCH detail, and POST pause, resume, cancel,
schedule-again and remind. List and detail remain available under the current V-5b read rules.
Planned-RPE defaults and quick toggles, plan ownership resolution, activity and roster writes,
estimates, Metrics, Dashboards and Imports follow separately.

### Scope and responses

- Native club/team writers must hold both `load.view.team` and `load.schedule.manage` at the active
  authenticated workspace. Reuse the request's checked workspace through `trainingLoadAccess.js`
  and its owner snapshot; do not resolve it again after checking targets. Club and team schedules
  remain distinct owners, including when one account holds both workspaces. Keep the current target
  membership validation. A module closure and permission revocation refuse without mutation.
- Preserve the platform branch and system owner in the platform workspace. Preserve a private
  coach's user-owned path. View workspaces, athlete workspaces and unscoped accounts cannot write.
  Old roles in another workspace grant no authority in the active one.
- For an eligible writer, a missing or foreign schedule ID returns the same existing 404, including
  remind, which currently returns 403 for a foreign schedule. Reject a foreign resource before
  locking its owner or schedule. Keep current malformed-body responses.
- Keep the existing Calendar-owned refusal on edit, pause, resume, cancel and schedule-again.
  Remind currently allows eligible staff to remind on a Calendar-owned schedule. Keep that
  behavior subject to the new permission. Calendar's Ask athletes and athlete self feedback,
  occurrence materialization and licence enforcement stay on their own existing paths.
  Leave shared insert functions in `externalScheduleWriter.js` unchanged.

### Transaction and browser

Use a write-only schedule helper for the seven mounted writes. Keep the shared scope resolver's
GET and planned-load callers on their existing paths. Reuse the one request-bound workspace
snapshot, including its owner context, throughout the write. In a native club/team transaction,
derive the active club from that snapshot, obtain its shared ceiling lock before row locks,
then call `public.lock_permission_actor` and check both permission words with
`public.user_has_permission`. The lock function's return value describes role administration
and cannot authorize scheduling. Recheck the native workspace relationship and exact schedule
owner. Use the transaction's checked-out client for mutable team, club and athlete membership
validation and target/schedule row checks. Order the locks ceiling → actor → target or schedule
rows. Preserve the existing schedule, occurrence and assignment lock order within each route.

Preserve schedule UPDATE locks for edit and lifecycle changes. Schedule-again reads a source and
its defaults. Capture and recheck the locked source in the write transaction before copying.
Its existing create-on-retry behavior stays. Remind keeps schedule SHARE, occurrence SHARE in ID
order and assignment UPDATE in ID order. Preserve cooldown, deduplication and post-commit
notification emission. A refused request leaves no changes or notification.

The bridge release has no new client permission gating. After the older writers are drained,
the second release uses the server-projected permission for the Schedule toolbar, schedule detail
controls and their dispatched actions. Users with read access can open schedule detail. Preserve
the existing platform and private-coach paths. A native writer whose permission data is
unavailable gets no write controls. No new screen or client-side source of authority.

### Two-release rollout and test gates

**Release 1, bridge.** One focused migration, v99 with the exact prefix reserved before SQL.
Pin the v98 `permission_word_honoured(text)` body, preserve its Calendar words and honor
`load.schedule.manage` in SQL. Seed existing native basic holders and their live versions and
customs under R4 §7.4, including audit rows, revision bumps, ceiling order and no new version
question. Independently created roles and existing schedule, recurrence and athlete RPE
functions stay unchanged. The bridge checks both native words in SQL under the transaction locks
on all seven writes. It fails closed if the schema, word or required scope is unavailable.
The bridge neither bypasses the Manage check while rolling out nor takes an unscoped actor's
word as authority. Preserve separate platform and private ownership rules.

The database can store the seeded word while JS still treats it as unavailable for role edits.
Keep it out of the native `/me` projection and the JS checked/editable inventory during this
release. The existing platform projection lists all permission names and is unchanged. There
is no new client gating during the bridge. Test this intentional SQL/JS inventory difference
explicitly, and retain other role catalog and inventory assertions.

During the roll the actual previous server may still write with its existing authority.
The seed must preserve that authority and older role operations must not remove or accidentally
grant the staged word. Verify, using the exact previous production binary **and** the exact
bridge binary against a fresh migrated disposable database:

- All seven native schedule writes continue for seeded holders, while the bridge rejects a
  missing word or closed licence through its transaction checks. Existing view-only and cross-
  workspace refusals, Calendar Ask athletes and athlete self feedback still hold.
- Full-list basic role edits preserve the staged word and reject a crafted omission or add.
  Create/edit a club version and a custom of a seeded role using unrelated editable words.
  Confirm each inherited set retains the staged word, and direct add/remove requests are
  refused. Verify accepting the default and ending a custom restore an effective set still
  containing the word where seeded. Copy as a new independent role keeps the source intact and
  does not grant the unavailable word to the copy. Check persistence, audit/revision and
  effective holdings, rather than relying on catalog flags or HTTP shape alone.
- If an older or bridge role operation can remove the staged word or apply a new grant before
  drain, stop before deploy and change the bridge design. A green health endpoint alone is
  insufficient evidence of server compatibility or of drain.

**Release 2, exposure.** Require authoritative evidence that every pre-bridge writer has
stopped serving, including all replicas and any other app process that can execute the routes.
Record the prior and new deployment IDs/builds, the serving inventory and the completed retirement
event. Keep the role word uneditable if that evidence is unavailable. After drain, a second small
change adds the word to the checked/editable JS catalog, native `/me` projection and client
controls. Both releases use the same SQL checks in transactions. Test the second release's
inventory, effective permissions, grant/revoke behavior and native controls against v99.
In release 2 the existing Settings role editor can grant or revoke the "Manage RPE session
schedules" word. The native Schedule tab uses both the projected View and Manage words.
The same client check guards create, edit, lifecycle and schedule-again actions. Both
the transaction checks and the view workspace's read-only surface stay in force. Release 2
uses the existing v99 schema.

Train/Calendar deployments and the separate mobile Calendar PR have no automatic coupling.
Production migration, the follow-up release and any activation require their own recorded orders.

Run read-only preflight and postcheck and an isolated apply → rollback → identical catalog and
audited seed data → reapply rehearsal. Rollback requires a quiet moment and refuses for altered
bodies, grants, seeded revisions, unsafe use or later migrations. Record the permitted
application rollback boundaries for each release in its runbook. Once exposed rights have been
changed, use a forward fix instead of restarting a writer that ignores them.

### Release gate

- Pin all seven mounted writes in the route inventory. Exercise successful native club/team writes
  and denial when either word is missing, with byte-identical missing/foreign replies, exact owner
  matching, mixed accounts, closed licence, unchanged rows and zero notifications on refusal.
- Preserve platform and own private schedule behavior, Calendar Ask athletes, Calendar-owned
  refusal and remind behavior, and all self-RPE paths. Verify one request-bound workspace and
  recorded SQL ordering. Race role removal or ceiling closure against an actual write, including
  remind, and verify that scope is rechecked before any change.
- Test every native seed and audit layer, historical cutoffs and previous build compatibility.
  Prove mutations that lose the View check, Manage check or owner match are caught separately.
  Run full backend disposable, frontend-fast, build and focused browser flows at phone and desktop
  widths, then obtain independent review.

## M-3a: attendance decisions for a team session

### Scope and behavior

Activate the existing `load.roster.decide` permission for exactly these staff writes under
`/api/training-activity/:activityId/roster`:

| Method | Remaining path | Action |
| --- | --- | --- |
| PUT | `/:athleteId/decision` | Set or change one athlete's attendance state |
| DELETE | `/:athleteId/decision` | Clear a prior decision |
| POST | `/decisions` | Decide attendance for several athletes |
| POST | `/complete` | Complete the roster |
| POST | `/reopen` | Reopen the roster |

The active native club must own the activity's team and the active native team must be that
exact team. This is the roster's existing club-to-team rule. Hold both `load.view.team`
and `load.roster.decide` in that active scope, including the licence ceiling, while the
underlying native workspace and team remain available. Preserve the designated platform
support path and the existing limits for private-coach and athlete workspaces. View-only
workspaces retain roster reads and their current refusal behavior. Another club's role
cannot authorize a write in the active workspace.

Resolve the active workspace once per request and retain the request-bound context. Preserve
the identical missing/foreign `404 notFound`, ordinary malformed-body validation, the v44
roster-not-applicable rule and stable response codes. A valid native scope without the new
write word is refused before changes or receipt disclosure. Keep the existing no-op,
completion, fingerprint and conflict behavior for an authorized caller. Carry the requested
activity identifier and canonical alias set exactly as today, including retries after a merge.

Keep the `GET /:activityId/roster` read open according to its View scope. At exposure use
a separate server-derived `viewer.canDecideRoster` flag for attendance, bulk actions,
complete and reopen. Preserve `viewer.basis` and the independent controls for estimates,
manual values and type changes. The present shared browser predicate is called before
those action dispatches and must be split when the new flag is introduced. Existing server
authorization remains the source of truth.

Out of scope: the GPEXE approval-origin roster writer, import/undo and their receipt paths,
self-report and athlete RPE, planned-session ownership or RPE switches, session type
assignments, estimates, manual values, Metrics corrections, and identity/materialization
writes. `decideImportStates` deliberately uses the shared `runRosterCommand` with an
`origin` tied to the approval. Leave its authorization, request hash, replay window,
receipt and undo behavior intact. The five staff callers opt into the new guard explicitly.
Do not place it on the generic roster route wrapper or on shared roster triggers.

### Transaction and recovery

Read the current target and its club without taking a foreign resource lock. Within the
write transaction, obtain the shared club ceiling before row locks. Order owner team and
club row locks before the users-first rights locks to match the v54 structural writer
and team-archive paths. Take `public.lock_permission_actor` and verify both fixed words
with `public.user_has_permission` in the actual active native scope. The return value
of the lock helper is for role administration. Under lock, recheck team membership of
the active club, native role holding and active owners. Preserve the subsequent team
import mutex, completion/roster team lock as applicable, canonical alias/resource locks,
and receipt order. Record SQL order and prove it is compatible with role revocation,
club/team archive, import and merge. The team/club context of the canonical activity is
rechecked if resolution changes under lock.

Check authority before reading a saved receipt. The new guard applies to ordinary
staff request-key replays and to the fresh connection used by `findStoredResult`
after an unknown COMMIT. That recovery path must repeat the scoped authorization and
canonical owner check in a single bounded, checked transaction before reading or returning
the stored result. Keep the existing total deadline and broken-connection handling,
request hash and replay semantics. A revoked viewer sees no saved result or details,
and the response must not claim the earlier write was rolled back. Preserve the
legacy recovery contract for the excluded approval-origin writer.

### Migration, bridge and exposure

Use one new audited seed migration, with exact slot reserved first. Gate on the
current `permission_word_honoured(text)` body, preserve all accepted v99 and earlier
words, and seed the word into the two native basic roles plus their applicable live
versions/customs under R4 §7.4. Preserve independent custom role definitions, audited
change rows, revision updates and pending-version behavior. Record first checked use
and retain the relevant R4 lock and ACL boundaries. Restore only the staged seed and
exact earlier function body during authorized rollback. Refuse rollback after a later
migration, changed function or staged grant, changed seed state or checked use.

Bridge release: run the fresh transaction-time SQL check for all five staff routes
while the new word stays unavailable to edit and ordinary native `/me` and browser
projection remain unchanged. Rehearse the exact previous production binary and the
bridge on the migrated disposable database. Both must keep seeded staff attendance
rights operational and must protect the staged word in full-list role edit, copy,
version/default acceptance, custom edit/end and bulk removal. Demonstrate no row/audit
or request-receipt change on refusal. Prove legacy replay receipts are still read by
an authorized bridge caller, including an existing receipt through an alias. Preserve
the observed platform projection contract and exact import/self-service cases.

Exposure release: after authoritative verification that every pre-bridge staff writer
has stopped serving, check and project the word in JS and show the role-editor
controls through the existing Roles and Training Load APIs. Hold exposure if the
retirement or role-editor compatibility cannot be proven. The bridge and exposure
binaries both enforce SQL in their overlap. Build, role-policy exposure and any
production migration follow the approved release process. Once the word can be changed,
an earlier writer ignoring it is outside the rollback boundary.

### Verification

- Pin all five mounted routes, with successful club/team cases, mixed accounts, a
  closed licence, View missing, Decide missing, a different team in the same club
  for the native team writer, and byte-identical foreign/missing activity responses.
  Assert denied requests change neither decision/completion state nor receipts.
- Use the current v54/alias/order fixtures in `activity-roster-5a2.test.mjs`
  (idempotency through aliases, rights loss, two writers, import and membership
  serialization, lost COMMIT). Add deterministic ceiling/revocation races, lost
  COMMIT with permission removed before recovery and no-op/receipt parity.
- Keep `activity-roster-5a1.test.mjs`, `activity-roster-self-report.test.mjs`,
  `import-states-j20c.test.mjs`, `session-undo-roster-o1.test.mjs` and the V role sweep
  green against the applicable baseline. Verify historical migration rehearsals use
  their exact own cutoff.
- Exercise independent mutations removing scope ownership, View or Decide, skipping
  fresh receipt authorization and weakening locked owner revalidation. Rehearse
  apply → rollback → identical catalogue and audited seed → reapply on isolated
  PostgreSQL 17; verify rollback refusals and exact old/bridge compatibility.
- Run the full backend disposable kind, frontend-fast, build and focused role/roster
  browser flows, including `roster-decisions.test.mjs` at phone and desktop widths.
  Independent review before release.

### Training Load next slices

M-3b covers the estimated-value save with `load.estimates.manage`. The proposal is
part of the estimate editor and should follow that permission at exposure. Ordinary
measured reads, Dashboard estimate policy and athlete confidentiality retain their
existing contract.

M-3c covers `load.activities.manage` on seven explicit staff HTTP commands: accept
and dismiss a match suggestion, reparent and merge participants, and the three
materialization endpoints. Separate authorization at the explicit staff entry and its
transaction from automatic/self/Calendar materialization callers.

Changes to recorded measurements (manual save/restore/remove and Metrics correction)
need a separate permission decision. Session-wide type and per-athlete type change
classification. Neither is an attendance decision. Decide their mapping together in
a later contract. Keep model administration of the session-type catalog separate from
assignment of a type to an activity or participant. Imports remain last.
