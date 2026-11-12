// Training Load -> Data configuration -> Map by drag and drop (J18, C112:
// docs/ai/c112-drag-mapping-contract.md, section 3). A club's administrator
// drags a GPEXE column onto a variable; OptiMove proposes the conversion and
// shows two athletes; the admin compares them with the GPEXE screen, ticks the
// row and saves. Frontend only, over routes 1-5 of the contract: the screen
// never sends an owner, an actor, a value or an athlete id, and the server
// answers everyone else with the identical 404.
import { api } from "./api.js";
import { state } from "./state.js";
import { WRITE_BOUND_MS, errorInfo, newRequestKey, outcomeUnknown } from "./metric-variables-data.js";

export { errorInfo, newRequestKey, outcomeUnknown };

const BASE = "/api/training-load/sources/metrics";
const CONNECTIONS = "/api/training-load/sources/gpexe/connections";
export const MAX_ROWS = 20;

// Who is offered the board (section 4.1): a club workspace only - the club's
// admin, or a platform admin working in the club. Never the platform
// workspace, never a team workspace. The server decides again.
export function boardContext(user = state.currentUser) {
  const ws = user?.activeWorkspace || null;
  if (!ws || ws.type !== "club" || !ws.scopeId) return null;
  return { clubId: String(ws.scopeId), clubName: ws.label || "" };
}

export function emptyBoardState() {
  return {
    // Bumped on every reset: an answer for an older view is dropped.
    generation: 0,
    // The club's teams with an active GPEXE link ("Which team?").
    teams: { items: [], loaded: false, loading: false, error: null },
    teamId: null,
    // "map" | "history"
    tab: "map",
    pair: 0,
    // Route 1's answer, as read; `error` is { code, message, current }.
    board: null,
    loading: false,
    error: null,
    // The column chosen by a tap, waiting for its variable.
    picked: null,
    // The admin's own new placements, by field id:
    // { fieldId, targetId, placement, checked, requirement }.
    placements: {},
    // Pre-placed rows the admin changed, by mapping version id: { removed, requirement }.
    preplaced: {},
    // OptiMove mappings the admin placed by hand (route 2's own rows), by mapping version id.
    extra: {},
    // The last announcement for the polite live region.
    live: "",
    // The open panel: { fieldId, targetId, loading, placement, error }.
    panel: null,
    // On a phone, the one open sheet: "targets" | "panel" | "review".
    sheet: null,
    review: false,
    // The one write in flight or not confirmed: { kind, body, sending, unconfirmed, note }.
    write: null,
    // What the last save switched on (the "Saved" notice).
    saved: null,
    notice: "",
    // A pending Switch off of a row that is on: { activationId, label }.
    switchOff: null,
    history: { items: [], nextCursor: null, loaded: false, loading: false, loadingMore: false, error: null },
  };
}
export function boardState() {
  if (!state.trainingLoad.board) state.trainingLoad.board = emptyBoardState();
  return state.trainingLoad.board;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------
const query = (params) => Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== "").map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&");

// The club's teams that can open a board: an active team with an active
// binding of the club's connection, each with the GPEXE team it is linked to.
export async function fetchBoardTeams(clubId) {
  const answer = await api(`${CONNECTIONS}?clubId=${encodeURIComponent(clubId)}`);
  const teams = [];
  for (const c of Array.isArray(answer?.connections) ? answer.connections : []) {
    for (const b of c.boundTeams || []) {
      if (b.state !== "active" || b.teamActive === false) continue;
      teams.push({ teamId: String(b.teamId), name: String(b.teamName || ""), sourceTeamId: String(b.sourceTeamId || "") });
    }
  }
  return teams.sort((a, b) => a.name.localeCompare(b.name));
}
export const fetchBoard = ({ teamId, pair }) => api(`${BASE}/board?${query({ teamId, pair: pair || undefined })}`);
export const fetchPlacement = ({ teamId, candidateId, pair, fieldId, targetId }) => api(`${BASE}/board/placement?${query({ teamId, candidateId, pair, fieldId, targetId })}`);
export const fetchConfirmations = ({ teamId, cursor }) => api(`${BASE}/confirmations?${query({ teamId, cursor })}`);

// ---------------------------------------------------------------------------
// Writes: each carries a request key; a lost answer is checked by sending the
// very same request again.
// ---------------------------------------------------------------------------
function write(path, body) {
  const signal = typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function" ? AbortSignal.timeout(WRITE_BOUND_MS) : undefined;
  return api(path, { method: "POST", body: JSON.stringify(body), ...(signal ? { signal } : {}) });
}
export const saveBoard = (body) => write(`${BASE}/confirmations`, body);
export const endActivation = (activationId, body) => write(`${BASE}/activations/${encodeURIComponent(activationId)}/end`, body);

