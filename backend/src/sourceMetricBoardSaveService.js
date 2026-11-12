// The save of the drag-and-drop board (J18, C112;
// docs/ai/c112-drag-mapping-contract.md, sections 4.3-4.5 and 15): route 3,
// POST /confirmations. ONE write transaction (runWrite): the club's new
// mappings and versions, the replaced activations' ends, the stored
// confirmation with two athletes' values, the versions' activation (the gate
// of v66 reads the confirmation) and the starts on the team's binding.
//
// The save recomputes what the reads showed with the board's own functions
// (boardKit), twice: once on plain reads, to answer a stale or refused row
// before any lock, and once after every lock, which is the answer that
// counts. Every lock is taken before the first write, in D's order
// (section 4.4): unit_conversions -> T2a -> T2b -> T3 -> T4 ->
// metric_definitions -> scope capabilities -> T5 (to end) -> binding -> team
// -> users / role / club -> the hide locks. The candidate is never locked.
//
// It never sends a GPEXE request, never logs or audits a value, a name or a
// hash, and never returns a value.
import { adminWriteKit, classifyDatabaseError, SourceMetricMappingError } from "./sourceMetricMappingService.js";
import { bindingClubHolds } from "./sourceMetricAccess.js";
import { lockHides, lockListedBindings } from "./sourceMetricActivationSteps.js";
import { boardKit, mayUseBoard } from "./sourceMetricBoardService.js";
import { DISPLAY_REGISTRY_VERSION } from "./sourceMetricBoard.js";

const { runWrite, rightsStillHold, refusal, NOT_FOUND, plainObject, uuidField, hashOf } = adminWriteKit;
const { loadWorld, columnsOf, choosePair, placementOf, preplacedOf } = boardKit;

export const MAX_SAVE_ROWS = 20;
const REQUIREMENTS = new Set(["required", "optional"]);
const HASH = /^[0-9a-f]{64}$/;
const NEW_KEYS = "checked,displayUnit,expectedTargetVersionId,fieldId,kind,placementHash,replaces,requirement,targetId";
const PREPLACED_KEYS = "kind,mappingVersionId,placementHash,replaces,requirement";

// The fixed reasons of the rows a save writes (section 4.3 step 16).
export const SAVE_REASONS = Object.freeze({
  replaced: "Replaced on the drag-and-drop board.",
  checked: "Switched on by drag and drop; two athletes checked in GPEXE.",
  system: "Switched on by drag and drop; OptiMove mapping.",
  club: "Switched on by drag and drop; the club's mapping.",
});
const CONVERSION_NOTE = "Converted by OptiMove's active unit conversion.";

const MESSAGES = {
  invalid_body: "The body is not a save of the board.",
  board_changed: "The board changed since it was read. Nothing was saved; read the board again.",
  canonical_version_changed: "The variable has a newer version than the one on the board. Nothing was saved.",
  activation_changed: "A mapping this save replaces is no longer on for the team. Nothing was saved.",
  binding_not_active: "The team is no longer linked to GPEXE. Nothing was saved.",
  activation_exists: "This column is already on for the team.",
  variable_taken_on_binding: "This variable is already filled for the team.",
  variable_hidden: "The club hides this OptiMove variable.",
  row_refused: "A row of the board cannot be saved as it is. Nothing was saved.",
};
const invalid = (message = MESSAGES.invalid_body) => refusal(400, "invalid_body", message);
const rowRefusal = (code, rowIndex, extra = {}) => refusal(409, code, MESSAGES[code] ?? MESSAGES.row_refused, { current: { rowIndex, ...extra } });

// Test seam (never set by the application): called inside the save's
// transaction at a named step, so a race test can hold it there.
let saveHold = null;
export function setBoardSaveHoldForTests(fn) { saveHold = fn ?? null; }
const hold = async (client, step) => { if (saveHold) await saveHold(client, step); };

