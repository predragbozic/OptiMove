# Programs Edit v109 bridge

This migration stages Programs Edit in the R4 SQL evaluator for native club and team workspaces. Settings editing and native permission projection stay closed while earlier writers are serving. Assignment and publication are separate effects and will get their own rollout.

## Seed and preflight

- The built-in Club admin and Team coach roles qualify when they already hold Programs View. A live club version must hold View itself to qualify. A live custom must replace a current native basic holding and hold View itself. Independent roles and assignments receive no seed, and no program ownership is backfilled.
- Take the exclusive club-ceiling locks in club ID order, then the role tables. The migration records the exact seeded rows, writes one migration change per affected layer and advances each affected revision. A version already following or acknowledging the current default advances with it. An existing unanswered role-version change keeps its existing state.
- The previous live server is `234e2eab4f7aea6376ddcdc26800bc516f6ec6e6`. Confirm it again at freeze. Run `program-edit-v109-preflight.sql` read-only and require all results true. It pins the exact v108 registry row and evaluator body and confirms that Programs Edit is not already staged.
- Use the wrapper under `backend/scripts` on a private PostgreSQL 17 loopback cluster and Node 20 or newer. The PowerShell wrapper accepts a private loopback URL or asks for a hidden local password. It prints `RESULT: PASS` after success.

## Deploy and exposure

Apply the reviewed migration through the repository runner and run `program-edit-v109-postcheck.sql`. Confirm evaluator, first-use guard, exact audited grants and RLS. The first-use field can become false as soon as a successful native guarded Edit commits. Check old and bridge binaries against the migrated disposable database, including a full Settings replacement and attempted removal from the built-in, live version and held custom layers.

Deploy the guarded bridge with Edit still closed in Roles. After every pre-bridge writer has drained, run the separate exposure release. Check that removing Edit denies new native writes and protects receipt replay while reads and remaining independent capabilities still work. Verify restoration. Keep Assign and Publish closed for their own release.

## Rollback

Drain both writer generations. Rollback is allowed only before exposure and first successful native guarded Edit, with no later migration, no changed permission body or first-use protection, and no divergence in the audited staged grants. The SQL restores the exact v108 evaluator and prior role revisions, seed history and timestamps. Only the named role table user triggers are temporarily disabled, and the transaction checks their reactivation. A refusal requires a reviewed forward correction.