// ---------------------------------------------------------------------------
// What the board shows, derived from route 1's answer and the admin's changes
// ---------------------------------------------------------------------------
export const columnOf = (board, fieldId) => (board?.columns || []).find((c) => c.fieldId === fieldId) || null;
export const variableOf = (board, variableId) => (board?.variables || []).find((v) => v.id === variableId) || null;

// The pre-placed rows that are part of the board now: OptiMove's and the
// club's own active mappings the admin has not removed, and replacements the
// admin added.
export function preplacedRows(s = boardState()) {
  const board = s.board;
  if (!board) return [];
  const rows = [];
  for (const p of board.preplaced || []) {
    const mine = s.preplaced[p.mappingVersionId] || {};
    if (!mine.removed) rows.push({ ...p, requirement: mine.requirement || "required", replaces: [] });
  }
  for (const p of board.replaceable || []) {
    const mine = s.preplaced[p.mappingVersionId] || {};
    if (mine.added) rows.push({ ...p, requirement: mine.requirement || "required", replaces: (p.replaces || []).map((c) => c.activationId) });
  }
  for (const p of Object.values(s.extra || {})) {
    const mine = s.preplaced[p.mappingVersionId] || {};
    if (mine.added && !mine.removed && !rows.some((r) => r.mappingVersionId === p.mappingVersionId)) {
      rows.push({ ...p, requirement: mine.requirement || "required", replaces: (p.collisions || []).map((c) => c.activationId) });
    }
  }
  return rows;
}
export const newRows = (s = boardState()) => Object.values(s.placements).filter((p) => p.placement?.placeable === true);

// The state of a variable on the board, for its slot.
export function slotOf(s, variable) {
  const board = s.board;
  const on = (board.on || []).find((o) => o.variableId === variable.id);
  if (on) return { kind: "on", on, column: columnOf(board, on.fieldId) };
  const placed = Object.values(s.placements).find((p) => p.targetId === variable.id);
  if (placed) return { kind: "new", placed, column: columnOf(board, placed.fieldId) };
  const pre = preplacedRows(s).find((p) => p.variableId === variable.id);
  if (pre) return { kind: "preplaced", pre, column: columnOf(board, pre.fieldId) };
  const off = (board.switchedOff || []).find((x) => x.variableId === variable.id);
  if (off) return { kind: "switchedOff", off, column: columnOf(board, off.fieldId) };
  const removed = (board.preplaced || []).find((p) => p.variableId === variable.id && s.preplaced[p.mappingVersionId]?.removed);
  if (removed) return { kind: "removed", pre: removed, column: columnOf(board, removed.fieldId) };
  const replaceable = (board.replaceable || []).find((p) => p.variableId === variable.id);
  if (replaceable) return { kind: "replaceable", pre: replaceable, column: columnOf(board, replaceable.fieldId) };
  return { kind: "empty" };
}
// Whether a column is already used by a row of the board (on, new or pre-placed).
export function columnUse(s, fieldId) {
  const board = s.board;
  if ((board.on || []).some((o) => o.fieldId === fieldId)) return "on";
  if (s.placements[fieldId]) return "new";
  if (preplacedRows(s).some((p) => p.fieldId === fieldId)) return "preplaced";
  return null;
}

// The number of the admin's own unsaved changes (the leave question counts
// only these; an untouched pre-placed row never asks).
export function unsavedCount(s = boardState()) {
  return Object.keys(s.placements).length + Object.values(s.preplaced).filter((p) => p.removed || p.added || p.requirementChanged).length;
}

// The body of the save (section 3.7): identities and the display unit only -
// never a value, a unit, a factor or a name.
export function saveBody(s, requestKey) {
  const rows = [
    ...newRows(s).map((p) => {
      const unit = p.placement.displayUnits[0];
      return {
        kind: "new", fieldId: p.fieldId, targetId: p.targetId, expectedTargetVersionId: p.placement.expectedTargetVersionId, displayUnit: unit,
        placementHash: p.placement.placementHashes[unit], checked: p.checked === true, requirement: p.requirement, replaces: (p.placement.collisions || []).map((c) => c.activationId),
      };
    }),
    ...preplacedRows(s).map((p) => ({ kind: "preplaced", mappingVersionId: p.mappingVersionId, placementHash: p.placementHash, requirement: p.requirement, replaces: p.replaces })),
  ];
  return { requestKey, teamId: s.teamId, candidateId: s.board.session.candidateId, pair: s.board.pair.index, rows };
}

// ---------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------
const UNIT_WORDS = { s: "seconds", min: "minutes", m: "metres", km: "kilometres", "m/s": "metres per second", "km/h": "kilometres per hour" };
export const unitWords = (unit) => UNIT_WORDS[unit] || unit || "";

