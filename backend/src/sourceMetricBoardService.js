// The reads of the drag-and-drop board (J18, C112, slice 18-2;
// docs/ai/c112-drag-mapping-contract.md, sections 3.3-3.6, 4.1, 4.2, 6 and
// 15): the board of one team (route 1), one placement (route 2), and the
// stored confirmations (routes 4 and 5). Reads only: no mapping, activation
// or confirmation is written here (18-3).
//
// Audience (section 4.1). The board and a placement: in club X's workspace,
// club X's active admin or a platform admin there, for an active team of
// club X whose active GPEXE binding's connection club X owns. The stored
// confirmations: the same, and an active platform admin in the platform
// workspace for any club. Everyone and everything else is the identical 404;
// a foreign or unknown id is that 404 too, never a refusal that depends on
// the resource.
//
// What it never does: send a GPEXE request; read a date of birth (its own
// reader selects display_name only, and it never calls the identity
// service); return, log or put into a URL an athlete id or a GPEXE athlete
// id (the pair is an index in the server's own order); return a value past
// its expiry.
import { adminWriteKit } from "./sourceMetricMappingService.js";
import { GPEXE_SOURCE_SYSTEM, gpexeSessionValuesKeyed } from "./gpexeImportMapper.js";
import { teamSessionTimezone } from "./gpexeTeamTimezoneRead.js";
import { convertAtStorageScale } from "./sourceMetricPreview.js";
import { canonicalDecimal, compareDecimal, extractorFor } from "./sourceMetricExtractors.js";
import { removeExpiredBatch as removeExpiredValuesBatch, setRemovalFaultForTests } from "./sourceMetricConfirmationRemoval.js";
import { DISPLAY_REGISTRY_VERSION, displayRuleFor, displayValue, distinctPair, placementHash, rankPairs } from "./sourceMetricBoard.js";

const { boundedRead, refusal, NOT_FOUND, UUID } = adminWriteKit;

// The largest stored bundle the board reads (7e's bound, R7 of J11).
export const BOARD_MAX_BUNDLE_BYTES = 16 * 1024 * 1024;
export const CONFIRMATIONS_PAGE = 50;
const SOURCE_CONNECTION_PATH = "source_connection";

const BOARD_MESSAGES = {
  invalid_query: "The query carries a parameter this route does not take, or a value it cannot read.",
  no_stored_session: "No saved session yet. Run a search in Imports first.",
  snapshot_expired: "The saved session is no longer available. Run a new search in Imports.",
  candidate_too_large: "The saved session is too large to read.",
  candidate_source_mismatch: "This session was not read through the team's current GPEXE link.",
  candidate_not_importable: "The import would not take this GPEXE session.",
  board_too_large: "This session has too many athletes and columns to compare at once.",
  session_start_unknown: "This saved session has no start time.",
  not_enough_athletes: "OptiMove needs two athletes it can name. Link the team's athletes in Imports (Link athletes) so OptiMove can name two of them.",
  pair_out_of_range: "No other athletes have values for all your columns.",
};
// Why a column cannot be placed (section 3.3), and why a placement cannot be
// made (sections 3.5 and 4.2). Codes only: the screen owns the sentences.
export const COLUMN_REASONS = Object.freeze(["field_not_confirmed", "field_has_parameters", "source_metric_unsupported", "display_rule_missing", "no_value_for_pair"]);

// Section 5.8: before every board or history read, ONE batch of the removal of
// expired values, in its own call before the read's transaction (a read
// transaction is read-only). Its failure or stall is logged by code only and
// never fails the read: no route returns a value past its date anyway.
const removeExpiredBatch = () => removeExpiredValuesBatch();
// Test seam (the tests of 18-2): the removal module's own.
export function setBoardRemovalFaultForTests(fn, options) { setRemovalFaultForTests(fn, options); }

// The query, from the raw query string (never Express's parsed req.query).
// A parameter the route does not take, a repeated one or a malformed value
// is 400 invalid_query.
function readQuery(queryString, allowed, required) {
  if (typeof queryString !== "string") throw refusal(400, "invalid_query", BOARD_MESSAGES.invalid_query);
  const out = {};
  for (const [name, value] of new URLSearchParams(queryString)) {
    if (!Object.hasOwn(allowed, name) || Object.hasOwn(out, name)) throw refusal(400, "invalid_query", BOARD_MESSAGES.invalid_query);
    if (allowed[name] === "uuid") {
      if (!UUID.test(value)) throw refusal(400, "invalid_query", BOARD_MESSAGES.invalid_query);
      out[name] = value.toLowerCase();
    } else if (allowed[name] === "index") {
      if (!/^(0|[1-9][0-9]{0,3})$/.test(value)) throw refusal(400, "invalid_query", BOARD_MESSAGES.invalid_query);
      out[name] = Number(value);
    } else {
      out[name] = value;
    }
  }
  for (const name of required) if (!Object.hasOwn(out, name)) throw refusal(400, "invalid_query", BOARD_MESSAGES.invalid_query);
  return out;
}

// The board's audience: a club workspace only (section 4.1).
export const mayUseBoard = (ctx) => ctx?.owner?.scope === "club" && (ctx.basis === "club_admin" || ctx.basis === "platform_admin");
// The stored confirmations: the board's audience, and a platform admin in the platform workspace.
export const mayReadConfirmations = (ctx) => mayUseBoard(ctx) || (ctx?.owner?.scope === "system" && ctx.basis === "platform_admin");