// ---------------------------------------------------------------------------
// The body (section 4.3 step 2).
// ---------------------------------------------------------------------------
function replacesOf(value) {
  if (!Array.isArray(value) || value.length > MAX_SAVE_ROWS) throw invalid();
  const ids = value.map((id) => uuidField(id));
  if (new Set(ids).size !== ids.length) throw invalid();
  return ids.sort();
}
function rowsOf(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_SAVE_ROWS) throw invalid(`A save has 1-${MAX_SAVE_ROWS} rows.`);
  const fields = new Set();
  const targets = new Set();
  const versions = new Set();
  return value.map((raw) => {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw invalid();
    const keys = Object.keys(raw).sort().join(",");
    if (typeof raw.requirement !== "string" || !REQUIREMENTS.has(raw.requirement)) throw invalid("Each row says whether it is required or optional.");
    if (typeof raw.placementHash !== "string" || !HASH.test(raw.placementHash)) throw invalid();
    if (raw.kind === "new") {
      if (keys !== NEW_KEYS) throw invalid();
      // A new row carries its own tick: the admin compared the two athletes for this row.
      if (raw.checked !== true) throw invalid("A new row is saved only with its own check.");
      if (typeof raw.displayUnit !== "string" || raw.displayUnit.length < 1 || raw.displayUnit.length > 16) throw invalid();
      const row = {
        kind: "new", fieldId: uuidField(raw.fieldId), targetId: uuidField(raw.targetId), expectedTargetVersionId: uuidField(raw.expectedTargetVersionId),
        displayUnit: raw.displayUnit, placementHash: raw.placementHash, requirement: raw.requirement, replaces: replacesOf(raw.replaces),
      };
      if (fields.has(row.fieldId) || targets.has(row.targetId)) throw invalid("A column and a variable appear in one row only.");
      fields.add(row.fieldId);
      targets.add(row.targetId);
      return row;
    }
    if (raw.kind === "preplaced") {
      if (keys !== PREPLACED_KEYS) throw invalid();
      const row = { kind: "preplaced", mappingVersionId: uuidField(raw.mappingVersionId), placementHash: raw.placementHash, requirement: raw.requirement, replaces: replacesOf(raw.replaces) };
      if (versions.has(row.mappingVersionId)) throw invalid("A column and a variable appear in one row only.");
      versions.add(row.mappingVersionId);
      return row;
    }
    throw invalid();
  });
}
// What the request hash covers: identities only - never a placement hash, a
// value or a name (T8's request_hash covers no value, section 5.6).
const identityOf = (row) => (row.kind === "new"
  ? { kind: "new", fieldId: row.fieldId, targetId: row.targetId, displayUnit: row.displayUnit, requirement: row.requirement, replaces: row.replaces }
  : { kind: "preplaced", mappingVersionId: row.mappingVersionId, requirement: row.requirement, replaces: row.replaces });

