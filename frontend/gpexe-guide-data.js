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
let varsSeq = 0;
const WRITE_BOUND_MS = 45_000;

export const emptyGuideState = () => ({
  teamId: null,
  conn: { status: "idle", connected: false, reconnect: false, bound: false, bindingId: null, hostLabel: "", clubId: null },
  vars: { status: "idle", items: [], total: 0, onCount: 0, onItems: [] },
  // U6b (S4): sample values from the newest saved session: { status, candidateId, startedAt, byMapping }.
  samples: { status: "idle", candidateId: null, startedAt: null, byMapping: {} },
  // Variables the server clearly refused in this session (memory only): never offered again, listed instead.
  skipped: [],
  // U6b: the step the person opened (null = the first step that is not done).
  step: null,
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
const info = (error) => ({ status: error?.status ?? 0, code: error?.data?.error || error?.message || "error", message: error?.data?.message || "", hasCode: Boolean(error?.data?.error) });
// A refusal the server will repeat, as opposed to a busy moment (never remembered as refused).
const TRANSIENT_CODES = new Set(["try_again", "database_busy", "rate_limited"]);

// Only a clear refusal of the server means "nothing was changed".
export function isClearRefusal(i) {
  // Only an answer with the server's own error code counts: a gateway's 4xx without one is not a statement about this write.
  return i.status >= 400 && i.status < 500 && i.hasCode && i.code !== "outcome_unknown";
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
      connected: bound ? bound.state === "verified" : list.some((c) => c.state === "verified"),
      reconnect: bound ? bound.state !== "verified" : list.some((c) => c.state === "needs_reconnect") && !list.some((c) => c.state === "verified"),
      bound: Boolean(bound && bound.state === "verified"), bindingId: bound ? String(bound.bindingId) : null, hostLabel: bound?.hostLabel || "",
    };
  } catch (error) {
    if (stale()) return;
    gx.guide = { ...gx.guide, conn: { ...emptyGuideState().conn, status: info(error).status === 404 ? "unavailable" : "error" } };
    render();
    return;
  }
  if (stale()) return;
  // A refusal belongs to one binding: another binding starts with a clean list.
  const skipped = conn.bindingId && conn.bindingId === gx.guide.conn.bindingId ? gx.guide.skipped : [];
  gx.guide = { ...gx.guide, conn, skipped };
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
  const seq = ++varsSeq;
  gx.guide = { ...gx.guide, vars: { ...gx.guide.vars, status: "loading" } };
  render();
  try {
    const [maps, acts] = await Promise.all([
      pages(() => api(`${METRICS}/mappings`), (c) => api(withCursor(`${METRICS}/mappings`, c)), "mappings"),
      pages(() => api(`${METRICS}/activations?bindingId=${encodeURIComponent(bindingId)}&state=open`), (c) => api(withCursor(`${METRICS}/activations?bindingId=${encodeURIComponent(bindingId)}&state=open`, c)), "activations"),
    ]);
    if (generation !== gx.generation || String(gx.teamId) !== teamId || seq !== varsSeq) return;
    // An incomplete read could hide an activation that is already on: never offer from it.
    if (!maps.complete || !acts.complete) throw Object.assign(new Error("incomplete"), { status: 0 });
    // On = any open activation of the same mapping (any version), so a replaced or copied variable is not offered again.
    const onVersions = new Set(acts.items.map((a) => String(a.versionId)));
    const onMappings = new Set(acts.items.map((a) => String(a.mappingId)));
    const refused = new Set((gx.guide.skipped || []).map((x) => x.mappingId));
    const candidates = maps.items
      .filter((m) => m.ownerScope === "system" && m.sourceMetric?.apiFamily === GUIDE_API_FAMILY && m.activeVersionId && m.targetHiddenInClub !== true)
      .sort((a, b) => (a.id < b.id ? -1 : 1));
    const isOn = (m) => onVersions.has(String(m.activeVersionId)) || onMappings.has(String(m.id));
    const items = candidates.filter((m) => !isOn(m) && !refused.has(String(m.id)))
      .map((m) => ({ mappingId: String(m.id), versionId: String(m.activeVersionId), label: variableLabel(m) }));
    // U6b (S4): the variables already on, to show two athletes' values from the stored preview.
    const onItems = candidates.filter(isOn).map((m) => ({ mappingId: String(m.id), label: variableLabel(m), sourceKey: String(m.sourceMetric?.key || "") }));
    gx.guide = { ...gx.guide, vars: { status: "ready", items, total: items.length, onCount: onItems.length, onItems } };
  } catch (error) {
    if (generation !== gx.generation || String(gx.teamId) !== teamId || seq !== varsSeq) return;
    gx.guide = { ...gx.guide, vars: { status: "error", items: [], total: 0, onCount: 0, onItems: [] } };
  }
  render();
  if (gx.guide.vars.status === "ready" && !gx.guide.write?.sending) void loadGuideSamples(render);
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
  if (!resume && !guide.vars.items.length) return;
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
      if (isClearRefusal(i)) {
        // A 404 can follow a committed write (the right is read again after COMMIT): then the sentence says it may have been made.
        const refused = { label: item.label, code: i.code, message: i.message, possible: i.status === 404 };
        const remember = !TRANSIENT_CODES.has(i.code);
        const skipped = !remember ? (gx.guide.skipped || []) : (gx.guide.skipped || []).some((x) => x.mappingId === item.mappingId) ? gx.guide.skipped : [...(gx.guide.skipped || []), { mappingId: item.mappingId, label: item.label, message: i.message }];
        gx.guide = { ...gx.guide, skipped, write: { sending: false, items, results, unknown: null, refused } };
      }
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

export function refusalSentence(refused, before = 0) {
  if (!refused) return "";
  const text = refused.message ? `${refused.message}` : "The server did not accept it.";
  const done = before ? `${before} ${before === 1 ? "variable before it is" : "variables before it are"} on.` : "Nothing was switched on.";
  const tail = refused.possible ? "This one may have been switched on: check the Mappings screen." : "The rest were not tried.";
  return `${refused.label}: ${text} ${done} ${tail}`;
}

export function setGuideOpen(value) {
  const gx = g();
  gx.guide = { ...gx.guide, open: value };
}

// U6b (S4): sample values beside each variable, only after a search (a saved session exists), administrators only.
// A variable already on: two athletes' values from the session's stored preview (what the import writes). A variable
// not on yet: 7e's aggregate preview of its version over the same session - a count and a range, never one athlete's
// value (OD3). One read per variable; a failed read leaves that variable without a sample, never a guess.
let samplesSeq = 0;
const SAMPLE_ATHLETES = 2;
const WRITING = new Set(["created", "supplemented", "corrected", "unchanged"]);
export function newestSampleCandidate(gx) {
  const list = Array.isArray(gx.candidates) ? gx.candidates : [];
  return list.filter((c) => c.status !== "superseded" && !c.importUndoneAt && c.sessionStartedAt)
    .sort((a, b) => (a.sessionStartedAt < b.sessionStartedAt ? 1 : -1))[0] || null;
}
export function athleteSamples(candidate, sourceKey) {
  const out = [];
  for (const a of candidate?.preview?.athletes || []) {
    const name = a.athleteId ? candidate.athletes?.[a.athleteId]?.name : "";
    if (!name) continue;
    const res = (a.results || []).find((r) => r.level !== "drill" && WRITING.has(r.outcome) && (r.values || []).some((v) => v.sourceMetricKey === sourceKey && v.value !== null && v.value !== undefined));
    if (!res) continue;
    const v = res.values.find((x) => x.sourceMetricKey === sourceKey && x.value !== null && x.value !== undefined);
    out.push({ name, value: v.value, unit: v.unit || "" });
    if (out.length === SAMPLE_ATHLETES) break;
  }
  return out;
}
export async function loadGuideSamples(render) {
  const gx = g();
  const v = gx.guide?.vars;
  if (!guideAdmin(gx) || v?.status !== "ready" || (!v.items.length && !v.onItems?.length)) return;
  const pick = newestSampleCandidate(gx);
  if (!pick) return;
  const generation = gx.generation;
  const teamId = String(gx.teamId);
  const seq = ++samplesSeq;
  const stale = () => generation !== gx.generation || String(gx.teamId) !== teamId || seq !== samplesSeq;
  gx.guide = { ...gx.guide, samples: { status: "loading", candidateId: String(pick.id), startedAt: pick.sessionStartedAt, byMapping: {} } };
  render();
  const byMapping = {};
  if (v.onItems?.length) {
    try {
      const { candidate } = await api(`/api/training-load/gpexe/teams/${encodeURIComponent(teamId)}/candidates/${encodeURIComponent(pick.id)}`);
      if (stale()) return;
      for (const item of v.onItems) {
        const values = athleteSamples(candidate, item.sourceKey);
        if (values.length) byMapping[item.mappingId] = { kind: "athletes", values };
      }
    } catch {
      if (stale()) return;
    }
  }
  for (const item of v.items) {
    try {
      const answer = await api(`${METRICS}/mappings/${encodeURIComponent(item.mappingId)}/versions/${encodeURIComponent(item.versionId)}/preview?candidateId=${encodeURIComponent(pick.id)}`);
      if (stale()) return;
      const level = answer?.preview?.levels?.session;
      if (level) byMapping[item.mappingId] = { kind: "aggregate", count: Number(level.athletesWithValue) || 0, min: level.minCanonical ?? null, max: level.maxCanonical ?? null, unit: answer.preview.targetUnit || "" };
    } catch {
      if (stale()) return;
    }
  }
  if (stale()) return;
  gx.guide = { ...gx.guide, samples: { status: "ready", candidateId: String(pick.id), startedAt: pick.sessionStartedAt, byMapping } };
  render();
}