const dec = (value) => (value === null || value === undefined ? null : canonicalDecimal(String(value)));
const factorsOf = (row) => ({ scale: dec(row.scale), divisor: dec(row.scale_divisor), offset: dec(row.offset) });
const sameFactors = (a, b) => compareDecimal(a.scale, b.scale) === 0 && compareDecimal(a.divisor, b.divisor) === 0 && compareDecimal(a.offset, b.offset) === 0;
const conversionText = (f) => `${f.scale}/${f.divisor}/${f.offset}`;
const IDENTITY = Object.freeze({ scale: "1", divisor: "1", offset: "0" });

// ---------------------------------------------------------------------------
// The board's world: everything one board or placement read needs, in ONE
// REPEATABLE READ READ ONLY transaction. Plain reads, no lock.
// ---------------------------------------------------------------------------
async function loadWorld(client, ctx, { teamId, candidateId, onCandidateMissing = NOT_FOUND }) {
  // The team, its one active GPEXE binding, and the binding's connection owned by the workspace's club.
  const team = (await client.query(
    `select t.id, t.name, b.id as binding_id, b.connection_id, b.source_team_id, h.api_family
       from public.teams t
       join public.clubs cl on cl.id = t.club_id and coalesce(cl.is_active, true)
       join training_load.source_team_bindings b on b.team_id = t.id and b.state = 'active' and b.source_system = $3
       join training_load.source_credential_connections c on c.id = b.connection_id and c.owner_scope = 'club' and c.owner_club_id = t.club_id
       join training_load.source_host_catalog h on h.source_system = c.source_system and h.host_key = c.host_key
      where t.id = $1 and t.club_id = $2 and coalesce(t.is_active, true)`,
    [teamId, ctx.owner.clubId, GPEXE_SOURCE_SYSTEM],
  )).rows[0];
  if (!team) throw NOT_FOUND();

  // The stored session. Never an undone import (v57) or a superseded one; its
  // last check succeeded through this binding (as the importer requires).
  const usable = `c.status <> 'superseded' and c.import_undone_at is null`;
  const candidateSql = (where, tail) => `
    with scoped as materialized (
      select c.id, c.status, c.gpexe_team_session_id, c.session_started_at, c.session_label, c.bundle_hash, c.last_seen_check_id,
             c.raw_purged_at is not null as purged, c.raw_expires_at <= now() as expired, c.raw_bundle,
             k.status as check_status, k.source_path, k.source_binding_id
        from training_load.gpexe_import_candidates c
        left join training_load.gpexe_import_checks k on k.id = c.last_seen_check_id and k.owner_team_id = c.owner_team_id
       where c.owner_team_id = $1::uuid and ${usable} and ${where} ${tail})
    select s.id, s.status, s.gpexe_team_session_id, s.session_started_at, s.session_label, s.bundle_hash, s.last_seen_check_id, s.purged, s.expired,
           s.check_status, s.source_path, s.source_binding_id, b.too_large,
           case when b.too_large is false and s.check_status = 'succeeded' and s.source_path = $3::text and s.source_binding_id = $2::uuid
                     and s.session_started_at is not null
                then s.raw_bundle end as raw_bundle
      from scoped s
      cross join lateral (select case when s.purged or s.expired then null else octet_length(s.raw_bundle::text) end as bundle_bytes offset 0) sz
      cross join lateral (select sz.bundle_bytes > $4::int as too_large offset 0) b`;
  const base = [team.id, team.binding_id, SOURCE_CONNECTION_PATH, BOARD_MAX_BUNDLE_BYTES];
  let candidate;
  if (candidateId) {
    candidate = (await client.query(candidateSql(`c.id = $5::uuid`, ""), [...base, candidateId])).rows[0];
    // An id that is not a usable stored session of this team is the identical 404.
    if (!candidate) throw onCandidateMissing();
  } else {
    candidate = (await client.query(candidateSql(
      `c.raw_purged_at is null and c.raw_expires_at > now() and c.session_started_at is not null
       and k.status = 'succeeded' and k.source_path = $3::text and k.source_binding_id = $2::uuid`,
      `order by c.session_started_at desc, c.id limit 1`,
    ), base)).rows[0];
    if (!candidate) throw refusal(409, "no_stored_session", BOARD_MESSAGES.no_stored_session);
  }
  // The session's own refusal is carried, not thrown here: a placement first
  // answers the identical 404 for a column or a variable outside the
  // workspace (section 4.1: a 404 always comes before any 409).
  let sessionRefusal = null;
  if (candidate.purged) sessionRefusal = refusal(409, "snapshot_expired", BOARD_MESSAGES.snapshot_expired, { current: { reason: "purged" } });
  else if (candidate.expired) sessionRefusal = refusal(409, "snapshot_expired", BOARD_MESSAGES.snapshot_expired, { current: { reason: "expired" } });
  else if (candidate.too_large === true) sessionRefusal = refusal(409, "candidate_too_large", BOARD_MESSAGES.candidate_too_large);
  else if (candidate.check_status !== "succeeded" || candidate.source_path !== SOURCE_CONNECTION_PATH || candidate.source_binding_id !== team.binding_id) {
    sessionRefusal = refusal(409, "candidate_source_mismatch", BOARD_MESSAGES.candidate_source_mismatch);
  } else if (candidate.session_started_at === null) sessionRefusal = refusal(409, "session_start_unknown", BOARD_MESSAGES.session_start_unknown);
  else if (candidate.raw_bundle === null || typeof candidate.raw_bundle !== "object") throw new Error("board bundle missing");

  const teamTimezone = await teamSessionTimezone(client, team.id);

  // The source fields of the binding's family, each with its active revision.
  const fields = (await client.query(
    `select d.id, d.source_system, d.api_family, d.source_metric_key, d.source_label,
            r.id as revision_id, r.value_shape, r.parameter_kind, r.supports_session, r.supports_drill,
            r.source_unit, r.expected_source_unit, r.evidence_status
       from training_load.source_metric_definitions d
       join training_load.source_metric_definition_versions r on r.source_metric_definition_id = d.id and r.state = 'active'
      where d.source_system = $1 and d.api_family = $2 and d.state = 'active'
      order by d.source_metric_key collate "C"`,
    [GPEXE_SOURCE_SYSTEM, team.api_family],
  )).rows;

  // The variables: the club's own, then OptiMove's (section 3.3).
  const variables = (await client.query(
    `select d.id, d.owner_scope, d.key, d.label, v.id as version_id, v.value_type, v.unit,
            coalesce(training_load.source_metric_unit_token_ok(v.unit), false) as unit_is_token,
            trim_scale(v.min_value)::text as min_value, trim_scale(v.max_value)::text as max_value,
            v.condition_description is not null as has_condition,
            (select array_agg(c.scope_level order by c.scope_level) from training_load.metric_definition_scope_capabilities c where c.metric_definition_id = d.id) as scopes,
            exists (select 1 from training_load.metric_definition_club_hides h
                     where h.club_id = $1::uuid and h.metric_definition_id = d.id and h.shown_at is null) as hidden
       from training_load.metric_definitions d
       join training_load.metric_definition_versions v on v.id = d.current_version_id and v.metric_definition_id = d.id
      where d.state = 'active' and ((d.owner_scope = 'club' and d.owner_club_id = $1::uuid) or d.owner_scope = 'system')
      order by (d.owner_scope = 'system'), d.label collate "C", d.id`,
    [ctx.owner.clubId],
  )).rows;

  // The active mapping versions the club can use: OptiMove's and its own.
  const versions = (await client.query(
    `select v.id, v.mapping_id, v.owner_key, v.source_metric_definition_id as field_id, v.metric_definition_id as variable_id,
            v.source_metric_version_id as revision_id, v.metric_definition_version_id as target_version_id,
            v.parameter_kind, v.parameter_fingerprint, v.source_unit, v.target_unit,
            trim_scale(v.scale)::text as scale, trim_scale(v.scale_divisor)::text as scale_divisor, trim_scale(v."offset")::text as "offset",
            v.applies_to_session, v.applies_to_drill
       from training_load.source_metric_mapping_versions v
      where v.status = 'active' and v.owner_key = any($1::text[])
      order by v.id`,
    [["system", ctx.owner.clubId]],
  )).rows;

  // What is switched on for the team, and what an administrator switched off on this binding (Q9).
  const open = (await client.query(
    `select a.id, a.mapping_version_id, a.source_metric_definition_id as field_id, a.metric_definition_id as variable_id,
            a.parameter_fingerprint, a.applies_to_session, a.applies_to_drill, a.requirement, m.owner_scope
       from training_load.source_metric_mapping_activations a
       join training_load.source_metric_mappings m on m.id = a.mapping_id
      where a.source_team_binding_id = $1 and a.ended_at is null
      order by a.id`,
    [team.binding_id],
  )).rows;
  const switchedOff = (await client.query(
    // The mapping's LATEST activation on this binding, and only when an administrator ended it:
    // a mapping switched on again and then ended another way is not "switched off". An end the
    // board itself wrote when a save replaced the mapping is not a switch-off either (the
    // Rukovodilac, 2026-11-12): it is the activation_end row of an operation that also holds a
    // mapping_confirmation row. T8 is append-only, so that fact cannot change.
    `select x.mapping_id, x.ended_at, coalesce(nullif(u.display_name, ''), u.full_name) as ended_by
       from (select distinct on (a.mapping_id) a.id, a.mapping_id, a.ended_at, a.end_reason, a.ended_by_user_id
               from training_load.source_metric_mapping_activations a
              where a.source_team_binding_id = $1
              order by a.mapping_id, a.activated_at desc, a.id desc) x
       left join public.users u on u.id = x.ended_by_user_id
      where x.end_reason = 'admin_ended'
        and not exists (select 1 from training_load.source_metric_audit e
                          join training_load.source_metric_audit mc on mc.operation_id = e.operation_id and mc.action = 'mapping_confirmation'
                         where e.activation_id = x.id and e.action = 'activation_end')`,
    [team.binding_id],
  )).rows;

  const conversions = (await client.query(
    `select from_unit, to_unit, trim_scale(scale)::text as scale, trim_scale(scale_divisor)::text as scale_divisor, trim_scale("offset")::text as "offset"
       from training_load.unit_conversions where state = 'active'`,
  )).rows;

  // The names, live and never stored: an OptiMove link first, else a GPEXE
  // name that has not expired. display_name only - never a date of birth.
  const linked = (await client.query(
    `select l.gpexe_athlete_id, coalesce(nullif(a.display_name, ''), a.full_name) as name
       from training_load.gpexe_athlete_links l join public.athletes a on a.id = l.athlete_id
      where l.owner_team_id = $1 and l.unlinked_at is null`,
    [team.id],
  )).rows;
  const identities = (await client.query(
    `select gpexe_athlete_id, display_name
       from training_load.gpexe_athlete_identities
      where binding_id = $1 and owner_team_id = $2 and expires_at > now()`,
    [team.binding_id, team.id],
  )).rows;
  const names = new Map();
  for (const row of identities) if (typeof row.display_name === "string" && row.display_name.trim() !== "") names.set(String(row.gpexe_athlete_id), row.display_name);
  for (const row of linked) if (typeof row.name === "string" && row.name.trim() !== "") names.set(String(row.gpexe_athlete_id), row.name);

  return { clubId: ctx.owner.clubId, team, candidate, sessionRefusal, teamTimezone, fields, variables, versions, open, switchedOff, conversions, names };
}