// ---------------------------------------------------------------------------
// The recompute (steps 6 and 15): every row against a world, with the board's
// own functions. Throws the first refusal, naming its row.
// ---------------------------------------------------------------------------
function evaluate(world, pairIndex, rows) {
  const columns = columnsOf(world);
  let pair = null;
  const shared = { columns, pairOf: () => (pair ??= choosePair(world, columns, pairIndex)) };
  // Every id of the body inside the workspace first: the identical 404 before any 409.
  const outcomes = rows.map((row) => (row.kind === "new"
    ? placementOf(world, pairIndex, { fieldId: row.fieldId, targetId: row.targetId }, shared).placement
    : preplacedOf(world, shared, row.mappingVersionId)));
  const openIds = new Set(world.open.map((o) => o.id));
  const plan = [];
  const fields = new Set();
  const variables = new Set();
  rows.forEach((row, rowIndex) => {
    const out = outcomes[rowIndex];
    let item;
    if (row.kind === "new") {
      if (out.placeable !== true) throw rowRefusal(out.code, rowIndex);
      // An OptiMove variable is switched on as a pre-placed row, never as a new one.
      if (out.kind !== "new") throw invalid("An OptiMove mapping is saved as a pre-placed row.");
      if (out.expectedTargetVersionId !== row.expectedTargetVersionId) throw rowRefusal("canonical_version_changed", rowIndex);
      if (!out.displayUnits.includes(row.displayUnit)) throw invalid("displayUnit is not a unit of the column's rule.");
      if (out.placementHashes[row.displayUnit] !== row.placementHash) throw rowRefusal("board_changed", rowIndex);
      item = {
        kind: "new", row, fieldId: row.fieldId, variableId: row.targetId, revisionId: out.revisionId, targetVersionId: out.expectedTargetVersionId,
        sourceUnit: out.sourceUnit, targetUnit: out.targetUnit, conversion: out.conversion, levels: out.levels,
        displayRule: out.displayRule, displayUnit: row.displayUnit, values: out.values, reusesVersionId: out.reusesVersionId, collisions: out.collisions, system: false,
      };
    } else {
      if (out.code) throw rowRefusal(out.code, rowIndex);
      if (out.row.placementHash !== row.placementHash) throw rowRefusal("board_changed", rowIndex);
      item = {
        kind: "preplaced", row, fieldId: out.v.field_id, variableId: out.v.variable_id, revisionId: out.v.revision_id, targetVersionId: out.v.target_version_id,
        versionId: out.v.id, mappingId: out.v.mapping_id, levels: out.row.levels, collisions: out.row.collisions, system: out.v.owner_key === "system",
      };
    }
    if (fields.has(item.fieldId) || variables.has(item.variableId)) throw invalid("A column and a variable appear in one row only.");
    fields.add(item.fieldId);
    variables.add(item.variableId);
    // What is on and in the way must be exactly what the row says it replaces.
    const colliding = new Set(item.collisions.map((c) => c.activationId));
    for (const c of item.collisions) {
      if (!row.replaces.includes(c.activationId)) throw rowRefusal(c.fieldId === item.fieldId ? "activation_exists" : "variable_taken_on_binding", rowIndex);
    }
    for (const id of row.replaces) {
      if (!colliding.has(id)) throw rowRefusal(openIds.has(id) ? "board_changed" : "activation_changed", rowIndex);
    }
    plan.push(item);
  });
  return { plan, pair: shared.pairOf() };
}

// ---------------------------------------------------------------------------
// The answer, and a replay's (sections 4.2 and 4.5): no value. The scope of
// routes 4 and 5 is checked again, under FOR SHARE - the confirmation is the
// workspace's club's, its team is active and in that club, the club is
// active. The binding need not still be active. Anything else is null (the
// identical 404).
// ---------------------------------------------------------------------------
async function savedConfirmation(executor, ctx, operationId) {
  if (!mayUseBoard(ctx)) return null;
  const c = (await executor.query(
    `select c.id, c.team_id, c.confirmed_at
       from training_load.source_metric_confirmations c
       join public.teams t on t.id = c.team_id
       join public.clubs cl on cl.id = t.club_id
      where c.operation_id = $1 and c.owner_scope = 'club' and c.owner_club_id = $2::uuid
        and t.club_id = $2::uuid and coalesce(t.is_active, true) and coalesce(cl.is_active, true)
        for share of t, cl`,
    [operationId, ctx.owner.clubId],
  )).rows[0];
  if (!c) return null;
  const rows = (await executor.query(
    `select a.source_metric_definition_id as "fieldId", a.metric_definition_id as "variableId", a.mapping_id as "mappingId",
            a.mapping_version_id as "versionId", a.id as "activationId", a.requirement
       from training_load.source_metric_audit e
       join training_load.source_metric_mapping_activations a on a.id = e.activation_id
      where e.operation_id = $1 and e.action = 'activation_start'
      order by a.mapping_version_id`,
    [operationId],
  )).rows;
  return { confirmation: { id: c.id, teamId: c.team_id, confirmedAt: c.confirmed_at, rows } };
}

