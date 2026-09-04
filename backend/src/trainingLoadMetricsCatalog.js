// Training Load metrics catalog — domains, categories, definitions,
// immutable semantic versions, classification links, per-user hiding.
// Pure service functions (no req/res) except where visibility/ownership
// genuinely needs the caller's authz/session (kept explicit as `req`
// parameters, same convention as testsAccess.js's canManageSchedule(req,
// row)) — routes/trainingLoadMetrics.js calls these directly, and this
// file's own tests call them directly too, so there is exactly one
// implementation of the business logic, never a copy inside a route
// handler or a test harness.
import { query, pool } from "./db.js";
import { canManageCatalogRow, catalogVisibilitySql, resolveCatalogOwnerScope } from "./trainingLoadMetricsAccess.js";

const DEFAULT_ICON_URL = "/assets/icons/metric-default.svg";
const MAX_PAGE_SIZE = 100;
const DEFAULT_PAGE_SIZE = 30;

function clampPageSize(raw) {
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_PAGE_SIZE;
  return Math.min(n, MAX_PAGE_SIZE);
}

// ---------------------------------------------------------------
// Domains / Categories (identical shape, kept as two small tables)
// ---------------------------------------------------------------

async function listVisibleNodes(req, table, { activeOnly = true } = {}) {
  const params = [];
  const visSql = catalogVisibilitySql(req, "n", params);
  const activeSql = activeOnly ? "and n.is_active = true" : "";
  const result = await query(
    `select n.* from training_load.${table} n where ${visSql} ${activeSql} order by n.name`,
    params,
  );
  return result.rows;
}

async function createNode(req, table, body) {
  const name = String(body?.name || "").trim();
  if (!name) return { error: "Name is required.", status: 400 };
  const owner = resolveCatalogOwnerScope(req, body);
  if (owner.error) return owner;
  const result = await query(
    `insert into training_load.${table} (name, owner_scope, owner_user_id, owner_club_id, owner_team_id, created_by_user_id)
     values ($1,$2,$3,$4,$5,$6) returning *`,
    [name, owner.ownerScope, owner.ownerUserId, owner.ownerClubId, owner.ownerTeamId, req.user.id],
  );
  return { row: result.rows[0] };
}

async function archiveNode(req, table, id) {
  const existing = await query(`select * from training_load.${table} where id = $1`, [id]);
  const row = existing.rows[0];
  if (!row) return { error: "Not found.", status: 404 };
  if (!canManageCatalogRow(req, row)) return { error: "Outside your access.", status: 403 };
  const result = await query(`update training_load.${table} set is_active = false, updated_at = now() where id = $1 returning *`, [id]);
  return { row: result.rows[0] };
}

export const listDomains = (req) => listVisibleNodes(req, "metric_domains");
export const createDomain = (req, body) => createNode(req, "metric_domains", body);
export const archiveDomain = (req, id) => archiveNode(req, "metric_domains", id);

export const listCategories = (req) => listVisibleNodes(req, "metric_categories");
export const createCategory = (req, body) => createNode(req, "metric_categories", body);
export const archiveCategory = (req, id) => archiveNode(req, "metric_categories", id);

// ---------------------------------------------------------------
// Definitions + semantic versions
// ---------------------------------------------------------------

const VALUE_TYPES = new Set(["numeric", "boolean", "text"]);
const AGGREGATION_METHODS = new Set(["sum", "avg", "max", "last", "none"]);

function validateVersionInput(body) {
  const valueType = body?.valueType;
  if (!VALUE_TYPES.has(valueType)) return { error: "valueType must be one of numeric, boolean, text.", status: 400 };
  const aggregation = body?.dailyAggregationMethod || "sum";
  if (!AGGREGATION_METHODS.has(aggregation)) return { error: "dailyAggregationMethod must be one of sum, avg, max, last, none.", status: 400 };
  const minValue = body?.minValue === undefined || body?.minValue === null || body?.minValue === "" ? null : Number(body.minValue);
  const maxValue = body?.maxValue === undefined || body?.maxValue === null || body?.maxValue === "" ? null : Number(body.maxValue);
  if (minValue !== null && !Number.isFinite(minValue)) return { error: "minValue must be a real number.", status: 400 };
  if (maxValue !== null && !Number.isFinite(maxValue)) return { error: "maxValue must be a real number.", status: 400 };
  if (minValue !== null && maxValue !== null && minValue > maxValue) return { error: "minValue cannot exceed maxValue.", status: 400 };
  if (body?.conditionDescription !== undefined && body?.conditionDescription !== null && typeof body.conditionDescription !== "object") {
    return { error: "conditionDescription must be a JSON object.", status: 400 };
  }
  return {
    unit: body?.unit ? String(body.unit) : null,
    valueType,
    minValue,
    maxValue,
    conditionDescription: body?.conditionDescription ?? null,
    dailyAggregationMethod: aggregation,
  };
}

