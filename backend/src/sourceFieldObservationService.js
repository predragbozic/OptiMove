// G1b-2: the platform's comparison of a generic source field (docs/ai/gpexe-field-inventory-plan.md, section 8.2; J18's
// routes 8, 9 and 10). An active platform admin, in the platform workspace, compares two athletes' values of a created
// field in one stored session of any club's team with the GPEXE screen, and ticks: the unit GPEXE sends with the value
// (a quantity word, section 8.10) and the field's meaning (GPEXE's own label, decision (a)) become source_stated.
//
//   Route 8  GET  /fields/:fieldId/observation?teamId|candidateId[&pair=k | &pairs=i,j] - the two athletes, their values
//            as GPEXE should show them, the word and its rule, and the comparison's hash. No write.
//   Route O  POST /fields/:fieldId/revisions/:revisionId/observed-confirmation - the tick. ONE write: T9
//            field_observation, its T9s session, one T9i field_unit row (both raw values, the word), T2b source_stated,
//            and the two T8 rows (the keyed source_metric_unit_observed, then source_metric_meaning_observed).
//   Route 10 GET  /fields/:fieldId/observations - the stored comparisons of the field, values only until they expire.
//
// Everyone else gets the identical 404 (ADR-006). An athlete is named only by the team's own link or a GPEXE name that
// has not expired, and is given to a request only by its position in the session's GPEXE list (the import plan's order),
// never by an id: no athlete id is returned, stored, logged or hashed. The two values are stored only in T9i, and v65's
// removal clears them at their date.
//
// Route O's lock order (v65's writers' order T4 -> T2b -> T9 -> T8, users first, v54): the per-user advisory lock and the
// request record (runWrite) -> the revision (T2b) FOR UPDATE, as an M2b act takes it -> the session's binding and team
// FOR SHARE -> the acting user and role (users first), then the team's club FOR SHARE -> the inserts and the update ->
// the T8 rows. No T4 is touched; the candidate is never locked (v65's session guard checks it at the insert). The order
// is pinned by a test of the statements' recorded order (.claude/rules/migrations.md).
import crypto from "node:crypto";
import { adminWriteKit, SourceMetricMappingError, STATEMENT_TIMEOUT_MS } from "./sourceMetricMappingService.js";
import { classifyFieldError, mayVerify } from "./sourceFieldVerificationService.js";
import { classifySaveError, VALUE_STATEMENT_TIMEOUT_MS } from "./sourceMetricBoardSaveService.js";
import { lockListedBindings } from "./sourceMetricActivationSteps.js";
import { bindingClubHolds } from "./sourceMetricAccess.js";
import { GPEXE_SOURCE_SYSTEM, gpexeSessionValuesKeyed } from "./gpexeImportMapper.js";
import { teamSessionTimezone } from "./gpexeTeamTimezoneRead.js";
import { canonicalDecimal, genericObservationExtract } from "./sourceMetricExtractors.js";
import { DISPLAY_REGISTRY_VERSION, displayEntryForRule, displayValue, rankPairs } from "./sourceMetricBoard.js";
import { readUnitWordRows } from "./sourceUnitWords.js";
import { removeExpiredBatch } from "./sourceMetricConfirmationRemoval.js";

const { runWrite, boundedRead, rightsStillHold, refusal, NOT_FOUND, plainObject, uuidField, hashOf, UUID, REVISION_COLUMNS, revisionOut } = adminWriteKit;

export const mayObserve = mayVerify;
const CONTRACT = "source-field-observed/v1";
const API_FAMILY = "rest_v1";
const SOURCE_CONNECTION_PATH = "source_connection";
// The board's bounds (J18): the largest stored bundle read, how far back the default session looks.
export const OBSERVATION_MAX_BUNDLE_BYTES = 16 * 1024 * 1024;
export const OBSERVATION_DEFAULT_SESSIONS = 10;
export const OBSERVATIONS_PAGE = 50;
const HASH = /^[0-9a-f]{64}$/;
const POSITION = /^(0|[1-9][0-9]{0,3})$/;

