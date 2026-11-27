# Dashboard Manage contract

Status: design recommendations for review. The integration and behavior still
require as-built evidence and owner authorization. This contract builds on V-6 and the Dashboard scope
rules in ADR-002, ADR-003, ADR-006 and Roles R4. The permission word already
exists in the catalog as `dashboards.manage` for club and team scopes. The
release will preserve `dashboards.view` and its existing per-route rules.

## Decisions and access

A shared scoped write predicate adds a requirement to today's owner and workspace
checks. For a native club or team writer it requires View and Manage at the active
native scope under the current Dashboard licence. For club- or team-owned content
it also checks authority for the actual destination owner. A role on another
holding, shell selection or a submitted workspace field supplies no authority.
Retain each route's existing owner-visibility and data-workspace behavior. Where a
route already requires a data-workspace match, continue to require it independently
of owner and Manage. Audit any route whose current data-workspace contract differs
before proposing behavior changes. A personal dashboard bound to a club or team
still belongs to the user and is governed by the native scope when edited there.
A system template remains a platform-only write. Preserve legacy platform, private
and athlete behavior without adding authoring routes or expanding an existing one.
Read-only `club_view` and `team_view` retain the account-without-write response.

At the #788 merged build, Legacy create resolves club/team ownership directly from
the requested owner id, checking both that owner and target-scope View. In the team
branch, canManageTeamById permits a direct team coach or a club admin managing the
team through their club, with the existing platform override. Both branches and
the target View check also apply to club/team template clone destinations.
Legacy clone first resolves the source in the active data workspace. It requires a
visible, active template and then uses the owner-targeted create resolver for the
destination. A default user-owned destination binds to the already resolved active
workspace. These are distinct compatibility exceptions to a blanket active-scope
match. Under lock, add Manage and the target club licence at the server-resolved
destination. Keep existing owner and destination View checks. Do not add a blanket
active-scope View gate to Legacy create. Clone still checks source template View
in the active data workspace separately before the same destination checks. The
legacy team destination can be managed through direct team coaching or club
admin delegation, without requiring a direct team role on the delegated path.
Capture the exact allowed/denied combinations on the deployed old binary and
compare them with bridge and exposure. Preserve these existing targets and
response meanings throughout both releases. Any narrowing needs separate approval.
Authorize before copying or inserting data. Validate source
visibility and destination owner/active workspace separately. On mutations,
resolve child ids under the authorized dashboard; a matching child alone gives
no authority. P3 additionally checks the selected reference workspace and its
own club/team/source constraints. Preserve existing generic missing/foreign
responses, including status, body and relevant headers. Do not attach the
write predicate to render/query, view-only filters or PDF export merely because
an endpoint uses POST.

Two decisions before implementation:

1. The technical design recommends the exact active native team workspace for
   new team writes. Preserve existing Legacy owner-targeted create and clone
   through bridge and exposure. Any later narrowing needs an explicit decision.
   This is a design recommendation pending as-built verification and owner approval.
2. Should a view-only user set or clear their personal active dashboard? The
   current V-6 contract closes these endpoints in view workspaces. Recommend
   preserving that for this release, and preserving selection for already-
   eligible users without Manage. V-6 view workspaces remain GET-only for
   /active. A later opening would check View, current workspace, visible
   dashboard, and the authenticated user's own preference.

## Mounted write surfaces

| Mount | Controlled by this contract |
| --- | --- |
| Legacy `/api/training-load/dashboards` | POST create and clone, PATCH dashboard, POST archive and DELETE dashboard; PUT layout and PATCH widget layout; POST/PATCH/DELETE widgets and series, PUT series reorder and POST series resolve. Map exact methods in a route inventory test. POST and DELETE `/active` only change personal preference. Query and reads stay under View. |
| Pages under the same prefix, mounted independently before Legacy | POST create, reorder and widget copy; PATCH and DELETE page; PUT page layout and PATCH widget layout; widget and series create/update/delete/reorder/resolve. Existing page and request status routes remain distinct. POST page query is a read. Preserve activation guard and Home/legacy projection. |
| Simple runtime `/api/training-load/dashboards/:dashboardId/simple`, mounted separately before the V-6 gate | Save via POST `/widgets` or PUT `/widgets/:widgetId` and POST `/requests/status` for recovery. Keep current platform-workspace pilot, mode checks and parser/404 behavior. Preview, validation, metric picker and capabilities are independent reads, but a save capability must reflect real authorization. Advanced presentation edits still obey the pilot field rule. |
| P3 `/api/training-load/dashboard-references/:dashboardId/widgets/:widgetId`, independently mounted | PUT binding applies the same Dashboard write predicate and existing P3 context/source checks. Binding GET and query reference previews keep their existing read/pilot rules. `/api/training-load/reference-tables` create/draft/publish/archive remain Data configuration operations under their existing authority; no R4 Data configuration word is enabled here. |

