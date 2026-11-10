// J20-C part b: the attendance states a coach chooses in the session review, saved right after a confirmed import
// (owner's O2 = A: the same button, a second step). docs/ai/j20-session-review-contract.md section 5.2.
//
// * The choices (athlete id -> kind and reason) are kept in sessionStorage for the candidate. When the coach confirms the import,
//   each kind + reason group gets its requestKey and the athlete ids it confirms; only those are ever sent. What is stored is an
//   allowlist: ids, kinds, reason keys, request keys, statuses and an error code - never a name, a note or a server message.
// * Nothing is sent for the states until the import is confirmed (its answer, or Check the result finding it); the approval and the
//   activity come from that confirmation only.
// * Each group is one POST …/approvals/:approvalId/states. Its body is stored as "sent" BEFORE the request, so a reload, a lost answer
//   or a hung request is never shown as "not saved": it is "we can't tell yet" until the server's answer, and Check the result repeats
//   exactly the same request with the same key (the server replays a saved one).
// * A refusal means "nothing was written" only when it is certain: on a first send any answered refusal; on a resend after an unknown
//   send only the refusals the server answers after its replay check (a saved request would have been replayed instead).
// * Only athletes the roster still lists as needing a state are sent (expected decision null), so a state someone set in the Roster
//   tab meanwhile is never overwritten; they are named as kept.
import { api } from "./api.js";
import { state } from "./state.js";

const STORE_PREFIX = "optimove.gpexe.importStates.v1.";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const STATE_KINDS = Object.freeze(["participated_no_values", "did_not_participate"]);
const STATUSES = new Set(["pending", "unread", "sent", "unknown", "saved", "refused", "final"]);
// The refusals the server gives only after it looked for a saved request with this key (activityRosterCommands: the replay comes
// first): after them nothing was written for this key, whatever an earlier send did.
const AFTER_REPLAY = new Set(["import_states_window_closed", "import_undone", "bulk_conflict", "activity_superseded", "roster_not_applicable", "kind_not_available", "unknown_reason"]);
// Refusals worth a second try with a fresh read of the roster (the same key: nothing was written).
const RETRYABLE = new Set(["bulk_conflict", "decision_changed", "try_again", "roster_busy"]);
const STATES_BOUND_MS = 45_000;

const g = () => state.trainingLoad.gpexe;
let boundMs = STATES_BOUND_MS;
export function setImportStatesBoundForTests(ms) { boundMs = ms ?? STATES_BOUND_MS; }

function storeKey(teamId, candidateId) {
  return `${STORE_PREFIX}${teamId}.${candidateId}`;
}

function cleanBody(body) {
  if (!body || typeof body !== "object" || !UUID.test(String(body.requestKey || ""))) return null;
  const athletes = (Array.isArray(body.athletes) ? body.athletes : []).filter((a) => UUID.test(String(a?.athleteId || ""))).map((a) => ({ athleteId: a.athleteId, expectedDecisionId: null }));
  if (!athletes.length || !STATE_KINDS.includes(body.kind)) return null;
  return { requestKey: body.requestKey, kind: body.kind, ...(body.reasonKey ? { reasonKey: String(body.reasonKey) } : {}), athletes };
}

// The allowlist that is stored and the one that is read back: the same shape both ways.
function storable(s) {
  const choices = {};
  for (const [id, c] of Object.entries(s.choices || {})) {
    if (UUID.test(id) && c && STATE_KINDS.includes(c.kind)) choices[id] = { kind: c.kind, reasonKey: c.kind === "did_not_participate" ? String(c.reasonKey || "") || null : null };
  }
  const groups = {};
  for (const [k, v] of Object.entries(s.groups || {})) {
    if (!v || !UUID.test(String(v.requestKey || ""))) continue;
    groups[k] = {
      requestKey: v.requestKey,
      status: STATUSES.has(v.status) ? v.status : "pending",
      athleteIds: (Array.isArray(v.athleteIds) ? v.athleteIds : []).filter((id) => UUID.test(String(id))),
      body: cleanBody(v.body),
      sentOnce: v.sentOnce === true,
      code: typeof v.code === "string" && /^[a-z_]{1,60}$/.test(v.code) ? v.code : null,
      saved: Number.isInteger(v.saved) ? v.saved : null,
      alreadySet: Number.isInteger(v.alreadySet) ? v.alreadySet : 0,
    };
  }
  return { choices, groups };
}

