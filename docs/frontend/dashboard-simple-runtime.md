# Dashboards 2.0 — S2c backend runtime candidate

This candidate connects the existing S2a/S2b/S2c factories to the actual server.
It adds no Simple Editor UI, KPI width migration, Pages or evaluator capability.
It is disabled by default. It does not authorize production configuration,
migration, merge or deployment.

## Routes and modes

The prefix is `/api/training-load/dashboards/:dashboardId/simple`.
Authenticated calls use GET capabilities, POST validate/preview, POST widgets,
PUT widgets/:widgetId and POST requests/status. Parent/workspace/actor checks
remain in the existing services; the runtime adds no authorization bypass.
The mount runs after CORS and with auth middleware, before the global JSON
parser. Preview preserves its 64 KiB raw byte limit; save preserves 96 KiB.

`DASHBOARD_SIMPLE_MODE` accepts exactly:

| Value | Behavior |
| --- | --- |
| `off` or absent | No new route mount, signing key read or schema checkout |
| `preview` | Validate/preview available; new saves refused; recorded replay/status retained |
| `enabled` | Preview and fresh atomic saves available after startup checks |
| `drain` | New preview/save refused; authenticated status and recorded replay retained without signing keys |

Drain preserves the service's recorded-receipt-before-token ordering. It is not
a database rollback. It does not make an unknown COMMIT equivalent to rollback,
and clients must not substitute a fresh request ID for an uncertain request.
Off removes these new routes completely; drain is the recovery-oriented mode.

## Explicit operator configuration

Preview/enabled require every field below. No values are installed by this PR.

| Name | Contract |
| --- | --- |
| `DASHBOARD_SIMPLE_BUDGET_VERIFIED` | Literal `true`, after the total deployment/database budget is reviewed |
| `DASHBOARD_SIMPLE_SESSION_AFFINITY_VERIFIED` | Literal `true`, after confirming a supported PostgreSQL connection topology |
| `DASHBOARD_SIMPLE_PREVIEW_MAX_ACTIVE` | Integer 1–16, identical deployment budget for all instances |
| `DASHBOARD_SIMPLE_KEY_ID` | 1–64 characters, letters/digits/underscore/hyphen |
| `DASHBOARD_SIMPLE_KEY_BASE64` | Canonical base64 for a dedicated 32–4096 byte key |
| `DASHBOARD_SIMPLE_VERIFICATION_KEYS_JSON` | Optional JSON map of at most 16 previous IDs to `{keyBase64,retiredAt}` |

Previous entries have exactly those two fields and canonical ISO retirement
timestamps. The token service rejects retirement in the future and applies its
ten-minute verification-only window. Keys do not fall back to session secrets,
persist in a new DB table, regenerate at restart, or appear in configuration
errors. Ordinary restarts require the same key configuration. Mixed key IDs
during rolling rotation require a reviewed rotation/drain procedure.

Configuration attestation is an operator gate, not automatic proof of production
capacity or a custom proxy's behavior. The runtime refuses the known transaction
pool port 6543 and `pgbouncer=true` before checkout; screening a port is not a
general topology detector. This first runtime candidate targets verified direct
or session-pool connections. A broader pooler support claim requires its own
integration evidence. `drain` needs neither signing nor preview configuration.

Active modes fail startup with a sanitized configuration error if the exact S2c
migration identity/checksum, presentation column, receipt relation or writer
signature is absent. The probe is a bounded read-only transaction. It does not
apply migrations or replace full migration preflight. `npm start` still runs the
repository migrator before server startup; enabling a mode is not authorization
for those migration side effects.

## Deployment-wide admission

The PostgreSQL adapter uses one checked-out connection for both admission and
preview. It begins READ ONLY REPEATABLE READ before taking transaction advisory
locks and exposes that owned transaction through a trusted one-use query pool.
The preview transaction wrapper reuses it. Rollback after preview work releases
the locks; abort, error or failed cleanup destroys the client. No session-level
advisory lock is intended to survive a transaction, and no coordination table,
DDL or application data write is introduced.

A stable namespace protects one active preview per authenticated UUID across
processes, a bounded deployment slot set, and a shared budget-configuration tag.
Different active budget tags refuse acquisition. Reconfigure only after draining
old leases and deploy a consistent budget to all processes; refusal is safe but
does not guarantee availability during mixed configuration. The process ID is
server-generated and must match the trusted admission caller. Request bodies
cannot choose a user, process limit or deployment budget.

Acquisition has one 400 ms deadline, with the existing 500 ms admission wrapper
as an outer bound. Busy/errors return sanitized 429. Late checkouts are destroyed,
release is idempotent, and query cleanup precedes lease release. The local limit
remains `min(2,floor((POOL_MAX-1)/2))`; it is conservative even though the adapter
reuses the query connection. PG_POOL_MAX is not increased by the runtime.

## Activation limits

Runtime construction and local tests do not measure production DB grants, total
web/cron/overlap session capacity, realistic fact volume or memory/SLO bounds.
Before activation, freeze the final integrated commit, rerun the real schema
checks, review the complete connection budget, verify key distribution/rotation
and measure the selected workload. S3a client work and its browser/mobile UX
review remain separately approved work. All optional Pages/reference/rule
capabilities stay unchanged.

Rollback first drains new work while preserving receipts/status/replay. Do not
improvise a down migration or delete the receipt ledger. Binary rollback needs a
compatibility trial against the retained schema and presentation values. A full
backup restore can discard later valid writes and requires a separate decision.