This inventory was checked against the exact #788 merged tree (27f64183). That tree
contains the Pages widget-copy endpoint and lacks a v100 migration. If the deployed
predecessor includes the v100 copy change, re-inventory its routes, SQL function and
receipt order against that exact build before implementation. Use mounted-route
coverage rather than inferring a surface from a migration version.

## Transaction, receipts and rollback

Perform permission and licence checks on the same client as the mutation. For
native scopes take the shared R4 club-ceiling lock before actor row locks, verify
the actual ability after `public.lock_permission_actor` and preserve existing
domain lock order. Record SQL order before changing acquisition. Pages and Simple
use actor/request advisory locks ahead of the dashboard lock. The legacy and page
Simple writers must keep the same advisory key before the dashboard lock. Preserve
dashboard → page → widget → series order, revision checks, copy/clone identity
mapping, the v19 delete audit basis, and sanctioned SQL in ADR-003. Recheck the
owner and data workspace on the protected row, and both ends of copy/clone as
applicable. For P3 binding, take the v97 dashboard-reference:<actor>:<request>
advisory (seed 0, identical to the sanctioned function) before locks used to check
the actual dashboard owner, data workspace, new gate and receipt. Keep that order
for every writer sharing this key. Retain existing reference domain and source
checks. Test deterministic revoke while the request waits, same-key calls on both
paths, and a wrong-workspace replay before any receipt is returned. Exercise same-request and revocation races across mounts before review.

Pages, Simple and P3 binding receipts retain their request namespaces, hashes,
revision fields and replay shapes. Reauthorize the current actor, target and
workspace before the request can disclose a receipt, including explicit status
and fresh uncertain-COMMIT recovery. A receipt from an old authorized request does
not grant current access. Preserve same-hash replays, changed-hash refusals,
deadlines and unknown outcomes. Do not introduce a ledger for Legacy operations
here. A closed licence or missing Manage cannot edit or recover a result. An
authorized status request need not revalidate that a successful deletion's child
still exists when its dashboard and receipt already establish the target. Simple
status or fresh unknown-outcome recovery that takes locks must use a lock-capable,
bounded transaction and reauthorize the protected dashboard before receipt lookup.
Retain the original request hash/key, recovery deadline, and deleted-child
semantics. A read-only transaction cannot take the required actor/target locks.

## Stage and verify

RISKY. Land a bridge that enforces the staged word at every native write entry
before capability projection or role editing exposes it. Capture the exact
deployed previous build and actual permission-function body/registry on the
implementation day. Request a migration slot if the R4 seed is needed; this
contract is docs only. Determine which basic roles, active club versions and
actual held custom layers need compatibility seeds. Preserve authored roles,
pending defaults, audit revisions and grants. Publish or edit the word only
after exact prior-build and bridge overlap is proved and prior writers are
drained. Keep feature flags and release boundaries for Pages, Simple and P3.
If the bridge uses a seed, rehearsal on isolated PG17 must cover apply → rollback
→ identical catalog and audited seed → reapply, and refusal after use, later
migration or incompatible changes. Verify both the deployed predecessor and
bridge binaries on the same migrated database around the cutover.

Use disposable real HTTP to enumerate methods across all four mounts. Exercise
native club and team success, closed licence, one word missing, wrong active
scope, foreign/missing ids, same-club other team, mixed account, view workspace,
and legacy platform/private/athlete behavior. Check personal preference stays
isolated. Rehearse old vs. bridge parity for Legacy create and clone by a direct
team coach and a delegated club admin. Include a cloned template visible only in
the source workspace, unaffected source View denials and destination View, Manage
and licence denials before a target write. Confirm the exposure build keeps the
same compatibility behavior. Assert denied requests do not change rows, revisions, receipts or delete
audit. Prove independent mutations are killed for removed permission, removed
workspace intersection, owner bypass and replay/status bypass. Exercise
concurrent revoke/save, same request through both Simple paths, stale revisions
and unknown COMMIT recovery. Compare dashboard query output and the shell-filter
intersection before and after. Cover P3 binding vs table administration,
templates, system copy/clone and Pages-off legacy behavior. Run the full
disposable backend suite, frontend-fast, build and dashboard E2E for Pages,
Gallery, Simple and References. An independent reviewer and full gate review the
frozen bridge and the exposure overlap before either production transition.

