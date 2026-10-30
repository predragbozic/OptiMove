# Dashboard Simple Editor — S2b read-only preview

Base: reviewed S2a `326d6edd09ba34959b2c69abfb2a168e22cee6df`.
Specification: S1.1 `26162ae8f266eb24c88c601c8d4e8b9f1ca59be7`, PR #265.
S2b is a separate dependent slice; neither dependency is merged by this work.

## Interfaces and activation boundary

`createSimplePreviewService` requires a server-owned pool and injected existing
`queryDashboard`. `createSimplePreviewRouter` exposes GET capabilities and POST
validate/preview when explicitly mounted below
`/api/training-load/dashboards/:dashboardId/simple-editor` behind authentication.
It is deliberately **not mounted in server.js**. Existing routes remain unchanged.
Tests mount the factory in a separate authenticated app on an ephemeral local port.

Preview defaults to unavailable. Runtime construction requires a dedicated
injected signing key, coordinated admission, and explicit server-owned
`coordinatedAdmissionVerified` / `deploymentBudgetVerified` activation flags.
These flags are never accepted from request data. They represent operational
evidence, not an automatic substitute for proving the actual deployment topology.
No key, environment value, production service or migration is created here.

The admission reference authority is a single coordinator. Multi-process tests
use actual child processes and IPC to that same authority. A separate local Map
in every server process is not a deployment-wide coordinator. Production needs
an explicitly approved transport/topology, identity enforcement, capacity budget,
failure recovery and load evidence before setting the activation flags. Lost
acknowledgement or unconfirmed cleanup retains occupancy rather than expiring an
unsafe lease. No production coordinator service is installed by this slice.

## Read-only authorization and snapshot

The service reloads the current user/session and real roles on its transaction
runner, resolves only an existing still-valid workspace preference, authorizes the
target dashboard and minimally supplied edit-widget target, then returns detailed
draft issues. Missing/revoked preference gives `workspaceSelectionRequired` with
no fallback selection or write. Missing/foreign/mismatched targets give generic
`notFound`. Existing widget revision is checked after target authorization and
structural validation. Read-only helpers use the existing role/workspace rules.

The pool client starts `REPEATABLE READ READ ONLY`. All role, workspace, catalog,
widget, selector-membership and canonical-fact reads use that same client. Optional
query-runner injection is threaded through every query-engine fetcher; default
saved-query calls retain their original global runner and math/status behavior.
Existing authorization/workspace helpers also retain their default behavior;
the new read-only workspace resolver never calls fallback persistence.

Authorized athletes are loaded from actual active workspace membership. A query
projection applies the compiler's complete effective filter, including that
authorized set. Zero authorized athletes yields an empty result without calling
the legacy engine, where an empty array would otherwise mean unrestricted.
Activity/component selection is checked against the same workspace and snapshot.

## Bounds and resource lifetime

- Request JSON: 64 KiB of original bytes, including whitespace. The local parser
  records byte evidence. An upstream parser must use the exported
  `captureSimplePreviewRequestBytes` verify hook; an already-parsed body without
  this server-side evidence is refused as `previewParserRequired`. Content-Length
  and normalized JSON size are not accepted as substitutes for original bytes.
- Preview response: 2 MiB; oversized results never return a partial success/token.
- Coordinator acknowledgement: default 500 ms, configurable only up to 1 s.
- Pool checkout: default 1 s, configurable only up to 5 s; late clients are
  destroyed without SQL and admission remains occupied until confirmed cleanup.
- Transaction work: at most 5 s, measured monotonically; each statement gets at
  most 3 s and no more than the remaining work budget. Abort/deadline is checked
  again after SET LOCAL, immediately before submitting the actual SELECT.
- Cleanup: an additional bounded 500 ms attempt; an unconfirmed/broken client is
  removed instead of being returned to the pool. No idle-in-transaction reuse.
- Admission: one user globally, per-process `min(2,floor((POOL_MAX-1)/2))`, plus an
  explicit aggregate deployment budget. Refusal is nonqueued 429 `previewBusy`
  with Retry-After. Tiny pools that cannot reserve capacity refuse preview.

HTTP abort does not free a lease or imply SQL completion. The adapter does not
assume a safe protocol-cancellation port exists on the injected pool: statement
timeout is the backstop, followed by confirmed rollback/release or client removal.
Only then is the authority lease released. A failed coordinator release leaves
capacity occupied for explicit recovery. Preview never increases pool limits.

## Response and token

Validate compiles without running measurements or returning a token. Preview
returns query/draft identity, hashes, effective context/period, informative
dashboard revision, relevant widget revision, normalized widget, existing-format
widget result, warnings, server timestamps and a signed ten-minute token.

