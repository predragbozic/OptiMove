// Domains and categories of canonical variables (phase 12b; the contract is J6,
// docs/ai/phase12-domains-categories-contract.md, decision C101 of
// docs/ai/gpexe-metric-variable-mapping-discovery.md).
//
// The canonical part of the v10 classification: a domain or category owned by
// the system or a club, and a link with such an owner, written only here, by
// the M3-0 admins (O1), each write one transaction that ends with its request
// row (migration v41: the change row is the database's, the request row names
// it, both are checked again in the database). A team coach reads the club's
// classification in its team workspace and writes nothing (O1). The older
// Metrics Core API keeps team and user classification and refuses the
// canonical one (O7, trainingLoadMetricsCatalog.js).
//
// Lock order of a write: the per-user advisory lock and the request record
// (runWrite); then the node row FOR UPDATE (rename, archive, restore), or a
// new link's targets FOR SHARE in the order domain, category, variable, or a
// removed link's row FOR UPDATE; then the rights FOR SHARE (rightsStillHold:
// user, club). The v41 guards lock the same targets again, already held.
import { adminWriteKit, SourceMetricMappingError, TEXT_LIMITS } from "./sourceMetricMappingService.js";
import { KEY_RULE, suggestVariableKey } from "./canonicalVariableAdminService.js";

const {
  runWrite, boundedRead, rightsStillHold, refusal, NOT_FOUND, MESSAGES, plainObject, uuidField, boundedText, boundedOut,
  hashOf, UUID,
} = adminWriteKit;

const CONTRACT = "metric-classification/v1";
// Every read is bounded (C70): at most this many domains, categories and
// category -> domain links each; `truncated` says that more exist.
export const CLASSIFICATION_CAP = 500;
const NAME_MAX = TEXT_LIMITS.label;
const DESCRIPTION_MAX = TEXT_LIMITS.description;
const NAMES_TOKEN = /^[0-9a-f]{64}$/;

const KINDS = Object.freeze({
  domain: { table: "training_load.metric_domains", column: "domain_id", plural: "domains" },
  category: { table: "training_load.metric_categories", column: "category_id", plural: "categories" },
});

const TEXT = {
  invalid_name: `name is one line of 1-${NAME_MAX} visible characters without surrounding spaces.`,
  invalid_description: `description is one line of 1-${DESCRIPTION_MAX} visible characters without surrounding spaces, or null.`,
  invalid_reason: `reason is one line of 1-${TEXT_LIMITS.reason} visible characters without surrounding spaces.`,
  invalid_key: "key is 1-63 characters: a lower-case letter, then lower-case letters, digits or underscores.",
  key_required: "No key can be made from this name; give the key.",
  key_taken: "This owner already has a domain or category with this key.",
  node_changed: "The name or description changed since it was read; read it again.",
  rename_unchanged: "The rename changes nothing.",
  node_not_active: "The domain or category is archived; restore it first.",
  node_active: "The domain or category is already active.",
  node_archived: "A link never points at an archived domain or category.",
  variable_not_active: "A link never points at an archived variable.",
  link_outside_owner: "A link stays inside its owner: the category or domain it adds to is this workspace's own.",
  category_has_domain: "The category already sits under a domain; remove that link first.",
  link_exists: "This link already exists.",
  link_shape: "A link names exactly two of variableId, categoryId and domainId.",
};

