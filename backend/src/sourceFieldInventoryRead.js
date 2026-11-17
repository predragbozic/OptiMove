// I2 (docs/ai/gpexe-field-inventory-plan.md, section 7.2): the read of the GPEXE field inventory (I1, v72) for
// Training Load -> Data configuration -> Source fields. Read-only, one statement, no lock.
//
// Who sees which rows (the owner's Q2, the Rukovodilac's P1-P3 of 2026-11-15):
// - a platform admin in the platform workspace: every connection's names;
// - a club scope (the club's admin, or a platform admin in that club's workspace): only the names seen through that
//   club's own connections - club-owned ones and team-owned ones of the club's own teams (P2);
// - everyone else never reaches this module (the route answers the identical 404 first, adminContext).
// Never in an answer: a connection or check id, a label, a club or a team. A club scope sees a unit word only when it is
// a known unit, the token of an active unit conversion (P3). `team_thresholds` names are never a field: a platform admin
// reads them with endpoint=team_thresholds only, and a club scope gets an empty list there (P1).
import { refusal } from "./sourceMetricAccess.js";
import { adminWriteKit } from "./sourceMetricMappingService.js";
import { FIELD_ENDPOINTS, STRUCTURAL_FIELDS } from "./sourceFieldInventory.js";
import { deriveField, FieldCreateRefusal, KEPT_VALUE_KINDS } from "./sourceFieldCreate.js";
import { mayCreateFields } from "./sourceFieldCreateService.js";

export const INVENTORY_PAGE_SIZE = 200;
const STATES = new Set(["not_supported", "covered", "all"]);
const ENDPOINTS = new Set(FIELD_ENDPOINTS);
const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const CURSOR_TEXT = /^[A-Za-z0-9_-]{1,400}$/;
const THRESHOLDS = "team_thresholds";
// The structural keys the collector no longer records (an identifier, a reference, a timestamp); hidden here too, for any
// row written before that rule. Two parallel arrays, one pair per (endpoint, name).
const STRUCTURAL_PAIRS = Object.entries(STRUCTURAL_FIELDS).flatMap(([endpoint, names]) => names.map((n) => [endpoint, n]));
const STRUCTURAL_ENDPOINTS = STRUCTURAL_PAIRS.map(([e]) => e);
const STRUCTURAL_NAMES = STRUCTURAL_PAIRS.map(([, n]) => n);
// Every metrics read is bounded (C70): read-only, a statement bound, a client bound, 409 try_again (M2's boundedRead).
const { boundedRead } = adminWriteKit;

const invalidQuery = (message) => refusal(400, "invalid_query", message);
const invalidCursor = () => invalidQuery("The cursor is not valid for this list.");

// The scope key a cursor is bound to: the platform workspace, or one club.
const isPlatformScope = (ctx) => ctx.basis === "platform_admin" && ctx.owner?.scope === "system";
const scopeKeyOf = (ctx) => (isPlatformScope(ctx) ? "platform" : ctx.owner.clubId);