Per-series execution failures and error rows in either current or comparison data
block proof issuance. Empty/conflict states remain explicit warnings; a KPI with
multiple groups/array values requires a choice, and nonnumeric chart values cannot
be coerced. Nonfinite numbers cannot silently become JSON null. Presentation
annotations are disabled; table rules requiring result-semantic evaluation remain
unsupported until their separately approved implementation.

Tokens use bounded canonical JSON and HMAC-SHA256 with an explicit dedicated key
of at least 32 bytes, version/keyId, timing-safe signature comparison, server-issued
requestIssuedAt/issuedAt/expiresAt and bounded verification-only key rotation.
No session/auth-key fallback or measurement-result persistence exists. Bindings
include user, workspace, parent/edit target, relevant revision, draft/catalog/
semantic/context fingerprints, period intent, concrete resolved period and
evaluatedAt. Unknown keys, tampering, expiry and changed bindings require preview;
period changes take precedence as `effectivePeriodChanged`. Browser time is not
an authority. Verification is a cryptographic helper, not a save authorization
endpoint: S2c must freshly authorize/revalidate and apply the documented ledger
replay ordering and relative-period rules.

## Validation and review record

Initial targeted token/admission/transaction tests passed. The first real DB run
executed 121 tests (109 inherited + 12 new); four test-fixture expectations needed
correction, including an unsupported legacy timeZone field, immutable historical
feedback update, SQL argument casts and metric info-hiding status. These failures
are not recorded as passing evidence.

Independent review identified three P2 defects: SQL submission after an abort
during SET LOCAL, detailed issues before edit-target authorization, and tokens
issued for aggregation error rows. All three received narrow code corrections
and focused regression cases; closing review and final measured results are
recorded below. No failure waiver was added. A genuine module-mocked
query-runner test has an explicit unit classification note because the static
runner sees its intentionally mocked db.js dependency.

Final measured results on Windows / Node v24.12.0:

| Check | Result |
| --- | --- |
| Real disposable Dashboard DB/API suite | **125 passed, 0 failed/skipped/cancelled**: 109 inherited cases plus 16 S2b cases |
| Backend unit regression | **524 passed, 1 confirmed inherited Builder failure**, 27 files |
| Dedicated security/admission and transaction cases | **42 passed** (included in backend totals); actual child-process IPC admission tests |
| Query runner isolation/default behavior | Unit wrapper passed, executing two inner module-mocked cases (included in backend total as one wrapper) |
| Existing workspace hierarchy | Separate fully module-mocked wrapper passed |
| Existing seven frontend regression suites | **164 passed, 0 failed** |
| Whitespace/syntax checks | Passed |

Actual DB/API cases prove session rechecks, no preference fallback writes, target
and edit-target authorization ordering, complete application-row digests unchanged
by preview, a single read-only repeatable-read client/snapshot, old-versus-fresh
snapshot behavior across a legitimate concurrent fact insert, PostgreSQL writer
refusal, deterministic draft IDs and clean saved-query result parity, selector
inheritance, no widening on zero authorized athletes, token binding, current and
comparison historical-type errors blocking proof, size bounds and real SQL
timeout/abort cleanup with successful follow-up. The original-byte guard includes
an upstream-parser regression; a GET parser false positive found during that
addition was corrected without weakening either POST byte limit.

The independent reviewer closed all original three P2 findings, then narrowly
verified bounded coordinator acknowledgement and original-byte parser safeguards.
No remaining code finding was reported in the reviewed scope. This is a technical
candidate review, not deployment approval or proof of a production topology.

The runner audited no leftover databases and unchanged maintenance objects. A
separate psql check confirmed only `postgres`, with zero user objects. The private
server was stopped and its checked workspace data directory removed. Existing
PostgreSQL services/configuration and production databases were untouched.

## Remaining separate gates

No Simple save/update/status route, composite writer, sidecar storage, ledger,
receipt, unknown-COMMIT recovery, Pages persistence, UI or production activation
is implemented here. Those remain later phases/operational decisions. Existing
Builder unit failure is a confirmed inherited baseline, not fixed or waived.
No merge, deployment, production write, production migration or persistent
environment change is authorized by this implementation.

**Candidate status: review-ready, preview disabled and router unmounted.**
Activation still requires the dedicated-key decision, a deployed coordinated
admission transport with verified process identities and failure recovery,
aggregate deployment/session-pool budget, original-byte-aware parser integration,
and realistic multi-user/multi-process SQL/load evidence. The 2 MiB response guard
is measured after query execution; it is not a streaming or pre-execution memory
bound. High-volume fact/result memory behavior belongs in that activation load
proof. No production-readiness claim is made from mocked/IPC tests alone.
