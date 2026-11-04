// Training Load Analysis Dashboard — dashboard lifecycle: list, detail,
// create, update metadata, clone, archive, and active-selection
// get/set/clear. Every WRITE below calls exactly one of the 15 sanctioned
// SQL functions from migrations_v2's v17 migration — never a raw INSERT/
// UPDATE/DELETE against training_load.dashboards/dashboard_active_
// selection — with ONE documented exception: cloneDashboard() below, a
// genuine multi-table composite transaction (1 dashboard + N widgets + N
// series, with live template-binding re-resolution) that cannot be
// expressed as a single set-based function call; see its own header
// comment for the guarantees it upholds in place of a sanctioned function.
// Pure service functions taking an already-resolved req/scope/context —
// routes/trainingLoadDashboard.js resolves workspace exactly once per
// request and threads the SAME snapshot through authorization, read, and
// write.
import { query, pool } from "./db.js";
import {
  canManageDashboardRow, canViewDashboardRow, dashboardManageBasis, dashboardVisibilitySql, dataWorkspaceMatches,
  resolveDashboardCreateContext,
} from "./trainingLoadDashboardAccess.js";
import { resolveTemplateSeriesBatchForWorkspace } from "./trainingLoadDashboardWidgets.js";
import { isSourceConnectionVisibleToDashboard,isMetricVisibleToDashboard } from "./trainingLoadDashboardAccess.js";
import { requireLegacySinglePage } from './dashboardPages/legacyGuard.js';
import { withPreviewTransaction } from './dashboardSimple/previewTransaction.js';
import { authorizePages } from './dashboardPages/access.js';
import { copyDashboardPages,enterClonePage } from './dashboardPages/clonePages.js';
import { runDashboardCloneTransaction } from './dashboardPages/cloneTransaction.js';
import { canonicalKey } from './dashboardSimple/compiler.js';

function httpError(status, message, code) {
  const e = new Error(message);
  e.httpStatus = status;
  if (code) e.code = code;
  return e;
}

// Deliberately the SAME 404 whether a dashboard doesn't exist or merely
// isn't visible to this account — knowing a valid UUID for someone else's
// private dashboard must not distinguish "not found" from "not yours".
async function fetchVisibleDashboard(req, dataWorkspace, dashboardId, queryRunner = query) {
  const r = await queryRunner(`select * from training_load.dashboards where id = $1`, [dashboardId]);
  const row = r.rows[0];
  if (!row || !canViewDashboardRow(req, row, dataWorkspace)) throw httpError(404, "Dashboard not found.");
  return row;
}

// ------------------------------------------------------------
// List / detail
// ------------------------------------------------------------

export async function listDashboards(req, dataWorkspace, { includeTemplates = true, includeArchived = false } = {}) {
  const params = [];
  const visSql = dashboardVisibilitySql(req, dataWorkspace, "d", params);
  const statusSql = includeArchived ? "true" : `d.status = 'active'`;
  const r = await query(
    `select d.id, d.name, d.description, d.owner_scope, d.owner_user_id, d.owner_club_id, d.owner_team_id,
            d.data_workspace_type, d.data_workspace_scope_id, d.is_template, d.status, d.cloned_from_dashboard_id,
            d.revision, d.created_by_user_id, d.created_at, d.updated_at
     from training_load.dashboards d
     where (${visSql}) and (${statusSql}) ${includeTemplates ? "" : "and d.is_template = false"}
     order by d.updated_at desc`,
    params,
  );
  return { dashboards: r.rows };
}