export async function listDefinitions(req, { search, ownerScope, state, cursor, limit } = {}) {
  const params = [];
  const visSql = catalogVisibilitySql(req, "d", params);
  // §6 fix: hideDefinitionForUser() wrote a real row to
  // metric_definition_hidden, but this default listing never read it back
  // — a hidden definition kept appearing for the very user who hid it.
  // Excluded here only (a direct GET /definitions/:id still resolves it —
  // hiding is a default-view convenience, never a real delete of shared
  // content, matching library.filter_hidden's own behavior).
  params.push(req.user.id);
  const hiddenSql = `not exists (select 1 from training_load.metric_definition_hidden h where h.definition_id = d.id and h.user_id = $${params.length})`;
  const conditions = [visSql, hiddenSql];
  if (state) {
    params.push(state);
    conditions.push(`d.state = $${params.length}`);
  } else {
    conditions.push(`d.state = 'active'`);
  }
  if (ownerScope) {
    params.push(ownerScope);
    conditions.push(`d.owner_scope = $${params.length}`);
  }
  if (search) {
    params.push(`%${search}%`);
    conditions.push(`(d.label ilike $${params.length} or d.key ilike $${params.length})`);
  }
  // Keyset pagination on (label, id) — never OFFSET, for a catalog that
  // may hold a large number of rows.
  if (cursor?.label !== undefined && cursor?.id) {
    params.push(cursor.label, cursor.id);
    conditions.push(`(d.label, d.id) > ($${params.length - 1}, $${params.length})`);
  }
  const pageSize = clampPageSize(limit);
  params.push(pageSize + 1);
  const result = await query(
    `select d.*, dv.unit, dv.value_type, dv.min_value, dv.max_value, dv.condition_description, dv.daily_aggregation_method, dv.version_number
     from training_load.metric_definitions d
     join training_load.metric_definition_versions dv on dv.id = d.current_version_id
     where ${conditions.join(" and ")}
     order by d.label, d.id
     limit $${params.length}`,
    params,
  );
  const rows = result.rows.slice(0, pageSize);
  const hasMore = result.rows.length > pageSize;
  const nextCursor = hasMore ? { label: rows[rows.length - 1].label, id: rows[rows.length - 1].id } : null;
  return { rows, nextCursor };
}

export async function getDefinition(req, id) {
  const result = await query(
    `select d.*, dv.unit, dv.value_type, dv.min_value, dv.max_value, dv.condition_description, dv.daily_aggregation_method, dv.version_number
     from training_load.metric_definitions d
     join training_load.metric_definition_versions dv on dv.id = d.current_version_id
     where d.id = $1`,
    [id],
  );
  const row = result.rows[0];
  if (!row) return null;
  const params = [];
  const visSql = catalogVisibilitySql(req, "d2", params);
  params.push(id);
  const visibleCheck = await query(
    `select 1 from training_load.metric_definitions d2 where d2.id = $${params.length} and ${visSql}`,
    params,
  );
  if (!visibleCheck.rowCount) return null;
  return row;
}