const isCoachView = (ctx) => ctx.view === "coach";
// O1: every write is an admin's; a team workspace (the coach's reduced view)
// gets the identical 404 for each.
function adminOnly(ctx) {
  if (isCoachView(ctx) || ctx.basis === "team_coach") throw NOT_FOUND();
}
const isOwn = (row, ctx) => row.owner_scope === ctx.owner.scope && (row.owner_scope === "system" || String(row.owner_club_id) === ctx.owner.clubId);
// The owners a workspace reads: the system's; in a club's workspace also the
// club's own (C88's reference rule). Never a team or user row.
function readableSql(ctx, alias, params) {
  if (ctx.owner.scope === "system") return `${alias}.owner_scope = 'system'`;
  params.push(ctx.owner.clubId);
  return `(${alias}.owner_scope = 'system' or (${alias}.owner_scope = 'club' and ${alias}.owner_club_id = $${params.length}::uuid))`;
}
function ownSql(ctx, alias, params) {
  if (ctx.owner.scope === "system") return `${alias}.owner_scope = 'system'`;
  params.push(ctx.owner.clubId);
  return `(${alias}.owner_scope = 'club' and ${alias}.owner_club_id = $${params.length}::uuid)`;
}
const invalidBody = (message) => refusal(400, "invalid_body", message);
const namesTokenOf = (row) => hashOf([row.name, row.description ?? null, row.is_active]);

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------
const NODE_COLUMNS = "n.id, n.key, n.name, n.description, n.owner_scope, n.owner_club_id, n.is_active, n.created_at, n.updated_at";
function actionsOf(row, ctx, editable) {
  if (!editable || isCoachView(ctx)) return [];
  return row.is_active ? ["rename", "archive"] : ["restore"];
}
function nodeOut(row, ctx) {
  const editable = isOwn(row, ctx) && !isCoachView(ctx);
  const key = boundedOut(row.key, TEXT_LIMITS.key);
  const name = boundedOut(row.name, NAME_MAX);
  const description = boundedOut(row.description ?? null, DESCRIPTION_MAX);
  return {
    id: row.id, key: key.text, name: name.text, description: description.text, ownerScope: row.owner_scope,
    state: row.is_active ? "active" : "archived", editable, actions: actionsOf(row, ctx, editable),
    namesToken: namesTokenOf(row), truncated: key.cut || name.cut || description.cut,
  };
}
function linkOut(row, ctx) {
  const editable = isOwn(row, ctx) && !isCoachView(ctx);
  return {
    id: row.id, variableId: row.metric_definition_id ?? null, categoryId: row.category_id ?? null, domainId: row.domain_id ?? null,
    ownerScope: row.owner_scope, editable, actions: editable ? ["remove"] : [],
  };
}

// ---------------------------------------------------------------------------
// C1: GET /classification
// ---------------------------------------------------------------------------
export async function getClassification({ ctx, query }) {
  for (const key of Object.keys(query ?? {})) {
    if (key) throw refusal(400, "invalid_query", "The query carries a parameter this route does not take.");
  }
  return boundedRead(async (client) => {
    const read = async (table) => {
      const params = [];
      const readable = readableSql(ctx, "n", params);
      params.push(CLASSIFICATION_CAP + 1);
      return (await client.query(
        `select ${NODE_COLUMNS} from ${table} n where ${readable} order by n.owner_scope desc, n.name, n.id limit $${params.length}`,
        params,
      )).rows;
    };
    const domains = await read(KINDS.domain.table);
    const categories = await read(KINDS.category.table);
    const params = [];
    const readable = readableSql(ctx, "l", params);
    params.push(CLASSIFICATION_CAP + 1);
    const links = (await client.query(
      `select l.id, l.domain_id, l.category_id, l.metric_definition_id, l.owner_scope, l.owner_club_id
         from training_load.metric_structure_links l
        where ${readable} and l.metric_definition_id is null and l.domain_id is not null and l.category_id is not null
        order by l.created_at, l.id limit $${params.length}`,
      params,
    )).rows;
    return {
      domains: domains.slice(0, CLASSIFICATION_CAP).map((row) => nodeOut(row, ctx)),
      categories: categories.slice(0, CLASSIFICATION_CAP).map((row) => nodeOut(row, ctx)),
      categoryDomains: links.slice(0, CLASSIFICATION_CAP).map((row) => linkOut(row, ctx)),
      truncated: domains.length > CLASSIFICATION_CAP || categories.length > CLASSIFICATION_CAP || links.length > CLASSIFICATION_CAP,
    };
  });
}