export async function getDashboardDetail(req, dataWorkspace, dashboardId) {
  return withPreviewTransaction({ pool, transactionTimeoutMs: 5000, statementTimeoutMs: 3000 }, async query => {
    const dashboard = await fetchVisibleDashboard(req, dataWorkspace, dashboardId, query);
    const pageId = await requireLegacySinglePage(query, dashboard);
    const widgets = await query(
      `select id, widget_type, title, widget_order, x, y, width, height, mobile_order, group_by, state, display_config, presentation_config, local_filter_override, revision
       from training_load.dashboard_widgets where dashboard_id = $1${pageId ? ' and page_id = $2' : ''} order by widget_order`,
      pageId ? [dashboardId, pageId] : [dashboardId],
    );
    const widgetIds = widgets.rows.map((w) => w.id);
    let seriesByWidget = new Map();
    if (widgetIds.length) {
      const series = await query(
        `select id, widget_id, series_order, metric_definition_id, built_in_series_key, template_metric_key_hints,
                resolution_status, template_resolution_candidates, axis, color, display_label, source_policy,
                source_connection_id, data_scope_level, analytical_aggregation, aggregation_role_policy, coverage_policy, comparison_period
         from training_load.dashboard_widget_series where widget_id = any($1::uuid[]) order by widget_id, series_order`,
        [widgetIds],
      );
      for (const s of series.rows) {
        if (!seriesByWidget.has(s.widget_id)) seriesByWidget.set(s.widget_id, []);
        seriesByWidget.get(s.widget_id).push(s);
      }
    }
    return {
      dashboard,
      widgets: widgets.rows.map((w) => ({ ...w, series: seriesByWidget.get(w.id) || [] })),
    };
  });
}

// ------------------------------------------------------------
// Create / update / archive
// ------------------------------------------------------------

// The filter shape both dashboards.default_filter and dashboard_widgets.
// local_filter_override carry — three optional, independently-clearable
// keys. Validated the same way at every write site (dashboard metadata
// PATCH, widget create/update) so an invalid filter is always a clean 400,
// never a value that silently corrupts the query engine's own effective-
// filter merge (trainingLoadDashboardQuery.js's mergeFilters).
const FILTER_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function validFilterShape(value) {
  if (value === null || value === undefined) return true;
  if (typeof value !== "object" || Array.isArray(value)) return false;
  const allowed = new Set(["athleteIds", "activityId", "componentId"]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) return false;
  }
  if ("athleteIds" in value && value.athleteIds !== null && !(Array.isArray(value.athleteIds) && value.athleteIds.length <= 500 && value.athleteIds.every((v) => typeof v === "string" && FILTER_UUID_RE.test(v)))) return false;
  if ("activityId" in value && value.activityId !== null && !FILTER_UUID_RE.test(value.activityId)) return false;
  if ("componentId" in value && value.componentId !== null && !FILTER_UUID_RE.test(value.componentId)) return false;
  return true;
}