const SAVE_REQUESTS = Object.freeze({
  find: `select action as operation, request_hash, operation_id, confirmation_id
           from training_load.source_metric_audit where performed_by_user_id = $1 and request_key = $2`,
  exists: `select 1 from training_load.source_metric_audit where performed_by_user_id = $1 and request_key = $2`,
});

// The database's refusals of a save (v65's and v66's guards are the backstop
// of the checks above): a right lost under a guard is the identical 404; a
// candidate that changed under the save, and a row another save wrote first,
// are board_changed. Anything else goes to the shared classifier.
const ACTOR_TEXTS = new Set([
  "source metric confirmation: the acting user may not write this confirmation",
  "source metric confirmation: the acting user may not write this audit row",
  "source metric confirmation: the row names another user than the acting user",
  "source metric confirmation: the row belongs to another user's confirmation",
  "source metric activation: the acting user may not write this audit row",
  "source metric mapping: the acting user may not write this audit row",
  "source metric mapping: the acting user may not write this mapping",
  "source metric mapping: the basis is not the acting user's own",
  "source metric mapping: the row names another user than the acting user",
]);
const CANDIDATE_TEXTS = new Set([
  "source_metric_confirmation_sessions: the candidate is an undone import",
  "source_metric_confirmation_sessions: the candidate is not a stored session of this team",
  "source_metric_confirmation_sessions: the candidate is superseded",
  "source_metric_confirmation_sessions: the candidate was last seen by another check",
  "source_metric_confirmation_sessions: the candidate's content is not the one confirmed",
  "source_metric_confirmation_sessions: the check did not read through the confirmation's binding",
  "source_metric_confirmation_sessions: the check did not succeed for this team",
  "source_metric_confirmation_sessions: the session's start is not the candidate's",
]);
const RACED_CONSTRAINTS = new Set([
  "source_metric_mappings_pair_key", "source_metric_mapping_versions_number_key", "source_metric_mapping_versions_one_active_per_mapping",
  "source_metric_mapping_versions_one_active_target_per_owner",
  "source_metric_activations_one_open_per_field", "source_metric_activations_one_open_session_target", "source_metric_activations_one_open_drill_target",
]);
export function classifySaveError(error) {
  if (error instanceof SourceMetricMappingError) return error;
  if (error?.code === "42501" && ACTOR_TEXTS.has(error.message)) {
    console.error("[source-metric-board] db_actor_refusal (42501)");
    return NOT_FOUND();
  }
  if (error?.code === "23514" && !error.constraint && CANDIDATE_TEXTS.has(error.message)) return refusal(409, "board_changed", MESSAGES.board_changed);
  if (error?.code === "23505" && RACED_CONSTRAINTS.has(error.constraint)) return refusal(409, "board_changed", MESSAGES.board_changed);
  return classifyDatabaseError(error);
}