// A variable's classification (C6): its links of the readable owners - the
// categories and domains it sits under directly, and the domains of those
// categories (O2: a variable's domain follows from variable -> category ->
// domain).
export async function variableClassification(client, ctx, variableId) {
  const params = [variableId];
  const linkReadable = readableSql(ctx, "l", params);
  const rows = (await client.query(
    `select l.id as link_id, l.category_id, l.domain_id,
            c.key as c_key, c.name as c_name, c.is_active as c_active, c.owner_scope as c_owner,
            d.key as d_key, d.name as d_name, d.is_active as d_active, d.owner_scope as d_owner
       from training_load.metric_structure_links l
       left join training_load.metric_categories c on c.id = l.category_id
       left join training_load.metric_domains d on d.id = l.domain_id
      where l.metric_definition_id = $1 and ${linkReadable}
      order by l.created_at, l.id
      limit ${CLASSIFICATION_CAP}`,
    params,
  )).rows;
  const categoryIds = rows.filter((r) => r.category_id).map((r) => r.category_id);
  let via = [];
  if (categoryIds.length) {
    const viaParams = [categoryIds];
    const viaReadable = readableSql(ctx, "l", viaParams);
    via = (await client.query(
      `select l.category_id, l.domain_id, d.key as d_key, d.name as d_name, d.is_active as d_active, d.owner_scope as d_owner
         from training_load.metric_structure_links l
         join training_load.metric_domains d on d.id = l.domain_id
        where l.category_id = any($1::uuid[]) and l.metric_definition_id is null and l.domain_id is not null and ${viaReadable}`,
      viaParams,
    )).rows;
  }
  const named = (key, name) => ({ key: boundedOut(key, TEXT_LIMITS.key).text, name: boundedOut(name, NAME_MAX).text });
  return {
    categories: rows.filter((r) => r.category_id).map((r) => ({
      linkId: r.link_id, id: r.category_id, ...named(r.c_key, r.c_name), state: r.c_active ? "active" : "archived", ownerScope: r.c_owner,
    })),
    domains: [
      ...rows.filter((r) => r.domain_id).map((r) => ({
        linkId: r.link_id, id: r.domain_id, ...named(r.d_key, r.d_name), state: r.d_active ? "active" : "archived", ownerScope: r.d_owner,
        viaCategoryId: null,
      })),
      ...via.map((r) => ({
        linkId: null, id: r.domain_id, ...named(r.d_key, r.d_name), state: r.d_active ? "active" : "archived", ownerScope: r.d_owner,
        viaCategoryId: r.category_id,
      })),
    ],
  };
}