export async function createDefinition(req, body) {
  const key = String(body?.key || "").trim();
  const label = String(body?.label || "").trim();
  if (!key) return { error: "key is required.", status: 400 };
  if (!label) return { error: "label is required.", status: 400 };
  const versionInput = validateVersionInput(body);
  if (versionInput.error) return versionInput;
  const owner = resolveCatalogOwnerScope(req, body);
  if (owner.error) return owner;

  const client = await pool.connect();
  try {
    await client.query("begin");
    const defResult = await client.query(
      `insert into training_load.metric_definitions
         (key, label, short_label, description, icon_url, owner_scope, owner_user_id, owner_club_id, owner_team_id, created_by_user_id)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning *`,
      [
        key, label, body?.shortLabel ? String(body.shortLabel) : null, body?.description ? String(body.description) : null,
        body?.iconUrl ? String(body.iconUrl) : null,
        owner.ownerScope, owner.ownerUserId, owner.ownerClubId, owner.ownerTeamId, req.user.id,
      ],
    );
    const definition = defResult.rows[0];
    const versionResult = await client.query(
      `insert into training_load.metric_definition_versions
         (metric_definition_id, version_number, unit, value_type, min_value, max_value, condition_description, daily_aggregation_method, created_by_user_id)
       values ($1,1,$2,$3,$4,$5,$6,$7,$8) returning *`,
      [
        definition.id, versionInput.unit, versionInput.valueType, versionInput.minValue, versionInput.maxValue,
        versionInput.conditionDescription ? JSON.stringify(versionInput.conditionDescription) : null,
        versionInput.dailyAggregationMethod, req.user.id,
      ],
    );
    await client.query(`update training_load.metric_definitions set current_version_id = $1 where id = $2`, [versionResult.rows[0].id, definition.id]);
    await client.query("commit");
    return { row: { ...definition, current_version_id: versionResult.rows[0].id, ...toVersionFields(versionResult.rows[0]) } };
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

function toVersionFields(v) {
  return {
    unit: v.unit, value_type: v.value_type, min_value: v.min_value, max_value: v.max_value,
    condition_description: v.condition_description, daily_aggregation_method: v.daily_aggregation_method, version_number: v.version_number,
  };
}

// Cosmetic-only edit: label/short_label/description/icon_url. Never
// touches current_version_id or creates a new version row.
export async function updateDefinitionCosmetic(req, id, body) {
  const existing = await query(`select * from training_load.metric_definitions where id = $1`, [id]);
  const row = existing.rows[0];
  if (!row) return { error: "Not found.", status: 404 };
  if (!canManageCatalogRow(req, row)) return { error: "Outside your access.", status: 403 };
  const label = body?.label !== undefined ? String(body.label).trim() : row.label;
  if (!label) return { error: "label cannot be empty.", status: 400 };
  const result = await query(
    `update training_load.metric_definitions
       set label = $1, short_label = $2, description = $3, icon_url = $4, updated_at = now()
     where id = $5 returning *`,
    [
      label,
      body?.shortLabel !== undefined ? (body.shortLabel ? String(body.shortLabel) : null) : row.short_label,
      body?.description !== undefined ? (body.description ? String(body.description) : null) : row.description,
      body?.iconUrl !== undefined ? (body.iconUrl ? String(body.iconUrl) : null) : row.icon_url,
      id,
    ],
  );
  return { row: result.rows[0] };
}

export async function archiveDefinition(req, id) {
  const existing = await query(`select * from training_load.metric_definitions where id = $1`, [id]);
  const row = existing.rows[0];
  if (!row) return { error: "Not found.", status: 404 };
  if (!canManageCatalogRow(req, row)) return { error: "Outside your access.", status: 403 };
  const result = await query(`update training_load.metric_definitions set state = 'archived', updated_at = now() where id = $1 returning *`, [id]);
  return { row: result.rows[0] };
}

// Semantic change: unit / value type / bounds / condition / aggregation.
// ALWAYS inserts a brand-new, immutable version row and repoints
// current_version_id — never edits an existing version in place. Every
// metric_values row already captured under the OLD version stays
// interpreted against that old version's own semantics forever.
export async function createDefinitionVersion(req, id, body) {
  const existing = await query(`select * from training_load.metric_definitions where id = $1`, [id]);
  const row = existing.rows[0];
  if (!row) return { error: "Not found.", status: 404 };
  if (!canManageCatalogRow(req, row)) return { error: "Outside your access.", status: 403 };
  const versionInput = validateVersionInput(body);
  if (versionInput.error) return versionInput;

  const client = await pool.connect();
  try {
    await client.query("begin");
    const currentVersionResult = await client.query(
      `select version_number from training_load.metric_definition_versions where metric_definition_id = $1 order by version_number desc limit 1 for update`,
      [id],
    );
    const nextNumber = (currentVersionResult.rows[0]?.version_number || 0) + 1;
    const versionResult = await client.query(
      `insert into training_load.metric_definition_versions
         (metric_definition_id, version_number, unit, value_type, min_value, max_value, condition_description, daily_aggregation_method, superseded_reason, created_by_user_id)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning *`,
      [
        id, nextNumber, versionInput.unit, versionInput.valueType, versionInput.minValue, versionInput.maxValue,
        versionInput.conditionDescription ? JSON.stringify(versionInput.conditionDescription) : null,
        versionInput.dailyAggregationMethod, body?.reason ? String(body.reason) : null, req.user.id,
      ],
    );
    await client.query(`update training_load.metric_definitions set current_version_id = $1, updated_at = now() where id = $2`, [versionResult.rows[0].id, id]);
    await client.query("commit");
    return { row: versionResult.rows[0] };
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function listDefinitionVersions(req, id) {
  const visible = await getDefinition(req, id);
  if (!visible) return null;
  const result = await query(`select * from training_load.metric_definition_versions where metric_definition_id = $1 order by version_number`, [id]);
  return result.rows;
}

// ---------------------------------------------------------------
// Per-user "hide this from my catalog view" — never a real delete of
// shared content.
// ---------------------------------------------------------------

export async function hideDefinitionForUser(req, definitionId) {
  await query(
    `insert into training_load.metric_definition_hidden (user_id, definition_id) values ($1,$2) on conflict (user_id, definition_id) do nothing`,
    [req.user.id, definitionId],
  );
  return { hidden: true };
}

export async function unhideDefinitionForUser(req, definitionId) {
  await query(`delete from training_load.metric_definition_hidden where user_id = $1 and definition_id = $2`, [req.user.id, definitionId]);
  return { hidden: false };
}

// ---------------------------------------------------------------
// Structure links — read-time visibility independently re-checks EVERY
// non-null target (domain/category/definition), never just the link's own
// scope — a LEFT JOIN (not INNER) so a domain-only/category-only link
// with metric_definition_id NULL is never silently dropped.
// ---------------------------------------------------------------

export async function listStructureLinks(req, { domainId, categoryId, definitionId } = {}) {
  const params = [];
  const linkVis = catalogVisibilitySql(req, "l", params);
  const domainVis = catalogVisibilitySql(req, "d", params);
  const categoryVis = catalogVisibilitySql(req, "c", params);
  const defVis = catalogVisibilitySql(req, "df", params);
  const conditions = [
    linkVis,
    `(d.id is null or (${domainVis}))`,
    `(c.id is null or (${categoryVis}))`,
    `(df.id is null or (${defVis}))`,
  ];
  if (domainId) {
    params.push(domainId);
    conditions.push(`l.domain_id = $${params.length}`);
  }
  if (categoryId) {
    params.push(categoryId);
    conditions.push(`l.category_id = $${params.length}`);
  }
  if (definitionId) {
    params.push(definitionId);
    conditions.push(`l.metric_definition_id = $${params.length}`);
  }
  const result = await query(
    `select l.* from training_load.metric_structure_links l
     left join training_load.metric_domains d on d.id = l.domain_id
     left join training_load.metric_categories c on c.id = l.category_id
     left join training_load.metric_definitions df on df.id = l.metric_definition_id
     where ${conditions.join(" and ")}
     order by l.created_at`,
    params,
  );
  return result.rows;
}

export async function createStructureLink(req, body) {
  if (!body?.domainId && !body?.categoryId && !body?.metricDefinitionId) {
    return { error: "At least one of domainId, categoryId, metricDefinitionId is required.", status: 400 };
  }
  const owner = resolveCatalogOwnerScope(req, body);
  if (owner.error) return owner;
  // Visibility check on each requested target — creating a link requires
  // only READ visibility of the target (classification, not a security
  // boundary), never manage rights over it. The DB's own write-time
  // breadth trigger (metric_structure_links_scope_breadth) additionally
  // rejects a link whose OWN scope would exceed a private target's
  // visibility footprint.
  for (const [field, table] of [["domainId", "metric_domains"], ["categoryId", "metric_categories"], ["metricDefinitionId", "metric_definitions"]]) {
    const targetId = body?.[field];
    if (!targetId) continue;
    const params = [];
    const visSql = catalogVisibilitySql(req, "t", params);
    params.push(targetId);
    const visible = await query(`select 1 from training_load.${table} t where t.id = $${params.length} and ${visSql}`, params);
    if (!visible.rowCount) return { error: "Referenced target is outside your access.", status: 404 };
  }
  try {
    const result = await query(
      `insert into training_load.metric_structure_links
         (domain_id, category_id, metric_definition_id, temporal_smoothing_enabled, owner_scope, owner_user_id, owner_club_id, owner_team_id, created_by_user_id)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning *`,
      [
        body.domainId || null, body.categoryId || null, body.metricDefinitionId || null, Boolean(body.temporalSmoothingEnabled),
        owner.ownerScope, owner.ownerUserId, owner.ownerClubId, owner.ownerTeamId, req.user.id,
      ],
    );
    return { row: result.rows[0] };
  } catch (error) {
    if (error?.code === "23505") return { error: "This classification link already exists.", status: 409 };
    if (error?.code === "P0001") return { error: error.message, status: 400 };
    throw error;
  }
}

export async function deleteStructureLink(req, id) {
  const existing = await query(`select * from training_load.metric_structure_links where id = $1`, [id]);
  const row = existing.rows[0];
  if (!row) return { error: "Not found.", status: 404 };
  if (!canManageCatalogRow(req, row)) return { error: "Outside your access.", status: 403 };
  await query(`delete from training_load.metric_structure_links where id = $1`, [id]);
  return { deleted: true };
}

export { DEFAULT_ICON_URL };