export async function createDashboard(req, body) {
  const ctx = await resolveDashboardCreateContext(req, body);
  if (ctx.error) throw httpError(ctx.status, ctx.error);
  if (!body?.name || typeof body.name !== "string" || body.name.trim().length < 1 || body.name.length > 200) {
    throw httpError(400, "name is required (1-200 characters, not whitespace-only).");
  }
  if (body.description !== undefined && body.description !== null && typeof body.description !== "string") {
    throw httpError(400, "description must be a string or null.");
  }
  // POST /dashboards previously silently ignored defaultFilter — now
  // validated and persisted just like PATCH's own defaultFilter handling.
  if (body.defaultFilter !== undefined && !validFilterShape(body.defaultFilter)) {
    throw httpError(400, "defaultFilter is invalid.");
  }
  const r = await query(
    `select * from training_load.create_dashboard($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [
      body.name.trim(), body.description ?? null, ctx.ownerScope, ctx.ownerUserId, ctx.ownerClubId, ctx.ownerTeamId,
      ctx.dataWorkspaceType, ctx.dataWorkspaceScopeId, ctx.isTemplate, req.user.id,
      body.defaultFilter ? JSON.stringify(body.defaultFilter) : null,
    ],
  );
  return { dashboard: r.rows[0] };
}

// PATCH semantics (merge-readiness corrective round, finding #7): one
// rule, applied consistently — an ABSENT key means no change, an
// explicit `null` means clear, any other value means replace. There is
// no separate client-facing clearDescription/clearDefaultFilter field
// anymore (a request that still sends one is rejected as an unknown key
// by the route layer) — the p_clear_* flags the SQL function takes are
// an internal JS<->SQL contract, derived here from hasOwnProperty+null.
export async function updateDashboardMetadata(req, dataWorkspace, dashboardId, body) {
  const row = await fetchVisibleDashboard(req, dataWorkspace, dashboardId);
  if (!canManageDashboardRow(req, row)) throw httpError(403, "Forbidden.");
  if (!Number.isSafeInteger(body?.expectedRevision) || body.expectedRevision < 1) {
    throw httpError(400, "expectedRevision must be a positive integer.");
  }
  if (body.name !== undefined && (typeof body.name !== "string" || body.name.trim().length < 1 || body.name.length > 200)) {
    throw httpError(400, "name must be 1-200 characters, not whitespace-only.");
  }
  const hasDescription = Object.prototype.hasOwnProperty.call(body, "description");
  if (hasDescription && body.description !== null && typeof body.description !== "string") {
    throw httpError(400, "description must be a string or null.");
  }
  const clearDescription = hasDescription && body.description === null;
  const hasDefaultFilter = Object.prototype.hasOwnProperty.call(body, "defaultFilter");
  if (hasDefaultFilter && body.defaultFilter !== null && !validFilterShape(body.defaultFilter)) {
    throw httpError(400, "defaultFilter is invalid.");
  }
  const clearDefaultFilter = hasDefaultFilter && body.defaultFilter === null;
  if (body.isTemplate !== undefined && typeof body.isTemplate !== "boolean") {
    throw httpError(400, "isTemplate must be a strict boolean.");
  }
  if (body.isTemplate === false && row.owner_scope === "system") {
    throw httpError(400, "A system dashboard is always a template.");
  }
  try {
    const r = await query(
      `select * from training_load.update_dashboard_metadata($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        dashboardId, body.expectedRevision, body.name !== undefined ? body.name.trim() : null,
        body.description ?? null, clearDescription,
        body.defaultFilter ? JSON.stringify(body.defaultFilter) : null, clearDefaultFilter,
        body.isTemplate ?? null,
      ],
    );
    return { dashboard: r.rows[0] };
  } catch (error) {
    if (error?.code === "40001") throw httpError(409, "Stale revision — reload and retry.", "staleRevision");
    if (error?.code === "40002") throw httpError(409, "This dashboard is archived and is read-only.", "dashboardArchived");
    throw error;
  }
}

export async function archiveDashboard(req, dataWorkspace, dashboardId, { expectedRevision }) {
  const row = await fetchVisibleDashboard(req, dataWorkspace, dashboardId);
  if (!canManageDashboardRow(req, row)) throw httpError(403, "Forbidden.");
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
    throw httpError(400, "expectedRevision must be a positive integer.");
  }
  try {
    const r = await query(`select * from training_load.archive_dashboard($1, $2)`, [dashboardId, expectedRevision]);
    return { dashboard: r.rows[0] };
  } catch (error) {
    if (error?.code === "40001") throw httpError(409, "Stale revision — reload and retry.", "staleRevision");
    throw error;
  }
}

