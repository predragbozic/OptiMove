// U4 (J19): the setup guide of the Imports screen, data side - the two reads
// only an administrator needs (the club's GPEXE connections and the system
// variables not yet switched on for the team's binding) and the one write,
// "Use OptiMove variables": the existing POST /activations, one request per
// system mapping version, each with its own request key, stopping at the first
// refusal. Nothing here decides what may be switched on - the server does.
import { api } from "./api.js";
import { state } from "./state.js";

const SOURCES = "/api/training-load/sources";
const CONNECTIONS = `${SOURCES}/gpexe/connections`;
const METRICS = `${SOURCES}/metrics`;
// The importer reads rest_v1 sessions; only that family's system variables are offered (plan Q3).
export const GUIDE_API_FAMILY = "rest_v1";
export const GUIDE_REQUIREMENT = "required"; // plan Q2: the server has no default (C23)
export const GUIDE_REASON = "Switched on from the setup guide";
const PAGE_LIMIT = 10;
const WRITE_BOUND_MS = 45_000;

export const emptyGuideState = () => ({
  teamId: null,
  conn: { status: "idle", connected: false, reconnect: false, bound: false, bindingId: null, hostLabel: "", clubId: null },
  vars: { status: "idle", items: [], total: 0, onCount: 0 },
  // null = automatic (folded when all is done), true / false = the person's choice.
  open: null,
  // The review card of "Use OptiMove variables".
  confirm: false,
  // The write: { sending, index, items, results: [{ mappingId, label, outcome, requestKey, message }], unknown }.
  write: null,
});

function g() {
  return state.trainingLoad.gpexe;
}
const info = (error) => ({ status: error?.status ?? 0, code: error?.data?.error || error?.message || "error", message: error?.data?.message || "" });

// Only a clear refusal of the server means "nothing was changed".
export function isClearRefusal(i) {
  return i.status >= 400 && i.status < 500 && i.code !== "error" && i.code !== "outcome_unknown";
}

export function guideAdmin(gx = g()) {
  return gx.status?.viewer?.identityAdmin === true;
}

export function clearGuide() {
  const gx = g();
  if (gx) gx.guide = { ...emptyGuideState(), open: gx.guide?.open ?? null };
}

function teamClubId(gx) {
  const team = (state.trainingLoad.orgPickerData?.teams || []).find((t) => String(t.id) === String(gx.teamId));
  return team?.club_id ? String(team.club_id) : null;
}

// Reads the club's connections (is the account connected, is this team bound)
// and, once bound, the system variables still to switch on. Administrators only.
export async function loadGuide(render) {
  const gx = g();
  if (!gx.teamId || !guideAdmin(gx)) return;
  const generation = gx.generation;
  const teamId = String(gx.teamId);
  const guide = gx.guide;
  const clubId = teamClubId(gx);
  gx.guide = { ...guide, teamId, conn: { ...guide.conn, status: "loading" } };
  render();
  const stale = () => generation !== gx.generation || String(gx.teamId) !== teamId;
  if (!clubId) {
    gx.guide = { ...gx.guide, conn: { ...emptyGuideState().conn, status: "unavailable" } };
    render();
    return;
  }
  let conn;
  try {
    const answer = await api(`${CONNECTIONS}?clubId=${encodeURIComponent(clubId)}`);
    const list = Array.isArray(answer?.connections) ? answer.connections : [];
    let bound = null;
    for (const c of list) {
      const b = (c.boundTeams || []).find((x) => String(x.teamId) === teamId && x.state === "active");
      if (b) { bound = { bindingId: b.bindingId, hostLabel: c.hostLabel || "", state: c.state }; break; }
    }
    conn = {
      status: "ready", clubId,
      connected: list.some((c) => c.state === "verified"),
      reconnect: list.some((c) => c.state === "needs_reconnect") && !list.some((c) => c.state === "verified"),
      bound: Boolean(bound && bound.state === "verified"), bindingId: bound ? String(bound.bindingId) : null, hostLabel: bound?.hostLabel || "",
    };
  } catch (error) {
    if (stale()) return;
    gx.guide = { ...gx.guide, conn: { ...emptyGuideState().conn, status: info(error).status === 404 ? "unavailable" : "error" } };
    render();
    return;
  }
  if (stale()) return;
  gx.guide = { ...gx.guide, conn };
  render();
  if (conn.bound) await loadGuideVariables(render);
}

async function pages(first, next, key) {
  const items = [];
  let cursor = null;
  for (let i = 0; i < PAGE_LIMIT; i += 1) {
    const answer = await (cursor ? next(cursor) : first());
    items.push(...(Array.isArray(answer?.[key]) ? answer[key] : []));
    cursor = answer?.nextCursor || null;
    if (!cursor) return { items, complete: true };
  }
  return { items, complete: false };
}

const withCursor = (path, cursor) => `${path}${path.includes("?") ? "&" : "?"}cursor=${encodeURIComponent(cursor)}`;
const variableLabel = (m) => `${m.target?.label || m.target?.key || "Variable"} from ${m.sourceMetric?.label || m.sourceMetric?.key || "GPEXE"}`;

