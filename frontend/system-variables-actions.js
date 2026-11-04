// Training Load -> Data configuration -> Variables -> From OptiMove (7i-B2,
// J15 section 8.2): the reads behind "Use for your teams" and "Move your teams
// to this copy", and the move itself - one switch-to-copy call per team, one at
// a time, with one result per team. Every write carries its own request key; a
// team whose answer is lost is "Result not confirmed" and is checked by sending
// the very same request again, never by a read. The server decides again on
// every request.
import {
  TEXT_FORBIDDEN, WRITE_BOUND_MS, errorInfo, fetchVariables, newRequestKey, outcomeUnknown, variablesState,
} from "./metric-variables-data.js";
import { api } from "./api.js";
import { fetchActivations, fetchMappings, fetchOrganization, orgFacts } from "./metric-mappings-data.js";

const MAX_PAGES = 10;
const SWITCH_BASE = "/api/training-load/sources/metrics/activations";
const REASON_MAX = 500;

const live = (generation) => variablesState().generation === generation;

async function allPages(fetchPage, pick) {
  const rows = [];
  let cursor = null;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const data = await fetchPage(cursor);
    rows.push(...pick(data));
    cursor = data?.nextCursor || null;
    if (!cursor) return rows;
  }
  // Never a partial list shown as complete.
  throw new Error("too many pages");
}
// The whole mappings list and the whole system list are read once per short
// window and generation, not once per opened variable (every club variable an
// administrator opens looks for its original). A failed read is not kept, and
// "Try again" starts a fresh one.
const CACHE_MS = 15000;
const cache = new Map();
function cached(name, read, fresh = false) {
  const generation = variablesState().generation;
  const hit = cache.get(name);
  if (!fresh && hit && hit.generation === generation && Date.now() - hit.at < CACHE_MS) return hit.promise;
  const promise = read();
  const entry = { generation, at: Date.now(), promise };
  cache.set(name, entry);
  promise.catch(() => { if (cache.get(name) === entry) cache.delete(name); });
  return promise;
}
export const dropSystemReadCache = () => cache.clear();
const allMappings = (fresh = false) => cached("mappings", () => allPages((cursor) => fetchMappings(cursor), (d) => (Array.isArray(d?.mappings) ? d.mappings : [])), fresh);
const allSystemVariables = (fresh = false) => cached("system", () => allPages(
  (cursor) => fetchVariables({ scope: "system", stateFilter: "all", hidden: "include", cursor }),
  (d) => (Array.isArray(d?.variables) ? d.variables : []),
), fresh);

// ---------------------------------------------------------------------------
// OptiMove's mappings of one system variable ("Use for your teams")
// ---------------------------------------------------------------------------
// The system mappings of the variable that have an active version: the data
// sources a club's teams can be switched on for. Read once per variable.
let inflight = null;
export function ensureSystemMappings(variableId, render) {
  const s = variablesState();
  const current = s.sys.mappings;
  if (current.variableId === variableId && current.state === "ready") return Promise.resolve();
  if (current.variableId === variableId && current.state === "loading" && inflight?.variableId === variableId && inflight.generation === s.generation) return inflight.promise;
  const promise = readSystemMappings(variableId, render);
  inflight = { variableId, generation: s.generation, promise };
  return promise;
}
async function readSystemMappings(variableId, render) {
  const s = variablesState();
  const generation = s.generation;
  s.sys.mappings = { variableId, state: "loading", rows: [] };
  try {
    const rows = (await allMappings())
      .filter((row) => row.ownerScope === "system" && row.metricDefinitionId === variableId && row.activeVersionId)
      .map((row) => ({ mappingId: row.id, versionId: row.activeVersionId, fieldKey: row.sourceMetric?.id || "", fieldLabel: row.sourceMetric?.label || "" }));
    if (!live(generation) || s.sys.mappings.variableId !== variableId) return;
    s.sys.mappings = { variableId, state: "ready", rows };
  } catch {
    if (!live(generation) || s.sys.mappings.variableId !== variableId) return;
    s.sys.mappings = { variableId, state: "error", rows: [] };
  }
  render();
}

// ---------------------------------------------------------------------------
// Move your teams to this copy
// ---------------------------------------------------------------------------
const oneLine = (value) => String(value ?? "").replace(/\s+/g, " ").trim();

// The sentence for each team's refusal (J15 8.2, "Sentences for the new codes").
const MOVE_TEXT = {
  not_a_copy_of_this_version: "This team uses a different OptiMove version than the one your copy was made from. Switch it off and then on with your copy; there is a short gap in between.",
  version_not_active: "The copy's link is not active yet. Activate it first.",
  field_retired: "The copy's link is not active yet. Activate it first.",
  activation_not_open: "This team was already switched off.",
  variable_hidden: "This club hides this variable. Show it again first.",
  binding_not_active: "This team is no longer linked to GPEXE.",
  binding_source_mismatch: "This team is linked to another source.",
  activation_exists: "This team already gets this field.",
  variable_taken_on_binding: "This team already has this variable at this level.",
  try_again: "The server was busy. This team was not moved. Try again.",
  internal_error: "The server could not move this team. It was not moved. Try again.",
  request_key_reused: "An earlier move of this team may already be stored. Open this variable again to see where the team is now.",
  notFound: "It is not available in this workspace now.",
};
const moveText = (info) => MOVE_TEXT[info.code] || "It was not moved: the server refused it.";