// Permanent delete (v19) — irreversible, unlike archiveDashboard() above:
// the row, every one of its widgets and series (dashboard_widgets/
// dashboard_widget_series cascade automatically, v16), and any active-
// selection pointing at it (cleared by delete_dashboard() itself, before
// the delete, in the same transaction — see that migration's own header)
// are all gone. Deliberately NOT gated by assert_dashboard_writable() —
// an archived dashboard can (and typically will) be the one being
// permanently deleted; Archive stays the reversible, softer action.
//
// Every permanent delete is recorded in training_load.dashboard_deletion_log
// (who, on what authority, what, when) by delete_dashboard() itself, in the
// same transaction - a refused or rolled-back delete leaves no record.
//
// A system template can NEVER be deleted — checked here unconditionally,
// for every caller including a platform admin (who otherwise passes
// canManageDashboardRow for every row): a deliberate carve-out with no
// exception, not an authorization gap.
export async function deleteDashboard(req, dataWorkspace, dashboardId, { expectedRevision }) {
  const row = await fetchVisibleDashboard(req, dataWorkspace, dashboardId);
  // Checked BEFORE the manage check (code-reviewer): a system template is
  // visible to every account, so answering it with the same 409 for
  // everyone leaks nothing - and every caller gets one consistent reason.
  if (row.owner_scope === "system") throw httpError(409, "System templates cannot be permanently deleted.", "systemTemplateProtected");
  if (!canManageDashboardRow(req, row)) throw httpError(403, "Forbidden.");
  const authorizedVia = dashboardManageBasis(req, row);
  // Defensive: the two helpers must agree; never log a delete without a basis.
  if (!authorizedVia) throw httpError(403, "Forbidden.");
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
    throw httpError(400, "expectedRevision must be a positive integer.");
  }
  try {
    await query(`select * from training_load.delete_dashboard($1, $2, $3, $4)`, [dashboardId, expectedRevision, req.user.id, authorizedVia]);
    return { deleted: true, dashboardId };
  } catch (error) {
    if (error?.code === "40001") throw httpError(409, "Stale revision — reload and retry.", "staleRevision");
    // Deleted by a concurrent request while this one waited on the row
    // lock (delete_dashboard raises P0002) - the same info-hiding 404 as
    // any dashboard that does not exist.
    if (error?.code === "P0002") throw httpError(404, "Dashboard not found.");
    // dashboards.cloned_from_dashboard_id is ON DELETE RESTRICT and
    // immutable (v15) — a dashboard that has been cloned from cannot be
    // deleted without breaking that lineage guarantee. Surfaced as a
    // clean, specific conflict rather than the generic 400 the route's
    // default SQLSTATE mapping would otherwise give a raw 23503.
    // Matched by constraint NAME, not just SQLSTATE: any other 23503 (a
    // future FK, or the active-selection RESTRICT if delete_dashboard()
    // ever stopped clearing it first) must never be misreported as
    // "has clones" - it falls through to the route's generic mapping.
    if (error?.code === "23503" && error?.constraint === "dashboards_cloned_from_dashboard_id_fkey") {
      throw httpError(409, "This dashboard has been cloned into other dashboards and cannot be permanently deleted. Archive it instead.", "dashboardHasClones");
    }
    throw error;
  }
}