export const OBSERVATION_TEXT = Object.freeze({
  invalid_query: "The query carries a parameter this route does not take, or a value it cannot read.",
  invalid_body: "The body is not a comparison of one field in one session.",
  not_attested: "Tick only after comparing both athletes with the GPEXE screen (attested: true).",
  field_has_parameters: "This field has parameters (a zone or an event threshold); confirm its unit with a document.",
  unit_already_verified: "This field's unit is already confirmed.",
  revision_not_active: "This revision is not the field's active one.",
  unit_not_stated: "GPEXE does not state a unit OptiMove can read for this field in this session.",
  no_unit_word: "GPEXE sends no unit with this value. A platform administrator confirms it with a document (Confirm the unit).",
  board_changed: "The session or the field changed since the comparison was read. Nothing was saved; read it again.",
  binding_not_active: "The team is no longer linked to GPEXE. Nothing was saved.",
  no_stored_session: "No saved session of this team yet. Run a search in Imports first.",
  no_comparable_session: "None of the team's latest saved sessions has two named athletes with different values of this field.",
  snapshot_expired: "The saved session is no longer available. Run a new search in Imports.",
  candidate_too_large: "The saved session is too large to read.",
  candidate_source_mismatch: "This session was not read through the team's current GPEXE link.",
  session_start_unknown: "This saved session has no start time.",
  candidate_not_importable: "The import would not take this GPEXE session.",
  not_enough_athletes: "OptiMove needs two athletes it can name, with different values of this field. Link the team's athletes in Imports (Link athletes).",
  pair_out_of_range: "No other pair of named athletes has different values of this field.",
  pair_not_comparable: "These two athletes cannot be compared for this field (not both named, or not two different values).",
});
// Why a session's word cannot be confirmed (current.reason of unit_not_stated; the screen owns the sentences).
export const UNIT_NOT_STATED_REASONS = Object.freeze(["no_unit_word", "words_disagree", "word_unknown", "expected_unit_differs", "not_generic"]);
const notStated = (reason) => refusal(409, "unit_not_stated", reason === "no_unit_word" ? OBSERVATION_TEXT.no_unit_word : OBSERVATION_TEXT.unit_not_stated, { current: { reason } });
const boardChanged = () => refusal(409, "board_changed", OBSERVATION_TEXT.board_changed);

function readQuery(queryString, allowed) {
  const bad = () => refusal(400, "invalid_query", OBSERVATION_TEXT.invalid_query);
  if (typeof queryString !== "string") throw bad();
  const out = {};
  for (const [name, value] of new URLSearchParams(queryString)) {
    if (!Object.hasOwn(allowed, name) || Object.hasOwn(out, name)) throw bad();
    if (allowed[name] === "uuid") {
      if (!UUID.test(value)) throw bad();
      out[name] = value.toLowerCase();
    } else if (allowed[name] === "index") {
      if (!POSITION.test(value)) throw bad();
      out[name] = Number(value);
    } else if (allowed[name] === "pairs") {
      const parts = value.split(",");
      if (parts.length !== 2 || !parts.every((p) => POSITION.test(p)) || parts[0] === parts[1]) throw bad();
      out[name] = parts.map(Number).sort((a, b) => a - b);
    }
  }
  return out;
}

function pathId(value) {
  if (typeof value !== "string" || !UUID.test(value)) throw NOT_FOUND();
  return value.toLowerCase();
}

// ---------------------------------------------------------------------------
// The world: the field, the team, the stored session, the names and the words. Plain reads.
// ---------------------------------------------------------------------------
// The field and its active revision, of the gpexe / rest_v1 family; anything else is the identical 404.
async function readField(client, fieldId) {
  return (await client.query(
    `select d.id, d.source_system, d.api_family, d.source_metric_key, d.source_label,
            r.id as revision_id, r.state, r.parameter_kind, r.evidence_status, r.unit_verified_at, r.meaning_verified_at,
            r.expected_source_unit, r.source_unit
       from training_load.source_metric_definitions d
       join training_load.source_metric_definition_versions r on r.source_metric_definition_id = d.id and r.state = 'active'
      where d.id = $1 and d.state = 'active' and d.source_system = $2 and d.api_family = $3`,
    [fieldId, GPEXE_SOURCE_SYSTEM, API_FAMILY],
  )).rows[0] ?? null;
}

// The field-level refusals, in route O's order: parameters, a proven unit, a field the comparison cannot read, an
// athlete-row value (GPEXE sends no word with it).
function fieldRefusal(field) {
  if (field.parameter_kind !== "none") return refusal(409, "field_has_parameters", OBSERVATION_TEXT.field_has_parameters);
  if (field.unit_verified_at !== null || field.meaning_verified_at !== null || field.evidence_status !== "unproven") {
    return refusal(409, "unit_already_verified", OBSERVATION_TEXT.unit_already_verified, { current: { evidenceStatus: field.evidence_status, sourceUnit: field.source_unit } });
  }
  if (!genericObservationExtract(field.source_metric_key)) return notStated("not_generic");
  if (field.source_metric_key.startsWith("athlete_session.")) return notStated("no_unit_word");
  return null;
}