## As-built bridge checkpoints

Local runtime review is based on the M-3c staging tree at 4a7eb04a. The
Dashboard migration slot follows the production registry after the Page Copy
release. Exposure of the word and the previous-build overlap rehearsal are
later release gates.

| Surface | Same-client authorization boundary | Receipt and read behavior |
| --- | --- | --- |
| Legacy POST create | Explicit club/team destinations use their existing owner resolver and fresh destination View and Manage. Personal creation uses the server-resolved active native scope when it has one. The scoped guard and sanctioned create run on one client. | The explicit destination retains the established owner-targeted behavior. |
| Legacy POST clone | The admitted source workspace and destination scope are resolved before lock acquisition. Ceilings for both scopes precede the actor check and source dashboard share lock. Source View is checked separately from destination View and Manage. The existing source dashboard, page, widget and series lock sequence remains. | Source visibility and destination checks both precede insert. Template and clone constraints remain in force. |
| Legacy PATCH dashboard, POST archive, DELETE dashboard | The current owner and active native scope are checked before the dashboard lock and sanctioned write. Delete derives the v19 audit basis again from the protected dashboard and fresh actor. | Delete retains its stale-revision, system-template and clone-lineage refusals. |
| Legacy PUT layout, PATCH widget layout, widget POST/PATCH/DELETE and series POST/PATCH/DELETE/reorder/resolve | Scoped authorization and the protected dashboard, child lookups, and sanctioned SQL use the same client. | Legacy's existing owner and workspace admission rules continue to apply. |
| Legacy POST/DELETE active dashboard selection and POST query | Personal preference and data reads continue under their existing checks. | View-workspace active selection stays GET-only. Query keeps the shell intersection. |
| Pages create/reorder/edit/delete, copy widget, layout, widget and series writes, and GET request status | The existing request advisory stays first for ledger writers, then club ceilings, identity and R4 actor locks, and the dashboard and page locks. Status uses the protected dashboard and current rights before receipt lookup. | A successful deletion's receipt is keyed to the dashboard. The original write hash and workspace comparison stay in force. POST Page query stays under View and its independent data scope. |
| Page Copy v104 POST /:dashboardId/pages/:pageId/copy | The v104 candidate at 3fd0bf8e is routed through copyPage into service.mutate and its Page target check. The Manage guard belongs ahead of the composed mutate_dashboard_page and copy_dashboard_page_contents transaction. Recheck the deployed implementation before finalizing Dashboard Manage. | Rehearse replay and a revoked actor against the final v104 build. |
| Simple POST/PUT widgets and POST requests/status | Preserve the server pilot. Both save routes use the same request advisory before the guard, dashboard, page, widget and series. Status and fresh lost-COMMIT verification use a bounded lock-capable transaction and protected dashboard. | The original token, hash, expiry, and replay verification values stay in force. Preview, validation, and picker remain independent reads. |
| P3 binding PUT, binding GET and reference-table operations | Binding PUT takes the exact v97 request advisory first, then ceilings, fresh actor/workspace and P3 source authority before the protected dashboard and sanctioned binding call. | Binding GET and query previews retain their read/pilot checks. Reference-table draft, publish, archive and create retain canonical-variable administration. |

The local route inventory pins the mounted Legacy, Pages, Simple save/status and
P3 binding switches. The lock-order unit test records the ceiling, identity and
scoped actor/permission calls for two distinct clone scopes, including a
View-only source and Manage destination. Final PostgreSQL evidence must include
missing Manage, closed Dashboard licence, a revoked receipt reader, mismatched
workspace, and the v19 deletion audit. Run the previous binaries with the final
role seed and repeat the same request across both versions before exposing the word.

In the first PostgreSQL 17.11 scratch rehearsal, the mocked future basic-role
seed enabled direct Team coach and delegated Club admin create/clone, preserved
the exact v19 deletion basis, and gave the same response for a foreign or
missing destination. A receipt request blocked at the club ceiling while the
Team coach grant was withdrawn, then returned the same 404 as a missing target.
The Page read remained available and the rejected write added no page or receipt.
Existing Pages access (9 tests) and P3 binding/reference HTTP (11 tests) passed
against the same scratch contract. The scratch seed was limited to disposable
databases. The final package must repeat this with the approved migration.