function readStore(teamId, candidateId) {
  try {
    const raw = globalThis.sessionStorage?.getItem(storeKey(teamId, candidateId));
    return storable(raw ? JSON.parse(raw) : {});
  } catch {
    return { choices: {}, groups: {} };
  }
}

function writeStore(teamId, candidateId, s) {
  try {
    const kept = storable(s);
    const groups = Object.values(kept.groups);
    // Settled (every group saved or final): nothing is left to do with it in a later visit; the screen keeps it in memory.
    if (groups.length && groups.every((x) => x.status === "saved" || x.status === "final")) globalThis.sessionStorage?.removeItem(storeKey(teamId, candidateId));
    else globalThis.sessionStorage?.setItem(storeKey(teamId, candidateId), JSON.stringify(kept));
  } catch {
    // A browser without storage keeps the choices for this page only.
  }
}

// The detail's states, read once per open review. teamId is fixed with them.
export function statesOf(detail, gx = g()) {
  if (!detail?.id || !gx.teamId) return { choices: {}, groups: {} };
  if (!detail.states) detail.states = { ...readStore(gx.teamId, detail.id), teamId: gx.teamId };
  return detail.states;
}

function persist(detail) {
  const s = detail?.states;
  if (detail?.id && s?.teamId) writeStore(s.teamId, detail.id, s);
}

// "" (no state), "participated_no_values", or "did_not_participate:<reasonKey>".
export function choiceValue(detail, athleteId) {
  const c = statesOf(detail).choices[athleteId];
  if (!c) return "";
  return c.kind === "did_not_participate" ? `did_not_participate:${c.reasonKey || ""}` : c.kind;
}

// A choice can change until the import is confirmed; after that the confirmed groups are what is saved.
export function chooseState(detail, athleteId, value) {
  if (!detail || !UUID.test(String(athleteId || ""))) return false;
  const s = statesOf(detail);
  if (Object.keys(s.groups).length) return false;
  const v = String(value || "");
  if (!v) delete s.choices[athleteId];
  else if (v === "participated_no_values") s.choices[athleteId] = { kind: v, reasonKey: null };
  else if (v.startsWith("did_not_participate:") && v.length > "did_not_participate:".length) s.choices[athleteId] = { kind: "did_not_participate", reasonKey: v.slice("did_not_participate:".length) };
  else return false;
  persist(detail);
  return true;
}

// The groups the bulk route takes (one kind and reason), from the choices on the rows that may get a state now.
function choiceGroups(s, allowedIds) {
  const allowed = new Set((allowedIds || []).map(String));
  const by = new Map();
  for (const [athleteId, c] of Object.entries(s.choices)) {
    if (!allowed.has(athleteId)) continue;
    const key = `${c.kind}|${c.reasonKey || ""}`;
    if (!by.has(key)) by.set(key, { key, kind: c.kind, reasonKey: c.reasonKey, athleteIds: [] });
    by.get(key).athleteIds.push(athleteId);
  }
  for (const grp of by.values()) grp.athleteIds.sort();
  return [...by.values()].sort((a, b) => a.key.localeCompare(b.key));
}

export function chosenStateCount(detail, allowedIds) {
  return choiceGroups(statesOf(detail), allowedIds).reduce((n, grp) => n + grp.athleteIds.length, 0);
}

// At the confirm, before the approval is sent: one requestKey per group and the athletes it confirms, kept across a reload.
export function prepareStateKeys(detail, allowedIds) {
  const s = statesOf(detail);
  if (Object.keys(s.groups).length) return;
  for (const grp of choiceGroups(s, allowedIds)) {
    s.groups[grp.key] = { requestKey: globalThis.crypto.randomUUID(), status: "pending", athleteIds: grp.athleteIds, body: null, sentOnce: false, code: null, saved: null, alreadySet: 0 };
  }
  persist(detail);
}

function errorOf(error) {
  return { status: error?.status ?? 0, code: typeof error?.data?.error === "string" ? error.data.error : null };
}
function answeredRefusal(error) {
  return typeof error?.data?.error === "string" && error.status >= 400 && error.status < 500;
}

function kindOf(key) {
  const [kind, reason] = key.split("|");
  return { kind, reasonKey: reason || null };
}