// ------------------------------------------------------------
// Clone — the REAL clone service the design proof explicitly left as
// future application logic (DASHBOARD_MODEL_REPORT.md §0-R4.7): inserts
// the new dashboard (cloned_from_dashboard_id set, firing the real
// snapshot-semantics/lock trigger), copies every widget's layout/content,
// and for each series either copies a workspace-agnostic binding as-is
// (built-in) or genuinely RE-RESOLVES its template_metric_key_hints
// against the NEW dashboard's own data workspace (never trusting the
// template's own binding blindly) — a hint resolving to zero/one/many
// candidates lands the new series in 'unresolved'/'resolved'/'ambiguous'
// exactly like every other binding decision in this model. The whole
// operation is one transaction: either every widget/series lands, or
// none do.
//
// The bounded transaction first locks fresh actor/organization authority,
// then takes FOR SHARE on the source before reading its Page/widget graph.
// Concurrent hierarchy writers take the dashboard FOR UPDATE and must wait.
// An archived source cannot be cloned
// (finding #1). default_filter is copied along with name/description/
// widgets/series (previously silently dropped). A pinned source
// connection (source_policy='source_connection') that is not active and
// visible in the TARGET workspace aborts the WHOLE clone atomically with
// 409 sourceConnectionResolutionRequired — never a silent policy change
// or a substituted connection (finding #6).
// ------------------------------------------------------------
export async function cloneDashboard(req, dataWorkspace, templateId, body) {
  const originalReq=req;
  let completed;
  const scope = workspace => Object.fromEntries(['type','dataWorkspaceType','dataWorkspaceScopeId','dataWorkspaceUserId','athleteWorkspaceAthleteId'].map(key=>[key,workspace[key]??null]));
  return runDashboardCloneTransaction({pool,write:async queryRunner=>{
    const c={query:queryRunner};
    let fresh=await authorizePages(queryRunner,originalReq,templateId,{mode:'read',lock:true,requirePages:false,lockOrganizations:false});
    const teamIds=[...new Set([fresh.workspace.type==='team'?fresh.workspace.dataWorkspaceScopeId:null,fresh.dashboard.owner_team_id,body?.ownerTeamId].filter(Boolean))].sort();
    const clubIds=[...new Set([fresh.workspace.type==='club'?fresh.workspace.dataWorkspaceScopeId:null,fresh.dashboard.owner_club_id,body?.ownerClubId].filter(Boolean))].sort();
    for(const[table,ids]of [['teams',teamIds],['clubs',clubIds]])if(ids.length){const rows=(await queryRunner(`select id from public.${table} where id=any($1::uuid[]) and coalesce(is_active,true) order by id for share`,[ids])).rows;if(rows.length!==ids.length)throw httpError(404,'Dashboard not found.');}
    fresh=await authorizePages(queryRunner,originalReq,templateId,{mode:'read',requirePages:false});
    if(canonicalKey(scope(fresh.workspace))!==canonicalKey(scope(dataWorkspace)))throw httpError(404,'Dashboard not found.');
    req=fresh.req;
    const templateResult = await c.query(`select * from training_load.dashboards where id = $1 for share`, [templateId]);
    const templateRow = templateResult.rows[0];
    if (!templateRow) throw httpError(404, "Template not found.");
    if (!templateRow.is_template && templateRow.pages_revision===undefined) throw httpError(400, "That dashboard is not a template.");
    if (!templateRow.is_template && !canManageDashboardRow(req,templateRow)) throw httpError(404, "Dashboard not found.");
    if (!canViewDashboardRow(req, templateRow, dataWorkspace)) throw httpError(404, "Template not found.");
    if (templateRow.status === "archived") throw httpError(409, "That template is archived and cannot be cloned.", "dashboardArchived");

    // Pass the ALREADY-RESOLVED dataWorkspace (the route resolved it once)
    // through to resolveDashboardCreateContext, instead of letting its own
    // 'user' branch resolve it AGAIN — resolveActiveWorkspace() must be
    // called exactly once per request (finding #3). A workspace-preference
    // change racing mid-request can therefore never hand this one request
    // two disagreeing snapshots.
    const ctx = await resolveDashboardCreateContext(req, { ...body, ownerScope: body?.ownerScope ?? "user" }, fresh.workspace);
    if (ctx.error) throw httpError(ctx.status, ctx.error);
    const name = body?.name || `${templateRow.name} (copy)`;
    if (typeof name !== "string" || name.trim().length < 1 || name.length > 200) {
      throw httpError(400, "name must be 1-200 characters, not whitespace-only.");
    }

    // The dashboard/widget/series inserts below are ONE documented,
    // explicit composite-transaction exception to the "every write goes
    // through a sanctioned SQL function" rule (see v17's own header note
    // on create_dashboard/update_dashboard_metadata) — clone is
    // inherently a multi-table operation (1 dashboard + N widgets + N
    // series) with live template-binding re-resolution baked in, which
    // cannot be expressed as a single set-based function call. The
    // template row is already locked (FOR SHARE, above) BEFORE this
    // insert and before any widget/series is read — genuinely
    // dashboard-first. ctx.isTemplate (never a hardcoded false) lets a
    // clone become a NEW template in its own target owner scope, exactly
    // like a fresh create — already gated by the SAME manage-rights check
    // resolveDashboardCreateContext applies to every owner scope.
    const dash = await c.query(
      `insert into training_load.dashboards (name, description, owner_scope, owner_user_id, owner_club_id, owner_team_id, data_workspace_type, data_workspace_scope_id, is_template, default_filter, created_by_user_id, cloned_from_dashboard_id)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) returning *`,
      [name.trim(), templateRow.description, ctx.ownerScope, ctx.ownerUserId, ctx.ownerClubId, ctx.ownerTeamId, ctx.dataWorkspaceType, ctx.dataWorkspaceScopeId, ctx.isTemplate, templateRow.default_filter, req.user.id, templateRow.is_template?templateId:null],
    );
    const newDashboard = dash.rows[0];
    const pageMap=await copyDashboardPages(queryRunner,templateRow,newDashboard);

    const widgets = await c.query(`select * from training_load.dashboard_widgets where dashboard_id = $1 order by widget_order,id limit 6401`, [templateId]);
    if(widgets.rows.length>6400)throw httpError(409,'Dashboard is too large to clone.','dashboardTooLarge');
    if(pageMap){const counts=new Map();for(const w of widgets.rows){counts.set(w.page_id,(counts.get(w.page_id)??0)+1);if(counts.get(w.page_id)>200)throw httpError(409,'Page is too large to clone.','pageTooLarge');}}
    const widgetIdMap = new Map();
    const seriesIdMap = {};
    const pageByWidget = new Map();
    for (const w of widgets.rows) {
      const pageId=pageMap?.get(w.page_id);
      if(pageMap && !pageId)throw httpError(404,'Page not found.');
      await enterClonePage(queryRunner,newDashboard.id,pageId);
      const nw = await c.query(
        `insert into training_load.dashboard_widgets (dashboard_id, widget_type, title, widget_order, x, y, width, height, mobile_order, group_by, state, display_config, local_filter_override, presentation_config${pageMap?',page_id':''})
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,null${pageMap?',$14':''}) returning id`,
        [newDashboard.id, w.widget_type, w.title, w.widget_order, w.x, w.y, w.width, w.height, w.mobile_order, w.group_by, w.state, w.display_config, w.local_filter_override,...(pageMap?[pageId]:[])],
      );
      widgetIdMap.set(w.id, nw.rows[0].id);
      pageByWidget.set(w.id,pageId);
    }

    const series = await c.query(`select * from training_load.dashboard_widget_series where widget_id = any($1::uuid[]) order by series_order`, [widgets.rows.map((w) => w.id)]);
    if(pageMap){
      const metricIds=[...new Set(series.rows.map(s=>s.metric_definition_id).filter(Boolean))].sort();
      if(metricIds.length)await queryRunner('select id from training_load.metric_definitions where id=any($1::uuid[]) order by id for share',[metricIds]);
      const metadata=metricIds.length?(await queryRunner('select d.id,d.key,v.value_type,v.unit from training_load.metric_definitions d join training_load.metric_definition_versions v on v.id=d.current_version_id where d.id=any($1::uuid[]) order by d.id',[metricIds])).rows:[];
      for(const s of series.rows){
        if(!s.metric_definition_id || s.template_metric_key_hints)continue;
        const binding=await isMetricVisibleToDashboard(newDashboard,s.metric_definition_id,queryRunner);
        if(!templateRow.is_template && binding.visible && binding.def?.state==='active')continue;
        const metric=metadata.find(m=>m.id===s.metric_definition_id);
        if(!metric)throw httpError(404,'Metric not found.');
        s.template_metric_key_hints=[{key:metric.key,valueType:metric.value_type,unit:metric.unit,scopeLevel:s.data_scope_level}];
      }
    }

    // ONE batch resolution call for EVERY hint-bearing series in this
    // clone — not one call (and its own 1-2 internal SQL statements) PER
    // series (finding #6). resolveTemplateSeriesBatchForWorkspace() itself
    // issues at most 3 set-based statements with the clone definition lock, however
    // many series/hints it holds.
    const hintBearingSpecs = series.rows.filter((s) => s.template_metric_key_hints).map((s) => ({ sourceSeriesId: s.id, hints: s.template_metric_key_hints }));
    const batchResolved = hintBearingSpecs.length
      ? await resolveTemplateSeriesBatchForWorkspace(c, hintBearingSpecs, { dataWorkspaceType: ctx.dataWorkspaceType, dataWorkspaceScopeId: ctx.dataWorkspaceScopeId, ownerUserId: ctx.ownerUserId, lockCatalog:true })
      : new Map();

    const cloneReport = [];
    for (const s of series.rows) {
      const newWidgetId = widgetIdMap.get(s.widget_id);
      await enterClonePage(queryRunner,newDashboard.id,pageByWidget.get(s.widget_id));

      // Portable source-connection contract (finding #6) — applies to
      // EVERY non-built-in series path below. A pinned connection is
      // NEVER silently dropped, re-policied, or swapped for another one:
      // if it isn't active and visible in the TARGET workspace, the
      // WHOLE clone aborts atomically. `newDashboard` already exists at
      // this point (inserted above) and carries the target's own owner_
      // scope/owner_user_id/data_workspace_*, so it can stand in directly
      // for a "dashboard row" argument to isSourceConnectionVisibleToDashboard.
      if (s.source_policy === "source_connection" && s.source_connection_id) {
        await c.query('select id from training_load.metric_source_connections where id=$1 for share',[s.source_connection_id]);
        const connCheck = await isSourceConnectionVisibleToDashboard(newDashboard, s.source_connection_id,queryRunner);
        if (!connCheck.visible || !connCheck.conn || connCheck.conn.state !== "active") {
          throw httpError(409, "A pinned source connection could not be resolved (active and visible) in the target workspace.", "sourceConnectionResolutionRequired");
        }
      }

      if (s.built_in_series_key) {
        const inserted=await c.query(
          `insert into training_load.dashboard_widget_series (widget_id, series_order, built_in_series_key, resolution_status, axis, color, display_label, source_policy, source_connection_id, data_scope_level, analytical_aggregation, aggregation_role_policy, coverage_policy, comparison_period, created_by_user_id)
           values ($1,$2,$3,'resolved',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) returning id`,
          [newWidgetId, s.series_order, s.built_in_series_key, s.axis, s.color, s.display_label, s.source_policy, s.source_connection_id, s.data_scope_level, s.analytical_aggregation, s.aggregation_role_policy, s.coverage_policy, s.comparison_period, req.user.id],
        );
        seriesIdMap[s.id]=inserted.rows[0].id;
        cloneReport.push({ sourceSeriesId: s.id, resolution: "built_in" });
        continue;
      }
      if (s.template_metric_key_hints) {
        // Genuine re-resolution against the NEW dashboard's own workspace
        // — the template's own (possibly stale, possibly workspace-
        // agnostic) binding is never trusted directly. A metric-backed
        // template series ALWAYS carries hints now (add_series() (v17)
        // auto-snapshots them server-side) so this branch is the normal
        // path for every portable metric-backed template series, not just
        // hint-only unresolved/ambiguous ones. `resolved` came from the
        // ONE batch call above, not a per-series resolution.
        const resolved = batchResolved.get(s.id);
        const inserted=await c.query(
          `insert into training_load.dashboard_widget_series (widget_id, series_order, metric_definition_id, template_metric_key_hints, resolution_status, template_resolution_candidates, axis, color, display_label, source_policy, source_connection_id, data_scope_level, analytical_aggregation, aggregation_role_policy, coverage_policy, comparison_period, created_by_user_id)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) returning id`,
          [
            newWidgetId, s.series_order,
            resolved.status === "resolved" ? resolved.candidateIds[0] : null,
            // s.template_metric_key_hints was deserialized to a real JS
            // array by pg on the SELECT above — must be re-stringified
            // before being re-inserted as a jsonb value, or `pg` silently
            // encodes it as a Postgres ARRAY literal instead of JSON
            // (22P02 invalid input syntax for type json).
            JSON.stringify(s.template_metric_key_hints),
            resolved.status,
            resolved.status === "ambiguous" ? JSON.stringify(resolved.candidateIds) : null,
            s.axis, s.color, s.display_label, s.source_policy, s.source_connection_id, s.data_scope_level, s.analytical_aggregation, s.aggregation_role_policy, s.coverage_policy, s.comparison_period, req.user.id,
          ],
        );
        seriesIdMap[s.id]=inserted.rows[0].id;
        cloneReport.push({ sourceSeriesId: s.id, resolution: resolved.status });
        continue;
      }
      // A plain resolved series with no hints at all — defensive fallback
      // for hint-less legacy data only (every metric-backed series
      // added through addSeries() to a template now always carries
      // hints). The metric-visibility/active-state/type-compat triggers
      // still re-validate it live against the NEW dashboard.
      const inserted=await c.query(
        `insert into training_load.dashboard_widget_series (widget_id, series_order, metric_definition_id, resolution_status, axis, color, display_label, source_policy, source_connection_id, data_scope_level, analytical_aggregation, aggregation_role_policy, coverage_policy, comparison_period, created_by_user_id)
         values ($1,$2,$3,'resolved',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) returning id`,
        [newWidgetId, s.series_order, s.metric_definition_id, s.axis, s.color, s.display_label, s.source_policy, s.source_connection_id, s.data_scope_level, s.analytical_aggregation, s.aggregation_role_policy, s.coverage_policy, s.comparison_period, req.user.id],
      );
      seriesIdMap[s.id]=inserted.rows[0].id;
      cloneReport.push({ sourceSeriesId: s.id, resolution: "copied" });
    }
    for (const sourceWidget of widgets.rows) {
      await enterClonePage(queryRunner,newDashboard.id,pageByWidget.get(sourceWidget.id));
      await c.query(
        `update training_load.dashboard_widgets as cloned_widget
         set presentation_config = ${pageMap?'training_load.dashboard_page_remap_presentation(source_widget.presentation_config,$3::jsonb)':'source_widget.presentation_config'}
         from training_load.dashboard_widgets as source_widget
         where cloned_widget.id = $1 and source_widget.id = $2`,
        [widgetIdMap.get(sourceWidget.id), sourceWidget.id,...(pageMap?[JSON.stringify(seriesIdMap)]:[])],
      );
    }
    if(pageMap)await queryRunner("select set_config('training_load.page_mutation','',true)");
    const current=(await queryRunner('select * from training_load.dashboards where id=$1',[newDashboard.id])).rows[0];
    completed={dashboard:current,cloneReport,...(pageMap?{pageIdMapping:Object.fromEntries(pageMap)}:{}),...(!templateRow.is_template?{copiedFromDashboardId:templateId}:{})};return completed;
  },verify:async()=>{
    if(!completed)return null;
    return withPreviewTransaction({pool},async q=>{
      const fresh=await authorizePages(q,originalReq,templateId,{mode:'read',requirePages:false});
      if(canonicalKey(scope(fresh.workspace))!==canonicalKey(scope(dataWorkspace)))throw httpError(404,'Dashboard not found.');
      const row=(await q('select * from training_load.dashboards where id=$1 and cloned_from_dashboard_id is not distinct from $2::uuid',[completed.dashboard.id,completed.dashboard.cloned_from_dashboard_id])).rows[0];
      return row && canManageDashboardRow(fresh.req,row)?{...completed,dashboard:row}:null;
    });
  }});
}