// The team: active, of an active club, with its one active GPEXE binding of the club's own rest_v1 connection. Any club
// (the platform workspace). Missing, archived or bound otherwise: null.
async function readTeam(client, teamId) {
  return (await client.query(
    `select t.id, t.name, t.club_id, cl.name as club_name, b.id as binding_id, b.connection_id
       from public.teams t
       join public.clubs cl on cl.id = t.club_id and coalesce(cl.is_active, true)
       join training_load.source_team_bindings b on b.team_id = t.id and b.state = 'active' and b.source_system = $2
       join training_load.source_credential_connections c on c.id = b.connection_id and c.owner_scope = 'club' and c.owner_club_id = t.club_id
       join training_load.source_host_catalog h on h.source_system = c.source_system and h.host_key = c.host_key and h.api_family = $3
      where t.id = $1 and coalesce(t.is_active, true)`,
    [teamId, GPEXE_SOURCE_SYSTEM, API_FAMILY],
  )).rows[0] ?? null;
}

const usable = `c.status <> 'superseded' and c.import_undone_at is null`;
const CANDIDATE_SQL = `
  with scoped as materialized (
    select c.id, c.owner_team_id, c.status, c.gpexe_team_session_id, c.session_started_at, c.session_label, c.bundle_hash, c.last_seen_check_id,
           c.raw_purged_at is not null as purged, c.raw_expires_at <= now() as expired, c.raw_bundle,
           k.status as check_status, k.source_path, k.source_binding_id
      from training_load.gpexe_import_candidates c
      left join training_load.gpexe_import_checks k on k.id = c.last_seen_check_id and k.owner_team_id = c.owner_team_id
     where c.id = $1::uuid and ${usable})
  select s.id, s.owner_team_id, s.status, s.gpexe_team_session_id, s.session_started_at, s.session_label, s.bundle_hash, s.last_seen_check_id,
         s.purged, s.expired, s.check_status, s.source_path, s.source_binding_id, b.too_large,
         case when b.too_large is false and s.check_status = 'succeeded' and s.source_path = $2::text and s.session_started_at is not null
              then s.raw_bundle end as raw_bundle
    from scoped s
    cross join lateral (select case when s.purged or s.expired then null else octet_length(s.raw_bundle::text) end as bundle_bytes offset 0) sz
    cross join lateral (select sz.bundle_bytes > $3::int as too_large offset 0) b`;
const readCandidate = async (client, candidateId) => (await client.query(CANDIDATE_SQL, [candidateId, SOURCE_CONNECTION_PATH, OBSERVATION_MAX_BUNDLE_BYTES])).rows[0] ?? null;

function sessionRefusal(candidate, team) {
  if (candidate.purged) return refusal(409, "snapshot_expired", OBSERVATION_TEXT.snapshot_expired, { current: { reason: "purged" } });
  if (candidate.expired) return refusal(409, "snapshot_expired", OBSERVATION_TEXT.snapshot_expired, { current: { reason: "expired" } });
  if (candidate.too_large === true) return refusal(409, "candidate_too_large", OBSERVATION_TEXT.candidate_too_large);
  if (candidate.check_status !== "succeeded" || candidate.source_path !== SOURCE_CONNECTION_PATH || candidate.source_binding_id !== team.binding_id) {
    return refusal(409, "candidate_source_mismatch", OBSERVATION_TEXT.candidate_source_mismatch);
  }
  if (candidate.session_started_at === null) return refusal(409, "session_start_unknown", OBSERVATION_TEXT.session_start_unknown);
  if (candidate.raw_bundle === null || typeof candidate.raw_bundle !== "object") return refusal(409, "candidate_source_mismatch", OBSERVATION_TEXT.candidate_source_mismatch);
  return null;
}

// The names, live and never stored (as the board): the team's own link first, else a GPEXE name that has not expired.
async function readNames(client, team) {
  const linked = (await client.query(
    `select l.gpexe_athlete_id, coalesce(nullif(a.display_name, ''), a.full_name) as name
       from training_load.gpexe_athlete_links l join public.athletes a on a.id = l.athlete_id
      where l.owner_team_id = $1 and l.unlinked_at is null`,
    [team.id],
  )).rows;
  const identities = (await client.query(
    `select gpexe_athlete_id, display_name from training_load.gpexe_athlete_identities
      where binding_id = $1 and owner_team_id = $2 and expires_at > now()`,
    [team.binding_id, team.id],
  )).rows;
  const names = new Map();
  for (const row of identities) if (typeof row.display_name === "string" && row.display_name.trim() !== "") names.set(String(row.gpexe_athlete_id), row.display_name);
  for (const row of linked) if (typeof row.name === "string" && row.name.trim() !== "") names.set(String(row.gpexe_athlete_id), row.name);
  return names;
}