// ---------------------------------------------------------------------------
// The values of the stored session, the pair, and the columns. Pure over the
// world; the athlete keys stay inside this function's result and never reach
// an answer.
// ---------------------------------------------------------------------------
function columnsOf(world) {
  return world.fields.map((f) => {
    const extractor = extractorFor({ sourceSystem: f.source_system, apiFamily: f.api_family, sourceMetricKey: f.source_metric_key });
    const proven = f.evidence_status === "verified" && f.source_unit !== null;
    const rule = proven ? displayRuleFor({ sourceSystem: f.source_system, apiFamily: f.api_family, sourceMetricKey: f.source_metric_key, sourceUnit: f.source_unit }) : null;
    let reason = null;
    if (!extractor || (extractor.valueShape !== null && (extractor.valueShape !== f.value_shape || extractor.parameterKind !== f.parameter_kind))) reason = "source_metric_unsupported";
    else if (f.parameter_kind !== "none") reason = "field_has_parameters";
    else if (!proven) reason = "field_not_confirmed";
    else if (!rule) reason = "display_rule_missing";
    // A column can be read (its values shown, a system mapping of it switched on) without being placeable as a new row.
    const readable = Boolean(extractor) && reason !== "source_metric_unsupported" && f.parameter_kind === "none";
    return { field: f, extractor, rule, reason, readable };
  });
}

