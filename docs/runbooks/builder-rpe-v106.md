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
permission and exact owner for a recorded effect. Whole-plan duplication,
template/assignment/day and block paste, exact sibling correspondence, first
Submit and the complete weekly Submit policy still require a follow-up.
Keep Roles exposure closed. Releasing these changes as a complete rollout
requires the remaining writer inventory and exact overlap evidence.

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