// ---------------------------------------------------------------------------
// The comparison (pure over a world): each athlete's value and word through the import's own gates, the pairs of named
// athletes with two different non-zero values, best first (the board's pair rule, C117).
// ---------------------------------------------------------------------------
function sessionAthletes(field, candidate, teamTimezone, names) {
  const extract = genericObservationExtract(field.source_metric_key);
  const out = gpexeSessionValuesKeyed(candidate.raw_bundle, [extract], { teamTimezone });
  if (out.code) return { code: out.code };
  const athletes = out.athletes.map((athlete, position) => {
    const key = String(athlete.key);
    const seen = athlete.session[0].length === 1 ? athlete.session[0][0] : null;
    const raw = seen ? canonicalDecimal(seen.value) : null;
    return { position, key, named: names.has(key), word: seen?.word ?? null, raw, values: new Map([[field.id, raw]]) };
  });
  return { code: null, ranked: rankPairs(athletes, [field.id]) };
}

function choose(ranked, { pair, pairs }) {
  if (pairs) {
    const index = ranked.findIndex((p) => [p.a.position, p.b.position].sort((x, y) => x - y).join() === pairs.join());
    if (index < 0) throw refusal(409, "pair_not_comparable", OBSERVATION_TEXT.pair_not_comparable);
    return { ...ranked[index], index };
  }
  const index = pair ?? 0;
  if (index >= ranked.length) throw refusal(409, "pair_out_of_range", OBSERVATION_TEXT.pair_out_of_range, { current: { count: ranked.length } });
  return { ...ranked[index], index };
}

// The word both athletes' answers carry, its seeded unit token and display rule (section 8.10), or the reason it
// cannot be confirmed. Carry-over 5: a word whose token is not the unit the field was created with (another GPEXE
// account may send the same name with another word) is not confirmed either.
function wordVerdict(field, a, b, words) {
  if (a.word !== b.word) return { reason: "words_disagree", words: [a.word, b.word] };
  const row = a.word === null ? null : words.get(a.word) ?? null;
  if (!row) return { reason: "word_unknown", words: [a.word, b.word] };
  if (field.expected_source_unit !== null && field.expected_source_unit !== row.sourceUnit) return { reason: "expected_unit_differs", words: [a.word, b.word] };
  const entry = displayEntryForRule(row.displayRule, row.sourceUnit);
  if (!entry) return { reason: "word_unknown", words: [a.word, b.word] };
  return { reason: null, word: a.word, unit: row.sourceUnit, rule: row.displayRule, displayUnit: entry.units[0], entry };
}

// The comparison's concurrency token: everything the admin compared, the two names included. Never stored, never in a
// request hash; recomputed on the tick.
function observationHash(parts) {
  return crypto.createHash("sha256").update(JSON.stringify([
    "g1.observation.v1", parts.bundleHash, parts.pairIndex, parts.positions, parts.labels, parts.revisionId,
    parts.word ?? null, parts.unit ?? null, parts.rule ?? null, parts.displayUnit ?? null, parts.rawA, parts.rawB,
  ])).digest("hex");
}

function comparisonOf({ field, team, candidate, names, words, teamTimezone }, selector) {
  const seen = sessionAthletes(field, candidate, teamTimezone, names);
  if (seen.code) throw refusal(409, "candidate_not_importable", OBSERVATION_TEXT.candidate_not_importable, { current: { reason: seen.code } });
  if (seen.ranked.length === 0) throw refusal(409, "not_enough_athletes", OBSERVATION_TEXT.not_enough_athletes);
  const chosen = choose(seen.ranked, selector);
  const positions = [chosen.a.position, chosen.b.position];
  const labels = [names.get(chosen.a.key), names.get(chosen.b.key)];
  const verdict = wordVerdict(field, chosen.a, chosen.b, words);
  const show = (raw) => (verdict.entry ? displayValue(verdict.entry, verdict.displayUnit, raw) : null);
  const placementHash = observationHash({
    bundleHash: candidate.bundle_hash, pairIndex: chosen.index, positions, labels, revisionId: field.revision_id,
    word: verdict.word, unit: verdict.unit, rule: verdict.rule, displayUnit: verdict.displayUnit, rawA: chosen.a.raw, rawB: chosen.b.raw,
  });
  return {
    pair: { index: chosen.index, count: seen.ranked.length, positions, labels },
    verdict,
    values: { a: { raw: chosen.a.raw, shown: show(chosen.a.raw) }, b: { raw: chosen.b.raw, shown: show(chosen.b.raw) } },
    placementHash,
  };
}