// "s → min (÷ 60)", "m/s → km/h (× 3.6)", or "No conversion".
export function conversionWords(conversion, sourceUnit, targetUnit) {
  if (!conversion || conversion.kind === "same_unit") return "No conversion";
  const scale = Number(conversion.scale);
  const divisor = Number(conversion.divisor);
  const offset = Number(conversion.offset);
  let how = "";
  if (offset === 0 && scale === 1 && divisor !== 1) how = `÷ ${conversion.divisor}`;
  else if (offset === 0 && divisor === 1) how = `× ${conversion.scale}`;
  else if (offset === 0) how = `× ${trim(scale / divisor)}`;
  else how = `× ${trim(scale / divisor)} ${offset < 0 ? "−" : "+"} ${Math.abs(offset)}`;
  return `${sourceUnit} → ${targetUnit} (${how})`;
}
const trim = (n) => String(Number(n.toFixed(6)));

// Why a column cannot be placed (section 3.3).
export const COLUMN_REASON = {
  field_not_confirmed: "OptiMove has not confirmed this column yet. Ask OptiMove support to confirm it.",
  field_has_parameters: "Map zones and thresholds in Mappings.",
  source_metric_unsupported: "OptiMove cannot read this column yet.",
  display_rule_missing: "OptiMove cannot show how GPEXE displays this column yet, so it cannot be compared here.",
  no_value_for_pair: "These two athletes have no value here. Choose other athletes.",
};
// Why a placement is refused (sections 3.5 and 4.2).
export function placementRefusal(p, { column, variable } = {}) {
  const code = p?.code || "";
  const name = variable?.label || "this variable";
  switch (code) {
    case "conversion_unavailable":
      return `The units do not match: GPEXE sends values in ${p.sourceUnit}, and the variable is in ${p.targetUnit}. Choose another variable or create a new one in a fitting unit.`;
    case "target_scope_mismatch": return "OptiMove does not fill this variable from this column. Choose another variable or create your own.";
    case "source_metric_target_taken": return "This column already fills another variable for your club. Change that in Mappings.";
    case "mapping_version_active": return "Your club already maps this column to this variable in another way. Disable it in Mappings first.";
    case "activation_exists": return "This column is already on for the team.";
    case "variable_taken_on_binding": return `${name} is already filled for the team.`;
    case "level_not_allowed": return "This variable is not kept per session, so this column cannot fill it.";
    case "condition_mismatch": return "This variable counts only values under a condition. Map it in Mappings.";
    case "target_not_usable": return "This variable has no numeric unit, so a column cannot fill it.";
    case "pair_not_distinct": return COLUMN_REASON.no_value_for_pair;
    case "value_outside_limits": {
      const l = p.limits || {};
      const range = l.min !== null && l.max !== null ? `${l.min}–${l.max} ${l.unit}` : l.max !== null ? `up to ${l.max} ${l.unit}` : `from ${l.min} ${l.unit}`;
      return `This value is outside ${name}'s limits (${range}). This usually means the variable or its unit is wrong. If you are sure they fit, choose other athletes.`;
    }
    case "variable_hidden": return "Your club hides this OptiMove variable. Show it in Variables first.";
    default:
      return COLUMN_REASON[code] || (column ? "This column cannot be placed here." : "This cannot be placed here.");
  }
}
// The board's own refusals (route 1), and a save's.
export const BOARD_ERROR = {
  notFound: "Map by drag and drop is not available in this workspace.",
  no_stored_session: "No saved session yet. Run a search in Imports first.",
  snapshot_expired: "The saved session is no longer available. Run a new search in Imports.",
  candidate_too_large: "The saved session is too large to read here. Run a search for a smaller session in Imports.",
  candidate_source_mismatch: "The newest saved session was not read through this team's current GPEXE link. Run a new search in Imports.",
  candidate_not_importable: "OptiMove cannot read the saved session. Run a new search in Imports.",
  session_start_unknown: "The saved session has no start time. Run a new search in Imports.",
  not_enough_athletes: "OptiMove needs two athletes it can name. Link the team's athletes in Imports (Link athletes) so OptiMove can name two of them.",
  pair_out_of_range: "No other athletes have values for all your columns.",
  board_too_large: "This session has too many athletes and columns to compare at once. Run a search for a smaller session in Imports.",
  try_again: "The server was busy. Nothing was saved. Try again.",
  board_changed: "The board changed since you read it. Nothing was saved. Compare the marked column again.",
  canonical_version_changed: "A variable was changed since you read the board. Nothing was saved. Compare the marked column again.",
  activation_changed: "A mapping this save replaces is no longer on for the team. Nothing was saved.",
  binding_not_active: "The team is no longer linked to GPEXE. Nothing was saved.",
  request_key_reused: "Nothing was saved. Press Save again.",
  invalid_body: "The board could not be saved as it is. Nothing was saved. Read the board again.",
};
export const boardErrorText = (info) => BOARD_ERROR[info?.code] || (info?.status === 404 ? BOARD_ERROR.notFound : "Something went wrong. Nothing was changed.");

// A name written by another person or by the source, safe to put in a
// sentence: control and direction characters removed, at most 80 characters.
export function cleanName(value) {
  const text = String(value ?? "").replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/g, "").trim();
  return text.length > 80 ? `${text.slice(0, 79)}…` : text;
}
