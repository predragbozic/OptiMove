# Builder RPE v106 provenance bridge

Local checkpoint. The slot `202612081000` is provisional and must be rechecked
against the exact deployed predecessor. Preflight provisionally pins the v105
candidate from `9a7c89450175f236ea271a657f9113989f10940c`. No v105 body is
changed. Apply order on production is v105, then v106 on the owner's order.
The additive v106 schema does not require v105 at runtime.

This checkpoint records new edit-draft openings and exact copied session IDs,
and explicit plan/default or session flag PATCH effects against those known
baselines. It leaves older drafts unclassified and existing feedback IDs intact.
It also tracks direct new plans and sessions, standalone session copy and the three
explicit bulk settings actions. A nonweekly edit Submit rechecks the current
permission and exact owner for a recorded effect. Whole-plan duplicates and
dated assignments record exact copied session IDs for new plans and replacements
of tracked weeks. The first Submit rechecks authority for recorded explicit
effects, including the draft members of a weekly batch. A recorded session
effect on a weekly sibling requires a unique shared or direct origin; a slot
match alone is insufficient. Older plans and drafts without stored evidence
remain on the staged compatibility path. Multi-week assembly, duplicate week,
and day or block copies record verified source and inserted session IDs as
inherited settings. Explicit and post-commit batch sync carry pending effects
only through a unique recorded match, retaining opening flags. A refused
post-commit sync still returns the saved primary draft and one status message.
A legacy draft without evidence stays unclassified, as does a future replacement
where its exact source history cannot be recovered. Those cases require the
owner's recorded resolution or a new draft after the bridge, never a slot guess.
Keep Roles exposure closed. The schema-only migration neither honours
`programs.rpe_settings` nor assigns it to a native role. The HTTP fixture
does both only inside a disposable database. Native runtime checks require
both conditions, so the full checkpoint as written would deny existing
native RPE actions against the unstaged production registry. A standalone
schema rollout must bring only schema-compatible runtime; integrate the
audited permission staging into the focused application bridge once the
remaining writers and exact predecessor overlap are covered. Role visibility
still belongs to its subsequent exposure change.

Run the read-only preflight and postcheck on the exact branches. The migration
takes a deployment advisory lock and creates only new relations. Writers acquire
its shared variant before plan locks. The first successful real opening sets the
durable marker in the same transaction. The rollback script takes the exclusive
lock first, refuses a later migration and refuses when either the marker or a
saved baseline exists. Discarding a draft does not make SQL rollback safe.
No known existing owner or draft is removed or guessed.

Use the repository disposable runner on a private PostgreSQL 17 cluster and
Node 22. The tracked v106 test rehearses apply, unused rollback and reapply.
The Builder HTTP suite exercises a saved opening, exact lineage and both
explicit flag writes. The final release must also cover earlier build writes
during overlap and all copy/sync paths in the implementation contract.

## Native staging design

Use the v105 bridge pattern against the exact deployed predecessor. Preflight
checks its recorded filename and checksum, the current permission evaluator
body, the catalogue row, the absence of staged RPE grants and the exact
role layers eligible for overlap. Under the existing exclusive club-ceiling
locks, add only `programs.rpe_settings` to the club-admin and team-coach
system roles, their live club versions, and actively held custom roles whose
legacy native holder was already eligible for the RPE actions. Capture the
exact staged role rows, words and original revisions before writing. Preserve
authored items and inherited-review markers. Append one sanctioned migration
audit row per changed role layer. Do not grant RPE to an unrelated custom
holder or to a club_view or team_view workspace.

Extend `permission_word_honoured` in the same transaction. Keep the
application permission editor closed to this word until the exposure release.
Pin old-runtime equivalence in a disposable overlap test, including built-in,
overridden and custom role holders, club licence changes, role revocation,
current workspace and unchanged content. Test the real staged registry and
grants directly without the fixture grant helper. Record the first checked
native write transactionally. Rollback must hold the deployment lock before
checking native first use, existing provenance, later migrations, schema and
body fingerprints, and the captured role/audit snapshot. Refuse if an
independent role editor changed any staged row. Rehearse catalogue and role
data equality before reapplying. This checkpoint does not implement seed SQL.