// After a confirmed import: the states, group by group. `approval` is { id, activityId }.
export async function saveImportStates(detail, approval, render) {
  const gx = g();
  const s = statesOf(detail);
  if (!approval?.id || !approval?.activityId || s.saving) return;
  const todo = Object.entries(s.groups).filter(([, v]) => v.status !== "saved" && v.status !== "final");
  if (!todo.length) return;
  const generation = gx.generation;
  s.saving = true;
  render();
  try {
    // Groups never sent need the roster: who still needs a state now (the Roster tab may have set some meanwhile).
    let needing = null;
    if (todo.some(([, v]) => !v.body)) {
      try {
        const roster = await api(`/api/training-activity/${encodeURIComponent(approval.activityId)}/roster`);
        needing = new Set((roster?.athletes || []).filter((a) => a.group === "needs_state").map((a) => String(a.athleteId)));
      } catch {
        for (const [k, v] of todo) if (!v.body) s.groups[k] = { ...v, status: "unread", code: null };
        persist(detail);
      }
    }
    for (const [k] of todo) {
      if (generation !== gx.generation || gx.detail !== detail) return;
      let entry = s.groups[k];
      if (!entry.body) {
        if (!needing) continue;
        const ids = entry.athleteIds.filter((id) => needing.has(id));
        const alreadySet = entry.athleteIds.length - ids.length;
        if (!ids.length) {
          s.groups[k] = { ...entry, status: "saved", saved: 0, alreadySet, code: null };
          persist(detail);
          continue;
        }
        const { kind, reasonKey } = kindOf(k);
        const body = { requestKey: entry.requestKey, kind, ...(reasonKey ? { reasonKey } : {}), athletes: ids.map((athleteId) => ({ athleteId, expectedDecisionId: null })) };
        entry = s.groups[k] = { ...entry, body, alreadySet };
      }
      // Stored as sent BEFORE the request: from here on, until an answer, it is "we can't tell yet", never "not saved".
      const resend = entry.sentOnce;
      s.groups[k] = { ...entry, status: "sent", sentOnce: true, code: null };
      persist(detail);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), boundMs);
      try {
        const answer = await api(`/api/training-load/gpexe/teams/${encodeURIComponent(s.teamId)}/approvals/${encodeURIComponent(approval.id)}/states`, {
          method: "POST", body: JSON.stringify(entry.body), signal: controller.signal,
        });
        s.groups[k] = { ...s.groups[k], status: "saved", saved: (answer?.decisions || []).length, code: null };
      } catch (error) {
        const info = errorOf(error);
        const certain = answeredRefusal(error) && (!resend || AFTER_REPLAY.has(info.code));
        if (!certain) {
          // No answer, a gateway error, 503 - or a refusal of a resend the server gives before its replay check: unknown.
          s.groups[k] = { ...s.groups[k], status: "unknown", code: answeredRefusal(error) ? info.code : null };
        } else if (RETRYABLE.has(info.code)) {
          // Nothing was written; the key stays free and the next try reads the roster again.
          s.groups[k] = { ...s.groups[k], status: "refused", body: null, code: info.code };
        } else {
          s.groups[k] = { ...s.groups[k], status: "final", body: null, code: info.code || (error?.status === 404 ? "notFound" : "refused") };
        }
      } finally {
        clearTimeout(timer);
      }
      persist(detail);
    }
  } finally {
    s.saving = false;
    persist(detail);
    if (generation === gx.generation && gx.detail === detail) render();
  }
}

// The summary the screen shows.
export function statesSummary(detail) {
  const s = detail?.states;
  if (!s) return null;
  const groups = Object.entries(s.groups || {}).map(([key, v]) => ({ key, ...v, n: v.body ? v.body.athletes.length : v.athleteIds.length }));
  if (!groups.length) {
    const chosen = Object.keys(s.choices || {}).length;
    return chosen ? { notTaken: chosen, saving: false, saved: 0, alreadySet: 0, groups: [] } : null;
  }
  const by = (st) => groups.filter((x) => x.status === st);
  return {
    saving: !!s.saving,
    saved: by("saved").reduce((n, x) => n + (x.saved ?? 0), 0),
    alreadySet: groups.reduce((n, x) => n + (x.alreadySet || 0), 0),
    pending: by("pending"),
    unread: by("unread"),
    unknown: [...by("unknown"), ...by("sent")],
    refused: by("refused"),
    final: by("final"),
    groups,
  };
}

// "Save them" / "Save them again": the groups that were not sent, or were refused for certain, are prepared again (same key).
export function retryStates(detail) {
  const s = statesOf(detail);
  for (const [k, v] of Object.entries(s.groups)) if (v.status === "refused" || v.status === "unread") s.groups[k] = { ...v, status: "pending", body: null, code: null };
  persist(detail);
}