function single(query, key) {
  const value = query[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw invalidQuery(`The query parameter ${key} is given more than once or in an unknown form.`);
  return value;
}

export function parseInventoryQuery(query, ctx) {
  const q = query ?? {};
  for (const key of Object.keys(q)) if (!["state", "endpoint", "cursor"].includes(key)) throw invalidQuery("The query carries a parameter this route does not take.");
  const state = single(q, "state") ?? "not_supported";
  if (!STATES.has(state)) throw invalidQuery("state must be not_supported, covered or all.");
  const endpoint = single(q, "endpoint") ?? null;
  if (endpoint !== null && !ENDPOINTS.has(endpoint)) throw invalidQuery("endpoint is not one of the inventory's endpoints.");
  const cursorText = single(q, "cursor");
  let after = null;
  if (cursorText !== undefined) {
    if (!CURSOR_TEXT.test(cursorText)) throw invalidCursor();
    let p;
    try { p = JSON.parse(Buffer.from(cursorText, "base64url").toString("utf8")); } catch { throw invalidCursor(); }
    if (p === null || typeof p !== "object" || Array.isArray(p) || Object.keys(p).sort().join(",") !== "e,f,n,s,v") throw invalidCursor();
    if (p.v !== 1 || p.s !== `${scopeKeyOf(ctx)}|${state}` || p.f !== endpoint) throw invalidCursor();
    if (!ENDPOINTS.has(p.e) || typeof p.n !== "string" || !NAME.test(p.n) || (endpoint !== null && p.e !== endpoint)) throw invalidCursor();
    after = { endpoint: p.e, name: p.n };
  }
  return { state, endpoint, after };
}

const encodeCursor = (ctx, { state, endpoint }, last) =>
  Buffer.from(JSON.stringify({ v: 1, s: `${scopeKeyOf(ctx)}|${state}`, f: endpoint, e: last.endpoint, n: last.name }), "utf8").toString("base64url");

// The visible connections are every state (a disconnected one included) and every team of the club (an archived one
// included): the names stay the club's own history, as the club's own account sent them (Q2).
// covered: an active T2a key of gpexe / rest_v1 names it (section 7.1); a retired key no longer covers. T2a keys are
// lower case, so a name with a capital letter is never covered (it waits for G1). Ordered and paged in the "C" collation,
// the same in every database. For team thresholds `state` does not apply (they are never a field). The complementary-data family is matched by a literal
// prefix (left() = the prefix, never LIKE), so an underscore in a name is only itself.
const INVENTORY_SQL = `
  with visible as (
    select c.id from training_load.source_credential_connections c
     where c.source_system = 'gpexe'
       and ($1::uuid is null
            or (c.owner_scope = 'club' and c.owner_club_id = $1::uuid)
            or (c.owner_scope = 'team' and exists (select 1 from public.teams t where t.id = c.owner_team_id and t.club_id = $1::uuid)))
  ), grouped as (
    select o.endpoint, o.field_name,
           (array_agg(o.value_kind order by o.last_seen_at desc, o.source_connection_id))[1] as kind,
           (array_agg(o.unit_word order by o.last_seen_at desc, o.source_connection_id) filter (where o.unit_word is not null))[1] as unit_word,
           sum(o.answers_seen)::bigint as answers,
           to_char(max(o.last_seen_at) at time zone 'UTC', 'YYYY-MM-DD') as last_seen_on,
           count(distinct o.source_connection_id)::int as connections,
           -- G1b: every observation of the name is a value kind a check keeps for its endpoint's shape.
           bool_and(case when o.endpoint = 'athlete_session' then o.value_kind = any($9::text[])
                         when o.endpoint in ('details.session', 'details.drill') then o.value_kind = any($10::text[])
                         else false end) as kinds_kept
      from training_load.source_field_observations o
      join visible v on v.id = o.source_connection_id
     where o.api_family = 'rest_v1'
       and ($2::text is null or o.endpoint = $2::text)
       and ($2::text = '${THRESHOLDS}' or o.endpoint <> '${THRESHOLDS}')
       and not exists (select 1 from unnest($7::text[], $8::text[]) s(endpoint, name) where s.endpoint = o.endpoint and s.name = o.field_name)
     group by o.endpoint, o.field_name
  ), marked as (
    select g.*,
           case when g.endpoint = '${THRESHOLDS}' then null else exists (
             select 1 from training_load.source_metric_definitions d
              where d.source_system = 'gpexe' and d.api_family = 'rest_v1' and d.state = 'active'
                and ((g.endpoint in ('athlete_session', 'more.events') and d.source_metric_key = g.endpoint || '.' || g.field_name)
                  or (g.endpoint in ('details.session', 'details.drill') and d.source_metric_key = 'details.players.' || g.field_name)
                  or (g.endpoint = 'more.complementary_data'
                      and left(d.source_metric_key, length('more.complementary_data.' || g.field_name || '.')) = 'more.complementary_data.' || g.field_name || '.'))
           ) end as covered,
           -- G1b: route C refuses a key that exists in any state (field_exists), a retired one included.
           g.endpoint in ('athlete_session', 'details.session', 'details.drill') and exists (
             select 1 from training_load.source_metric_definitions d
              where d.source_system = 'gpexe' and d.api_family = 'rest_v1'
                and d.source_metric_key = case when g.endpoint = 'athlete_session' then 'athlete_session.' else 'details.players.' end || g.field_name
           ) as key_taken,
           g.unit_word is not null and exists (
             select 1 from training_load.unit_conversions u where u.state = 'active' and g.unit_word in (u.from_unit, u.to_unit)
           ) as unit_known
      from grouped g
  )
  select endpoint, field_name, kind, unit_word, unit_known, answers::text as answers, last_seen_on, connections, covered, kinds_kept, key_taken
    from marked
   where ($3::text = 'all' or endpoint = '${THRESHOLDS}' or covered = ($3::text = 'covered'))
     and ($4::text is null or (endpoint collate "C", field_name collate "C") > ($4::text collate "C", $5::text collate "C"))
   order by endpoint collate "C", field_name collate "C"
   limit $6`;

// Route C would create this name: not covered yet, a generic endpoint, a name route C derives a key from, and every
// observation a value kind a check keeps. Route C decides again on the request.
function creatable(row) {
  if (row.covered !== false || row.kinds_kept !== true || row.key_taken !== false) return false;
  try {
    deriveField({ endpoint: row.endpoint, name: row.field_name, supportsSession: row.endpoint !== "details.drill", supportsDrill: true });
    return true;
  } catch (error) {
    if (error instanceof FieldCreateRefusal) return false;
    throw error;
  }
}

export async function listFieldInventory({ ctx, query }) {
  const parsed = parseInventoryQuery(query, ctx);
  const platform = isPlatformScope(ctx);
  // P1: team thresholds are the platform admin's only; a club scope asking for them gets an empty list.
  if (parsed.endpoint === THRESHOLDS && !platform) return { fields: [], nextCursor: null };
  const params = [
    platform ? null : ctx.owner.clubId, parsed.endpoint, parsed.state,
    parsed.after?.endpoint ?? null, parsed.after?.name ?? null, INVENTORY_PAGE_SIZE + 1,
    STRUCTURAL_ENDPOINTS, STRUCTURAL_NAMES, [...KEPT_VALUE_KINDS.number], [...KEPT_VALUE_KINDS.unit_value_object],
  ];
  // G1b: whether route C would take this name (its own derivation, never a guess of the screen), for its audience only.
  const mayCreate = mayCreateFields(ctx);
  const r = await boundedRead((client) => client.query(INVENTORY_SQL, params));
  const rows = r.rows.slice(0, INVENTORY_PAGE_SIZE);
  const fields = rows.map((row) => ({
    endpoint: row.endpoint,
    name: row.field_name,
    kind: row.kind,
    unitWord: platform || row.unit_known ? row.unit_word ?? null : null,
    answersSeen: Number(row.answers),
    lastSeenOn: row.last_seen_on,
    covered: row.covered,
    ...(platform ? { connectionCount: row.connections } : {}),
    ...(mayCreate ? { creatable: creatable(row) } : {}),
  }));
  const last = rows[rows.length - 1];
  return { fields, nextCursor: r.rows.length > INVENTORY_PAGE_SIZE ? encodeCursor(ctx, parsed, { endpoint: last.endpoint, name: last.field_name }) : null };
}
