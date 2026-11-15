# Dashboard Simple editor S3a

S3a connects the existing single-dashboard UI to the gated Simple runtime. It is stacked on the S2c runtime branch, with S1.1 pinned at `26162ae8f266eb24c88c601c8d4e8b9f1ca59be7`. It does not activate the runtime or change deployment configuration.

The existing Add widget and Settings actions discover capabilities for the selected dashboard. A missing runtime returns to the existing guided editor. A mounted runtime offers three steps: metric, athletes and period, display. Advanced settings remain available, with confirmation before discarding the Simple draft. Complex, unresolved and multi-series widgets use Advanced instead of being flattened.

## Catalog and preview

`GET /api/training-load/dashboards/:dashboardId/simple/metrics` exposes the existing target-bound reader. Queries accept `search`, `afterId`, `limit` (1–100) and `dataScopeLevel`. Unknown, repeated, malformed and conflicting fields are rejected after target authorization. The exclusive `metricDefinitionId` query returns one authorized active metric, allowing an existing selection beyond the first catalog page to retain its metadata. No query accepts an owner or workspace override.

The UI starts without a selected metric. Built-in metadata, including nullable units, comes from capabilities. Custom metrics require an explicit analytical aggregation; daily aggregation metadata is not used as an analytical default. Ambiguous scopes require an explicit choice. The server remains the authority for validation and compilation.

Preview changes are debounced by 350 ms. The controller keeps at most one preview request in flight, waits for its response before starting the next, and ignores obsolete draft or context responses. Workspace identity, dashboard, runtime filters and concrete period bind the UI draft. Athletes inherit dashboard filters by default; selecting none is not interpreted as all authorized. Fixed replacement dates are explicitly labelled as a personal period change for the entire dashboard after successful save.

Every returned preview row remains available in an escaped accessible table, including zero, negative values, nulls, arrays and problem flags. Complete result details remain available. This phase uses the existing saved-widget renderers and does not implement the S3b chart composer or S3c formatting evaluator.

## Save and recovery

Capabilities now include `atomicSave`. It is true only when verified preview dependencies and enabled-mode save activation are both present. Preview-only and drain modes do not offer a fresh save.

The final Save action constructs one request ID and retains the exact serialized payload, server-issued timestamp, resolved period, preview token and input. A transport error, uncertain server failure or in-progress response locks editing and navigation. Authorization or workspace denial also retains that request: receipt verification can be denied after COMMIT, so a 401/404 alone does not establish rollback. Only explicit precommit validation/conflict errors release a first request. Retry sends the same payload and request ID. Status `notRecorded` is presented as inconclusive, never proof of rollback. A recorded receipt completes the flow before reloading the saved dashboard. A stale widget revision requires reopening, without overwriting the newer server widget. Unsaved or uncertain editor state participates in leave and browser-unload guards.

Keyboard focus stays within the dialog and returns to its opener when closed. Native form controls, labelled scrollable result regions and responsive CSS support the mobile layout.

## Activation boundary

No migration, key, persistent environment value, production write, merge or deployment is performed by this change. The existing runtime remains off by default. Local synthetic UI fixtures and disposable PostgreSQL tests do not establish production load capacity, production connection topology or operator readiness. Those remain separate activation gates. S2d, S3b, S3c, persisted Pages and release remain outside this change.