// ------------------------------------------------------------
// Active dashboard selection.
// ------------------------------------------------------------

export async function getActiveDashboard(req, dataWorkspace) {
  if (dataWorkspace.type === null) throw httpError(403, "No active workspace.");
  const scopeId = dataWorkspace.dataWorkspaceScopeId ?? null;
  const r = await query(
    `select s.dashboard_id, d.name, d.revision, d.status
     from training_load.dashboard_active_selection s
     join training_load.dashboards d on d.id = s.dashboard_id
     where s.user_id = $1 and s.workspace_type = $2 and s.scope_id is not distinct from $3`,
    [req.user.id, dataWorkspace.dataWorkspaceType, scopeId],
  );
  return { activeDashboard: r.rows[0] || null };
}

export async function setActiveDashboard(req, dataWorkspace, dashboardId) {
  if (dataWorkspace.type === null) throw httpError(403, "No active workspace.");
  const row = await fetchVisibleDashboard(req, dataWorkspace, dashboardId);
  // Info-hiding 404, never 400/403 (finding #1) — fetchVisibleDashboard's
  // own canViewDashboardRow already lets a platform admin (or, for a
  // club/team dashboard, anyone with manage rights) see the STRUCTURE of
  // a dashboard whose data workspace does not match their own CURRENT
  // one; setting it active is a further, stricter gate that must never
  // reveal whether the mismatch was "wrong workspace" vs "doesn't exist".
  if (!dataWorkspaceMatches(dataWorkspace, row)) throw httpError(404, "Dashboard not found.");
  try {
    const r = await query(
      `select * from training_load.set_active_dashboard($1, $2, $3, $4)`,
      [req.user.id, dataWorkspace.dataWorkspaceType, dataWorkspace.dataWorkspaceScopeId ?? null, dashboardId],
    );
    return { selection: r.rows[0] };
  } catch (error) {
    if (error?.code === "P0001") throw httpError(409, "That dashboard cannot be selected as active for this workspace.", "selectionRejected");
    throw error;
  }
}

export async function clearActiveDashboard(req, dataWorkspace) {
  if (dataWorkspace.type === null) throw httpError(403, "No active workspace.");
  const r = await query(
    `select * from training_load.clear_active_dashboard($1, $2, $3)`,
    [req.user.id, dataWorkspace.dataWorkspaceType, dataWorkspace.dataWorkspaceScopeId ?? null],
  );
  return { cleared: r.rows[0]?.cleared === true };
}

export { httpError };