// A board read does at most this much extraction work: readable columns x
// athlete rows of the stored session (drill rows included). More is refused,
// never read in part.
export const BOARD_MAX_CELLS = 60_000;

function sessionValues(world, columns) {
  // Each athlete's session-level value per readable column, in ONE plan (the import's own gates).
  const ids = [];
  const extracts = [];
  for (const col of columns) {
    if (!col.readable) continue;
    // The registry's own entry, taken here (the importer's architecture guard: a value is read only through extractorFor).
    const extractor = extractorFor({ sourceSystem: col.field.source_system, apiFamily: col.field.api_family, sourceMetricKey: col.field.source_metric_key });
    if (!extractor) continue;
    ids.push(col.field.id);
    extracts.push((input) => extractor.extract(input, {}));
  }
  const rowCount = Array.isArray(world.candidate.raw_bundle?.athleteSessions) ? world.candidate.raw_bundle.athleteSessions.length : 0;
  if (extracts.length * rowCount > BOARD_MAX_CELLS) throw refusal(409, "board_too_large", BOARD_MESSAGES.board_too_large);
  const out = gpexeSessionValuesKeyed(world.candidate.raw_bundle, extracts, { teamTimezone: world.teamTimezone });
  if (out.code) throw refusal(409, "candidate_not_importable", BOARD_MESSAGES.candidate_not_importable, { current: { reason: out.code } });
  return out.athletes.map((athlete) => {
    const key = String(athlete.key);
    const values = new Map(ids.map((id, index) => [id, athlete.session[index].length === 1 ? canonicalDecimal(athlete.session[index][0]) : null]));
    return { key, named: world.names.has(key), values };
  });
}

function choosePair(world, columns, pairIndex) {
  const athletes = sessionValues(world, columns);
  const placeable = columns.filter((c) => c.reason === null).map((c) => c.field.id);
  // With no column that can be placed as a new row, the pair is chosen over the columns that can be read.
  const ranked = rankPairs(athletes, placeable.length > 0 ? placeable : columns.filter((c) => c.readable).map((c) => c.field.id));
  if (ranked.length === 0) throw refusal(409, "not_enough_athletes", BOARD_MESSAGES.not_enough_athletes);
  if (pairIndex >= ranked.length) throw refusal(409, "pair_out_of_range", BOARD_MESSAGES.pair_out_of_range, { current: { count: ranked.length } });
  const { a, b } = ranked[pairIndex];
  return { a, b, index: pairIndex, count: ranked.length, labels: [world.names.get(a.key), world.names.get(b.key)] };
}

const conversionBetween = (world, from, to) => {
  if (from === to) return { kind: "same_unit", factors: IDENTITY };
  const row = world.conversions.find((c) => c.from_unit === from && c.to_unit === to);
  return row ? { kind: "converted", factors: factorsOf(row) } : null;
};
const stored = (raw, factors) => (raw === null ? null : convertAtStorageScale(raw, factors));
const levelsOf = (v) => ({ session: v.applies_to_session === true, drill: v.applies_to_drill === true });
// The open activations a start of this field and variable would collide with (v34's two open-row rules).
function collisionsOf(world, { fieldId, variableId, levels }) {
  return world.open
    .filter((o) => (o.field_id === fieldId && o.parameter_fingerprint === "")
      || (o.variable_id === variableId && ((levels.session && o.applies_to_session) || (levels.drill && o.applies_to_drill))))
    .map((o) => ({ activationId: o.id, fieldId: o.field_id, variableId: o.variable_id }));
}

