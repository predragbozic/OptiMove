# Architecture decisions

Each ADR here is provable by current code, a merged migration, or a merged PR — not a
plan or a preference. A superseded decision keeps its file and gets `Status: Superseded`
plus a link to what replaced it; it is never deleted.

`CLAUDE.md` links here but does not import every ADR automatically — read the table, then
open the specific ADR(s) relevant to the task at hand.

| ID | Odluka | Status | Datum | Dokaz | Supersedes / Superseded by |
|---|---|---|---|---|---|
| [ADR-001](ADR-001-canonical-activity-layer.md) | Training Activity je kanonski activity sloj; `training.canonical_activity_results()` je jedina tačka spajanja RPE/metrika/component performance po aktivnosti | Active | 2026-09-07 | `migrations_v2/202609071300_training_activity_v4_canonical_functions.sql`; `backend/src/trainingActivityResults.js`; `backend/src/trainingLoadDashboardQuery.js` | — |
| [ADR-002](ADR-002-owner-scope-vs-data-workspace.md) | `owner_scope` (ko upravlja) i `data_workspace` (koji podaci se čitaju) su dve nezavisne autorizacione provere, nikad jedna jednakost | Active | 2026-09-10 | `migrations_v2/202609100900_training_load_v15_dashboard_catalog_and_dashboards.sql`; `backend/src/trainingLoadDashboardAccess.js`; `backend/src/routes/trainingLoadDashboard.js` | — |
| [ADR-003](ADR-003-dashboard-sanctioned-writes.md) | Dashboard/widget/series/active-selection mutacije isključivo kroz sankcionisane Postgres funkcije, lock order dashboard→widget→series, sa jednim dokumentovanim izuzetkom (`cloneDashboard`) | Active | 2026-09-10 | `migrations_v2/202609101000_training_load_v16_dashboard_widgets_series_selection.sql`; `migrations_v2/202609101100_training_load_v17_dashboard_sanctioned_functions.sql`; `backend/src/trainingLoadDashboardCatalog.js`; `backend/src/trainingLoadDashboardWidgets.js` | — |
| [ADR-004](ADR-004-rpe-srpe-storage.md) | RPE/sRPE/duration žive isključivo u `training_load.session_feedback` (sRPE je generated kolona); dashboard ih čita preko `canonical_activity_results()`, bez kopije u `metric_values` | Active | 2026-08-31 | `migrations_v2/202608310900_training_load_v1_session_feedback.sql`; `backend/src/trainingLoadDashboardQuery.js` | — |
| [ADR-005](ADR-005-append-only-migration-policy.md) | Append-only, checksum-zaštićena migraciona politika — već primenjena migracija je nepromenljiva | Active | 2026-09-14 (verified) | `backend/src/migrate.js`; svi fajlovi u `migrations_v2/` | — |
| [ADR-006](ADR-006-info-hiding-authorization.md) | Nepostojeći i tuđi (drugi workspace) resurs vraćaju identičan `404 {error:"notFound"}` | Active | 2026-09-10 | `backend/src/routes/trainingLoadDashboard.js` (`requireManageableDashboard`); `backend/src/trainingActivityMaterialize.js` | — |

## Adding a new ADR

1. Confirm the decision is actually implemented — cite the migration/code/merged PR, not
   a plan.
2. Number it sequentially, `ADR-0NN-short-slug.md`, max 120 lines.
3. Add a row to the table above.
4. If it replaces an earlier ADR, set both files' Supersedes/Superseded-by fields and
   change the old one's Status to `Superseded` — don't delete it.