// The active system mapping versions of the importer's family that this
// workspace can use (not hidden by the club) and that are not yet on for the binding.
export async function loadGuideVariables(render) {
  const gx = g();
  const bindingId = gx.guide?.conn?.bindingId;
  if (!bindingId) return;
  const generation = gx.generation;
  const teamId = String(gx.teamId);
  gx.guide = { ...gx.guide, vars: { ...gx.guide.vars, status: "loading" } };
  render();
  try {
    const [maps, acts] = await Promise.all([
      pages(() => api(`${METRICS}/mappings`), (c) => api(withCursor(`${METRICS}/mappings`, c)), "mappings"),
      pages(() => api(`${METRICS}/activations?bindingId=${encodeURIComponent(bindingId)}&state=open`), (c) => api(withCursor(`${METRICS}/activations?bindingId=${encodeURIComponent(bindingId)}&state=open`, c)), "activations"),
    ]);
    if (generation !== gx.generation || String(gx.teamId) !== teamId) return;
    // An incomplete read could hide an activation that is already on: never offer from it.
    if (!maps.complete || !acts.complete) throw Object.assign(new Error("incomplete"), { status: 0 });
    const on = new Set(acts.items.map((a) => String(a.versionId)));
    const candidates = maps.items
      .filter((m) => m.ownerScope === "system" && m.sourceMetric?.apiFamily === GUIDE_API_FAMILY && m.activeVersionId && m.targetHiddenInClub !== true)
      .sort((a, b) => (a.id < b.id ? -1 : 1));
    const items = candidates.filter((m) => !on.has(String(m.activeVersionId)))
      .map((m) => ({ mappingId: String(m.id), versionId: String(m.activeVersionId), label: variableLabel(m) }));
    gx.guide = { ...gx.guide, vars: { status: "ready", items, total: items.length, onCount: candidates.length - items.length } };
  } catch (error) {
    if (generation !== gx.generation || String(gx.teamId) !== teamId) return;
    gx.guide = { ...gx.guide, vars: { status: "error", items: [], total: 0, onCount: 0 } };
  }
  render();
}

export function openVariablesConfirm() {
  const gx = g();
  const v = gx.guide.vars;
  if (gx.guide.write?.sending || gx.guide.write?.unknown || v.status !== "ready" || !v.items.length || !gx.guide.conn.bindingId) return false;
  gx.guide = { ...gx.guide, confirm: true, write: null };
  return true;
}
export function cancelVariablesConfirm() {
  const gx = g();
  if (gx.guide.write?.sending) return false;
  gx.guide = { ...gx.guide, confirm: false };
  return true;
}

const body = (item, bindingId, requestKey) => ({
  requestKey, mappingId: item.mappingId, versionId: item.versionId,
  bindings: [{ bindingId, requirement: GUIDE_REQUIREMENT }], reason: GUIDE_REASON,
});

// One request per variable, in order, each with its own key; stops at the first
// refusal (its sentence is kept) and at the first answer that did not arrive
// (the same key is sent again only by "Check result", never by itself).
export async function sendVariables(render, { resume = false } = {}) {
  const gx = g();
  const guide = gx.guide;
  if (guide.write?.sending) return;
  const bindingId = guide.conn.bindingId;
  const teamId = String(gx.teamId);
  const generation = gx.generation;
  if (!bindingId) return;
  const items = resume && guide.write?.items ? guide.write.items : guide.vars.items.slice();
  const results = resume && guide.write?.results ? guide.write.results.filter((r) => r.outcome === "on") : [];
  let index = results.length;
  gx.guide = { ...guide, confirm: true, write: { sending: true, items, results, unknown: null, refused: null, key: resume ? guide.write?.unknown?.requestKey ?? null : null } };
  render();
  const stale = () => generation !== gx.generation || String(gx.teamId) !== teamId;
  let carriedKey = resume ? guide.write?.unknown?.requestKey ?? null : null;
  while (index < items.length) {
    const item = items[index];
    const requestKey = carriedKey || globalThis.crypto.randomUUID();
    carriedKey = null;
    try {
      const signal = typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function" ? AbortSignal.timeout(WRITE_BOUND_MS) : undefined;
      await api(`${METRICS}/activations`, { method: "POST", body: JSON.stringify(body(item, bindingId, requestKey)), ...(signal ? { signal } : {}) });
      results.push({ mappingId: item.mappingId, label: item.label, outcome: "on" });
      index += 1;
      if (stale()) return;
      gx.guide = { ...gx.guide, write: { ...gx.guide.write, results: results.slice() } };
      render();
    } catch (error) {
      if (stale()) return;
      const i = info(error);
      if (isClearRefusal(i)) gx.guide = { ...gx.guide, write: { sending: false, items, results, unknown: null, refused: { label: item.label, code: i.code, message: i.message } } };
      else gx.guide = { ...gx.guide, write: { sending: false, items, results, refused: null, unknown: { label: item.label, requestKey } } };
      await loadGuideVariables(render);
      gx.guide = { ...gx.guide, write: gx.guide.write };
      render();
      return;
    }
  }
  if (stale()) return;
  gx.guide = { ...gx.guide, confirm: false, write: { sending: false, items, results, refused: null, unknown: null, done: true } };
  await loadGuideVariables(render);
  render();
}

export function refusalSentence(refused) {
  if (!refused) return "";
  const text = refused.message ? `${refused.message}` : "The server did not accept it.";
  return `${refused.label}: ${text} Nothing was changed for this one; the variables before it are on.`;
}

export function setGuideOpen(value) {
  const gx = g();
  gx.guide = { ...gx.guide, open: value };
}