// A row of an active version (OptiMove's, or the club's own): pre-placed, never compared.
function versionRow(world, pair, col, v) {
  const factors = factorsOf(v);
  const rawA = pair.a.values.get(col.field.id) ?? null;
  const rawB = pair.b.values.get(col.field.id) ?? null;
  const storedA = stored(rawA, factors);
  const storedB = stored(rawB, factors);
  return {
    kind: "preplaced",
    badge: v.owner_key === "system" ? "optimove_mapping" : "club_mapping",
    mappingVersionId: v.id, fieldId: v.field_id, variableId: v.variable_id,
    sourceUnit: v.source_unit, targetUnit: v.target_unit,
    conversion: v.source_unit === v.target_unit && sameFactors(factors, IDENTITY) ? { kind: "same_unit" } : { kind: "converted", ...factors },
    levels: levelsOf(v),
    values: { a: { raw: rawA, stored: storedA }, b: { raw: rawB, stored: storedB } },
    placementHash: placementHash({
      bundleHash: world.candidate.bundle_hash, pairIndex: pair.index, pairLabels: pair.labels, revisionId: v.revision_id, mappingVersionId: v.id,
      conversion: conversionText(factors), rawA, storedA, rawB, storedB,
    }),
  };
}

function boardOf(world, pairIndex) {
  if (world.sessionRefusal) throw world.sessionRefusal;
  const columns = columnsOf(world);
  const pair = choosePair(world, columns, pairIndex);
  const colById = new Map(columns.map((c) => [c.field.id, c]));
  const variableById = new Map(world.variables.map((v) => [v.id, v]));
  const offByMapping = new Map(world.switchedOff.map((s) => [s.mapping_id, s]));
  const openVersionIds = new Set(world.open.map((o) => o.mapping_version_id));

  const preplaced = [];
  const replaceable = [];
  const switchedOff = [];
  const fedBySystem = new Map();
  for (const v of world.versions) {
    const col = colById.get(v.field_id);
    const variable = variableById.get(v.variable_id);
    // Eligible (section 7): the column can be read and has a value in this session, the
    // version's revision is the column's active one, its variable is active, current and not hidden.
    if (!col || !col.readable || v.parameter_kind !== "none" || col.field.revision_id !== v.revision_id) continue;
    if (!variable || variable.version_id !== v.target_version_id || variable.hidden) continue;
    if (v.owner_key === "system") {
      if (!fedBySystem.has(v.variable_id)) fedBySystem.set(v.variable_id, []);
      fedBySystem.get(v.variable_id).push(v.field_id);
    }
    if (openVersionIds.has(v.id)) continue; // already on: a row of `on`
    const row = versionRow(world, pair, col, v);
    if (row.values.a.raw === null && row.values.b.raw === null) continue; // no value in the board's session
    const off = offByMapping.get(v.mapping_id);
    if (off) {
      switchedOff.push({ mappingVersionId: v.id, fieldId: v.field_id, variableId: v.variable_id, badge: row.badge, endedBy: off.ended_by ?? null, endedAt: off.ended_at });
      continue;
    }
    const replaces = collisionsOf(world, { fieldId: v.field_id, variableId: v.variable_id, levels: row.levels });
    if (replaces.length > 0) replaceable.push({ ...row, replaces });
    else preplaced.push(row);
  }

  return {
    board: {
      displayRegistryVersion: DISPLAY_REGISTRY_VERSION,
      team: { id: world.team.id, name: world.team.name, sourceTeamId: world.team.source_team_id },
      session: { candidateId: world.candidate.id, label: world.candidate.session_label ?? null, startedAt: world.candidate.session_started_at },
      pair: { index: pair.index, count: pair.count, labels: pair.labels },
      columns: columns.map((c) => {
        const rawA = c.readable ? pair.a.values.get(c.field.id) ?? null : null;
        const rawB = c.readable ? pair.b.values.get(c.field.id) ?? null : null;
        const reason = c.reason ?? (distinctPair(rawA, rawB) ? null : "no_value_for_pair");
        return {
          fieldId: c.field.id, revisionId: c.field.revision_id, key: c.field.source_metric_key, label: c.field.source_label,
          unit: c.field.evidence_status === "verified" ? c.field.source_unit : null,
          unitProven: c.field.evidence_status === "verified" && c.field.source_unit !== null,
          expectedUnit: c.field.expected_source_unit ?? null,
          placeable: reason === null, reason,
          displayRule: c.rule?.rule ?? null, displayUnits: c.rule ? [...c.rule.units] : [],
          rawA, rawB,
        };
      }),
      variables: world.variables.filter((v) => !(v.owner_scope === "system" && v.hidden)).map((v) => ({
        id: v.id, ownerScope: v.owner_scope, key: v.key, label: v.label, versionId: v.version_id,
        unit: v.unit_is_token ? v.unit : null,
        // A club variable takes a column; an OptiMove variable only where its system mapping of a column fills it (C61).
        placeable: v.owner_scope === "club" ? v.value_type === "numeric" && v.unit_is_token === true : fedBySystem.has(v.id),
        filledByFieldIds: v.owner_scope === "system" ? fedBySystem.get(v.id) ?? [] : [],
      })),
      on: world.open.map((o) => ({
        activationId: o.id, mappingVersionId: o.mapping_version_id, fieldId: o.field_id, variableId: o.variable_id,
        requirement: o.requirement, badge: o.owner_scope === "system" ? "optimove_mapping" : "club_mapping",
        levels: { session: o.applies_to_session, drill: o.applies_to_drill },
      })),
      preplaced, replaceable, switchedOff,
    },
  };
}