// The filter of GET /variables (C6): variables linked to the category; or to
// the domain directly or through one of its categories. Only links of the
// readable owners count.
export function classificationFilterSql(ctx, filter, params) {
  if (filter.categoryId) {
    params.push(filter.categoryId);
    const idx = params.length;
    const readable = readableSql(ctx, "fl", params);
    return `exists (select 1 from training_load.metric_structure_links fl
                     where fl.metric_definition_id = d.id and fl.category_id = $${idx}::uuid and ${readable})`;
  }
  params.push(filter.domainId);
  const idx = params.length;
  const direct = readableSql(ctx, "fl", params);
  const first = readableSql(ctx, "f1", params);
  const second = readableSql(ctx, "f2", params);
  return `(exists (select 1 from training_load.metric_structure_links fl
                    where fl.metric_definition_id = d.id and fl.domain_id = $${idx}::uuid and ${direct})
           or exists (select 1 from training_load.metric_structure_links f1
                        join training_load.metric_structure_links f2
                          on f2.category_id = f1.category_id and f2.metric_definition_id is null and f2.domain_id = $${idx}::uuid
                       where f1.metric_definition_id = d.id and f1.category_id is not null and ${first} and ${second}))`;
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------
const CLASSIFICATION_REQUESTS = Object.freeze({
  find: `select r.operation, r.request_hash, c.object_kind, c.domain_id, c.category_id, c.metric_definition_id, c.link_id,
                c.owner_scope, c.owner_club_id
           from training_load.metric_classification_requests r
           join training_load.metric_classification_changes c on c.id = r.metric_classification_change_id
          where r.requested_by_user_id = $1 and r.request_key = $2`,
  exists: `select 1 from training_load.metric_classification_requests where requested_by_user_id = $1 and request_key = $2`,
});
const idsOf = (written) => {
  if (written.object_kind === "link") return { linkId: written.link_id ?? null };
  if (written.object_kind === "domain") return { domainId: written.domain_id ?? null };
  return { categoryId: written.category_id ?? null };
};

const BASIS_CHANGED = "metric classification request: the basis is not the acting user's own";
const KEY_INDEXES = new Set(["metric_domains_canonical_key_unique", "metric_categories_canonical_key_unique"]);
const RETRY_CONSTRAINTS = new Set(["metric_classification_requests_one_per_key", "metric_classification_changes_one_seq"]);
// Only allowlisted database refusals become a 4xx; everything else is a
// sanitized 500 (logged by its code only, by the router).
export function classifyClassificationError(error) {
  if (error instanceof SourceMetricMappingError) return error;
  const code = error?.code;
  if (code === "55P03" || code === "40P01" || code === "57014") {
    console.error(`[metric-classification] try_again (${code})`);
    return refusal(409, "try_again", MESSAGES.try_again);
  }
  if (code === "42501" && error.message === BASIS_CHANGED) {
    console.error("[metric-classification] try_again (basis changed)");
    return refusal(409, "try_again", MESSAGES.try_again);
  }
  if (code === "23505") {
    if (KEY_INDEXES.has(error.constraint)) return refusal(409, "key_taken", TEXT.key_taken);
    if (error.constraint === "metric_structure_links_one_domain_per_category") return refusal(409, "category_has_domain", TEXT.category_has_domain);
    if (error.constraint === "metric_structure_links_owner_scope_owner_user_id_owner_club_key") return refusal(409, "link_exists", TEXT.link_exists);
    if (RETRY_CONSTRAINTS.has(error.constraint)) return refusal(409, "try_again", MESSAGES.try_again);
  }
  return null;
}

// Test seam (never set by the application): runs inside a write's transaction
// after its rows are written, right before its request row.
let writeHold = null;
export function setClassificationWriteHoldForTests(fn) { writeHold = fn ?? null; }

async function insertRequest(client, { ctx, requestKey, requestHash, operation, changeId, reason = null }) {
  if (writeHold) await writeHold(client, operation);
  await client.query(
    `insert into training_load.metric_classification_requests
       (request_key, requested_by_user_id, operation, request_hash, owner_scope, owner_club_id, basis, metric_classification_change_id, reason)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [requestKey, ctx.userId, operation, requestHash, ctx.owner.scope, ctx.owner.clubId, ctx.basis, changeId, reason],
  );
}
// The change row the v41 trigger wrote for this object in this transaction.
async function changeIdOf(client, column, id) {
  const rows = (await client.query(
    `select id from training_load.metric_classification_changes where ${column} = $1 and xact_id = pg_current_xact_id()`, [id],
  )).rows;
  if (rows.length !== 1) throw new Error("metric classification: not exactly one change row");
  return rows[0].id;
}
// The database's own text rule, once more inside the write (the JavaScript twin
// decided before any lock; they must agree).
async function textsAgree(client, texts) {
  for (const [value, max, message] of texts) {
    if (value === null || value === undefined) continue;
    const ok = (await client.query(`select training_load.source_metric_text_ok($1, $2) as ok`, [value, max])).rows[0].ok;
    if (ok !== true) throw invalidBody(message);
  }
}
async function readNode(executor, ctx, kind, id) {
  const params = [id];
  const readable = readableSql(ctx, "n", params);
  const row = (await executor.query(`select ${NODE_COLUMNS} from ${KINDS[kind].table} n where n.id = $1 and ${readable}`, params)).rows[0];
  return row ?? null;
}
// A write's answer and a replay: what the request wrote, read now.
async function reread(executor, ctx, record) {
  if (record.owner_scope !== ctx.owner.scope || (record.owner_scope === "club" && String(record.owner_club_id) !== ctx.owner.clubId)) return null;
  if (record.object_kind === "link") {
    const link = { id: record.link_id, domain_id: record.domain_id, category_id: record.category_id, metric_definition_id: record.metric_definition_id, owner_scope: record.owner_scope, owner_club_id: record.owner_club_id };
    const present = (await executor.query(`select 1 from training_load.metric_structure_links where id = $1`, [record.link_id])).rowCount === 1;
    return { link: { ...linkOut(link, ctx), present } };
  }
  const row = await readNode(executor, ctx, record.object_kind, record.object_kind === "domain" ? record.domain_id : record.category_id);
  return row ? { [record.object_kind]: nodeOut(row, ctx) } : null;
}
function write({ ctx, operation, requestKey, requestHash, body }) {
  return runWrite({
    ctx, where: operation, requestKey, requestHash, action: operation, body,
    reread: (executor, record) => reread(executor, ctx, record),
    requests: CLASSIFICATION_REQUESTS, classify: classifyClassificationError, idsOf,
  });
}
function textField(body, field, max, message, { nullable }) {
  if (!Object.hasOwn(body, field)) return undefined;
  const value = body[field];
  if (value === null && nullable) return null;
  if (!boundedText(value, max)) throw invalidBody(message);
  return value;
}
function kindOf(raw) {
  const kind = raw === "domains" ? "domain" : raw === "categories" ? "category" : null;
  if (!kind) throw NOT_FOUND();
  return kind;
}
function idOrNotFound(raw) {
  if (typeof raw !== "string" || !UUID.test(raw)) throw NOT_FOUND();
  return raw.toLowerCase();
}

// C2: POST /classification/domains | /classification/categories
export async function createNode({ ctx, kind: rawKind, body }) {
  adminOnly(ctx);
  const kind = kindOf(rawKind);
  plainObject(body, ["requestKey", "name", "description", "key"], ["requestKey", "name"]);
  const requestKey = uuidField(body.requestKey);
  const name = textField(body, "name", NAME_MAX, TEXT.invalid_name, { nullable: false });
  const description = textField(body, "description", DESCRIPTION_MAX, TEXT.invalid_description, { nullable: true }) ?? null;
  let key;
  if (Object.hasOwn(body, "key")) {
    if (typeof body.key !== "string" || !KEY_RULE.test(body.key)) throw invalidBody(TEXT.invalid_key);
    key = body.key;
  } else {
    key = suggestVariableKey(name);
    if (key === null) throw refusal(400, "key_required", TEXT.key_required);
  }
  const operation = `${kind}_create`;
  const requestHash = hashOf({ contract: CONTRACT, operation, body: { name, description, key } });
  return write({
    ctx, operation, requestKey, requestHash,
    body: async (client) => {
      if (!(await rightsStillHold(client, ctx))) throw NOT_FOUND();
      await textsAgree(client, [[name, NAME_MAX, TEXT.invalid_name], [description, DESCRIPTION_MAX, TEXT.invalid_description]]);
      const id = (await client.query(
        `insert into ${KINDS[kind].table} (name, description, key, owner_scope, owner_club_id, created_by_user_id)
         values ($1, $2, $3, $4, $5, $6) returning id`,
        [name, description, key, ctx.owner.scope, ctx.owner.clubId, ctx.userId],
      )).rows[0].id;
      await insertRequest(client, { ctx, requestKey, requestHash, operation, changeId: await changeIdOf(client, KINDS[kind].column, id) });
      return { operation, object_kind: kind, [KINDS[kind].column]: id, owner_scope: ctx.owner.scope, owner_club_id: ctx.owner.clubId };
    },
  });
}

// C3: rename, archive and restore of an own domain or category (R2's acts).
async function changeNode({ ctx, kind, id, operation, requestKey, requestHash, reason, check, update, texts }) {
  return write({
    ctx, operation, requestKey, requestHash,
    body: async (client) => {
      const params = [id];
      const own = ownSql(ctx, "n", params);
      const plain = (await client.query(`select n.id from ${KINDS[kind].table} n where n.id = $1 and ${own}`, params)).rows[0];
      if (!plain) throw NOT_FOUND();
      const locked = (await client.query(`select ${NODE_COLUMNS} from ${KINDS[kind].table} n where n.id = $1 for update`, [id])).rows[0];
      if (!locked || !isOwn(locked, ctx)) throw NOT_FOUND();
      if (!(await rightsStillHold(client, ctx))) throw NOT_FOUND();
      check(locked);
      await textsAgree(client, [...texts(locked), [reason, TEXT_LIMITS.reason, TEXT.invalid_reason]]);
      const set = update(locked);
      await client.query(`update ${KINDS[kind].table} set ${set.sql}, updated_at = now() where id = $1`, [id, ...set.values]);
      await insertRequest(client, { ctx, requestKey, requestHash, operation, changeId: await changeIdOf(client, KINDS[kind].column, id), reason });
      return { operation, object_kind: kind, [KINDS[kind].column]: id, owner_scope: ctx.owner.scope, owner_club_id: ctx.owner.clubId };
    },
  });
}

// A rename field: absent (unchanged), or its new value; null clears the
// description. Only its type is checked here: the text rule applies inside the
// write to a value that differs from the stored one (the v38 pattern), so a
// field sent with its stored value is exempt.
function renameField(body, field, message, { nullable }) {
  if (!Object.hasOwn(body, field)) return undefined;
  const value = body[field];
  if (value === null && nullable) return null;
  if (typeof value !== "string") throw invalidBody(message);
  return value;
}

export async function renameNode({ ctx, kind: rawKind, nodeId, body }) {
  adminOnly(ctx);
  const kind = kindOf(rawKind);
  const id = idOrNotFound(nodeId);
  plainObject(body, ["requestKey", "namesToken", "name", "description"], ["requestKey", "namesToken"]);
  const requestKey = uuidField(body.requestKey);
  if (typeof body.namesToken !== "string" || !NAMES_TOKEN.test(body.namesToken)) throw invalidBody("namesToken is the token a read of the domain or category returned.");
  const name = renameField(body, "name", TEXT.invalid_name, { nullable: false });
  const description = renameField(body, "description", TEXT.invalid_description, { nullable: true });
  if (name === undefined && description === undefined) throw invalidBody("A rename names at least one of name and description.");
  const operation = `${kind}_rename`;
  const sent = { namesToken: body.namesToken, ...(name === undefined ? {} : { name }), ...(description === undefined ? {} : { description }) };
  const requestHash = hashOf({ contract: CONTRACT, operation, id, body: sent });
  const next = (row) => ({ name: name === undefined ? row.name : name, description: description === undefined ? (row.description ?? null) : description });
  const changed = (row) => {
    const n = next(row);
    return {
      name: n.name !== row.name ? n.name : undefined,
      description: n.description !== (row.description ?? null) ? n.description : undefined,
    };
  };
  return changeNode({
    ctx, kind, id, operation, requestKey, requestHash, reason: null,
    check: (row) => {
      if (!row.is_active) throw refusal(409, "node_not_active", TEXT.node_not_active);
      if (namesTokenOf(row) !== body.namesToken) throw refusal(409, "node_changed", TEXT.node_changed, { current: nodeOut(row, ctx) });
      const c = changed(row);
      if (c.name === undefined && c.description === undefined) throw refusal(409, "rename_unchanged", TEXT.rename_unchanged);
      if (c.name !== undefined && !boundedText(c.name, NAME_MAX)) throw invalidBody(TEXT.invalid_name);
      if (c.description !== undefined && c.description !== null && !boundedText(c.description, DESCRIPTION_MAX)) throw invalidBody(TEXT.invalid_description);
    },
    texts: (row) => {
      const c = changed(row);
      return [
        ...(c.name !== undefined ? [[c.name, NAME_MAX, TEXT.invalid_name]] : []),
        ...(c.description !== undefined && c.description !== null ? [[c.description, DESCRIPTION_MAX, TEXT.invalid_description]] : []),
      ];
    },
    update: (row) => {
      const n = next(row);
      return { sql: "name = $2, description = $3", values: [n.name, n.description] };
    },
  });
}

export async function archiveNode({ ctx, kind: rawKind, nodeId, body }) {
  adminOnly(ctx);
  const kind = kindOf(rawKind);
  const id = idOrNotFound(nodeId);
  plainObject(body, ["requestKey", "reason"], ["requestKey", "reason"]);
  const requestKey = uuidField(body.requestKey);
  if (!boundedText(body.reason, TEXT_LIMITS.reason)) throw invalidBody(TEXT.invalid_reason);
  const reason = body.reason;
  const operation = `${kind}_archive`;
  const requestHash = hashOf({ contract: CONTRACT, operation, id, body: { reason } });
  return changeNode({
    ctx, kind, id, operation, requestKey, requestHash, reason,
    check: (row) => { if (!row.is_active) throw refusal(409, "node_not_active", TEXT.node_not_active); },
    texts: () => [],
    update: () => ({ sql: "is_active = false", values: [] }),
  });
}

export async function restoreNode({ ctx, kind: rawKind, nodeId, body }) {
  adminOnly(ctx);
  const kind = kindOf(rawKind);
  const id = idOrNotFound(nodeId);
  plainObject(body, ["requestKey", "reason"], ["requestKey"]);
  const requestKey = uuidField(body.requestKey);
  const reason = textField(body, "reason", TEXT_LIMITS.reason, TEXT.invalid_reason, { nullable: true }) ?? null;
  const operation = `${kind}_restore`;
  const requestHash = hashOf({ contract: CONTRACT, operation, id, body: { reason } });
  return changeNode({
    ctx, kind, id, operation, requestKey, requestHash, reason,
    check: (row) => { if (row.is_active) throw refusal(409, "node_active", TEXT.node_active); },
    texts: () => [],
    update: () => ({ sql: "is_active = true", values: [] }),
  });
}

// C4: POST /classification/links - one link of the three shapes (O2).
export async function createLink({ ctx, body }) {
  adminOnly(ctx);
  plainObject(body, ["requestKey", "variableId", "categoryId", "domainId"], ["requestKey"]);
  const requestKey = uuidField(body.requestKey);
  const ids = {};
  for (const field of ["variableId", "categoryId", "domainId"]) {
    if (!Object.hasOwn(body, field)) continue;
    if (typeof body[field] !== "string" || !UUID.test(body[field])) throw invalidBody(`${field} is a uuid.`);
    ids[field] = body[field].toLowerCase();
  }
  if (Object.keys(ids).length !== 2) throw invalidBody(TEXT.link_shape);
  const operation = "link_create";
  const requestHash = hashOf({ contract: CONTRACT, operation, body: ids });
  return write({
    ctx, operation, requestKey, requestHash,
    body: async (client) => {
      // Readable targets first, unlocked: anything else is the identical 404,
      // and a refused caller never waits for a target's lock.
      const readable = async (table, id) => {
        const params = [id];
        const owner = readableSql(ctx, "t", params);
        return (await client.query(`select t.id from ${table} t where t.id = $1 and ${owner}`, params)).rowCount === 1;
      };
      if (ids.domainId && !(await readable(KINDS.domain.table, ids.domainId))) throw NOT_FOUND();
      if (ids.categoryId && !(await readable(KINDS.category.table, ids.categoryId))) throw NOT_FOUND();
      if (ids.variableId && !(await readable("training_load.metric_definitions", ids.variableId))) throw NOT_FOUND();
      // FOR SHARE in the order domain, category, variable (the v41 guard's).
      const dom = ids.domainId ? (await client.query(`select id, owner_scope, owner_club_id, is_active from training_load.metric_domains where id = $1 for share`, [ids.domainId])).rows[0] : null;
      const cat = ids.categoryId ? (await client.query(`select id, owner_scope, owner_club_id, is_active from training_load.metric_categories where id = $1 for share`, [ids.categoryId])).rows[0] : null;
      const def = ids.variableId ? (await client.query(`select id, owner_scope, owner_club_id, state from training_load.metric_definitions where id = $1 for share`, [ids.variableId])).rows[0] : null;
      if ((ids.domainId && !dom) || (ids.categoryId && !cat) || (ids.variableId && !def)) throw NOT_FOUND();
      if (!(await rightsStillHold(client, ctx))) throw NOT_FOUND();
      // O4: the category (or the domain of a variable -> domain link) is this
      // workspace's own; the other end is its own or the system's.
      const ownOrSystem = (row) => row.owner_scope === "system" || isOwn(row, ctx);
      const container = cat ?? dom;
      const other = def ?? dom;
      if (!isOwn(container, ctx) || !ownOrSystem(other)) throw refusal(409, "link_outside_owner", TEXT.link_outside_owner);
      if ((dom && !dom.is_active) || (cat && !cat.is_active)) throw refusal(409, "node_archived", TEXT.node_archived);
      if (def && def.state !== "active") throw refusal(409, "variable_not_active", TEXT.variable_not_active);
      if (cat && dom && !def) {
        const placed = (await client.query(
          `select 1 from training_load.metric_structure_links
            where category_id = $1 and metric_definition_id is null and domain_id is not null and owner_scope in ('system', 'club')`,
          [cat.id],
        )).rowCount;
        if (placed) throw refusal(409, "category_has_domain", TEXT.category_has_domain);
      }
      const id = (await client.query(
        `insert into training_load.metric_structure_links
           (domain_id, category_id, metric_definition_id, temporal_smoothing_enabled, owner_scope, owner_club_id, created_by_user_id)
         values ($1, $2, $3, false, $4, $5, $6) returning id`,
        [ids.domainId ?? null, ids.categoryId ?? null, ids.variableId ?? null, ctx.owner.scope, ctx.owner.clubId, ctx.userId],
      )).rows[0].id;
      await insertRequest(client, { ctx, requestKey, requestHash, operation, changeId: await changeIdOf(client, "link_id", id) });
      return {
        operation, object_kind: "link", link_id: id, domain_id: ids.domainId ?? null, category_id: ids.categoryId ?? null,
        metric_definition_id: ids.variableId ?? null, owner_scope: ctx.owner.scope, owner_club_id: ctx.owner.clubId,
      };
    },
  });
}

// C5: POST /classification/links/:id/remove - an own canonical link.
export async function removeLink({ ctx, linkId, body }) {
  adminOnly(ctx);
  const id = idOrNotFound(linkId);
  plainObject(body, ["requestKey", "reason"], ["requestKey"]);
  const requestKey = uuidField(body.requestKey);
  const reason = textField(body, "reason", TEXT_LIMITS.reason, TEXT.invalid_reason, { nullable: true }) ?? null;
  const operation = "link_remove";
  const requestHash = hashOf({ contract: CONTRACT, operation, id, body: { reason } });
  return write({
    ctx, operation, requestKey, requestHash,
    body: async (client) => {
      const params = [id];
      const own = ownSql(ctx, "l", params);
      const plain = (await client.query(`select l.id from training_load.metric_structure_links l where l.id = $1 and ${own}`, params)).rows[0];
      if (!plain) throw NOT_FOUND();
      const locked = (await client.query(
        `select id, domain_id, category_id, metric_definition_id, owner_scope, owner_club_id
           from training_load.metric_structure_links where id = $1 for update`, [id],
      )).rows[0];
      if (!locked || !isOwn(locked, ctx)) throw NOT_FOUND();
      if (!(await rightsStillHold(client, ctx))) throw NOT_FOUND();
      await textsAgree(client, [[reason, TEXT_LIMITS.reason, TEXT.invalid_reason]]);
      // The v41 guard writes the removed link's change row, from the row, before it goes.
      await client.query(`delete from training_load.metric_structure_links where id = $1`, [id]);
      await insertRequest(client, { ctx, requestKey, requestHash, operation, changeId: await changeIdOf(client, "link_id", id), reason });
      return {
        operation, object_kind: "link", link_id: id, domain_id: locked.domain_id, category_id: locked.category_id,
        metric_definition_id: locked.metric_definition_id, owner_scope: locked.owner_scope, owner_club_id: locked.owner_club_id,
      };
    },
  });
}
