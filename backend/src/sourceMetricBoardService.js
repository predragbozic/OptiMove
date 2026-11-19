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
import { conditionRuleFor, storedRule } from "./sourceConditionRules.js";
import { conditionMatchInstalled, conditionRuleColumn, matchCondition, ruleFits, settingMismatchText } from "./sourceConditionMatch.js";
import { revisionProven } from "./sourceFieldEvidence.js";
import { bundleZoneThresholds } from "./sourceZoneThresholds.js";
import { adminWriteKit } from "./sourceMetricMappingService.js";
import { GPEXE_SOURCE_SYSTEM, gpexeSessionValuesKeyed } from "./gpexeImportMapper.js";
import { BLOCK_MESSAGES } from "./gpexeImportPreview.js";
import { teamSessionTimezone } from "./gpexeTeamTimezoneRead.js";
import { convertAtStorageScale } from "./sourceMetricPreview.js";
import { canonicalDecimal, compareDecimal, extractorFor, isGenericDetailsKey } from "./sourceMetricExtractors.js";
import { provenWordsOf, unitWordCodeOf, unitWordsFor } from "./sourceUnitWords.js";
import { removeExpiredBatch as removeExpiredValuesBatch, setRemovalFaultForTests } from "./sourceMetricConfirmationRemoval.js";
import { DISPLAY_REGISTRY_VERSION, displayRuleFor, displayValue, distinctPair, placementHash, rankPairs } from "./sourceMetricBoard.js";

const { boundedRead, refusal, NOT_FOUND, UUID } = adminWriteKit;

// The largest stored bundle the board reads (7e's bound, R7 of J11).
export const BOARD_MAX_BUNDLE_BYTES = 16 * 1024 * 1024;
export const CONFIRMATIONS_PAGE = 50;
// With no session named, the board opens on the newest stored session the import would take. It looks at most this
// far back; each one is read and tried alone, never several bundles at once.
export const BOARD_DEFAULT_SESSION_ATTEMPTS = 10;
// The time those attempts may take in all, inside the read's own 8 s bound.
export const BOARD_DEFAULT_SESSION_BUDGET_MS = 4_000;
let defaultSessionBudgetMs = BOARD_DEFAULT_SESSION_BUDGET_MS;
// Test seam: another budget (the default with no argument).
export function setBoardDefaultSessionBudgetForTests(ms = BOARD_DEFAULT_SESSION_BUDGET_MS) { defaultSessionBudgetMs = ms; }
const SOURCE_CONNECTION_PATH = "source_connection";