export async function readBoard({ ctx, queryString }) {
  if (!mayUseBoard(ctx)) throw NOT_FOUND();
  const q = readQuery(queryString, { teamId: "uuid", candidateId: "uuid", pair: "index" }, ["teamId"]);
  await removeExpiredBatch();
  const world = await boundedRead((client) => loadWorld(client, ctx, { teamId: q.teamId, candidateId: q.candidateId ?? null }));
  return boardOf(world, q.pair ?? 0);
}

// ---------------------------------------------------------------------------
// Route 2: one placement. A placement's own refusals are a 200 with
// placeable: false and a code, so the panel can show them.
// ---------------------------------------------------------------------------
function inLimits(value, variable) {
  if (value === null) return true;
  if (variable.min_value !== null && compareDecimal(value, variable.min_value) < 0) return false;
  if (variable.max_value !== null && compareDecimal(value, variable.max_value) > 0) return false;
  return true;
}

function placementOf(world, pairIndex, { fieldId, targetId }, shared = null) {
  const columns = shared?.columns ?? columnsOf(world);
  const col = columns.find((c) => c.field.id === fieldId);
  const variable = world.variables.find((v) => v.id === targetId);
  // A column or a variable outside what this workspace reads is the identical 404
  // (another club's variable, a hidden OptiMove one, an unknown id) - before
  // any refusal about the session or the pair.
  if (!col || !variable || (variable.owner_scope === "system" && variable.hidden)) throw NOT_FOUND();
  if (world.sessionRefusal) throw world.sessionRefusal;
  const pair = shared ? shared.pairOf() : choosePair(world, columns, pairIndex);
  const refuse = (code, extra = {}) => ({ placement: { placeable: false, code, fieldId, targetId, ...extra } });

  if (variable.owner_scope === "system") {
    // An OptiMove variable is filled only by OptiMove's own mapping of this column (C61).
    const v = world.versions.find((x) => x.owner_key === "system" && x.field_id === fieldId && x.variable_id === targetId && x.parameter_kind === "none"
      && x.revision_id === col.field.revision_id && x.target_version_id === variable.version_id);
    if (!v || !col.readable) return refuse("target_scope_mismatch");
    if (world.open.some((o) => o.mapping_version_id === v.id)) return refuse("activation_exists");
    const row = versionRow(world, pair, col, v);
    return { placement: { placeable: true, ...row, collisions: collisionsOf(world, { fieldId, variableId: targetId, levels: row.levels }) } };
  }

  if (col.reason !== null) return refuse(col.reason);
  if (variable.value_type !== "numeric" || !variable.unit_is_token) return refuse("target_not_usable");
  if (variable.has_condition) return refuse("condition_mismatch");
  const conversion = conversionBetween(world, col.field.source_unit, variable.unit);
  if (!conversion) return refuse("conversion_unavailable", { sourceUnit: col.field.source_unit, targetUnit: variable.unit });
  const scopes = variable.scopes ?? [];
  const levels = { session: col.field.supports_session === true && scopes.includes("session"), drill: col.field.supports_drill === true && scopes.includes("component") };
  if (!levels.session) return refuse("level_not_allowed");
  // C33: another mapping of the club with an active version of this column.
  const own = world.versions.filter((v) => v.owner_key === world.clubId && v.field_id === fieldId && v.parameter_fingerprint === "");
  if (own.some((v) => v.variable_id !== targetId)) return refuse("source_metric_target_taken");
  const active = own.find((v) => v.variable_id === targetId) ?? null;
  // The mapping's active version is reused only when it is this very contract (section 4.3 step 10).
  if (active && (active.revision_id !== col.field.revision_id || active.target_version_id !== variable.version_id
      || !sameFactors(factorsOf(active), conversion.factors) || active.applies_to_session !== levels.session || active.applies_to_drill !== levels.drill)) {
    return refuse("mapping_version_active");
  }
  // The same contract is already on for the team: nothing to place.
  if (active && world.open.some((o) => o.mapping_version_id === active.id)) return refuse("activation_exists");
  const rawA = pair.a.values.get(fieldId) ?? null;
  const rawB = pair.b.values.get(fieldId) ?? null;
  if (!distinctPair(rawA, rawB)) return refuse("pair_not_distinct");
  const storedA = stored(rawA, conversion.factors);
  const storedB = stored(rawB, conversion.factors);
  if (!inLimits(storedA, variable) || !inLimits(storedB, variable)) {
    return refuse("value_outside_limits", { limits: { min: variable.min_value, max: variable.max_value, unit: variable.unit } });
  }
  const display = {};
  const hashes = {};
  for (const unit of col.rule.units) {
    display[unit] = { a: displayValue(col.rule, unit, rawA), b: displayValue(col.rule, unit, rawB) };
    hashes[unit] = placementHash({
      bundleHash: world.candidate.bundle_hash, pairIndex: pair.index, pairLabels: pair.labels, revisionId: col.field.revision_id, targetVersionId: variable.version_id,
      conversion: conversion.kind === "same_unit" ? "same" : conversionText(conversion.factors),
      displayRule: col.rule.rule, displayUnit: unit, rawA, storedA, rawB, storedB,
    });
  }
  return {
    placement: {
      placeable: true, kind: "new", fieldId, targetId,
      revisionId: col.field.revision_id, expectedTargetVersionId: variable.version_id,
      reusesVersionId: active ? active.id : null,
      sourceUnit: col.field.source_unit, targetUnit: variable.unit,
      conversion: conversion.kind === "same_unit" ? { kind: "same_unit" } : { kind: "converted", ...conversion.factors },
      levels,
      displayRule: col.rule.rule, displayUnits: [...col.rule.units],
      values: { a: { raw: rawA, stored: storedA }, b: { raw: rawB, stored: storedB } },
      display,
      collisions: collisionsOf(world, { fieldId, variableId: targetId, levels }),
      placementHashes: hashes,
    },
  };
}