// The world of one comparison. With a candidate, its own team; else the team's newest stored sessions are tried, newest
// first, until one has a pair to compare.
async function loadComparison(client, { fieldId, teamId = null, candidateId = null, selector }) {
  const field = await readField(client, fieldId);
  if (!field) throw NOT_FOUND();
  const refused = fieldRefusal(field);
  if (refused) throw refused;
  let team;
  let candidate = null;
  if (candidateId) {
    candidate = await readCandidate(client, candidateId);
    if (!candidate) throw NOT_FOUND();
    team = await readTeam(client, candidate.owner_team_id);
    if (!team || (teamId && teamId !== String(team.id))) throw NOT_FOUND();
  } else {
    team = await readTeam(client, teamId);
    if (!team) throw NOT_FOUND();
  }
  const words = await readUnitWordRows(client, { sourceSystem: GPEXE_SOURCE_SYSTEM, apiFamily: API_FAMILY });
  const names = await readNames(client, team);
  const teamTimezone = await teamSessionTimezone(client, team.id);
  const world = { field, team, names, words, teamTimezone };
  if (candidate) {
    const sessionRefused = sessionRefusal(candidate, team);
    if (sessionRefused) throw sessionRefused;
    return { ...world, candidate, comparison: comparisonOf({ ...world, candidate }, selector) };
  }
  const listed = (await client.query(
    `select c.id from training_load.gpexe_import_candidates c
       join training_load.gpexe_import_checks k on k.id = c.last_seen_check_id and k.owner_team_id = c.owner_team_id
      where c.owner_team_id = $1::uuid and ${usable}
        and c.raw_purged_at is null and c.raw_expires_at > now() and c.session_started_at is not null
        and k.status = 'succeeded' and k.source_path = $2::text and k.source_binding_id = $3::uuid
      order by c.session_started_at desc, c.id limit ${OBSERVATION_DEFAULT_SESSIONS}`,
    [team.id, SOURCE_CONNECTION_PATH, team.binding_id],
  )).rows;
  if (listed.length === 0) throw refusal(409, "no_stored_session", OBSERVATION_TEXT.no_stored_session);
  for (const row of listed) {
    const read = await readCandidate(client, row.id);
    if (!read || sessionRefusal(read, team)) continue;
    try {
      return { ...world, candidate: read, comparison: comparisonOf({ ...world, candidate: read }, selector) };
    } catch (error) {
      // A session without a pair (or one the import would not take) is passed by; anything else is the answer.
      if (!(error instanceof SourceMetricMappingError) || error.status !== 409) throw error;
    }
  }
  throw refusal(409, "no_comparable_session", OBSERVATION_TEXT.no_comparable_session, { current: { tried: listed.length } });
}

function comparisonOut(world) {
  const { field, team, candidate, comparison: c } = world;
  return {
    observation: {
      fieldId: field.id, revisionId: field.revision_id, key: field.source_metric_key, label: field.source_label,
      expectedUnit: field.expected_source_unit ?? null,
      team: { id: team.id, name: team.name, clubId: team.club_id, clubName: team.club_name ?? null },
      session: { candidateId: candidate.id, label: candidate.session_label ?? null, startedAt: candidate.session_started_at },
      pair: c.pair,
      confirmable: c.verdict.reason === null,
      reason: c.verdict.reason,
      ...(c.verdict.reason ? { words: c.verdict.words } : {}),
      word: c.verdict.word ?? null, unit: c.verdict.unit ?? null, displayRule: c.verdict.rule ?? null, displayUnit: c.verdict.displayUnit ?? null,
      values: c.values,
      placementHash: c.placementHash,
    },
  };
}

