# Sources provider closed integration on v115

Base `b4a652969d77dd202ed4762d56eaf73ff35d259a` is the merged v115 local
writer bridge. The previously accepted rollout contract stays authoritative.
This packet adds disposable tests and an export of two existing protocol
functions so the tests use the exact v115 implementation. It assigns no
migration slot. No mounted request consults the disposable store.

## Exact seams

- `sourceConnectionService.js` keeps local Create, Unbind and their fresh
  protected response paths. The legacy GPEXE pointer and the v115
  first-checked-local-write marker remain separate.
- `attempt` still controls Connect, Reconnect, Test and Bind. Its
  `trackedFetch`, `exchangeCredential`, `testReads`, source presentation,
  savepoint and `recordUnknownOutcome` are the behavior to preserve. The test
  export provides `exchangeCredential` and `testReads` only. It is not mounted
  or an alternative provider client.
- `source-provider-claim-compatibility.mjs` always uses an injected fake
  fetch when active. With its default off it returns before issuing an
  authorization query, reservation or provider request. The disposable
  schema install independently refuses any database outside the test
  namespace. The stop switch and old-process bit model policy, not production
  process inventory.

## First actual private storage slice

Build the private control record, immutable attempt identity and captured
resource relationship rows in a single additive schema step once a slot is
assigned. Keep database admission false, with no environment setting that
can override it. Do not run reconciliation or reserve in mounted routes while
admission is false. Use separate liveness indexes for actor and connection, a
team-scope lookup, and a bounded expiry scan. Keep claim ACLs separate from
public API roles, with narrow runtime and operator privileges. Feature-off
checks must never execute provider storage SQL on the old binary.

Start by checking migration prerequisite identities and live writer-trigger
inventory. Add PostgreSQL constraints for the initial reserved state, valid
transitions, terminal evidence, expiry bounds and the exact captured team
set. Use relational identities and generations for production rather than
deploying the fake fixture's permissive tables or numeric-only projections.
Pin that an attempted CAS cannot pre-extend its lease, reuse its nonce,
insert an arbitrary team, or expose an existing attempt before fresh scope
validation. Record the DB clock, identity and generation evidence only.
Do not persist any plaintext credential, response payload or unnecessary
upstream label.

Maintain an explicit reserve/consume/settle command API with no provider
import. A caller may invoke remote I/O only on an acknowledged protected
consume. The receipt can never acquire a new dispatch lease. A reserve
whose consume never happened expires as no-send. A consumed dispatch can
expire as unknown and retains its debit and scoped conflict through the last
safe transport horizon. Distinct attempt IDs unify legacy audit and durable
debits on both axes. The command API and expiry worker are exercised on a
disposable cluster first, without mounting provider paths.

## Before mounting or opening admission

Use a separate real-route equivalence gate that covers identity and team
scope, host approval, credential invalidation, reconnect confirmations,
candidate writers, active binding transitions, blocking and try outcomes,
and the independent actor/connection quota. Prove no false effect on scope
loss and verify the 90-second existing attempt ceiling, provider teardown,
and no reused dispatch after uncertain acknowledgements. Review all caller
and SQL boundaries, then coordinate exact drain and migration order. This
checkpoint transfers a fake protocol and state-machine proof, not mounted
parity, migration readiness, or an authorization to activate.