// A row of an active version the save switches on as it is (OptiMove's, or
// the club's own): { row } or { code }. The same eligibility as the board's
// pre-placed rows, except that a mapping an administrator switched off may be
// placed again by hand.
function preplacedOf(world, shared, mappingVersionId) {
  const v = world.versions.find((x) => x.id === mappingVersionId);
  if (!v) throw NOT_FOUND();
  const col = shared.columns.find((c) => c.field.id === v.field_id);
  const variable = world.variables.find((x) => x.id === v.variable_id);
  if (!col || !variable) throw NOT_FOUND();
  if (world.sessionRefusal) throw world.sessionRefusal;
  if (!col.readable || v.parameter_kind !== "none") return { code: col.reason ?? "field_has_parameters", v };
  if (col.field.revision_id !== v.revision_id) return { code: "revision_not_usable", v };
  if (variable.version_id !== v.target_version_id) return { code: "canonical_version_changed", v };
  if (variable.hidden) return { code: "variable_hidden", v };
  if (world.open.some((o) => o.mapping_version_id === v.id)) return { code: "activation_exists", v };
  const row = versionRow(world, shared.pairOf(), col, v);
  return { row: { ...row, collisions: collisionsOf(world, { fieldId: v.field_id, variableId: v.variable_id, levels: row.levels }) }, v };
}

export async function readPlacement({ ctx, queryString }) {
  if (!mayUseBoard(ctx)) throw NOT_FOUND();
  const q = readQuery(queryString, { teamId: "uuid", candidateId: "uuid", pair: "index", fieldId: "uuid", targetId: "uuid" }, ["teamId", "candidateId", "pair", "fieldId", "targetId"]);
  const world = await boundedRead((client) => loadWorld(client, ctx, { teamId: q.teamId, candidateId: q.candidateId }));
  return placementOf(world, q.pair, { fieldId: q.fieldId, targetId: q.targetId });
}

// ---------------------------------------------------------------------------
// Routes 4 and 5: the stored confirmations of a team (History).
// ---------------------------------------------------------------------------
// The scope predicate (section 6.2): the confirmation's club is the
// workspace's club, its team is active and currently in that club, and the
// club is active. A platform admin in the platform workspace reads any.
const SCOPE_SQL = `
  from training_load.source_metric_confirmations c
  join training_load.source_metric_confirmation_sessions s on s.confirmation_id = c.id and s.session_ordinal = 1
  left join public.users u on u.id = c.confirmed_by_user_id
 where ($1::text = 'system'
        or (c.owner_club_id = $2::uuid
            and exists (select 1 from public.teams t join public.clubs cl on cl.id = t.club_id and coalesce(cl.is_active, true)
                         where t.id = c.team_id and t.club_id = $2::uuid and coalesce(t.is_active, true))))`;
const CONFIRMATION_COLUMNS = `c.id, c.team_id, c.confirmed_at, to_char(c.confirmed_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as cursor_at, c.attested, c.values_expire_at <= now() as expired,
  coalesce(nullif(u.display_name, ''), u.full_name) as confirmed_by, s.session_started_at`;

async function itemsOf(client, confirmationIds) {
  if (confirmationIds.length === 0) return new Map();
  const rows = (await client.query(
    `select i.confirmation_id, i.item_no, i.item_kind, i.checked, i.mapping_version_id, i.source_unit, i.target_unit,
            trim_scale(i.scale)::text as scale, trim_scale(i.scale_divisor)::text as scale_divisor, trim_scale(i."offset")::text as "offset",
            i.gpexe_display_rule, i.gpexe_display_unit,
            trim_scale(i.raw_a)::text as raw_a, trim_scale(i.stored_a)::text as stored_a, trim_scale(i.raw_b)::text as raw_b, trim_scale(i.stored_b)::text as stored_b,
            i.values_removed_kind, d.source_metric_key, d.source_label, md.label as variable_label, md.id as variable_id, d.id as field_id
       from training_load.source_metric_confirmation_items i
       join training_load.source_metric_mapping_versions v on v.id = i.mapping_version_id
       join training_load.source_metric_definitions d on d.id = v.source_metric_definition_id
       join training_load.metric_definitions md on md.id = v.metric_definition_id
      where i.confirmation_id = any($1::uuid[])
      order by i.confirmation_id, i.item_no`,
    [confirmationIds],
  )).rows;
  const out = new Map();
  for (const r of rows) {
    if (!out.has(r.confirmation_id)) out.set(r.confirmation_id, []);
    out.get(r.confirmation_id).push(r);
  }
  return out;
}