// Settled by a check: the answers the server gives once it has read its
// request record (every state refusal), not busy, a server error or no access.
const SETTLED_ON_CHECK = new Set([
  "not_a_copy_of_this_version", "version_not_active", "field_retired", "activation_not_open", "variable_hidden", "binding_not_active",
  "binding_source_mismatch", "activation_exists", "variable_taken_on_binding",
]);

export const emptyMove = (copyId) => ({
  copyId, state: "loading", original: null, teams: [], review: false, reason: "", reasonError: "", busy: false, unconfirmed: false, note: "",
});

// A copy knows nothing of where it came from (the server gives no link back),
// so the original is found in the system list: the row whose `club.copyId` is
// this copy. Then OptiMove's open activations of its mappings are the teams
// still on it, each with the copy's active version of the same field.
export async function ensureMove(copy, render) {
  const s = variablesState();
  const retry = s.sys.move?.copyId === copy.id && s.sys.move.state === "error";
  if (s.sys.move?.copyId === copy.id && s.sys.move.state !== "error") return;
  const generation = s.generation;
  const move = emptyMove(copy.id);
  s.sys.move = move;
  const stale = () => !live(generation) || s.sys.move !== move;
  try {
    const system = await allSystemVariables(retry);
    if (stale()) return;
    const original = system.find((row) => row?.club?.copyId === copy.id) || null;
    if (!original) { move.state = "none"; render(); return; }
    move.original = { id: original.id, label: original.label || "", state: original.state, actions: Array.isArray(original.actions) ? original.actions : [] };
    const mappings = await allMappings(retry);
    if (stale()) return;
    const originalRows = mappings.filter((m) => m.ownerScope === "system" && m.metricDefinitionId === original.id && m.activeVersionId);
    const copyActive = new Map(mappings.filter((m) => m.ownerScope === "club" && m.metricDefinitionId === copy.id && m.activeVersionId).map((m) => [m.sourceMetric?.id, m.activeVersionId]));
    const teams = [];
    for (const row of originalRows) {
      const open = await allPages((cursor) => fetchActivations({ versionId: row.activeVersionId, stateFilter: "open", cursor }), (d) => (Array.isArray(d?.activations) ? d.activations : []));
      if (stale()) return;
      for (const activation of open) {
        if (activation.endedAt) continue;
        teams.push({
          activationId: activation.id, teamId: activation.teamId, teamName: "", requirement: activation.requirement,
          fieldLabel: row.sourceMetric?.label || "", targetVersionId: copyActive.get(row.sourceMetric?.id) || null,
          key: newRequestKey(), outcome: null, note: "",
        });
      }
    }
    let names = new Map();
    if (teams.length) {
      try { names = new Map(orgFacts(await fetchOrganization()).teams.map((t) => [t.id, t.name])); } catch { /* the names stay generic */ }
      if (stale()) return;
    }
    for (const team of teams) team.teamName = names.get(String(team.teamId)) || "A team";
    move.teams = teams;
    move.state = "ready";
  } catch {
    if (stale()) return;
    move.state = "error";
  }
  render();
}

export const moveBlocker = (move) => (move.teams.some((t) => !t.targetVersionId) ? "Activate the copy's GPEXE field links first." : "");

function reasonProblem(reason) {
  if (!reason) return "Required.";
  if ([...reason].length > REASON_MAX) return `At most ${REASON_MAX} characters.`;
  if (TEXT_FORBIDDEN.test(reason)) return "Remove the hidden characters.";
  return "";
}

function postSwitch(team, reason) {
  const signal = typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function" ? AbortSignal.timeout(WRITE_BOUND_MS) : undefined;
  return api(`${SWITCH_BASE}/${encodeURIComponent(team.activationId)}/switch-to-copy`, {
    method: "POST",
    body: JSON.stringify({ requestKey: team.key, expectedState: "open", toVersionId: team.targetVersionId, reason }),
    ...(signal ? { signal } : {}),
  });
}

// One team at a time. `check` sends again only the teams whose answer was
// lost, each with its own key.
export async function sendMove(render, { check = false } = {}) {
  const s = variablesState();
  const move = s.sys.move;
  if (!move || move.busy || move.state !== "ready") return;
  // One command at a time: while a result is not confirmed only Check result is live.
  if (!check && move.unconfirmed) return;
  const reason = oneLine(move.reason);
  const problem = reasonProblem(reason);
  if (problem) { move.reasonError = problem; render(); return; }
  if (moveBlocker(move)) return;
  const generation = s.generation;
  const pending = move.teams.filter((t) => (check ? t.outcome === "unknown" : t.outcome === null || t.outcome === "refused"));
  if (!pending.length) return;
  move.busy = true;
  move.reasonError = "";
  move.note = "";
  render();
  for (const team of pending) {
    if (!live(generation) || s.sys.move !== move) return;
    try {
      await postSwitch(team, reason);
      team.outcome = "moved";
      team.note = "";
    } catch (error) {
      if (!live(generation) || s.sys.move !== move) return;
      const info = errorInfo(error);
      if (outcomeUnknown(info) || (check && !SETTLED_ON_CHECK.has(info.code) && info.code !== "request_key_reused")) {
        team.outcome = "unknown";
        team.note = "";
      } else {
        team.outcome = "refused";
        team.note = moveText(info);
        if (info.code === "request_key_reused") team.key = newRequestKey();
      }
    }
    render();
  }
  if (!live(generation) || s.sys.move !== move) return;
  move.busy = false;
  move.unconfirmed = move.teams.some((t) => t.outcome === "unknown");
  render();
}

export const moveNeedsAsk = () => {
  const move = variablesState().sys?.move;
  return Boolean(move && (move.busy || move.unconfirmed));
};