// Route 8.
export async function readObservation({ ctx, fieldId: rawField, queryString }) {
  if (!mayObserve(ctx)) throw NOT_FOUND();
  const fieldId = pathId(rawField);
  const q = readQuery(queryString, { teamId: "uuid", candidateId: "uuid", pair: "index", pairs: "pairs" });
  if ((!q.teamId && !q.candidateId) || (q.pair !== undefined && q.pairs)) throw refusal(400, "invalid_query", OBSERVATION_TEXT.invalid_query);
  await removeExpiredBatch();
  const world = await boundedRead((client) => loadComparison(client, { fieldId, teamId: q.teamId ?? null, candidateId: q.candidateId ?? null, selector: { pair: q.pair, pairs: q.pairs } }));
  return comparisonOut(world);
}

// ---------------------------------------------------------------------------
// Route O: the tick.
// ---------------------------------------------------------------------------
const OBSERVED_REQUESTS = Object.freeze({
  find: `select action as operation, request_hash, operation_id, source_metric_definition_id, source_metric_version_id, confirmation_id
           from training_load.source_metric_audit where performed_by_user_id = $1 and request_key = $2`,
  exists: `select 1 from training_load.source_metric_audit where performed_by_user_id = $1 and request_key = $2`,
});
const observedIdsOf = (written) => ({ fieldId: written.source_metric_definition_id ?? null, revisionId: written.source_metric_version_id ?? null, confirmationId: written.confirmation_id ?? null });

// The answer and a replay's: the revision as it is now, and the comparison's id. No value.
async function observedAnswer(executor, record) {
  const row = (await executor.query(
    `select ${REVISION_COLUMNS} from training_load.source_metric_definition_versions where id = $1 and source_metric_definition_id = $2`,
    [record.source_metric_version_id, record.source_metric_definition_id],
  )).rows[0];
  return row ? { revision: { fieldId: row.source_metric_definition_id, ...revisionOut(row) }, confirmationId: record.confirmation_id ?? null } : null;
}

function classifyObservedError(error) {
  if (error instanceof SourceMetricMappingError) return error;
  return classifyFieldError(error) ?? classifySaveError(error);
}

function readBody(body) {
  const invalid = (message = OBSERVATION_TEXT.invalid_body) => refusal(400, "invalid_body", message);
  plainObject(body, ["requestKey", "session", "attested"], ["requestKey", "session", "attested"]);
  const requestKey = uuidField(body.requestKey);
  if (body.attested !== true) throw invalid(OBSERVATION_TEXT.not_attested);
  const s = body.session;
  if (s === null || typeof s !== "object" || Array.isArray(s) || Object.keys(s).sort().join(",") !== "candidateId,pairs,placementHash") throw invalid();
  const candidateId = uuidField(s.candidateId);
  if (!Array.isArray(s.pairs) || s.pairs.length !== 2 || !s.pairs.every((p) => Number.isInteger(p) && p >= 0 && p <= 9999) || s.pairs[0] === s.pairs[1]) throw invalid();
  if (typeof s.placementHash !== "string" || !HASH.test(s.placementHash)) throw invalid();
  return { requestKey, candidateId, pairs: [...s.pairs].sort((a, b) => a - b), placementHash: s.placementHash };
}

// Test seam (never set by the application): called inside the tick's transaction at a named step.
let observedHold = null;
export function setObservedHoldForTests(fn) { observedHold = fn ?? null; }
const hold = async (client, step) => { if (observedHold) await observedHold(client, step); };

// The judgement of a comparison, the same before and after the locks: a reason is unit_not_stated, a hash that differs
// is board_changed.
function judge(world, placementHash) {
  if (world.comparison.verdict.reason) throw notStated(world.comparison.verdict.reason);
  if (world.comparison.placementHash !== placementHash) throw boardChanged();
}