function confirmationOut(row, items) {
  return {
    id: row.id, teamId: row.team_id, confirmedAt: row.confirmed_at, confirmedBy: row.confirmed_by ?? null,
    sessionStartedAt: row.session_started_at,
    rows: items.map((i) => {
      const factors = factorsOf(i);
      // The values' state: never a value past the expiry, before any physical removal (section 5.8).
      let state = "not_compared";
      if (i.checked) state = i.values_removed_kind ?? (row.expired ? "expired" : "present");
      return {
        itemNo: i.item_no, kind: i.item_kind, checked: i.checked, mappingVersionId: i.mapping_version_id,
        fieldId: i.field_id, column: { key: i.source_metric_key, label: i.source_label },
        variableId: i.variable_id, variable: { label: i.variable_label },
        sourceUnit: i.source_unit, targetUnit: i.target_unit,
        conversion: i.source_unit === i.target_unit && sameFactors(factors, IDENTITY) ? { kind: "same_unit" } : { kind: "converted", ...factors },
        displayRule: i.gpexe_display_rule, displayUnit: i.gpexe_display_unit,
        valuesState: state,
        values: state === "present" ? { a: { raw: i.raw_a, stored: i.stored_a }, b: { raw: i.raw_b, stored: i.stored_b } } : null,
      };
    }),
  };
}

// The cursor carries the row's time in full (microseconds), as text from SQL, never through a JS Date.
const CURSOR_AT = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{6}Z$/;
const realInstant = (at) => { const d = new Date(at.slice(0, 23) + "Z"); return !Number.isNaN(d.getTime()) && d.getUTCFullYear() >= 2000 && d.toISOString().slice(0, 23) === at.slice(0, 23); };
const encodeCursor = (row) => Buffer.from(JSON.stringify([row.cursor_at, row.id])).toString("base64url");
function decodeCursor(text) {
  try {
    const [at, id] = JSON.parse(Buffer.from(text, "base64url").toString("utf8"));
    if (typeof at !== "string" || !CURSOR_AT.test(at) || !realInstant(at) || typeof id !== "string" || !UUID.test(id)) throw new Error("cursor");
    return { at, id: id.toLowerCase() };
  } catch {
    throw refusal(400, "invalid_query", BOARD_MESSAGES.invalid_query);
  }
}

export async function listConfirmations({ ctx, queryString }) {
  if (!mayReadConfirmations(ctx)) throw NOT_FOUND();
  const q = readQuery(queryString, { teamId: "uuid", cursor: "text" }, ["teamId"]);
  const cursor = q.cursor === undefined ? null : decodeCursor(q.cursor);
  await removeExpiredBatch();
  return boundedRead(async (client) => {
    // The team inside the scope first: a team outside it is the identical 404, not an empty list.
    const team = (await client.query(
      // The same audience as SCOPE_SQL: a platform admin in the platform workspace reads any team's history.
      `select 1 from public.teams t
        where t.id = $1::uuid and ($2::text = 'system' or (t.club_id = $3::uuid and coalesce(t.is_active, true)
              and exists (select 1 from public.clubs cl where cl.id = t.club_id and coalesce(cl.is_active, true))))`,
      [q.teamId, ctx.owner.scope, ctx.owner.clubId],
    )).rows[0];
    if (!team) throw NOT_FOUND();
    const rows = (await client.query(
      `select ${CONFIRMATION_COLUMNS} ${SCOPE_SQL}
          and c.team_id = $3::uuid
          and ($4::timestamptz is null or (c.confirmed_at, c.id) < ($4::timestamptz, $5::uuid))
        order by c.confirmed_at desc, c.id desc
        limit $6`,
      [ctx.owner.scope, ctx.owner.clubId, q.teamId, cursor?.at ?? null, cursor?.id ?? null, CONFIRMATIONS_PAGE + 1],
    )).rows;
    const page = rows.slice(0, CONFIRMATIONS_PAGE);
    const items = await itemsOf(client, page.map((r) => r.id));
    return {
      confirmations: page.map((r) => confirmationOut(r, items.get(r.id) ?? [])),
      nextCursor: rows.length > CONFIRMATIONS_PAGE ? encodeCursor(page[page.length - 1]) : null,
    };
  });
}

export async function readConfirmation({ ctx, confirmationId }) {
  if (!mayReadConfirmations(ctx)) throw NOT_FOUND();
  if (typeof confirmationId !== "string" || !UUID.test(confirmationId)) throw NOT_FOUND();
  await removeExpiredBatch();
  return boundedRead(async (client) => {
    const found = await confirmationById(client, ctx, confirmationId.toLowerCase());
    if (!found) throw NOT_FOUND();
    return found;
  });
}

// What the save (sourceMetricBoardSaveService.js) reuses, so that it
// recomputes exactly what the reads showed.
// One confirmation in the caller's History scope, on the caller's executor: { confirmation } or null.
async function confirmationById(executor, ctx, confirmationId) {
  if (!mayReadConfirmations(ctx)) return null;
  const row = (await executor.query(`select ${CONFIRMATION_COLUMNS} ${SCOPE_SQL} and c.id = $3::uuid`, [ctx.owner.scope, ctx.owner.clubId, confirmationId])).rows[0];
  if (!row) return null;
  const items = await itemsOf(executor, [row.id]);
  return { confirmation: confirmationOut(row, items.get(row.id) ?? []) };
}
export const boardKit = Object.freeze({ loadWorld, columnsOf, choosePair, placementOf, preplacedOf, BOARD_MESSAGES, removeExpiredBatch, confirmationById });
