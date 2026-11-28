# Sources Connect staged rollout

Decision from the owner: preserve the existing wait or busy result when an
operation conflicts with provider work for the same team. Preserve the host
and sanctioned direct SQL callers on the same basis. This is an access and
concurrency change. Each deployable slice needs independent review and the full
disposable gate. This contract assigns no migration number.

## 1. Local writes and the hidden permission

The first release covers keyed and unkeyed Create, keyed Unbind and the legacy
first approved GPEXE team pointer. These are existing local writes and send
nothing to the provider. The exact existing platform path remains available.
Native writes need the active owning club workspace, current Club admin
standing, licence, and `sources.connect` checked on the same client under
the resource locks. A stale session, switched workspace or changed actor basis
must not disclose a saved result. Preserve the legacy pointer's same-pair
no-op, its platform-only replacement and its existing refusal envelopes.
Unbind replay keeps its audit identity and skips the existing team advisory.
Team timezone and Imports retain their authorities.

The gate and the hidden SQL permission stage must ship together in one
deployable release. A runtime-only candidate fails closed when the SQL word is
absent and would refuse legitimate existing native actions. The schema stage
honours the word and seeds only the existing eligible native Club admin
layers. Require the exact validated eligibility matrix for built-in, live
version and currently held custom roles. Verify the existing licence and
read prerequisites, with no Team role grants, inferred independent grants or
change to another checked word. Settings keeps the word hidden until its
release criteria below. Replay and unchanged writes never stamp native use.
A checked mutation stamps first use in the same transaction after its durable
receipt. Preflight, postcheck and the operator rehearsal must show that the
exact preceding binary coexists with the staged schema and old Settings
writes preserve the staged word. Rehearse applied, rolled back, catalog equal,
then reapplied. Refuse destructive rollback after first use, unexpected role
or audit changes, or a later migration. A reviewed non-destructive forward fix
remains available after first use.

## 2. Add provider coordination with admission closed

Keep Connect, Reconnect, Test and Bind on their existing transport and lock
path until the durable boundary is complete. An additive provider store can
deploy with admissions closed. Old binaries continue operating while the
store is empty. Install the generation capture and any cooperative SQL
boundaries while admission is closed. Preflight inventories actual hosted
builds, jobs and sanctioned SQL callers, plus both live Undo overloads and
grants where present.

Reserve against the existing separate actor and connection quotas, five in
15 minutes on either axis. Deduplicate audit and pending or unknown claim
debits by immutable attempt identity. Successful Bind and proved no-send keep
their old exceptions. Reserve privately, then transition to dispatching in
the database exactly once by compare-and-set. The one-time dispatch nonce is
private to the invocation. A retry may recover authorized state and never
resends. Count uncertain reached work and fence it until the hard I/O and
teardown deadline is over. Do not compare a local wall clock to a database
lease. Use database eligibility and a monotonic transport bound with a safety
margin. Retain unresolved evidence. Keep credentials and provider payloads
out of claim persistence.

Under the existing locks, capture and recheck the exact session, workspace,
permission, licence, club, credential generation, approved host and protocol,
full active binding set or selected team, and effective approved pointer.
Use monotonic generations for replacements, retirement, move, archive,
Unbind and auto-invalidation, including change-away-and-back. A same-pair
replay changes no generation. Check current authority again before disclosing
a result, even after a durable commit. A refusal after commit returns the
plain missing-resource answer and no private details.

## 3. Adopt the old contention boundaries before activation

Keep the actor advisory, connection row, host row and sorted team try-locks
in their existing order for short reserve and finalize transactions. Prove
the club ceiling cannot cycle with a connection-first predecessor. Use a
consistent acquisition order, or bounded nonblocking connection acquisition
and a full retry that releases the ceiling. Finalization may reenter only its
exact authorized connection and captured teams by the private attempt nonce.
No transaction or pool client spans provider I/O.

Install the durable fence check under the appropriate existing lock for each
participant:

| Existing boundary | Required adoption |
| --- | --- |
| Keyed Create, Unbind, four provider routes | Preserve the independent per-actor and per-connection contention. Unbind checks its connection and one target team. Receipt replay still bypasses the team advisory. |
| GPEXE settings and timezone, reservation/check, preview, approval/import, track choices and linking | Preserve the original target team, response and time bound. Existing check finalization and SQL try points remain immediate. Verify the specific route paths and finalize/write hooks on the pinned tree. |
| Activity roster, manual values and estimates | Preserve the roster wait and manual/estimate try responses. Read paths that had no team lock remain outside this fence. |
| Source instance end, sanctioned Undo SQL, binding/link/check/pointer/timezone triggers, team move | Audit inline advisory call sites and direct SQL grants. Keep old immediate trigger semantics and exact Undo waits. Pin valid signatures, replay, and the absence of partial commits. |
| Host catalogue and approval/retirement | Preserve the old host row conflict and its bound in the scoped replacement. Keep admission closed if a sanctioned host writer could bypass it. |

For existing blocking HTTP traffic, poll outside write transactions within the
original single deadline. On entry acquire the old lock, recheck the durable
fence, ownership and inputs, and proceed only before any effect. If still
blocked, unwind the untouched transaction before waiting. Existing immediate
try paths retain their original busy response. Do not sleep in a trigger,
wait while holding candidate or other domain locks, or retry a partially
committed batch. Keep production admission closed if a sanctioned direct SQL
caller cannot be routed through a reviewed equivalent wait path. Do not add
organization-wide fences or block reads, unrelated teams or unrelated
connections.

## 4. Activate, turn off, then expose Settings

1. On an exact old/current disposable rehearsal, compare every mounted
   busy/timeout path. Include wait-then-success, unrelated teams, host
   retirement, direct SQL, queued exclusive ceiling, missing rights, same
   actor/different connection, and different actors/same connection. Use an
   instrumented fake provider. Capture exact provider operations, headers and
   order, one actual send, crash after dispatch, stale nonce, and quota counts.
   Existing support-only prototypes do not satisfy this gate.
2. Keep admission closed until all claim-ignorant participating web and job
   processes, in-flight requests, and sanctioned direct callers are drained or
   proved to use the same fence. Record actual deployed build identities and
   evidence of the drain. Open one database-backed admission epoch atomically
   against reservation. A flag on an individual worker is insufficient.
3. To back out, close admission first. Leave converted readers, fences and
   reconciliation running through the latest hard transport deadline. Do not
   restore a claim-ignorant worker that could resend or bypass a pending
   operation. Preserve reached/unknown quota debits in the legacy accounting
   or hold fallback until their 15-minute window expires. Refuse destructive
   rollback with pending or unresolved work, retained counted-unknown
   debits, first checked use, registry drift, or a later migration. Verify
   same-catalog rollback and recovery on the exact older binary before release.
4. Expose `sources.connect` in Settings only after every action the word
   controls enforces it and the old provider workers have drained. Pin
   scoped revocation and regrant, previous Settings replay and unrelated
   Variables/Mappings permissions. Imports rights remain a separate step.

Implementation reviews must check the live migration registry, rollback
preconditions, and the complete caller inventory again. This contract adds no
role words, migration files, provider traffic or production actions.