export async function confirmObserved({ ctx, fieldId: rawField, revisionId: rawRevision, body }) {
  if (!mayObserve(ctx)) throw NOT_FOUND();
  const fieldId = pathId(rawField);
  const revisionId = pathId(rawRevision);
  const { requestKey, candidateId, pairs, placementHash } = readBody(body);
  const action = "source_metric_unit_observed";
  const requestHash = hashOf({ contract: CONTRACT, operation: action, fieldId, revisionId, candidateId, pairs });
  return runWrite({
    ctx, where: "field_observed", requestKey, requestHash, action, requests: OBSERVED_REQUESTS, classify: classifyObservedError, idsOf: observedIdsOf,
    reread: (executor, record) => observedAnswer(executor, record),
    body: async (client, operationId) => {
      // Plain reads and the judgement, before any lock: a stale or refused comparison is answered here.
      const owns = (await client.query(
        `select r.state from training_load.source_metric_definition_versions r
           join training_load.source_metric_definitions d on d.id = r.source_metric_definition_id
          where r.id = $1 and r.source_metric_definition_id = $2 and d.source_system = $3 and d.api_family = $4`,
        [revisionId, fieldId, GPEXE_SOURCE_SYSTEM, API_FAMILY],
      )).rows[0];
      if (!owns) throw NOT_FOUND();
      const seen = await loadComparison(client, { fieldId, candidateId, selector: { pairs } });
      if (seen.field.revision_id !== revisionId) throw refusal(409, "revision_not_active", OBSERVATION_TEXT.revision_not_active);
      judge(seen, placementHash);
      await hold(client, "before_locks");

      // The locks, in v65's order (no T4): the revision, the binding and its team, the rights (users first), the club.
      const rev = (await client.query(
        `select id, state, parameter_kind, evidence_status, unit_verified_at, meaning_verified_at
           from training_load.source_metric_definition_versions where id = $1 and source_metric_definition_id = $2 for update`,
        [revisionId, fieldId],
      )).rows[0];
      if (!rev) throw NOT_FOUND();
      const locked = await lockListedBindings(client, [{ bindingId: seen.team.binding_id }]);
      if (!(await rightsStillHold(client, ctx))) throw NOT_FOUND();
      if (!(await bindingClubHolds(client, [String(seen.team.club_id)]))) throw NOT_FOUND();

      // The states, on what is locked now.
      if (rev.state !== "active") throw refusal(409, "revision_not_active", OBSERVATION_TEXT.revision_not_active);
      if (rev.parameter_kind !== "none") throw refusal(409, "field_has_parameters", OBSERVATION_TEXT.field_has_parameters);
      if (rev.unit_verified_at !== null || rev.meaning_verified_at !== null || rev.evidence_status !== "unproven") {
        throw refusal(409, "unit_already_verified", OBSERVATION_TEXT.unit_already_verified, { current: { evidenceStatus: rev.evidence_status } });
      }
      if (locked.get(seen.team.binding_id)?.state !== "active") throw refusal(409, "binding_not_active", OBSERVATION_TEXT.binding_not_active);
      const world = await loadComparison(client, { fieldId, candidateId, selector: { pairs } });
      if (world.team.binding_id !== seen.team.binding_id || world.field.revision_id !== revisionId) throw boardChanged();
      judge(world, placementHash);
      await hold(client, "before_writes");

      const { team, candidate, comparison } = world;
      const actor = [ctx.userId, "platform_admin"];
      // T9: OptiMove's comparison of one revision (system scope, no club); the database sets the expiry of its values.
      const confirmationId = (await client.query(
        `insert into training_load.source_metric_confirmations
           (operation_id, kind, owner_scope, owner_club_id, binding_id, team_id, credential_connection_id, confirmed_by_user_id, confirmed_basis,
            confirmed_at, attested, display_registry_version, values_expire_at, source_metric_version_id)
         values ($1, 'field_observation', 'system', null, $2, $3, $4, $5, $6, now(), true, $7, now(), $8) returning id`,
        [operationId, team.binding_id, team.id, team.connection_id, ...actor, DISPLAY_REGISTRY_VERSION, revisionId],
      )).rows[0].id;
      // T9s: the session, so a stricter rule can check it again later.
      await client.query(
        `insert into training_load.source_metric_confirmation_sessions
           (confirmation_id, session_ordinal, candidate_id, candidate_bundle_hash, gpexe_team_session_id, session_started_at, check_id, team_id, pair_index)
         values ($1, 1, $2, $3, $4, $5, $6, $7, $8)`,
        [confirmationId, candidate.id, candidate.bundle_hash, candidate.gpexe_team_session_id, candidate.session_started_at,
          candidate.last_seen_check_id, team.id, comparison.pair.index],
      );
      // T9i: the one compared row - both raw values and the word. The only statement that carries an athlete's value, under
      // its own lower bound (the board save's rule: below the database's auto_explain threshold).
      await client.query(`set local statement_timeout = '${VALUE_STATEMENT_TIMEOUT_MS}ms'`);
      await client.query(
        `insert into training_load.source_metric_confirmation_items
           (confirmation_id, session_ordinal, item_no, item_kind, checked, source_metric_version_id, source_unit, compared_level,
            gpexe_display_rule, gpexe_display_unit, raw_a, raw_b, source_unit_word)
         values ($1, 1, 1, 'field_unit', true, $2, $3, 'session', $4, $5, $6::numeric, $7::numeric, $8)`,
        [confirmationId, revisionId, comparison.verdict.unit, comparison.verdict.rule, comparison.verdict.displayUnit,
          comparison.values.a.raw, comparison.values.b.raw, comparison.verdict.word],
      );
      await client.query(`set local statement_timeout = '${STATEMENT_TIMEOUT_MS}ms'`);
      // T2b: the unit (the word's token) and the meaning (GPEXE's own label), both proved by this comparison.
      await client.query(
        `update training_load.source_metric_definition_versions
            set source_unit = $2, unit_verified_by_user_id = $3, unit_verified_at = now(), unit_observation_id = $4,
                meaning_verified_by_user_id = $3, meaning_verified_at = now(), meaning_observation_id = $4, evidence_status = 'source_stated'
          where id = $1`,
        [revisionId, comparison.verdict.unit, ctx.userId, confirmationId],
      );
      // T8: the keyed request record, then the meaning's row.
      const audit = (kind, keyed) => client.query(
        `insert into training_load.source_metric_audit
           (action, source_metric_definition_id, source_metric_version_id, confirmation_id, performed_by_user_id, basis, operation_id, request_key, request_hash)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [kind, fieldId, revisionId, confirmationId, ...actor, operationId, keyed ? requestKey : null, keyed ? requestHash : null],
      );
      await audit("source_metric_unit_observed", true);
      await audit("source_metric_meaning_observed", false);
      return { operation_id: operationId, source_metric_definition_id: fieldId, source_metric_version_id: revisionId, confirmation_id: confirmationId };
    },
  });
}

// ---------------------------------------------------------------------------
// Route 10: the stored comparisons of a field (C119 (c)): a platform admin in the platform workspace only. Values only
// while they are kept (v65's removal clears them at their date); never an athlete's name or id (none is stored).
// ---------------------------------------------------------------------------
export async function listObservations({ ctx, fieldId: rawField }) {
  if (!mayObserve(ctx)) throw NOT_FOUND();
  const fieldId = pathId(rawField);
  await removeExpiredBatch();
  return boundedRead(async (client) => {
    const field = (await client.query(`select id from training_load.source_metric_definitions where id = $1`, [fieldId])).rows[0];
    if (!field) throw NOT_FOUND();
    const rows = (await client.query(
      `select c.id, c.confirmed_at, c.values_expire_at, c.values_expire_at <= now() as expired, c.source_metric_version_id,
              r.revision_number, t.id as team_id, t.name as team_name, cl.name as club_name,
              coalesce(nullif(u.display_name, ''), u.full_name) as confirmed_by,
              s.session_started_at,
              i.source_unit_word, i.source_unit, i.gpexe_display_rule, i.gpexe_display_unit, i.values_removed_at is not null as removed,
              case when i.values_removed_at is null and c.values_expire_at > now() then trim_scale(i.raw_a)::text end as raw_a,
              case when i.values_removed_at is null and c.values_expire_at > now() then trim_scale(i.raw_b)::text end as raw_b
         from training_load.source_metric_confirmations c
         join training_load.source_metric_definition_versions r on r.id = c.source_metric_version_id and r.source_metric_definition_id = $1
         join training_load.source_metric_confirmation_items i on i.confirmation_id = c.id and i.item_kind = 'field_unit'
         left join training_load.source_metric_confirmation_sessions s on s.confirmation_id = c.id and s.session_ordinal = 1
         left join public.teams t on t.id = c.team_id
         left join public.clubs cl on cl.id = t.club_id
         left join public.users u on u.id = c.confirmed_by_user_id
        where c.kind = 'field_observation'
        order by c.confirmed_at desc, c.id
        limit ${OBSERVATIONS_PAGE}`,
      [fieldId],
    )).rows;
    return {
      observations: rows.map((r) => ({
        id: r.id, revisionId: r.source_metric_version_id, revisionNumber: r.revision_number, confirmedAt: r.confirmed_at, confirmedBy: r.confirmed_by ?? null,
        team: { id: r.team_id, name: r.team_name ?? null, clubName: r.club_name ?? null },
        sessionStartedAt: r.session_started_at ?? null,
        word: r.source_unit_word, unit: r.source_unit, displayRule: r.gpexe_display_rule, displayUnit: r.gpexe_display_unit,
        valuesExpireAt: r.values_expire_at,
        values: r.raw_a === null || r.raw_b === null ? null : { a: r.raw_a, b: r.raw_b },
      })),
    };
  });
}