const BOARD_MESSAGES = {
  invalid_query: "The query carries a parameter this route does not take, or a value it cannot read.",
  no_stored_session: "No saved session yet. Run a search in Imports first.",
  no_usable_session: "None of the sessions found so far can be used for mapping. Run a search in Imports for another session.",
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

// The board's audience (section 4.1): in a club workspace, the club's admin or a platform admin there (the club's
// variables, and OptiMove's where OptiMove's own mapping fills them); S (the owner, 2026-11-17): in the platform
// workspace, an active platform admin for any club's team, onto OptiMove's (system) variables only. The owner of
// what a save writes is always the workspace's (J1): the club's on a club board, OptiMove's on the platform board.
export const isSystemBoard = (ctx) => ctx?.owner?.scope === "system" && ctx.basis === "platform_admin";
export const mayUseBoard = (ctx) => (ctx?.owner?.scope === "club" && (ctx.basis === "club_admin" || ctx.basis === "platform_admin")) || isSystemBoard(ctx);
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
  const systemBoard = isSystemBoard(ctx);
  // The team, its one active GPEXE binding, and the binding's connection owned by the team's club - the workspace's
  // club on a club board; any active club on the platform board (S).
  const team = (await client.query(
    `select t.id, t.name, t.club_id, cl.name as club_name, b.id as binding_id, b.connection_id, b.source_team_id, h.api_family
       from public.teams t
       join public.clubs cl on cl.id = t.club_id and coalesce(cl.is_active, true)
       join training_load.source_team_bindings b on b.team_id = t.id and b.state = 'active' and b.source_system = $3
       join training_load.source_credential_connections c on c.id = b.connection_id and c.owner_scope = 'club' and c.owner_club_id = t.club_id
       join training_load.source_host_catalog h on h.source_system = c.source_system and h.host_key = c.host_key
      where t.id = $1 and ($2::uuid is null or t.club_id = $2::uuid) and coalesce(t.is_active, true)`,
    [teamId, systemBoard ? null : ctx.owner.clubId, GPEXE_SOURCE_SYSTEM],
  )).rows[0];
  if (!team) throw NOT_FOUND();
  // The team's club (its hides of OptiMove's variables apply on both boards); the owner of what a save writes.
  const clubId = String(team.club_id);
  const ownerKey = systemBoard ? "system" : clubId;

  const teamTimezone = await teamSessionTimezone(client, team.id);

  // The source fields of the binding's family, each with its active revision.
  const fields = (await client.query(
    `select d.id, d.source_system, d.api_family, d.source_metric_key, d.source_label,
            r.id as revision_id, r.value_shape, r.parameter_kind, r.supports_session, r.supports_drill,
            r.source_unit, r.expected_source_unit, r.evidence_status,
            d.created_by_user_id is not null as created
       from training_load.source_metric_definitions d
       join training_load.source_metric_definition_versions r on r.source_metric_definition_id = d.id and r.state = 'active'
      where d.source_system = $1 and d.api_family = $2 and d.state = 'active'
      order by d.source_metric_key collate "C"`,
    [GPEXE_SOURCE_SYSTEM, team.api_family],
  )).rows;
  // G1b-2 (rule (b)): GPEXE's unit words, once for this board, only when a generic details field is among the fields: a
  // column reads exactly the words of its revision's proven unit, as its import does.
  const unitWords = await unitWordsFor(client, fields.map((f) => ({ sourceSystem: f.source_system, apiFamily: f.api_family, sourceMetricKey: f.source_metric_key })));
  // G1b-3: the exact word of each generic details field's proof, read only when such a field is on the board.
  const generic = fields.filter((f) => isGenericDetailsKey({ sourceSystem: f.source_system, apiFamily: f.api_family, sourceMetricKey: f.source_metric_key }));
  const proven = generic.length > 0 ? await provenWordsOf(client, generic.map((f) => f.revision_id)) : new Map();
  for (const f of fields) f.proven_word = proven.get(String(f.revision_id)) ?? null;

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
  // How many newer stored sessions the default left behind because the import would not take them.
  let defaultSkipped = 0;
  // The plan of the session the default took, so it is not built a second time for the answer.
  let defaultPlan = null;
  if (candidateId) {
    candidate = (await client.query(candidateSql(`c.id = $5::uuid`, ""), [...base, candidateId])).rows[0];
    // An id that is not a usable stored session of this team is the identical 404.
    if (!candidate) throw onCandidateMissing();
  } else {
    // No session named: the newest stored session THE IMPORT WOULD TAKE, not merely the newest one. A session of a
    // type OptiMove does not import (a match, for one) at the top of the list must not close the board for the team.
    // One statement lists the newest few (ids only, no bundle); then each is read alone, within the size bound, and
    // tried with the board's own plan, until one is taken. Sessions the import already blocked are tried last: a
    // block may be only "no mapping yet", which is what the board is for, so it is never taken as the answer itself.
    const listed = (await client.query(
      `select c.id, c.status = 'blocked' as blocked, c.preview->'blocked'->>'code' as blocked_code
         from training_load.gpexe_import_candidates c
         join training_load.gpexe_import_checks k on k.id = c.last_seen_check_id and k.owner_team_id = c.owner_team_id
        where c.owner_team_id = $1::uuid and ${usable}
          and c.raw_purged_at is null and c.raw_expires_at > now() and c.session_started_at is not null
          and k.status = 'succeeded' and k.source_path = $3::text and k.source_binding_id = $2::uuid
        order by c.session_started_at desc, c.id limit ${BOARD_DEFAULT_SESSION_ATTEMPTS}`,
      base.slice(0, 3),
    )).rows;
    if (listed.length === 0) throw refusal(409, "no_stored_session", BOARD_MESSAGES.no_stored_session);
    const columns = columnsOf({ fields, unitWords });
    // "Refused by the import's own gates": blocked, with a code that is not one of the mapping-level blocks (those say
    // "no mapping yet" or "this mapping does not fit", which the board is there to change). Such a session is not read
    // while another can be taken; its stored code is its reason. Every other session is tried, newest first.
    const rows = listed.map((row, index) => ({ ...row, index, gate: row.blocked === true && typeof row.blocked_code === "string" && !Object.hasOwn(BLOCK_MESSAGES, row.blocked_code) }));
    const reasons = [];
    let tried = 0;
    const startedAt = Date.now();
    // The attempts have a time budget of their own, well inside the read's bound: when it is spent the answer is the
    // honest "none usable among those tried", never the read's own timeout. One attempt is always made.
    const inBudget = () => tried === 0 || Date.now() - startedAt < defaultSessionBudgetMs;
    const attempt = async (row) => {
      tried += 1;
      const read = (await client.query(candidateSql(`c.id = $5::uuid`, ""), [...base, row.id])).rows[0];
      const verdict = !read ? { why: "gone", plan: null } : defaultSessionVerdict(read, team, columns, teamTimezone, unitWords);
      if (verdict.why !== null) { reasons[row.index] = verdict.why; return false; }
      candidate = read;
      defaultPlan = verdict.plan;
      // The newer ones passed by: each was tried and refused, or the import's own gates had refused it.
      defaultSkipped = rows.filter((r) => r.index < row.index && (reasons[r.index] !== undefined || r.gate)).length;
      return true;
    };
    for (const pass of [rows.filter((r) => !r.gate), rows.filter((r) => r.gate)]) {
      if (candidate) break;
      for (const row of pass) {
        if (!inBudget()) break;
        if (await attempt(row)) break;
      }
    }
    if (!candidate) {
      // One reason when every session has the same one (said in the sentence); otherwise "mixed". A session the gates
      // had refused and that was not read again speaks by its stored code.
      const all = rows.map((r) => reasons[r.index] ?? (r.gate ? r.blocked_code : undefined)).filter((x) => x !== undefined);
      const distinct = [...new Set(all)];
      // Every session that was read failed the same unexpected way: that points at this code, not at one stored
      // bundle. Said once more, so it is not mistaken for a single bad session.
      const failed = reasons.filter((x) => x !== undefined);
      if (failed.length >= 2 && failed.every((x) => x === DEFAULT_SESSION_UNREADABLE)) console.error(`[source-metric-board] default_session_all_unreadable (tried=${failed.length})`);
      throw refusal(409, "no_usable_session", BOARD_MESSAGES.no_usable_session, { current: { reason: distinct.length === 1 ? distinct[0] : "mixed", tried } });
    }
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

  // The variables: the club's own, then OptiMove's (section 3.3); on the platform board OptiMove's only.
  const variables = (await client.query(
    `select d.id, d.owner_scope, d.key, d.label, v.id as version_id, v.value_type, v.unit,
            coalesce(training_load.source_metric_unit_token_ok(v.unit), false) as unit_is_token,
            trim_scale(v.min_value)::text as min_value, trim_scale(v.max_value)::text as max_value,
            v.condition_description is not null as has_condition, v.condition_description as condition_raw,
            ((to_jsonb(v.*) ->> 'calculation') is not null) as calculated,
            (select array_agg(c.scope_level order by c.scope_level) from training_load.metric_definition_scope_capabilities c where c.metric_definition_id = d.id) as scopes,
            exists (select 1 from training_load.metric_definition_club_hides h
                     where h.club_id = $1::uuid and h.metric_definition_id = d.id and h.shown_at is null) as hidden
       from training_load.metric_definitions d
       join training_load.metric_definition_versions v on v.id = d.current_version_id and v.metric_definition_id = d.id
      where d.state = 'active' and ((d.owner_scope = 'club' and d.owner_club_id = $1::uuid and not $2::boolean) or d.owner_scope = 'system')
      order by (d.owner_scope = 'system'), d.label collate "C", d.id`,
    [clubId, systemBoard],
  )).rows;

  // The active mapping versions the club can use: OptiMove's and its own; on the platform board OptiMove's only.
  const matchInstalled = await conditionMatchInstalled(client);
  const versions = (await client.query(
    `select v.id, v.mapping_id, v.owner_key, v.source_metric_definition_id as field_id, v.metric_definition_id as variable_id,
            v.source_metric_version_id as revision_id, v.metric_definition_version_id as target_version_id,
            v.parameter_kind, v.parameter_fingerprint, v.source_unit, v.target_unit,
            trim_scale(v.scale)::text as scale, trim_scale(v.scale_divisor)::text as scale_divisor, trim_scale(v."offset")::text as "offset",
            v.applies_to_session, v.applies_to_drill, ${conditionRuleColumn(matchInstalled)}
       from training_load.source_metric_mapping_versions v
      where v.status = 'active' and v.owner_key = any($1::text[])
      order by v.id`,
    [systemBoard ? ["system"] : ["system", clubId]],
  )).rows;

  // What is switched on for the team, and what an administrator switched off on this binding (Q9).
  const open = (await client.query(
    `select a.id, a.mapping_version_id, a.source_metric_definition_id as field_id, a.metric_definition_id as variable_id,
            a.parameter_fingerprint, a.applies_to_session, a.applies_to_drill, a.requirement, m.owner_scope,
            md.label as variable_label
       from training_load.source_metric_mapping_activations a
       join training_load.source_metric_mappings m on m.id = a.mapping_id
       left join training_load.metric_definitions md on md.id = a.metric_definition_id
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
                          join training_load.source_metric_audit mc on mc.operation_id = e.operation_id
                           and (mc.action = 'mapping_confirmation'
                                -- S: a platform-board save stores no confirmation; its replacement is an end in the same
                                -- operation as the start of an OptiMove (system) mapping. The 7i move to a club's copy also
                                -- ends and starts in one operation, but it starts the club's copy, so it stays a switch-off.
                                or (mc.action = 'activation_start'
                                    and exists (select 1 from training_load.source_metric_mapping_versions sv
                                                  join training_load.source_metric_mappings sm on sm.id = sv.mapping_id
                                                 where sv.id = mc.mapping_version_id and sm.owner_scope = 'system')))
                         where e.activation_id = x.id and e.action = 'activation_end')`,
    [team.binding_id],
  )).rows;

  // S-2: a club board's mapping whose latest activation on this binding a platform-board save ended (an end in the same
  // operation as the start of an OptiMove mapping, with no club confirmation in it): the club reads when OptiMove's
  // mapping replaced it.
  const replacedBySystem = systemBoard ? [] : (await client.query(
    `select x.mapping_id, x.ended_at
       from (select distinct on (a.mapping_id) a.id, a.mapping_id, a.ended_at, a.end_reason
               from training_load.source_metric_mapping_activations a
              where a.source_team_binding_id = $1
              order by a.mapping_id, a.activated_at desc, a.id desc) x
      where x.end_reason = 'admin_ended'
        and exists (select 1 from training_load.source_metric_audit e
                      join training_load.source_metric_audit mc on mc.operation_id = e.operation_id and mc.action = 'activation_start'
                      join training_load.source_metric_mapping_versions sv on sv.id = mc.mapping_version_id
                      join training_load.source_metric_mappings sm on sm.id = sv.mapping_id and sm.owner_scope = 'system'
                     where e.activation_id = x.id and e.action = 'activation_end'
                       -- A club-board save stores the club's confirmation in the same operation: the club itself switched
                       -- OptiMove's mapping on, so its own mapping is not "replaced by OptiMove's mapping".
                       and not exists (select 1 from training_load.source_metric_audit c
                                     where c.operation_id = e.operation_id and c.action = 'mapping_confirmation'))`,
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

  // v80: each variable with a condition, against each column whose condition rule fits it, matched once against this
  // session's team setting (the variable version and the bundle are immutable rows; the save reads the world again
  // under its locks, so the match it writes is the one checked there).
  const matches = new Map();
  const thresholds = candidate?.raw_bundle?.teamThresholds ?? null;
  // Before v80 (no rule, no match on this database) nothing is matched: the board is as before.
  for (const variable of matchInstalled ? variables.filter((x) => x.has_condition === true && !x.calculated) : []) {
    for (const f of fields) {
      const rule = conditionRuleFor(f.source_metric_key);
      if (!rule || !ruleFits(rule, variable.condition_raw)) continue;
      const result = await matchCondition(client, { rule, cd: variable.condition_raw, thresholds, revisionId: f.revision_id });
      matches.set(`${f.id}:${variable.id}`, { ...result, rule: storedRule(rule) });
    }
  }
  return { clubId, ownerKey, systemBoard, team, candidate, defaultSkipped, defaultPlan, sessionRefusal, teamTimezone, unitWords, fields, variables, versions, open, switchedOff, replacedBySystem, conversions, names, matches, matchInstalled };
}

// ---------------------------------------------------------------------------
// The values of the stored session, the pair, and the columns. Pure over the
// world; the athlete keys stay inside this function's result and never reach
// an answer.
// ---------------------------------------------------------------------------
// A variable's condition as the board says it: the three stored shapes (v42), numbers as their shortest decimal; any other
// shape is { kind: "unsupported" } (never the stored JSON).
const conditionNumber = (v) => (typeof v === "number" && Number.isFinite(v) ? String(v) : null);
export function boardCondition(cd) {
  if (!cd || typeof cd !== "object" || Array.isArray(cd) || typeof cd.unit !== "string" || typeof cd.operator !== "string") return { kind: "unsupported" };
  const keys = Object.keys(cd).sort().join(",");
  if (cd.operator === "between" && keys === "max,min,operator,unit" && conditionNumber(cd.min) !== null && conditionNumber(cd.max) !== null) {
    return { kind: "zone", operator: "between", lower: conditionNumber(cd.min), upper: conditionNumber(cd.max), unit: cd.unit };
  }
  if ([">=", ">", "<=", "<"].includes(cd.operator) && keys === "operator,unit,value" && conditionNumber(cd.value) !== null) {
    return { kind: "zone", operator: cd.operator, value: conditionNumber(cd.value), unit: cd.unit };
  }
  if ([">=", ">", "<=", "<"].includes(cd.operator) && keys === "duration_seconds,operator,unit,value"
      && conditionNumber(cd.value) !== null && conditionNumber(cd.duration_seconds) !== null) {
    return { kind: "event_threshold", operator: cd.operator, value: conditionNumber(cd.value), durationSeconds: conditionNumber(cd.duration_seconds), unit: cd.unit };
  }
  return { kind: "unsupported" };
}

// v80: the match of a column to a variable with a condition in this session (loadWorld's), or a refusal: a column with no
// fitting rule is condition_mismatch.
function conditionMatchOf(world, fieldId, variableId) {
  return world.matches?.get(`${fieldId}:${variableId}`) ?? { ok: false, code: "condition_mismatch", range: null, rule: null };
}
function matchingFieldIds(world, variableId) {
  return [...(world.matches ?? new Map()).entries()].filter(([k, m]) => m.ok && k.endsWith(`:${variableId}`)).map(([k]) => k.split(":")[0]);
}
// A refusal of a match names both settings in plain words (the board's sentence; never an id).
function matchRefusalExtra(world, m, variable) {
  if (m.code !== "team_setting_mismatch") return {};
  return { message: settingMismatchText(variable.label, m.range, variable.condition_raw, world.team?.name ?? null) };
}

function columnsOf(world) {
  return world.fields.map((f) => {
    const extractor = extractorFor({ sourceSystem: f.source_system, apiFamily: f.api_family, sourceMetricKey: f.source_metric_key });
    const proven = revisionProven(f);
    const rule = proven ? displayRuleFor({ sourceSystem: f.source_system, apiFamily: f.api_family, sourceMetricKey: f.source_metric_key, sourceUnit: f.source_unit }) : null;
    let reason = null;
    if (!extractor || (extractor.valueShape !== null && (extractor.valueShape !== f.value_shape || extractor.parameterKind !== f.parameter_kind))) reason = "source_metric_unsupported";
    else if (f.parameter_kind !== "none") reason = "field_has_parameters";
    else if (!proven) reason = "field_not_confirmed";
    else if (!rule) reason = "display_rule_missing";
    // G1b-3: a created details field is read only with its proven word (route O), or by a document only where the unit
    // has exactly one GPEXE word; otherwise the column carries no value and never becomes a row.
    else if (isGenericDetailsKey({ sourceSystem: f.source_system, apiFamily: f.api_family, sourceMetricKey: f.source_metric_key })) {
      reason = unitWordCodeOf({ unitWords: world.unitWords ?? new Map(), sourceUnit: f.source_unit, provenWord: f.proven_word ?? null });
    }
    // A column can be read (its values shown, a system mapping of it switched on) without being placeable as a new row.
    // G2 (the Rukovodilac's rule, security MEDIUM 2 of G1a): a field created by route C whose unit is not proven yet is
    // never readable on this board - no athlete's value of it leaves the server; the platform's comparison (G1b) is
    // where it is proven. A seeded field keeps today's rule.
    // G1b-3: a column without a GPEXE word OptiMove can read carries no value either.
    const readable = Boolean(extractor) && reason !== "source_metric_unsupported" && f.parameter_kind === "none" && !(f.created === true && !proven)
      && reason !== "unit_word_missing" && reason !== "unit_word_ambiguous";
    return { field: f, extractor, rule, reason, readable };
  });
}

// A board read does at most this much extraction work: readable columns x
// athlete rows of the stored session (drill rows included). More is refused,
// never read in part.
export const BOARD_MAX_CELLS = 60_000;

// The board's one plan of a stored session: each athlete's session-level value per readable column, through the
// import's own gates. The only caller of the keyed read; the extracts are filled here, from the registry alone.
// Returns { ids, out } - out is the mapper's answer (out.code when the import would not take the session) - or
// { tooLarge: true } when the work is over the board's cap, before any value is read.
function keyedPlan(bundle, columns, teamTimezone, unitWords) {
  const ids = [];
  const extracts = [];
  for (const col of columns) {
    if (!col.readable) continue;
    // The registry's own entry, taken here (the importer's architecture guard: a value is read only through extractorFor).
    const extractor = extractorFor({ sourceSystem: col.field.source_system, apiFamily: col.field.api_family, sourceMetricKey: col.field.source_metric_key });
    if (!extractor) continue;
    ids.push(col.field.id);
    const context = { sourceUnit: col.field.source_unit, unitWords, provenWord: col.field.proven_word ?? null };
    extracts.push((input) => extractor.extract(input, {}, context));
  }
  const rowCount = Array.isArray(bundle?.athleteSessions) ? bundle.athleteSessions.length : 0;
  if (extracts.length * rowCount > BOARD_MAX_CELLS) return { tooLarge: true };
  return { ids, out: gpexeSessionValuesKeyed(bundle, extracts, { teamTimezone }) };
}

// The reason of a stored session whose plan failed in a way the import's gates do not name.
export const DEFAULT_SESSION_UNREADABLE = "session_unreadable";
// Whether the default can open on a stored session: `why` is the reason it must be passed by, or null with the
// session's plan. The same checks, in the same order, a named session is refused by (its size, its check and
// binding, its start, the board's size cap), and then the board's own plan - the import's gates - so a session taken
// here is one sessionValues() reads.
function defaultSessionVerdict(row, team, columns, teamTimezone, unitWords) {
  const no = (why) => ({ why, plan: null });
  if (row.purged || row.expired) return no("snapshot_expired");
  if (row.too_large === true) return no("candidate_too_large");
  if (row.check_status !== "succeeded" || row.source_path !== SOURCE_CONNECTION_PATH || row.source_binding_id !== team.binding_id) return no("candidate_source_mismatch");
  if (row.session_started_at === null) return no("session_start_unknown");
  if (row.raw_bundle === null || typeof row.raw_bundle !== "object") return no("candidate_source_mismatch");
  let plan;
  try {
    plan = keyedPlan(row.raw_bundle, columns, teamTimezone, unitWords);
  } catch (error) {
    // A stored bundle the plan cannot even walk (a shape the mapper does not expect) is one more session to pass by,
    // never a failed board for the team. Said once, by the kind of error only - no message, no value, no id.
    console.error(`[source-metric-board] default_session_plan_failed (${String(error?.name || "Error").replace(/[^A-Za-z0-9_]/g, "").slice(0, 40) || "Error"})`);
    return no(DEFAULT_SESSION_UNREADABLE);
  }
  if (plan.tooLarge) return no("board_too_large");
  return plan.out.code ? no(plan.out.code) : { why: null, plan };
}

function sessionValues(world, columns) {
  // The default's own plan when it chose this session (the same columns, bundle and time zone); else built here.
  const plan = world.defaultPlan ?? keyedPlan(world.candidate.raw_bundle, columns, world.teamTimezone, world.unitWords);
  if (plan.tooLarge) throw refusal(409, "board_too_large", BOARD_MESSAGES.board_too_large);
  const { ids, out } = plan;
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
    // S-2: whose mapping is on (the club's own or OptiMove's) and its variable's name, so a review can say what it replaces.
    .map((o) => ({ activationId: o.id, fieldId: o.field_id, variableId: o.variable_id, owner: o.owner_scope === "system" ? "system" : "club", variableLabel: o.variable_label ?? null }));
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
  const replacedByMapping = new Map((world.replacedBySystem ?? []).map((r) => [r.mapping_id, r]));
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
    // A field without a condition never fills a variable with one (the review of 2026-11-18): never offered, never feeds -
    // v80: except through its condition rule, when this session's team setting matches.
    if (variable.has_condition && !(v.condition_rule && conditionMatchOf(world, v.field_id, v.variable_id).ok)) continue;
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
    // S-2: the club's own mapping that OptiMove's replaced on this team says so, with the day; it can be put back as before.
    const replaced = v.owner_key !== "system" ? replacedByMapping.get(v.mapping_id) : null;
    const marked = replaced ? { ...row, replacedBy: { owner: "system", at: replaced.ended_at } } : row;
    if (replaces.length > 0) replaceable.push({ ...marked, replaces });
    else preplaced.push(marked);
  }

  return {
    board: {
      displayRegistryVersion: DISPLAY_REGISTRY_VERSION,
      // Whose mappings a save writes: the club's, or OptiMove's on the platform board (S).
      owner: world.systemBoard ? "system" : "club",
      // clubId: the team's own club (the other board's workspace, for its switch link).
      team: { id: world.team.id, name: world.team.name, sourceTeamId: world.team.source_team_id, clubId: world.clubId, clubName: world.team.club_name ?? null },
      // newerNotUsable: with no session named, how many newer stored sessions were passed by because the import would not take them.
      session: { candidateId: world.candidate.id, label: world.candidate.session_label ?? null, startedAt: world.candidate.session_started_at, newerNotUsable: world.defaultSkipped },
      pair: { index: pair.index, count: pair.count, labels: pair.labels },
      columns: columns.map((c) => {
        const rawA = c.readable ? pair.a.values.get(c.field.id) ?? null : null;
        const rawB = c.readable ? pair.b.values.get(c.field.id) ?? null : null;
        const reason = c.reason ?? (distinctPair(rawA, rawB) ? null : "no_value_for_pair");
        return {
          fieldId: c.field.id, revisionId: c.field.revision_id, key: c.field.source_metric_key, label: c.field.source_label,
          unit: revisionProven(c.field) ? c.field.source_unit : null,
          unitProven: revisionProven(c.field),
          expectedUnit: c.field.expected_source_unit ?? null,
          placeable: reason === null, reason,
          displayRule: c.rule?.rule ?? null, displayUnits: c.rule ? [...c.rule.units] : [],
          rawA, rawB,
        };
      }),
      variables: world.variables.filter((v) => !(v.owner_scope === "system" && v.hidden)).map((v) => ({
        id: v.id, ownerScope: v.owner_scope, key: v.key, label: v.label, versionId: v.version_id,
        unit: v.unit_is_token ? v.unit : null,
        // A club variable takes a column; an OptiMove variable only where its system mapping of a column fills it (C61) -
        // except on the platform board, where OptiMove's variables are the owner's own and take a column (S).
        // v77 (J21): a calculated variable takes no column; its value is its calculation.
        // v80 step A: a variable with a condition takes no column of this board (the save refuses condition_mismatch); it
        // is never shown as a free target, and says its condition instead (until v80 matches a column's team setting).
        placeable: v.calculated !== true && (v.has_condition !== true || matchingFieldIds(world, v.id).length > 0)
          && (v.owner_scope === "club" || world.systemBoard ? v.value_type === "numeric" && v.unit_is_token === true : fedBySystem.has(v.id)),
        condition: v.has_condition === true ? boardCondition(v.condition_raw) : null,
        // v80: the columns whose team setting in this session is the variable's condition.
        matchingFieldIds: v.has_condition === true ? matchingFieldIds(world, v.id) : [],
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

// S: the platform board's "Which team?" in one step - every active team of an active club with an active GPEXE binding
// of its club's connection, with its club's name. An active platform admin in the platform workspace only; everyone else
// the identical 404. Bounded; never an athlete, a source id or a value.
export const BOARD_TEAMS_MAX = 500;
export async function listBoardTeams({ ctx }) {
  if (!isSystemBoard(ctx)) throw NOT_FOUND();
  const rows = await boundedRead(async (client) => (await client.query(
    `select cl.id as club_id, cl.name as club_name, t.id as team_id, t.name as team_name
       from public.teams t
       join public.clubs cl on cl.id = t.club_id and coalesce(cl.is_active, true)
       join training_load.source_team_bindings b on b.team_id = t.id and b.state = 'active' and b.source_system = $1
       join training_load.source_credential_connections c on c.id = b.connection_id and c.owner_scope = 'club' and c.owner_club_id = t.club_id
      where coalesce(t.is_active, true)
      order by cl.name collate "C", cl.id, t.name collate "C", t.id
      limit ${BOARD_TEAMS_MAX + 1}`,
    [GPEXE_SOURCE_SYSTEM],
  )).rows);
  return {
    teams: rows.slice(0, BOARD_TEAMS_MAX).map((r) => ({ clubId: r.club_id, clubName: r.club_name ?? "", teamId: r.team_id, teamName: r.team_name ?? "" })),
    truncated: rows.length > BOARD_TEAMS_MAX,
  };
}

export async function readBoard({ ctx, queryString }) {
  if (!mayUseBoard(ctx)) throw NOT_FOUND();
  const q = readQuery(queryString, { teamId: "uuid", candidateId: "uuid", pair: "index" }, ["teamId"]);
  await removeExpiredBatch();
  const world = await boundedRead((client) => loadWorld(client, ctx, { teamId: q.teamId, candidateId: q.candidateId ?? null }));
  const out = boardOf(world, q.pair ?? 0);
  // The team zone limits of the session in view, so a numbered zone column shows its range. The board is always of one
  // team the caller may map (its own club's, or any team for the platform board), so a club's admin sees only its own
  // team's limits (the Rukovodilac's decision of 2026-11-18); P1 still keeps them off a club's list of GPEXE names.
  out.board.zoneThresholds = bundleZoneThresholds(world.candidate?.raw_bundle);
  return out;
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

  if (variable.owner_scope === "system" && !world.systemBoard) {
    // On a club board an OptiMove variable is filled only by OptiMove's own mapping of this column (C61).
    const v = world.versions.find((x) => x.owner_key === "system" && x.field_id === fieldId && x.variable_id === targetId && x.parameter_kind === "none"
      && x.revision_id === col.field.revision_id && x.target_version_id === variable.version_id);
    if (!v || !col.readable) return refuse("target_scope_mismatch");
    let systemMatch = null;
    if (variable.has_condition) {
      if (!v.condition_rule) return refuse("condition_mismatch");
      const m = conditionMatchOf(world, fieldId, targetId);
      if (!m.ok) return refuse(m.code, matchRefusalExtra(world, m, variable));
      systemMatch = m.match;
    }
    if (world.open.some((o) => o.mapping_version_id === v.id)) return refuse("activation_exists");
    const row = versionRow(world, pair, col, v);
    return { placement: { placeable: true, ...row, conditionMatch: systemMatch, collisions: collisionsOf(world, { fieldId, variableId: targetId, levels: row.levels }) } };
  }

  if (col.reason !== null) return refuse(col.reason);
  if (variable.calculated === true || variable.value_type !== "numeric" || !variable.unit_is_token) return refuse("target_not_usable");
  // v80: a variable with a condition takes a column only through the column's condition rule, when this session's team
  // setting matches the condition (the refusal names both).
  let conditionMatch = null;
  let conditionRule = null;
  if (variable.has_condition) {
    const m = conditionMatchOf(world, fieldId, targetId);
    if (!m.ok) return refuse(m.code, matchRefusalExtra(world, m, variable));
    conditionMatch = m.match;
    conditionRule = m.rule;
  }
  const conversion = conversionBetween(world, col.field.source_unit, variable.unit);
  if (!conversion) return refuse("conversion_unavailable", { sourceUnit: col.field.source_unit, targetUnit: variable.unit });
  const scopes = variable.scopes ?? [];
  const levels = { session: col.field.supports_session === true && scopes.includes("session"), drill: col.field.supports_drill === true && scopes.includes("component") };
  if (!levels.session) return refuse("level_not_allowed");
  // C33: another mapping of the board's owner (the club, or OptiMove on the platform board) with an active version of this column.
  const own = world.versions.filter((v) => v.owner_key === world.ownerKey && v.field_id === fieldId && v.parameter_fingerprint === "");
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
      conditionRule, conditionMatch,
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
  // A field without a condition never fills a variable with one (the review of 2026-11-18), even through an existing
  // version: the save never switches such a version on - v80: except a version with a condition rule whose team setting
  // matches in this session.
  let match = null;
  if (variable.has_condition) {
    if (!v.condition_rule) return { code: "condition_mismatch", v };
    const m = conditionMatchOf(world, v.field_id, v.variable_id);
    if (!m.ok) return { code: m.code, v };
    match = m.match;
  }
  if (col.field.revision_id !== v.revision_id) return { code: "revision_not_usable", v };
  if (variable.version_id !== v.target_version_id) return { code: "canonical_version_changed", v };
  if (variable.hidden) return { code: "variable_hidden", v };
  if (world.open.some((o) => o.mapping_version_id === v.id)) return { code: "activation_exists", v };
  const row = versionRow(world, shared.pairOf(), col, v);
  return { row: { ...row, collisions: collisionsOf(world, { fieldId: v.field_id, variableId: v.variable_id, levels: row.levels }) }, v, match };
}

export async function readPlacement({ ctx, queryString }) {
  if (!mayUseBoard(ctx)) throw NOT_FOUND();
  const q = readQuery(queryString, { teamId: "uuid", candidateId: "uuid", pair: "index", fieldId: "uuid", targetId: "uuid" }, ["teamId", "candidateId", "pair", "fieldId", "targetId"]);
  const world = await boundedRead((client) => loadWorld(client, ctx, { teamId: q.teamId, candidateId: q.candidateId }));
  const out = placementOf(world, q.pair, { fieldId: q.fieldId, targetId: q.targetId });
  if (!out.placement) return out;
  // v80: the rule and the match are the save's own (the stored condition never leaves the server as it is stored).
  const { conditionRule: _rule, conditionMatch: _match, ...placement } = out.placement;
  return { ...out, placement };
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