// ---------------------------------------------------------------------------
// Route 3: POST /confirmations.
// ---------------------------------------------------------------------------
export async function saveConfirmation({ ctx, body }) {
  if (!mayUseBoard(ctx)) throw NOT_FOUND();
  const keys = ["requestKey", "teamId", "candidateId", "pair", "rows"];
  plainObject(body, keys, keys);
  const requestKey = uuidField(body.requestKey);
  const teamId = uuidField(body.teamId);
  const candidateId = uuidField(body.candidateId);
  if (!Number.isInteger(body.pair) || body.pair < 0 || body.pair > 9999) throw invalid();
  const pairIndex = body.pair;
  const rows = rowsOf(body.rows);
  const requestHash = hashOf({ op: "mapping_confirmation", teamId, candidateId, pair: pairIndex, rows: rows.map(identityOf) });

  return runWrite({
    ctx, where: "board_save", requestKey, requestHash, action: "mapping_confirmation", requests: SAVE_REQUESTS, classify: classifySaveError,
    idsOf: (written) => ({ confirmationId: written.confirmation_id ?? null }),
    reread: (executor, record) => savedConfirmation(executor, ctx, record.operation_id),
    body: async (client, operationId) => {
      const clubId = ctx.owner.clubId;
      const actor = [ctx.userId, ctx.basis];
      const audit = (action, columns, values) => client.query(
        `insert into training_load.source_metric_audit (action, ${columns.join(", ")}, performed_by_user_id, basis, operation_id)
         values ($1, ${columns.map((_, i) => `$${i + 2}`).join(", ")}, $${columns.length + 2}, $${columns.length + 3}, $${columns.length + 4})`,
        [action, ...values, ...actor, operationId],
      );

      // Steps 5 and 6: plain reads, and the recompute. A stale or refused row
      // is answered here, before any lock.
      const seen = await loadWorld(client, ctx, { teamId, candidateId });
      // Every listed activation is one of this binding (open or not): any other id is the identical 404.
      const replaced = [...new Set(rows.flatMap((r) => r.replaces))].sort();
      if (replaced.length > 0) {
        const known = await client.query(
          `select 1 from training_load.source_metric_mapping_activations where id = any($1::uuid[]) and source_team_binding_id = $2`, [replaced, seen.team.binding_id]);
        if (known.rowCount !== replaced.length) throw NOT_FOUND();
      }
      const first = evaluate(seen, pairIndex, rows);
      await hold(client, "before_locks");

      // Step 7: the unit conversions of every converted row, ascending.
      const pairs = first.plan.filter((p) => p.kind === "new" && p.conversion.kind === "converted");
      if (pairs.length > 0) {
        await client.query(
          `select c.id from training_load.unit_conversions c
            where c.state = 'active' and (c.from_unit, c.to_unit) in (select * from unnest($1::text[], $2::text[]))
            order by c.id for share`,
          [pairs.map((p) => p.sourceUnit), pairs.map((p) => p.targetUnit)],
        );
      }
      // Step 8: the fields (T2a) and their revisions (T2b), ascending.
      const sorted = (ids) => [...new Set(ids)].sort();
      await client.query(`select id from training_load.source_metric_definitions where id = any($1::uuid[]) order by id for share`, [sorted(first.plan.map((p) => p.fieldId))]);
      await client.query(`select id from training_load.source_metric_definition_versions where id = any($1::uuid[]) order by id for share`, [sorted(first.plan.map((p) => p.revisionId))]);
      // Step 9: the mappings (T3), one pass in ascending id - the club's
      // existing mapping of a new row FOR NO KEY UPDATE, a pre-placed row's
      // FOR SHARE. A missing one is inserted at step 16.1.
      const existing = new Map((await client.query(
        `select m.id, m.source_metric_definition_id as field_id, m.metric_definition_id as variable_id
           from training_load.source_metric_mappings m
          where (m.source_metric_definition_id, m.metric_definition_id) in (select * from unnest($1::uuid[], $2::uuid[]))`,
        [first.plan.filter((p) => p.kind === "new").map((p) => p.fieldId), first.plan.filter((p) => p.kind === "new").map((p) => p.variableId)],
      )).rows.map((m) => [`${m.field_id}:${m.variable_id}`, m.id]));
      const mappingLocks = [];
      for (const p of first.plan) {
        if (p.kind === "preplaced") mappingLocks.push({ id: p.mappingId, strength: "share" });
        else if (existing.has(`${p.fieldId}:${p.variableId}`)) mappingLocks.push({ id: existing.get(`${p.fieldId}:${p.variableId}`), strength: "no key update" });
      }
      mappingLocks.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      for (const m of mappingLocks) await client.query(`select id from training_load.source_metric_mappings where id = $1 for ${m.strength}`, [m.id]);
      // Step 10: the versions (T4) a row reuses or switches on as it is, ascending.
      const versionIds = sorted(first.plan.map((p) => (p.kind === "preplaced" ? p.versionId : p.reusesVersionId)).filter(Boolean));
      if (versionIds.length > 0) await client.query(`select id from training_load.source_metric_mapping_versions where id = any($1::uuid[]) order by id for share`, [versionIds]);
      // Step 11: the variables and their levels, ascending.
      const variableIds = sorted(first.plan.map((p) => p.variableId));
      await client.query(`select id from training_load.metric_definitions where id = any($1::uuid[]) order by id for share`, [variableIds]);
      await client.query(
        `select metric_definition_id from training_load.metric_definition_scope_capabilities
          where metric_definition_id = any($1::uuid[]) order by metric_definition_id, scope_level for share`,
        [variableIds],
      );
      // Step 12: the activations this save ends, ascending, on this binding only.
      let ending = [];
      if (replaced.length > 0) {
        ending = (await client.query(
          `select id, mapping_version_id, team_id, ended_at from training_load.source_metric_mapping_activations
            where id = any($1::uuid[]) and source_team_binding_id = $2 order by id for no key update`,
          [replaced, seen.team.binding_id],
        )).rows;
        if (ending.length !== replaced.length) throw NOT_FOUND();
      }
      // Step 13: the binding and its team.
      const locked = await lockListedBindings(client, [{ bindingId: seen.team.binding_id }]);
      // Step 14: the rights - users first - and the club; then the hide locks
      // of every OptiMove variable the save switches on. No row lock follows.
      if (!(await rightsStillHold(client, ctx))) throw NOT_FOUND();
      if (!(await bindingClubHolds(client, [clubId]))) throw NOT_FOUND();
      await hold(client, "before_hide_locks");
      await lockHides(client, first.plan.filter((p) => p.system).map((p) => ({ clubId, definitionId: p.variableId })));

      // Step 15: the states, on what is locked now. The candidate first: a
      // check finalized meanwhile, or an undone import, is board_changed.
      if (locked.get(seen.team.binding_id).state !== "active") throw refusal(409, "binding_not_active", MESSAGES.binding_not_active);
      const boardChanged = () => refusal(409, "board_changed", MESSAGES.board_changed);
      const world = await loadWorld(client, ctx, { teamId, candidateId, onCandidateMissing: boardChanged });
      if (world.team.binding_id !== seen.team.binding_id) throw refusal(409, "binding_not_active", MESSAGES.binding_not_active);
      if (world.candidate.bundle_hash !== seen.candidate.bundle_hash || world.candidate.last_seen_check_id !== seen.candidate.last_seen_check_id) throw boardChanged();
      const ended = ending.findIndex((e) => e.ended_at !== null);
      if (ended >= 0) throw rowRefusal("activation_changed", rows.findIndex((r) => r.replaces.includes(ending[ended].id)));
      const { plan, pair } = evaluate(world, pairIndex, rows);
      // What was locked is what is saved: a mapping or version that appeared
      // or changed between the plain read and the locks is board_changed.
      plan.forEach((p, i) => {
        const before = first.plan[i];
        if ((p.reusesVersionId ?? null) !== (before.reusesVersionId ?? null) || p.revisionId !== before.revisionId || p.targetVersionId !== before.targetVersionId) throw rowRefusal("board_changed", i);
      });
      const nowExisting = (await client.query(
        `select m.id, m.source_metric_definition_id as field_id, m.metric_definition_id as variable_id
           from training_load.source_metric_mappings m
          where (m.source_metric_definition_id, m.metric_definition_id) in (select * from unnest($1::uuid[], $2::uuid[]))`,
        [plan.filter((p) => p.kind === "new").map((p) => p.fieldId), plan.filter((p) => p.kind === "new").map((p) => p.variableId)],
      )).rows;
      if (nowExisting.length !== existing.size) throw boardChanged();
      await hold(client, "before_writes");

      // Step 16.1: each missing mapping, each new version, its submit - every
      // audit row right after its own write.
      const fresh = plan.filter((p) => p.kind === "new" && !p.reusesVersionId)
        .sort((a, b) => (a.fieldId < b.fieldId ? -1 : a.fieldId > b.fieldId ? 1 : a.variableId < b.variableId ? -1 : 1));
      for (const p of fresh) {
        p.mappingId = existing.get(`${p.fieldId}:${p.variableId}`) ?? null;
        if (!p.mappingId) {
          p.mappingId = (await client.query(
            `insert into training_load.source_metric_mappings (source_metric_definition_id, source_system, api_family, metric_definition_id, owner_scope, owner_club_id, created_by_user_id)
             select d.id, d.source_system, d.api_family, $2, 'club', $3, $4 from training_load.source_metric_definitions d where d.id = $1 returning id`,
            [p.fieldId, p.variableId, clubId, ctx.userId],
          )).rows[0].id;
          await audit("mapping_create", ["mapping_id"], [p.mappingId]);
        }
        const factors = p.conversion.kind === "converted" ? p.conversion : { scale: "1", divisor: "1", offset: "0" };
        p.versionId = (await client.query(
          `insert into training_load.source_metric_mapping_versions
             (mapping_id, source_metric_definition_id, metric_definition_id, source_metric_version_id, version_number, metric_definition_version_id,
              conversion_kind, scale, scale_divisor, "offset", source_unit, target_unit, conversion_note, parameter_kind,
              source_parameters, canonical_parameters, parameter_scale, parameter_scale_divisor, parameter_offset,
              applies_to_session, applies_to_drill, created_by_user_id)
           select $1, $2, $3, $4,
                  (select coalesce(max(version_number), 0) + 1 from training_load.source_metric_mapping_versions where mapping_id = $1),
                  $5, 'numeric_linear', $6::numeric, $7::numeric, $8::numeric, $9, $10, $11, 'none',
                  '{}'::jsonb, '{}'::jsonb, 1, 1, 0, $12, $13, $14
           returning id`,
          [p.mappingId, p.fieldId, p.variableId, p.revisionId, p.targetVersionId, factors.scale, factors.divisor, factors.offset,
            p.sourceUnit, p.targetUnit, p.sourceUnit === p.targetUnit ? null : CONVERSION_NOTE, p.levels.session, p.levels.drill, ctx.userId],
        )).rows[0].id;
        await audit("mapping_version_create", ["mapping_id", "mapping_version_id", "to_status"], [p.mappingId, p.versionId, "draft"]);
        await client.query(
          `update training_load.source_metric_mapping_versions
              set status = 'needs_review', submitted_by_user_id = $2, submitted_at = clock_timestamp(), submitted_basis = $3 where id = $1`,
          [p.versionId, ...actor],
        );
        await audit("mapping_status", ["mapping_id", "mapping_version_id", "from_status", "to_status"], [p.mappingId, p.versionId, "draft", "needs_review"]);
      }
      for (const p of plan.filter((x) => x.kind === "new" && x.reusesVersionId)) {
        p.versionId = p.reusesVersionId;
        p.mappingId = existing.get(`${p.fieldId}:${p.variableId}`);
      }
      // Step 16.2: the listed ends, with their audit rows.
      if (ending.length > 0) {
        await client.query(
          `update training_load.source_metric_mapping_activations
              set ended_at = now(), ended_by_user_id = $2, ended_basis = $3, end_reason = 'admin_ended' where id = any($1::uuid[])`,
          [ending.map((e) => e.id), ...actor],
        );
        for (const e of ending) await audit("activation_end", ["mapping_version_id", "activation_id", "team_id", "reason"], [e.mapping_version_id, e.id, e.team_id, SAVE_REASONS.replaced]);
      }
      // Step 16.3: the confirmation, its session, its rows. The database sets
      // the time and the expiry, computes each digest and checks each stored
      // value against the raw one.
      const confirmationId = (await client.query(
        `insert into training_load.source_metric_confirmations
           (operation_id, kind, owner_scope, owner_club_id, binding_id, team_id, credential_connection_id, confirmed_by_user_id, confirmed_basis,
            confirmed_at, attested, display_registry_version, values_expire_at)
         values ($1, 'team_mapping', 'club', $2, $3, $4, $5, $6, $7, now(), $8, $9, now()) returning id`,
        [operationId, clubId, world.team.binding_id, world.team.id, world.team.connection_id, ...actor, plan.some((p) => p.kind === "new"), DISPLAY_REGISTRY_VERSION],
      )).rows[0].id;
      await client.query(
        `insert into training_load.source_metric_confirmation_sessions
           (confirmation_id, session_ordinal, candidate_id, candidate_bundle_hash, gpexe_team_session_id, session_started_at, check_id, team_id, pair_index)
         values ($1, 1, $2, $3, $4, $5, $6, $7, $8)`,
        [confirmationId, world.candidate.id, world.candidate.bundle_hash, world.candidate.gpexe_team_session_id, world.candidate.session_started_at,
          world.candidate.last_seen_check_id, world.team.id, pair.index],
      );
      for (const [index, p] of plan.entries()) {
        const checked = p.kind === "new";
        await client.query(
          `insert into training_load.source_metric_confirmation_items
             (confirmation_id, session_ordinal, item_no, item_kind, checked, source_metric_version_id, mapping_version_id, parameter_fingerprint,
              source_unit, target_unit, scale, scale_divisor, "offset", compared_level, gpexe_display_rule, gpexe_display_unit, raw_a, stored_a, raw_b, stored_b)
           select $1, 1, $2, $3, $4, v.source_metric_version_id, v.id, v.parameter_fingerprint, v.source_unit, v.target_unit, v.scale, v.scale_divisor, v."offset",
                  'session', $6, $7, $8::numeric, $9::numeric, $10::numeric, $11::numeric
             from training_load.source_metric_mapping_versions v where v.id = $5`,
          [confirmationId, index + 1, p.system ? "system_mapping" : "club_mapping", checked, p.versionId,
            checked ? p.displayRule : null, checked ? p.displayUnit : null,
            checked ? p.values.a.raw : null, checked ? p.values.a.stored : null, checked ? p.values.b.raw : null, checked ? p.values.b.stored : null],
        );
      }
      // Step 16.4: each new version becomes active (the gate reads its row above).
      for (const p of fresh) {
        await client.query(
          `update training_load.source_metric_mapping_versions
              set status = 'active', activated_by_user_id = $2, activated_at = clock_timestamp(), activated_basis = $3 where id = $1`,
          [p.versionId, ...actor],
        );
        await audit("mapping_status", ["mapping_id", "mapping_version_id", "from_status", "to_status"], [p.mappingId, p.versionId, "needs_review", "active"]);
      }
      // Step 16.5: the starts on the one binding, ascending version id.
      const starting = [...plan].sort((a, b) => (a.versionId < b.versionId ? -1 : 1));
      for (const p of starting) {
        const reason = p.kind === "new" ? SAVE_REASONS.checked : p.system ? SAVE_REASONS.system : SAVE_REASONS.club;
        const activationId = (await client.query(
          `insert into training_load.source_metric_mapping_activations
             (mapping_version_id, mapping_id, source_metric_definition_id, metric_definition_id, parameter_fingerprint,
              source_team_binding_id, team_id, applies_to_session, applies_to_drill, requirement, activated_by_user_id, activated_basis, reason)
           select v.id, v.mapping_id, v.source_metric_definition_id, v.metric_definition_id, v.parameter_fingerprint,
                  $2, $3, v.applies_to_session, v.applies_to_drill, $4, $5, $6, $7
             from training_load.source_metric_mapping_versions v where v.id = $1 returning id`,
          [p.versionId, world.team.binding_id, world.team.id, p.row.requirement, ...actor, reason],
        )).rows[0].id;
        await audit("activation_start", ["mapping_version_id", "activation_id", "team_id", "reason"], [p.versionId, activationId, world.team.id, reason]);
      }
      // Step 16.6: the keyed request record, last.
      await client.query(
        `insert into training_load.source_metric_audit (action, team_id, confirmation_id, performed_by_user_id, basis, operation_id, request_key, request_hash)
         values ('mapping_confirmation', $1, $2, $3, $4, $5, $6, $7)`,
        [world.team.id, confirmationId, ...actor, operationId, requestKey, requestHash],
      );
      return { operation_id: operationId, confirmation_id: confirmationId };
    },
  });
}
