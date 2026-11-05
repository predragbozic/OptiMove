# What is source-neutral and what is still GPEXE-specific (read-only discovery)

Asked by the owner (2026-11-05, via the *Rukovodilac*): which parts of the import path would a second data source (Catapult, Polar, Kinexon, Garmin, …) reuse, and what would it have to add. **Status: findings only; no code, no decision.** Verified against `origin/main` `003d1fab` by reading migrations and modules; no production read, no source request. Names are as they exist in the repository today.

## 1. Already source-neutral (keyed by `source_system`, no source name in the object)

| Area | Where | Note |
|---|---|---|
| Host catalog | `training_load.source_host_catalog` (`source_system`, `host_key`, `api_family`); `backend/src/sourceHosts.js` (exact-host allowlist, profile per host: base URL, API family with its one path prefix, auth scheme, exchange) | A source is a new catalog row plus one code profile; never a typed URL. Today only `gpexe` rows exist (`e03`, `server3`). |
| Connection and credential | `source_credential_connections` (+ `sourceCredentialCrypto.js`, AES-256-GCM), `source_connection_audit`; routes `/api/training-load/sources/:source/connections…` (connect, reconnect, test, bindings, unbind); `sourceConnectionService.js` | `:source` is a path parameter and `source_system` a column; the exchange rules (form body, token field) come from the host profile. Two credential kinds exist (`api_token`, `exchanged_token`); a source with OAuth would need a third. |
| Team binding | `source_team_bindings` (`source_system`, one active binding per team and source, one OptiMove team per source team) | The "visible ids" limitation (task #189) is about GPEXE's one-account-many-teams shape; another source decides its own. |
| Read adapters | `sourceAdapters.js`: `SOURCE_ADAPTERS[source][apiFamily]` | The registry is generic; the only adapter is `gpexeRestV1Adapter.js`. The adapter contract (the read set: session list in a window, session, athletes, tracks, thresholds, drills) is GPEXE-shaped, not a neutral interface. |
| Source fields and mappings | `source_metric_definitions` / `_definition_versions` (`source_system`, `api_family`, evidence status, unit, meaning), `source_metric_mappings` and their versions, activations (T5, per binding), copies, `source_metric_audit`, `unit_conversions`; services `sourceMetric*`, `sourceFieldVerificationService.js`, `sourceRevisionLifecycleService.js`; routes `/sources/metrics/*` | The whole variable-mapping machinery (J8-J17) is source-neutral by design (ADR-007); a new source adds its own field rows with owner-run evidence (C97), never a canonical variable. |
| Metrics Core and provenance | `metric_definitions`, scopes, domains, categories, `metric_value_source_provenance`, `metric_source_connections`, `metric_source_identities`, `metric_event_source_bindings` | Canonical registry and the append-only fact provenance; several sources may fill one variable without merging. |
| Activities | `training.canonical_activity_results()`, `activity_source_observations`, the roster contract (5a) | Source-agnostic by ADR-001; the roster treats the source as "a record", not GPEXE. |

## 2. Still GPEXE-specific

| Area | Where | What ties it to GPEXE |
|---|---|---|
| Import state | `gpexe_import_checks`, `_check_observations`, `_candidates`, `_approvals`, `_approvers`, `gpexe_retention_runs`, `gpexe_import_prerequisite_records` | Names, `gpexe_team_session_id`, GPEXE session/drill snapshot shape, and many triggers/functions that test `source_system = 'gpexe'` (v20, v24, v30, v31, v33). A second source would need the same tables again or a migration adding `source_system` to them. |
| Athlete link and identity | `gpexe_athlete_links`, `gpexe_athlete_identities` / `_requests` / `_suppressions` (v32), U3 suggestions | The link key is the GPEXE athlete id; the identity snapshot reads `rest/v1/athlete/<id>/`. |
| Team settings | `gpexe_team_settings` (+ history), the F3b settings route, the approved pair (v30) | One GPEXE Team ID per team; the platform-admin approval of "OptiMove team <-> source team" is stored here. |
| Import switch (U2) | `gpexe_team_import_switch` (+ history), `team_import_switch` service, the approver function and its bases | The switch, the conditions (backup, restore probe, wrong-link procedure, archived-team stop) and the approval bases are one per team, not per source; a second source on the same team has no switch of its own. |
| Check pipeline | `gpexeImportService.js` (check, candidates, approve, batch), `gpexeClient.js` (the `e03` client), `gpexeImportMapper.js` / `gpexeImportWriter.js` / `gpexeImportPreview.js` / `gpexeImportMapping.js`, `sourceImportCredentialResolver.js`, the whole-list window rule (PR #148) | The mapper turns one GPEXE team session (+ drills, + athlete sessions) into events and values; the resolver only resolves a GPEXE binding; the check rules (two complete reads, drill projection, drill-parameter guard) are GPEXE findings. |
| Routes | `/api/training-load/gpexe/teams/:teamId/*` (status, checks, candidates, imports, athlete-links, source-athletes, athlete-identities, athlete-pair-suggestions, import-switch) | Source name in the path. |
| Frontend | `gpexe-import-*.js`, `gpexe-guide-*.js`, `team-import-switch-*.js`; `IMPORT_SOURCES = [{ key: "gpexe", … }]` (one card), `/sources/gpexe/connections` fixed in `metric-mappings-data.js` | The Imports screen is built around one source card; the connections screen already takes the source as data. |

## 3. What a second source would have to bring

1. **A host profile**: a catalog row and a `sourceHosts.js` entry (base URL, API family, auth scheme and how a credential is obtained; OAuth needs a new credential kind and a refresh path).
2. **A read adapter** for that family, with its own contract tests, and an owner-run capability probe like F3c2b (what the API really answers; nothing assumed from GPEXE).
3. **A mapper** from the source's session shape to the importer's plan (events, participants, segments, values), and a decision on how its athletes are linked (an id, a name, a date of birth) and whether an identity snapshot is needed.
4. **Source fields with evidence** (T2a/T2b rows, units and meanings confirmed by the owner-run procedure of C97), then system mappings and activations - no migration of the mapping tables.
5. **Import state**: either the `gpexe_*` import tables are generalised with a `source_system` column (a large ★★ migration touching approvals, retention and many triggers) or the second source gets parallel tables; this is the real decision, and it should be taken before any adapter work.
6. **The same safety rules** restated per source: per-team switch and conditions (U2), the wrong-link procedure (U5), retention, the legal basis for personal data of that source (C123 covers the club's own members, not a new data class).
7. **Screens**: a second source card on Imports, a source picker in the guide, the connections screen already generic.

## 4. Recommendation and open questions (for the owner, via the *Rukovodilac*)

- The cheap, safe part is already done: connections, bindings, adapters registry, fields, mappings, activations, provenance are neutral. The expensive part is the **import layer** (section 2, first three rows): it was built, correctly, for one source, one session shape and one link key.
- **Q1:** generalise the import tables (one migration, one pipeline) or keep GPEXE as it is and build a second pipeline beside it? Recommendation: decide after the first controlled GPEXE import (the pipeline is still unproven in production), and only for a concrete second source.
- **Q2:** which source first, and does it expose athletes by an id, by name, or both (this decides the link key and whether U3-style matching is needed)?
- **Q3:** is the import switch per team (as U2) or per team and source?

## 5. The owner's decisions (2026-11-05, relayed by the *Rukovodilac*)

- **Q1 (answered):** a second source gets its **own parallel import flow**, with the same scheme per source card on Imports. The owner: "verovatno napraviti drugi tok uvoza podataka… kada dođe novi izvor onda bi trebalo razmišljati o kreiranju novog povezivanja sa njegovim serverom i verovatno bi po sličnom principu se to uvozilo. Mi bi kliknuli na izvor pa uvezli podatke sa tog izvora, nakon toga bi verovatno kliknuli na drugi izvor i uvozili sa drugog izvora." So the import layer is not generalised now: a second pipeline is built beside GPEXE when a concrete source arrives, behind a new connection to that source's server.
- **Q3 (the *Rukovodilac*'s recommendation, to be confirmed when a second source arrives):** the import switch becomes per team and source.
- **Q2 (open):** which source comes second, and whether it exposes athletes by id, by name or both.
