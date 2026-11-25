# M steps for module write permissions

## Order and boundaries

The V package is complete (#778). The R4 contract, decision O7, puts Calendar and Training Load first and Imports last. Start with one Calendar-only RISKY PR. Follow with Training Load slices, then the remaining O7 modules. Plan limits follow M.

Every staff write retains the module VIEW check and the current workspace and resource relationship checks. Each M slice adds its write permission and the licence ceiling at the actual operation. A club_view or team_view workspace stays read-only. Existing view-only custom-role accounts do not acquire a writable workspace through a MANAGE word. A different workspace entitlement would need its own contract.

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
