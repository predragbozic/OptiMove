// J20-C part b: the attendance states a coach chooses in the session review, saved right after a confirmed import
// (owner's O2 = A: the same button, a second step). docs/ai/j20-session-review-contract.md section 5.2.
//
// * The choices (athlete id -> kind and reason) and one requestKey per kind + reason group are kept in sessionStorage for
//   the candidate, so a reload never loses them and a lost answer is checked with the same key. Only ids, kinds, reason
//   keys and request keys are stored: never a name.
// * The keys are made before the import is sent; nothing is sent for the states until the import is confirmed (its answer,
//   or Check the result finding it). The activity and the approval come from that confirmation only.
// * Each group is one POST …/approvals/:approvalId/states with its own outcome: saved / not saved (a refusal the server
//   answered; nothing written) / not confirmed (Check result repeats the same request with the same key). A states failure
//   never touches the import.
// * Only athletes the roster still lists as needing a state are sent (expected decision null), so a state someone set in
//   the Roster tab meanwhile is never overwritten; they are reported as already set.
import { api } from "./api.js";
import { state } from "./state.js";

const STORE_PREFIX = "optimove.gpexe.importStates.v1.";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const STATE_KINDS = Object.freeze(["participated_no_values", "did_not_participate"]);
// Refusals after which the same request is pointless: set the states in the Roster tab.
const FINAL_CODES = new Set(["import_states_window_closed", "import_undone", "notFound", "roster_not_applicable", "activity_superseded"]);

const g = () => state.trainingLoad.gpexe;

function storeKey(teamId, candidateId) {
  return `${STORE_PREFIX}${teamId}.${candidateId}`;
}

function readStore(teamId, candidateId) {
  try {
    const raw = globalThis.sessionStorage?.getItem(storeKey(teamId, candidateId));
    const parsed = raw ? JSON.parse(raw) : null;
    if (!parsed || typeof parsed !== "object") return { choices: {}, groups: {} };
    const choices = {};
    for (const [id, c] of Object.entries(parsed.choices || {})) {
      if (UUID.test(id) && c && STATE_KINDS.includes(c.kind)) choices[id] = { kind: c.kind, reasonKey: c.kind === "did_not_participate" ? String(c.reasonKey || "") || null : null };
    }
    const groups = {};
    for (const [k, v] of Object.entries(parsed.groups || {})) {
      if (v && UUID.test(String(v.requestKey || ""))) groups[k] = { requestKey: v.requestKey, status: v.status || "pending", body: v.body || null };
    }
    return { choices, groups };
  } catch {
    return { choices: {}, groups: {} };
  }
}

function writeStore(teamId, candidateId, store) {
  try {
    globalThis.sessionStorage?.setItem(storeKey(teamId, candidateId), JSON.stringify(store));
  } catch {
    // A browser without storage keeps the choices for this page only.
  }
}

// The detail's states, read once per open review.
export function statesOf(detail, gx = g()) {
  if (!detail?.id || !gx.teamId) return { choices: {}, groups: {} };
  if (!detail.states) detail.states = readStore(gx.teamId, detail.id);
  return detail.states;
}

function persist(detail, gx = g()) {
  if (detail?.id && gx.teamId && detail.states) writeStore(gx.teamId, detail.id, detail.states);
}

// "" (no state), "participated_no_values", or "did_not_participate:<reasonKey>".
export function choiceValue(detail, athleteId) {
  const c = statesOf(detail).choices[athleteId];
  if (!c) return "";
  return c.kind === "did_not_participate" ? `did_not_participate:${c.reasonKey || ""}` : c.kind;
}

export function chooseState(detail, athleteId, value) {
  if (!detail || !UUID.test(String(athleteId || ""))) return false;
  const s = statesOf(detail);
  // Chosen while the states are being saved or after: nothing changes (the screen shows the saved outcome).
  if (s.locked) return false;
  const v = String(value || "");
  if (!v) delete s.choices[athleteId];
  else if (v === "participated_no_values") s.choices[athleteId] = { kind: v, reasonKey: null };
  else if (v.startsWith("did_not_participate:") && v.length > "did_not_participate:".length) s.choices[athleteId] = { kind: "did_not_participate", reasonKey: v.slice("did_not_participate:".length) };
  else return false;
  // A changed choice is a new plan: the keys are made again at the next import press.
  s.groups = {};
  persist(detail);
  return true;
}

// The groups the bulk route takes: one kind and reason for its athletes.
export function stateGroups(detail, allowedIds = null) {
  const s = statesOf(detail);
  const allowed = allowedIds ? new Set(allowedIds.map(String)) : null;
  const by = new Map();
  for (const [athleteId, c] of Object.entries(s.choices)) {
    if (allowed && !allowed.has(athleteId)) continue;
    const key = `${c.kind}|${c.reasonKey || ""}`;
    if (!by.has(key)) by.set(key, { key, kind: c.kind, reasonKey: c.reasonKey, athleteIds: [] });
    by.get(key).athleteIds.push(athleteId);
  }
  for (const grp of by.values()) grp.athleteIds.sort();
  return [...by.values()].sort((a, b) => a.key.localeCompare(b.key));
}

// Before the import is sent: one requestKey per group, kept across a reload.
export function prepareStateKeys(detail, allowedIds) {
  const s = statesOf(detail);
  for (const grp of stateGroups(detail, allowedIds)) {
    if (!s.groups[grp.key]) s.groups[grp.key] = { requestKey: globalThis.crypto.randomUUID(), status: "pending", body: null };
  }
  persist(detail);
}

export function chosenStateCount(detail, allowedIds) {
  return stateGroups(detail, allowedIds).reduce((n, grp) => n + grp.athleteIds.length, 0);
}

function errorOf(error) {
  return { status: error?.status ?? 0, code: error?.data?.error ?? null, message: error?.data?.message ?? null, data: error?.data ?? null };
}
function answeredRefusal(info) {
  return !!info.data && typeof info.data.error === "string" && info.status >= 400 && info.status < 500;
}

// After a confirmed import: the states, group by group. `approval` is { id, activityId }.
export async function saveImportStates(detail, approval, render) {
  const gx = g();
  const s = statesOf(detail);
  if (!approval?.id || !approval?.activityId) return;
  const groups = stateGroups(detail).filter((grp) => s.groups[grp.key] && s.groups[grp.key].status !== "saved" && s.groups[grp.key].status !== "final");
  if (!groups.length || s.saving) return;
  const generation = gx.generation;
  s.locked = true;
  s.saving = true;
  s.approvalId = approval.id;
  render();
  try {
    // Who still needs a state now (the Roster tab may have set some meanwhile).
    let needing = null;
    const fresh = groups.some((grp) => !s.groups[grp.key].body);
    if (fresh) {
      try {
        const roster = await api(`/api/training-activity/${encodeURIComponent(approval.activityId)}/roster`);
        needing = new Set((roster?.athletes || []).filter((a) => a.group === "needs_state").map((a) => String(a.athleteId)));
      } catch (error) {
        for (const grp of groups) if (!s.groups[grp.key].body) s.groups[grp.key] = { ...s.groups[grp.key], status: "unread", error: errorOf(error) };
      }
    }
    for (const grp of groups) {
      if (generation !== gx.generation || gx.detail !== detail) return;
      const entry = s.groups[grp.key];
      if (entry.status === "unread") continue;
      let body = entry.body;
      if (!body) {
        const ids = grp.athleteIds.filter((id) => needing?.has(id));
        entry.alreadySet = grp.athleteIds.length - ids.length;
        if (!ids.length) {
          s.groups[grp.key] = { ...entry, status: "saved", saved: 0 };
          continue;
        }
        body = { requestKey: entry.requestKey, kind: grp.kind, ...(grp.reasonKey ? { reasonKey: grp.reasonKey } : {}), athletes: ids.map((athleteId) => ({ athleteId, expectedDecisionId: null })) };
        // Kept as sent: Check result repeats exactly this request.
        s.groups[grp.key] = { ...entry, body };
        persist(detail);
      }
      try {
        const answer = await api(`/api/training-load/gpexe/teams/${encodeURIComponent(gx.teamId)}/approvals/${encodeURIComponent(approval.id)}/states`, { method: "POST", body: JSON.stringify(body) });
        s.groups[grp.key] = { ...s.groups[grp.key], status: "saved", saved: (answer?.decisions || []).length, error: null };
      } catch (error) {
        const info = errorOf(error);
        if (answeredRefusal(info)) {
          // Nothing was written; the key stays free. A final refusal sends the coach to the Roster tab.
          s.groups[grp.key] = { ...s.groups[grp.key], status: FINAL_CODES.has(info.code) || info.status === 404 ? "final" : "refused", body: null, error: info };
        } else {
          // No answer, a gateway error, 503 (outcome_unknown included): never "not saved".
          s.groups[grp.key] = { ...s.groups[grp.key], status: "unknown", error: info };
        }
      }
      persist(detail);
    }
  } finally {
    s.saving = false;
    persist(detail);
    if (generation === gx.generation && gx.detail === detail) render();
  }
}

// The summary the result panel shows.
export function statesSummary(detail) {
  const s = detail?.states;
  if (!s || !Object.keys(s.groups || {}).length) return null;
  const groups = stateGroups(detail).map((grp) => ({ ...grp, ...(s.groups[grp.key] || {}) }));
  const sum = (status) => groups.filter((x) => x.status === status).reduce((n, x) => n + (x.status === "saved" ? (x.saved ?? x.athleteIds.length) : x.athleteIds.length), 0);
  return {
    saving: !!s.saving,
    saved: sum("saved"),
    alreadySet: groups.reduce((n, x) => n + (x.alreadySet || 0), 0),
    refused: groups.filter((x) => x.status === "refused"),
    unknown: groups.filter((x) => x.status === "unknown" || x.status === "unread"),
    final: groups.filter((x) => x.status === "final"),
    pending: groups.filter((x) => x.status === "pending"),
  };
}

// "Save them again" after a refusal: the refused groups are prepared again (same key: a refused request wrote nothing).
export function retryRefusedStates(detail) {
  const s = statesOf(detail);
  for (const [k, v] of Object.entries(s.groups)) if (v.status === "refused" || v.status === "unread") s.groups[k] = { requestKey: v.requestKey, status: "pending", body: null };
  persist(detail);
}

// Forget a candidate's states once they are settled or the session is gone.
export function forgetStates(teamId, candidateId) {
  try {
    globalThis.sessionStorage?.removeItem(storeKey(teamId, candidateId));
  } catch {
    // Nothing to forget.
  }
}
