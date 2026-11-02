// Training Load -> Data configuration -> Mappings: the reads, the clicks and
// the writes (phase 8, J16). One write at a time; a write in flight, a result
// not confirmed or an open flow or panel with choices is asked about before
// leaving. A write whose answer is lost is shown as "Result not confirmed" and
// checked by sending the very same request (the same request key and body)
// again: the server replays a saved write and never saves twice.
import { state } from "./state.js";
import {
  READ_AGAIN, TEAM_CODES, TEAM_CODE_TEXT, buildDraftBody, checkNoteText, checkSettles, chosenRevision, cleanName, cleanReason,
  emptyFlowDraft, emptyMappingsState, errorInfo, fetchActivations, fetchCandidates, fetchConnections, fetchConversions, fetchFields,
  fetchMapping, fetchMappings, fetchOrganization, fetchPreview, fetchTargets, fieldStatus, mappingsContext, mappingsState,
  levelsOf, newRequestKey, notForImport, orgFacts, outcomeUnknown, previewRefusalText, reasonError, refusalText, revisionVerified, sendWrite,
  targetStatus,
} from "./metric-mappings-data.js";

const confirmAsk = (question) => Boolean(globalThis.window?.confirm?.(question));
const toTitle = () => globalThis.document?.getElementById?.("metric-mappings-title")?.scrollIntoView?.({ block: "start" });
const focus = (selector) => globalThis.document?.querySelector?.(selector)?.focus?.();
const focusNotice = () => focus(".metric-mappings .metric-variables-notice");
// Bounds of the reads that walk pages (J16 5.1): 10 pages of activations, 10
// of conversions, one mapping read per other version when teams are checked.
const MAX_PAGES = 10;
const MAX_RESOLVE = 20;
const BATCH_MAX = 50;

export function resetMappings() {
  const generation = (state.trainingLoad.mappings?.generation || 0) + 1;
  state.trainingLoad.mappings = { ...emptyMappingsState(), generation };
}
const live = (s, generation) => mappingsState() === s && s.generation === generation;
function setNotice(s, text, kind = "") {
  s.notice = text;
  s.noticeKind = kind;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------
const NOT_AVAILABLE = "Mappings are not available in this workspace.";
export async function loadMappings(render, { more = false } = {}) {
  const s = mappingsState();
  if (!mappingsContext()) return;
  const list = s.list;
  const generation = s.generation;
  if (more) list.loadingMore = true; else list.loading = true;
  list.error = null;
  render();
  try {
    const data = await fetchMappings(more ? list.nextCursor : null);
    if (!live(s, generation)) return;
    const items = Array.isArray(data?.mappings) ? data.mappings : [];
    list.items = more ? [...list.items, ...items] : items;
    list.nextCursor = data?.nextCursor || null;
    list.loaded = true;
  } catch (error) {
    if (!live(s, generation)) return;
    list.error = errorInfo(error).code === "notFound" ? NOT_AVAILABLE : "The mappings could not be loaded.";
  } finally {
    if (live(s, generation)) { list.loading = false; list.loadingMore = false; }
  }
  render();
}
// The first page once, for the Data configuration start screen's card.
export function ensureMappingsList(render) {
  const s = mappingsState();
  if (!mappingsContext() || s.list.loaded || s.list.loading) return Promise.resolve();
  return loadMappings(render);
}

const TOO_LARGE = {
  fields: "There are too many source fields to list here. Ask a platform administrator.",
  targets: "There are too many variables to list here. Ask a platform administrator.",
};
export async function loadRefs(render, { force = false } = {}) {
  const s = mappingsState();
  if (!mappingsContext() || (!force && (s.refs.loaded || s.refs.loading))) return;
  const generation = s.generation;
  s.refs.loading = true;
  s.refs.error = null;
  render();
  const one = async (kind, read) => {
    try {
      return await read();
    } catch (error) {
      const info = errorInfo(error);
      throw Object.assign(new Error(kind), {
        sentence: info.code === "notFound" ? NOT_AVAILABLE : info.code === "result_too_large" ? TOO_LARGE[kind] || "There is too much to list here." : `The ${kind === "conversions" ? "unit conversions" : kind === "fields" ? "source fields" : "variables"} could not be loaded.`,
      });
    }
  };
  try {
    const [fields, targets] = await Promise.all([one("fields", fetchFields), one("targets", fetchTargets)]);
    const conversions = [];
    let cursor = null;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const data = await one("conversions", () => fetchConversions(cursor));
      conversions.push(...(Array.isArray(data?.conversions) ? data.conversions : []));
      cursor = data?.nextCursor || null;
      if (!cursor) break;
    }
    if (!live(s, generation)) return;
    s.refs = { fields: fields?.fields || [], targets: targets?.targets || [], conversions, loaded: true, loading: false, error: null };
  } catch (error) {
    if (!live(s, generation)) return;
    s.refs = { ...s.refs, loading: false, error: error.sentence || "The source fields could not be loaded." };
  }
  render();
}

// One read of the clubs at a time: a second caller waits for the read in
// flight instead of going on without the names.
let orgRead = null;
export async function loadOrg(render) {
  const s = mappingsState();
  if (s.org.loaded) return;
  if (s.org.loading && orgRead) { await orgRead; return; }
  const generation = s.generation;
  s.org.loading = true;
  const read = (async () => {
    try {
      const facts = orgFacts(await fetchOrganization());
      if (!live(s, generation)) return;
      s.org = { ...facts, loaded: true, loading: false, error: null };
    } catch {
      if (!live(s, generation)) return;
      s.org = { ...s.org, loading: false, error: "The clubs and teams could not be loaded." };
    }
  })();
  orgRead = read;
  try { await read; } finally { if (orgRead === read) orgRead = null; }
  render();
}
// In the platform workspace, a lone club is chosen for the administrator.
function onlyClubId(s) {
  return s.org.loaded && s.org.clubs.length === 1 ? s.org.clubs[0].id : "";
}

export async function loadConnections(clubId, render) {
  const s = mappingsState();
  if (!clubId) return;
  const current = s.connections[clubId];
  if (current?.loaded || current?.loading) return;
  const generation = s.generation;
  s.connections[clubId] = { connections: [], loaded: false, loading: true, error: null };
  try {
    const data = await fetchConnections(clubId);
    if (!live(s, generation)) return;
    s.connections[clubId] = { connections: Array.isArray(data?.connections) ? data.connections : [], loaded: true, loading: false, error: null };
  } catch (error) {
    if (!live(s, generation)) return;
    s.connections[clubId] = { connections: [], loaded: false, loading: false, error: errorInfo(error).code === "notFound" ? "This club's GPEXE teams are not available in this workspace." : "This club's GPEXE teams could not be loaded." };
  }
  render();
}

export async function loadMapping(id, render, { more = false } = {}) {
  const s = mappingsState();
  if (!mappingsContext() || !id) return;
  const generation = s.generation;
  const d = s.detail;
  if (more) d.loadingMore = true;
  else s.detail = { ...d, id, mapping: d.id === id ? d.mapping : null, loading: true, error: null };
  render();
  try {
    const data = await fetchMapping(id, more ? s.detail.nextCursor : null);
    if (!live(s, generation) || s.detail.id !== id) return;
    const mapping = data?.mapping || null;
    if (more && s.detail.mapping && mapping) mapping.versions = [...s.detail.mapping.versions, ...(mapping.versions || [])];
    s.detail.mapping = mapping;
    s.detail.nextCursor = data?.nextCursor || null;
    s.detail.error = null;
  } catch (error) {
    if (!live(s, generation) || s.detail.id !== id) return;
    const notFound = errorInfo(error).code === "notFound";
    if (notFound) s.detail.mapping = null;
    s.detail.error = notFound ? "This mapping is not available in this workspace." : "The mapping could not be loaded.";
  } finally {
    if (live(s, generation) && s.detail.id === id) { s.detail.loading = false; s.detail.loadingMore = false; }
  }
  render();
  const active = activeVersion(s.detail.mapping);
  if (active && s.teams.versionId !== active.id && live(s, generation)) await loadTeams(active.id, render);
}

// Every page of a version's activations (J16 5.1): never a partial list
// shown as complete. Returns { rows, truncated } or throws.
async function allActivations(query) {
  const rows = [];
  let cursor = null;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const data = await fetchActivations({ ...query, cursor });
    rows.push(...(Array.isArray(data?.activations) ? data.activations : []));
    cursor = data?.nextCursor || null;
    if (!cursor) return { rows, truncated: false };
  }
  return { rows, truncated: true };
}

// The clubs whose connections name the rows: the workspace's club, or in the
// platform workspace the clubs of the rows' teams.
async function nameSources(teamIds, render) {
  const s = mappingsState();
  const ctx = mappingsContext();
  await loadOrg(render);
  const clubs = ctx?.owner === "club" ? [ctx.clubId]
    : [...new Set(teamIds.map((id) => s.org.teams.find((t) => t.id === id)?.club_id).filter(Boolean))];
  await Promise.all(clubs.map((clubId) => loadConnections(clubId, render)));
}

export async function loadTeams(versionId, render) {
  const s = mappingsState();
  if (!versionId) return;
  const generation = s.generation;
  s.teams = { ...s.teams, versionId, loading: true, error: null };
  render();
  try {
    const { rows, truncated } = await allActivations({ versionId, stateFilter: s.teams.showEnded ? "all" : "open" });
    if (!live(s, generation) || s.teams.versionId !== versionId) return;
    s.teams = { ...s.teams, rows, truncated, loading: false, error: null };
    await nameSources(rows.map((r) => r.teamId), render);
  } catch {
    if (!live(s, generation) || s.teams.versionId !== versionId) return;
    s.teams = { ...s.teams, loading: false, error: "The teams of this version could not be loaded." };
  }
  render();
}

// What the screen knows of a binding: its team, its GPEXE team and its
// connection, from the connections read (null when not read).
export function bindingFacts(bindingId, s = mappingsState()) {
  for (const [clubId, entry] of Object.entries(s.connections)) {
    for (const connection of entry.connections || []) {
      const team = (connection.boundTeams || []).find((b) => b.bindingId === bindingId);
      if (team) return { ...team, clubId, hostLabel: connection.hostLabel || "", accountLabel: connection.accountLabel || "" };
    }
  }
  return null;
}
export function teamNameOf(teamId, s = mappingsState()) {
  return s.org.teams.find((t) => t.id === teamId)?.name || null;
}

export function loadMappingsSection(render) {
  const s = mappingsState();
  if (!mappingsContext()) { render(); return Promise.resolve(); }
  if (s.view === "detail" && s.detail.id && !s.write) return Promise.all([loadRefs(render), loadMapping(s.detail.id, render)]);
  if (s.view === "flow") return loadRefs(render);
  if (!s.list.loaded && !s.list.loading) return Promise.all([loadMappings(render), loadRefs(render)]);
  render();
  return loadRefs(render);
}

// ---------------------------------------------------------------------------
// Facts of a mapping on the screen
// ---------------------------------------------------------------------------
export const activeVersion = (mapping) => (mapping?.versions || []).find((v) => v.status === "active") || null;
// A mapping is changed (drafts, submit, activate, disable) only in its owner's
// workspace (J16 2).
export function inOwnerWorkspace(mapping, ctx = mappingsContext()) {
  if (!mapping || !ctx) return false;
  return (mapping.ownerScope === "system") === (ctx.owner === "system");
}
export const mayTransition = (mapping, ctx = mappingsContext()) => Boolean(ctx?.isPlatformAdmin && inOwnerWorkspace(mapping, ctx));
export function fieldOf(mapping, s = mappingsState()) {
  return s.refs.fields.find((f) => f.id === mapping?.sourceMetric?.id) || null;
}
export function targetOf(mapping, s = mappingsState()) {
  return s.refs.targets.find((t) => t.id === mapping?.metricDefinitionId) || null;
}
// Why a version waiting for review cannot be activated yet, from the reads
// (J16 5); "" when the reads show nothing missing. The server decides again.
export function activateBlocker(mapping, version, s = mappingsState()) {
  const field = fieldOf(mapping, s);
  const revision = (field?.revisions || []).find((r) => r.id === version.sourceRevisionId) || null;
  if (!revisionVerified(revision)) return "The field's meaning must be confirmed first.";
  const target = targetOf(mapping, s);
  if (!target) return "The variable is no longer active.";
  if (target.currentVersion?.id !== version.metricDefinitionVersionId) return "The variable has a newer version: make a new version.";
  return "";
}

// ---------------------------------------------------------------------------
// Leaving
// ---------------------------------------------------------------------------
function hasChoices(s) {
  if (s.flow?.dirty) return true;
  const p = s.panel;
  if (!p) return false;
  return Boolean(p.reason || Object.keys(p.chooser?.selected || {}).length);
}
export function mappingsMayBeLeft() {
  const s = state.trainingLoad.mappings;
  if (!s) return true;
  if (s.write?.busy) return confirmAsk("A change is still being saved. Leave anyway? Its result will not be shown.");
  if (s.write?.unconfirmed) return confirmAsk("The result of the last change is not known. Leave without checking? Open the mapping later to see whether it was saved.");
  if (hasChoices(s)) return confirmAsk("Discard the choices you have not saved?");
  return true;
}
export function mappingsUnloadShouldWarn() {
  if (state.activeTab !== "training-load" || state.trainingLoad.section !== "mappings") return false;
  const s = state.trainingLoad.mappings;
  return Boolean(s && (s.write?.busy || s.write?.unconfirmed || hasChoices(s)));
}
export function dropMappingsForms() {
  const s = state.trainingLoad.mappings;
  if (!s) return;
  s.flow = null;
  s.panel = null;
  s.write = null;
}
function leave() {
  if (!mappingsMayBeLeft()) return false;
  dropMappingsForms();
  return true;
}

// ---------------------------------------------------------------------------
// The guided flow (J16 4)
// ---------------------------------------------------------------------------
function existingMapping(s, fieldId, targetId) {
  return s.list.items.find((m) => m.sourceMetric?.id === fieldId && m.metricDefinitionId === targetId) || null;
}
// Another mapping of this owner already has an active version of this field
// (the cause of source_metric_target_taken; the server's rule is per owner, so
// a system mapping never takes a club's field and the other way round).
export function fieldTakenBy(s, fieldId, targetId, ownerScope = null) {
  return s.list.items.find((m) => m.sourceMetric?.id === fieldId && m.metricDefinitionId !== targetId && m.activeVersionId
    && (!ownerScope || m.ownerScope === ownerScope)) || null;
}
// The variable the refused version's field already fills, named from the
// mappings list (read once if the screen does not hold it); null when unknown.
async function takenTargetLabel(s, mapping) {
  if (!mapping?.sourceMetric?.id) return null;
  let items = s.list.loaded ? s.list.items : null;
  if (!items) {
    try { items = (await fetchMappings())?.mappings || []; } catch { return null; }
  }
  const other = items.find((m) => m.sourceMetric?.id === mapping.sourceMetric.id && m.metricDefinitionId !== mapping.metricDefinitionId
    && m.activeVersionId && m.ownerScope === mapping.ownerScope);
  return other ? cleanName(other.target?.label || other.target?.key || "") || null : null;
}
function openFlow(s, { mapping = null, fixed = false } = {}) {
  const draft = emptyFlowDraft();
  if (mapping) {
    const latest = (mapping.versions || [])[0] || null;
    if (latest) {
      draft.session = Boolean(latest.appliesToSession);
      draft.drill = Boolean(latest.appliesToDrill);
      draft.conversionNote = latest.conversionNote || "";
      const p = latest.sourceParameters || {};
      draft.lower = p.lower ?? "";
      draft.upper = p.upper ?? "";
      draft.thresholdValue = p.threshold_value ?? "";
      draft.durationSeconds = p.duration_seconds ?? "";
    }
  }
  s.flow = {
    step: fixed ? 3 : 1,
    fieldId: mapping?.sourceMetric?.id || null,
    targetId: mapping?.metricDefinitionId || null,
    mappingId: mapping?.id || null,
    fixed,
    draft,
    errors: {},
    error: "",
    dirty: false,
  };
  s.view = "flow";
}
export function flowFacts(s = mappingsState()) {
  const f = s.flow;
  if (!f) return {};
  const field = s.refs.fields.find((x) => x.id === f.fieldId) || null;
  const revision = chosenRevision(field);
  const target = s.refs.targets.find((t) => t.id === f.targetId) || null;
  const status = target && revision ? targetStatus(target, revision, s.refs.conversions) : null;
  return { field, revision, target, status };
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------
function startWrite(s, act, target, body, after = {}) {
  s.notice = "";
  s.write = { act, target, body, busy: false, unconfirmed: false, checkNote: "", error: "", after };
}
async function send(render) {
  const s = mappingsState();
  const w = s.write;
  if (!w || w.busy) return;
  const generation = s.generation;
  const check = w.unconfirmed;
  w.busy = true;
  w.error = "";
  render();
  let data;
  try {
    data = await sendWrite(w.act, w.target, w.body);
  } catch (error) {
    if (!live(s, generation) || s.write !== w) return;
    w.busy = false;
    await refused(w, errorInfo(error), { render, check });
    return;
  }
  if (!live(s, generation) || s.write !== w) return;
  await succeeded(w, data, render);
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
// J16 5.1: more teams switched off than the list showed is said, never hidden.
function endedSentence(ended, listed) {
  return listed !== null && listed !== undefined && ended > listed
    ? `${plural(ended, "team was", "teams were")} switched off; the list showed fewer.`
    : `${plural(ended, "team was", "teams were")} switched off.`;
}
async function succeeded(w, data, render) {
  const s = mappingsState();
  const readError = data?.readError ? " It could not be read back; it is read again." : "";
  s.write = null;
  if (w.act === "create") {
    // The mapping exists; its draft is the second write, with its own key.
    const mappingId = data?.mapping?.id || data?.mappingId;
    return continueWithDraft(s, mappingId, render);
  }
  s.list = { ...emptyMappingsState().list };
  if (w.act === "draft") {
    s.flow = null;
    s.view = "detail";
    s.detail = { ...emptyMappingsState().detail, id: w.target.mappingId };
    setNotice(s, `The draft is saved.${readError} Submit it for review when it is ready.`);
    await loadMapping(w.target.mappingId, render);
    focusNotice();
    return;
  }
  s.panel = null;
  if (w.act === "submit") {
    const ctx = mappingsContext();
    setNotice(s, `Submitted for review.${s.detail.mapping && mayTransition(s.detail.mapping, ctx) ? " You can activate it now." : ""}${readError}`);
  }
  if (w.act === "activate") {
    const ended = Number(data?.activationsEnded) || 0;
    const listed = w.after.listed ?? null;
    const started = Array.isArray(data?.activations) ? data.activations.length : 0;
    const v = w.after.versionNumber ?? "";
    // A replacement that keeps every team it ends is a move, said as one.
    const moved = data?.replaced && started > 0 && started === ended && !(listed !== null && ended > listed);
    setNotice(s, [
      `Version ${v} is active.`,
      moved ? `${plural(started, "team", "teams")} moved to version ${v}.` : "",
      data?.replaced && !moved ? endedSentence(ended, listed) : "",
      started && !moved ? `${plural(started, "team is", "teams are")} switched on${data?.replaced ? ` for version ${v}` : ""}.` : "",
      // UX L4 (9-B): a review already open keeps its preview until the next search.
      started ? "Imports use it from the next Find new sessions." : "",
      readError,
    ].filter(Boolean).join(" "));
  }
  if (w.act === "disable") {
    const ended = Number(data?.activationsEnded) || 0;
    const listed = w.after.listed ?? null;
    setNotice(s, [`Version ${w.after.versionNumber ?? ""} is disabled.`, ended ? endedSentence(ended, listed) : "", readError].filter(Boolean).join(" "));
  }
  if (w.act === "switchOn") setNotice(s, `Switched on. Imports use it from the next Find new sessions.${readError}`);
  if (w.act === "switchOff") setNotice(s, `Switched off.${readError}`);
  s.teams = { ...emptyMappingsState().teams, showEnded: s.teams.showEnded };
  await loadMapping(s.detail.id, render);
  focusNotice();
}

async function continueWithDraft(s, mappingId, render) {
  const { revision, target } = flowFacts(s);
  if (!mappingId || !revision || !target) {
    setNotice(s, "The mapping is saved, but its draft could not be prepared. Use New version to try again.", "warning");
    s.flow = null;
    s.view = "detail";
    s.detail = { ...emptyMappingsState().detail, id: mappingId };
    if (mappingId) await loadMapping(mappingId, render);
    return;
  }
  s.flow.mappingId = mappingId;
  const { body } = buildDraftBody({ requestKey: newRequestKey(), revision, target, conversions: s.refs.conversions, draft: s.flow.draft });
  startWrite(s, "draft", { mappingId }, body);
  await send(render);
}

async function refused(w, info, { render, check }) {
  const s = mappingsState();
  // A lost answer, or a Check result answered before the server read its
  // request record: what happened to the first write is still not known.
  if (outcomeUnknown(info) || (check && !checkSettles(w.act, info))) {
    w.unconfirmed = true;
    w.checkNote = check ? checkNoteText(info) : "";
    render();
    return;
  }
  w.unconfirmed = false;
  w.checkNote = "";
  if (w.act === "create" && info.code === "mapping_exists" && info.current?.mappingId) {
    s.write = null;
    return continueWithDraft(s, info.current.mappingId, render);
  }
  // request_key_reused needs no key change here: a refused write is never sent
  // again; the next attempt is a new write with a new key (startWrite).
  if (TEAM_CODES.has(info.code) && info.current?.bindingId && s.panel) {
    // One team of a batch is refused: it is named and unticked, and the
    // others can be sent with a new request (J16 5.1, 6).
    const facts = bindingFacts(info.current.bindingId);
    const name = cleanName(facts?.teamName || teamNameOf(facts?.teamId) || "One team");
    const chooser = s.panel.chooser;
    if (chooser) delete chooser.selected[info.current.bindingId];
    if (s.panel.kept) delete s.panel.kept[info.current.bindingId];
    s.panel.refusedTeam = { bindingId: info.current.bindingId, name, text: TEAM_CODE_TEXT[info.code] };
    s.write = null;
    render();
    return;
  }
  if (info.code === "notFound" || READ_AGAIN.has(info.code)) {
    // The item on the screen no longer fits what is saved: the form closes and
    // the item is read again.
    s.write = null;
    s.panel = null;
    setNotice(s, refusalText(w.act, info), "warning");
    if (w.act === "create" || w.act === "draft") {
      s.flow = null;
      if (w.target?.mappingId) {
        s.view = "detail";
        s.detail = { ...emptyMappingsState().detail, id: w.target.mappingId };
        await loadMapping(w.target.mappingId, render);
      } else {
        s.view = "list";
        s.list = { ...emptyMappingsState().list };
        await loadMappings(render);
      }
    } else {
      s.teams = { ...emptyMappingsState().teams };
      if (s.detail.id) await loadMapping(s.detail.id, render);
    }
    focusNotice();
    return;
  }
  if (w.act === "draft") {
    // The mapping exists without this draft (C27, R11).
    s.write = null;
    s.flow = null;
    s.view = "detail";
    s.detail = { ...emptyMappingsState().detail, id: w.target.mappingId };
    setNotice(s, `The mapping is saved, but its draft was not: ${refusalText("draft", info)} Use New version to try again.`, "warning");
    await loadMapping(w.target.mappingId, render);
    focusNotice();
    return;
  }
  w.error = refusalText(w.act, info);
  if (w.act === "activate" && info.code === "source_metric_target_taken") {
    const label = await takenTargetLabel(s, s.detail.mapping);
    if (label) w.error = `This field already fills “${label}”. Only one of them can be active at a time.`;
  }
  w.code = info.code;
  render();
  // A refusal the screen has no sentence for (J16 8, last row): the mapping is
  // read again so the next attempt starts from what is saved.
  if (unknownRefusal(w.act, info) && s.view === "detail" && s.detail.id) await loadMapping(s.detail.id, render);
}
function unknownRefusal(act, info) {
  if (!(info.status >= 400 && info.status < 500) || info.status === 401 || info.status === 403) return false;
  return refusalText(act, info) === "It was not saved: the server refused it.";
}

// ---------------------------------------------------------------------------
// The team chooser (switch on, activate with teams; J16 6)
// ---------------------------------------------------------------------------
function emptyChooser(ctx) {
  return { clubId: ctx.owner === "club" ? ctx.clubId : "", selected: {}, requirement: "", perTeam: {}, checks: {} };
}
// Every team of a club's connections, with its choosability for this version.
export function chooserTeams(s, chooser, version) {
  const entry = s.connections[chooser.clubId];
  const onFor = new Set((s.teams.versionId === version?.id ? s.teams.rows : []).filter((r) => !r.endedAt).map((r) => r.bindingId));
  return (entry?.connections || []).map((connection) => ({
    connection,
    teams: (connection.boundTeams || []).map((team) => {
      const check = chooser.checks[team.bindingId] || null;
      let reason = "";
      let note = "";
      if (team.teamActive === false) reason = "This team is archived.";
      else if (onFor.has(team.bindingId)) reason = "Already on.";
      else if (!check || check.state === "loading") reason = "Checking…";
      else if (check.state === "taken") reason = check.reason;
      else if (check.state === "failed") note = "Could not be checked; the server decides.";
      return { team, choosable: !reason, reason, note };
    }),
  }));
}
// The pre-checks of a club's teams for a version (J16 6 step 2).
async function checkTeams(s, chooser, mapping, version, render) {
  const entry = s.connections[chooser.clubId];
  // A club changed meanwhile replaces the map: the old checks land in the old one.
  const checks = chooser.checks;
  const cache = new Map();
  let resolved = 0;
  const resolve = async (mappingId) => {
    if (cache.has(mappingId)) return cache.get(mappingId);
    if (resolved >= MAX_RESOLVE) return null;
    resolved += 1;
    const promise = fetchMapping(mappingId).then((d) => d?.mapping || null).catch(() => null);
    cache.set(mappingId, promise);
    return promise;
  };
  const teams = (entry?.connections || []).flatMap((c) => c.boundTeams || []).filter((t) => t.teamActive !== false);
  await Promise.all(teams.map(async (team) => {
    checks[team.bindingId] = { state: "loading" };
    try {
      const { rows } = await allActivations({ bindingId: team.bindingId, stateFilter: "open" });
      let verdict = { state: "ok" };
      for (const row of rows) {
        if (row.versionId === version.id) continue;
        const other = await resolve(row.mappingId);
        const otherVersion = (other?.versions || []).find((v) => v.id === row.versionId);
        if (!otherVersion) { verdict = { state: "failed" }; continue; }
        if (other.sourceMetric?.id === mapping.sourceMetric?.id && otherVersion.parameterFingerprint === version.parameterFingerprint) {
          verdict = { state: "taken", reason: "Already gets this field." };
          break;
        }
        if (other.metricDefinitionId === mapping.metricDefinitionId
          && ((otherVersion.appliesToSession && version.appliesToSession) || (otherVersion.appliesToDrill && version.appliesToDrill))) {
          verdict = { state: "taken", reason: "Already has this variable at this level." };
          break;
        }
      }
      checks[team.bindingId] = verdict;
    } catch {
      checks[team.bindingId] = { state: "failed" };
    }
  }));
  render();
}
async function chooseClub(s, chooser, clubId, mapping, version, render) {
  chooser.clubId = clubId;
  chooser.selected = {};
  chooser.checks = {};
  if (!clubId) { render(); return; }
  await loadConnections(clubId, render);
  if (s.panel?.chooser === chooser) await checkTeams(s, chooser, mapping, version, render);
}
// The listed teams of a chooser, as the write sends them.
export function chosenBindings(chooser) {
  return Object.keys(chooser.selected).map((bindingId) => ({ bindingId, requirement: chooser.perTeam[bindingId] || chooser.requirement }));
}

// ---------------------------------------------------------------------------
// Replace and disable: the teams switched off (J16 5.1)
// ---------------------------------------------------------------------------
async function loadOffList(s, panel, versionId, render) {
  panel.loading = true;
  panel.error = "";
  render();
  try {
    const { rows, truncated } = await allActivations({ versionId, stateFilter: "open" });
    if (s.panel !== panel) return;
    panel.rows = rows;
    panel.truncated = truncated;
    await nameSources(rows.map((r) => r.teamId), render);
    if (s.panel !== panel) return;
    if (panel.kind === "replace") {
      // Kept: an active link, a team the organization read lists, a link
      // that was read; at most 50; each with its own requirement (R19).
      panel.kept = {};
      for (const row of rows) {
        if (Object.keys(panel.kept).length >= BATCH_MAX) break;
        if (keepable(s, row)) panel.kept[row.bindingId] = row.requirement;
      }
    }
  } catch {
    if (s.panel !== panel) return;
    panel.error = "The teams this version switches off could not be loaded, so it cannot be changed now. Try again.";
  } finally {
    if (s.panel === panel) panel.loading = false;
  }
  render();
}
export function keepable(s, row) {
  return row.bindingState === "active" && Boolean(teamNameOf(row.teamId, s)) && Boolean(bindingFacts(row.bindingId, s));
}

// ---------------------------------------------------------------------------
// The preview (J16 7)
// ---------------------------------------------------------------------------
async function loadCandidates(s, panel, render) {
  panel.candidates = [];
  panel.candidatesLoading = true;
  panel.candidatesError = "";
  panel.candidateId = "";
  panel.result = null;
  render();
  const teamId = panel.teamId;
  const current = () => s.panel === panel && panel.teamId === teamId;
  try {
    const data = await fetchCandidates(teamId);
    if (!current()) return;
    panel.candidates = Array.isArray(data?.candidates) ? data.candidates : [];
  } catch (error) {
    if (!current()) return;
    panel.candidatesError = errorInfo(error).code === "notFound" ? "This team's saved sessions are not available in this workspace." : "The saved sessions could not be loaded.";
  } finally {
    if (current()) panel.candidatesLoading = false;
  }
  render();
}
async function runPreview(s, panel, render) {
  const mapping = s.detail.mapping;
  const candidateId = panel.candidateId;
  if (!mapping || !candidateId) return;
  panel.loading = true;
  panel.result = null;
  panel.error = "";
  panel.recheck = null;
  render();
  try {
    const data = await fetchPreview(mapping.id, panel.versionId, candidateId);
    if (s.panel !== panel || panel.candidateId !== candidateId) return;
    // The session read again through the list route before the numbers are
    // shown (J16 7 step 3): never the single-session route.
    let recheck;
    try {
      const list = await fetchCandidates(panel.teamId, { includeSuperseded: true });
      const found = (list?.candidates || []).find((c) => c.id === candidateId) || null;
      recheck = { state: "ok", candidate: found, marked: notForImport(found) };
    } catch {
      const before = panel.candidates.find((c) => c.id === candidateId) || null;
      recheck = { state: "failed", candidate: before, marked: notForImport(before) };
    }
    if (s.panel !== panel || panel.candidateId !== candidateId) return;
    panel.recheck = recheck;
    panel.result = data?.preview || null;
  } catch (error) {
    if (s.panel !== panel || panel.candidateId !== candidateId) return;
    const info = errorInfo(error);
    panel.error = previewRefusalText(info);
    panel.errorCode = info.code;
  } finally {
    if (s.panel === panel) panel.loading = false;
  }
  render();
}

// ---------------------------------------------------------------------------
// Clicks (every one named metric-mappings-*)
// ---------------------------------------------------------------------------
function versionOf(s, id) {
  return (s.detail.mapping?.versions || []).find((v) => v.id === id) || null;
}
export async function handleMappingsAction(action, { render }) {
  const type = action.dataset.action || "";
  if (!type.startsWith("metric-mappings-")) return false;
  const s = mappingsState();
  const ctx = mappingsContext();
  if (!ctx) return true;
  const d = action.dataset;
  // A write the server refused with a stated reason is settled: its sentence
  // stays until the next act, which may send again (a new key; nothing was
  // saved). Only a write in flight or not confirmed holds the screen.
  if (s.write && !s.write.busy && !s.write.unconfirmed && type !== "metric-mappings-close-unchecked") s.write = null;

  // ---- reads and navigation
  if (type === "metric-mappings-reload") { await loadMappings(render); return true; }
  if (type === "metric-mappings-more") { await loadMappings(render, { more: true }); return true; }
  if (type === "metric-mappings-refs-reload") { await loadRefs(render, { force: true }); return true; }
  if (type === "metric-mappings-detail-reload") { if (s.detail.id) await loadMapping(s.detail.id, render); return true; }
  if (type === "metric-mappings-versions-more") { if (s.detail.id) await loadMapping(s.detail.id, render, { more: true }); return true; }
  if (type === "metric-mappings-open") {
    if (!d.mappingId || !leave()) return true;
    s.notice = "";
    s.view = "detail";
    s.detail = { ...emptyMappingsState().detail, id: d.mappingId };
    s.teams = { ...emptyMappingsState().teams };
    await Promise.all([loadRefs(render), loadMapping(d.mappingId, render)]);
    toTitle();
    return true;
  }
  if (type === "metric-mappings-back") {
    if (!leave()) return true;
    s.notice = "";
    s.view = "list";
    s.detail = { ...emptyMappingsState().detail };
    if (!s.list.loaded) await loadMappings(render); else render();
    toTitle();
    return true;
  }

  // ---- the guided flow
  if (type === "metric-mappings-new") {
    if (s.write || !leave()) return true;
    s.notice = "";
    openFlow(s);
    render();
    await Promise.all([loadRefs(render), s.list.loaded ? null : loadMappings(render)]);
    toTitle();
    return true;
  }
  if (type === "metric-mappings-new-version") {
    const mapping = s.detail.mapping;
    if (s.write || s.detail.loading || !mapping || !inOwnerWorkspace(mapping, ctx) || !leave()) return true;
    s.notice = "";
    openFlow(s, { mapping, fixed: true });
    render();
    await loadRefs(render);
    toTitle();
    return true;
  }
  if (type === "metric-mappings-flow-field") {
    const f = s.flow;
    if (!f || f.fixed || s.write) return true;
    const field = s.refs.fields.find((x) => x.id === d.fieldId);
    if (!fieldStatus(field).choosable) return true;
    if (f.fieldId !== field.id) { f.targetId = null; f.mappingId = null; f.draft = emptyFlowDraft(); }
    f.fieldId = field.id;
    f.step = 2;
    f.dirty = true;
    f.errors = {};
    render();
    focus("#metric-mappings-title");
    return true;
  }
  if (type === "metric-mappings-flow-target") {
    const f = s.flow;
    if (!f || f.fixed || s.write) return true;
    const { revision } = flowFacts(s);
    const target = s.refs.targets.find((t) => t.id === d.targetId);
    if (!revision || !target || !targetStatus(target, revision, s.refs.conversions).choosable) return true;
    if (f.targetId !== target.id) {
      // The levels both the field and the variable allow start ticked; the
      // review card names them and either can be unticked.
      const levels = levelsOf(revision, target);
      f.draft = { ...emptyFlowDraft(), session: levels.session, drill: levels.drill };
    }
    f.targetId = target.id;
    f.mappingId = existingMapping(s, f.fieldId, target.id)?.id || null;
    f.step = 3;
    f.dirty = true;
    f.errors = {};
    render();
    focus("#metric-mappings-title");
    return true;
  }
  if (type === "metric-mappings-flow-step") {
    const f = s.flow;
    if (!f || s.write) return true;
    const step = Number(d.step);
    if (step >= (f.fixed ? 3 : 1) && step < f.step) { f.step = step; f.error = ""; render(); }
    return true;
  }
  if (type === "metric-mappings-flow-review") {
    const f = s.flow;
    if (!f || s.write) return true;
    const { revision, target, status } = flowFacts(s);
    if (!revision || !target || !status?.choosable) return true;
    const { errors } = buildDraftBody({ requestKey: "x", revision, target, conversions: s.refs.conversions, draft: f.draft });
    f.errors = errors;
    f.error = Object.keys(errors).length ? "Check the marked fields." : "";
    if (!f.error) f.step = 4;
    render();
    if (f.error) focus('.metric-mappings-flow [aria-invalid="true"]');
    return true;
  }
  if (type === "metric-mappings-flow-cancel") {
    if (s.write?.busy) return true;
    if (s.write?.unconfirmed) return true;
    if (s.flow?.dirty && !confirmAsk("Discard this new mapping?")) return true;
    const mappingId = s.flow?.fixed ? s.flow.mappingId : null;
    s.flow = null;
    s.write = null;
    s.view = mappingId ? "detail" : "list";
    render();
    toTitle();
    return true;
  }
  if (type === "metric-mappings-flow-save") {
    const f = s.flow;
    if (!f || s.write || f.step !== 4) return true;
    const { revision, target, status } = flowFacts(s);
    if (!revision || !target || !status?.choosable) return true;
    if (f.mappingId) {
      const { body } = buildDraftBody({ requestKey: newRequestKey(), revision, target, conversions: s.refs.conversions, draft: f.draft });
      if (!body) return true;
      startWrite(s, "draft", { mappingId: f.mappingId }, body);
    } else {
      startWrite(s, "create", {}, { requestKey: newRequestKey(), sourceMetricId: f.fieldId, metricDefinitionId: f.targetId });
    }
    await send(render);
    return true;
  }

  // ---- the write in progress
  if (type === "metric-mappings-check-result") { if (s.write?.unconfirmed) await send(render); return true; }
  if (type === "metric-mappings-close-unchecked") {
    const w = s.write;
    if (!w || w.busy) return true;
    if (!confirmAsk("Close without checking? Whether it was saved stays unknown until the mapping is read again.")) return true;
    s.write = null;
    s.panel = null;
    s.flow = null;
    setNotice(s, "The result was not checked. The mapping below is as it is saved now.", "warning");
    s.list = { ...emptyMappingsState().list };
    s.teams = { ...emptyMappingsState().teams };
    const mappingId = w.target?.mappingId || s.detail.id;
    if (mappingId) {
      s.view = "detail";
      s.detail = { ...emptyMappingsState().detail, id: mappingId };
      await loadMapping(mappingId, render);
    } else {
      s.view = "list";
      await loadMappings(render);
    }
    focusNotice();
    return true;
  }

  // ---- the detail's acts
  const mapping = s.detail.mapping;
  const version = d.versionId ? versionOf(s, d.versionId) : null;
  // An act never starts from a mapping that is being read again after a change,
  // and an old outcome's sentence never stands above a new act.
  if (/-(open|submit)$/.test(type)) {
    if (s.detail.loading) return true;
    if (!s.write && !s.panel) s.notice = "";
  }
  if (type === "metric-mappings-submit") {
    if (s.write || !mapping || !version || version.status !== "draft" || !inOwnerWorkspace(mapping, ctx)) return true;
    const name = cleanName(mapping.target?.label || "");
    if (!confirmAsk(`Submit version ${version.versionNumber} of "${name}" from "${cleanName(mapping.sourceMetric?.label || "")}" for review?`)) return true;
    startWrite(s, "submit", { mappingId: mapping.id, versionId: version.id }, { requestKey: newRequestKey() });
    await send(render);
    return true;
  }
  if (type === "metric-mappings-panel-close") {
    if (s.write?.busy || s.write?.unconfirmed) return true;
    if (hasChoices(s) && !confirmAsk("Discard the choices you have not saved?")) return true;
    s.panel = null;
    s.write = null;
    render();
    return true;
  }
  if (type === "metric-mappings-activate-open" || type === "metric-mappings-replace-open") {
    if (s.write || s.panel || !mapping || !version || version.status !== "needs_review" || !mayTransition(mapping, ctx)) return true;
    if (activateBlocker(mapping, version)) return true;
    const active = activeVersion(mapping);
    if (active) {
      s.panel = { kind: "replace", versionId: version.id, activeVersionId: active.id, rows: [], kept: {}, keep: true, reason: "", errors: {}, loading: true };
      render();
      await loadOffList(s, s.panel, active.id, render);
    } else {
      s.panel = { kind: "activate", versionId: version.id, withTeams: false, chooser: emptyChooser(ctx), reason: "", errors: {} };
      render();
    }
    return true;
  }
  if (type === "metric-mappings-disable-open") {
    if (s.write || s.panel || !mapping || !version || version.status === "disabled" || !mayTransition(mapping, ctx)) return true;
    s.panel = { kind: "disable", versionId: version.id, status: version.status, rows: [], reason: "", errors: {}, loading: version.status === "active" };
    render();
    if (version.status === "active") await loadOffList(s, s.panel, version.id, render);
    return true;
  }
  if (type === "metric-mappings-switch-on-open") {
    if (s.write || s.panel || !mapping || !version || version.status !== "active") return true;
    s.panel = { kind: "switchOn", versionId: version.id, chooser: emptyChooser(ctx), reason: "", errors: {}, review: false };
    render();
    await loadOrg(render);
    const chooser = s.panel?.chooser;
    if (chooser && !chooser.clubId) chooser.clubId = onlyClubId(s);
    if (chooser?.clubId) await chooseClub(s, chooser, chooser.clubId, mapping, version, render);
    else render();
    return true;
  }
  if (type === "metric-mappings-switch-off-open") {
    if (s.write || s.panel || !mapping) return true;
    const row = s.teams.rows.find((r) => r.id === d.activationId && !r.endedAt);
    if (!row) return true;
    s.panel = { kind: "switchOff", activationId: row.id, bindingId: row.bindingId, teamId: row.teamId, versionId: row.versionId, reason: "", errors: {} };
    render();
    focus(".metric-mappings-panel textarea");
    return true;
  }
  if (type === "metric-mappings-preview-open") {
    if (s.write || s.panel || !mapping || !version || !["draft", "needs_review", "active"].includes(version.status)) return true;
    s.panel = { kind: "preview", versionId: version.id, clubId: ctx.owner === "club" ? ctx.clubId : "", teamId: "", candidates: [], candidateId: "", result: null };
    render();
    await loadOrg(render);
    if (s.panel?.kind === "preview" && !s.panel.clubId) s.panel.clubId = onlyClubId(s);
    if (s.panel?.clubId) await loadConnections(s.panel.clubId, render);
    // The club may have been chosen here with its teams already read: paint it.
    render();
    return true;
  }
  if (type === "metric-mappings-org-reload") {
    if (s.org.loading) return true;
    s.org = { ...s.org, error: null };
    render();
    await loadOrg(render);
    return true;
  }
  if (type === "metric-mappings-teams-ended") {
    s.teams.showEnded = !s.teams.showEnded;
    const active = activeVersion(mapping);
    if (active) await loadTeams(active.id, render);
    return true;
  }
  if (type === "metric-mappings-every-team") {
    const p = s.panel;
    const chooser = p?.chooser;
    if (!chooser || s.write) return true;
    const v = versionOf(s, p.versionId);
    const group = chooserTeams(s, chooser, v).find((g) => g.connection.id === d.connectionId);
    if (!group) return true;
    let count = Object.keys(chooser.selected).length;
    for (const { team, choosable } of group.teams) {
      if (!choosable || chooser.selected[team.bindingId]) continue;
      if (count >= BATCH_MAX) { p.capNote = `Only the first ${BATCH_MAX} teams are checked: one change takes at most ${BATCH_MAX}.`; break; }
      chooser.selected[team.bindingId] = true;
      count += 1;
    }
    render();
    return true;
  }
  if (type === "metric-mappings-review") {
    const p = s.panel;
    if (!p || s.write) return true;
    p.errors = {};
    if (p.chooser && (p.kind === "switchOn" || p.withTeams)) {
      const chosen = chosenBindings(p.chooser);
      if (!chosen.length) p.errors.teams = "Choose at least one team.";
      if (chosen.some((b) => !b.requirement)) p.errors.requirement = "Choose Required or Optional.";
    }
    const reasonNeeded = p.kind !== "activate" || p.withTeams;
    if (reasonNeeded) { const e = reasonError(p.reason); if (e) p.errors.reason = e; }
    if (Object.keys(p.errors).length) { render(); focus('.metric-mappings-panel [aria-invalid="true"]'); return true; }
    if (p.kind === "switchOff") {
      // A short single act: one confirmation naming the team, its link and
      // the version (J16 6, 8).
      const facts = bindingFacts(p.bindingId);
      const team = cleanName(facts?.teamName || teamNameOf(p.teamId) || "this team");
      const v = versionOf(s, p.versionId);
      const link = facts?.sourceTeamId ? ` (linked to GPEXE team ${cleanName(facts.sourceTeamId)})` : "";
      if (!confirmAsk(`Switch off version ${v?.versionNumber ?? ""} of "${cleanName(mapping?.target?.label || "")}" for "${team}"${link}?`)) return true;
      p.review = true;
      return confirmPanel(s, mapping, render);
    }
    p.review = true;
    render();
    focus(".metric-mappings-review-card");
    return true;
  }
  if (type === "metric-mappings-review-back") {
    if (s.panel && !s.write) { s.panel.review = false; render(); }
    return true;
  }
  if (type === "metric-mappings-confirm") {
    return confirmPanel(s, mapping, render);
  }
  if (type === "metric-mappings-preview-run") {
    const p = s.panel;
    if (p?.kind !== "preview" || !p.candidateId || p.loading) return true;
    await runPreview(s, p, render);
    return true;
  }
  return true;
}

// The identity of an R8 list: each open row and its team link and requirement.
const rowsKey = (rows) => rows.map((r) => `${r.id}|${r.bindingId}|${r.requirement}`).sort().join(",");
// The R8 list read again at the primary button. While it is read the panel is
// confirming: a second click starts nothing, so one click is one write.
async function listStillSame(s, p, versionId, changedText, render) {
  p.confirming = true;
  render();
  let rows;
  try {
    ({ rows } = await allActivations({ versionId, stateFilter: "open" }));
  } catch {
    p.confirming = false;
    if (s.panel !== p) return false;
    p.error = "The teams this version switches off could not be read again. Try again.";
    render();
    return false;
  }
  p.confirming = false;
  // Closed or taken back to the form meanwhile: nothing is sent.
  if (s.panel !== p || !p.review) { render(); return false; }
  if (rowsKey(rows) !== rowsKey(p.rows)) {
    p.review = false;
    p.changed = changedText;
    await loadOffList(s, p, versionId, render);
    return false;
  }
  return true;
}
async function confirmPanel(s, mapping, render) {
  const p = s.panel;
  if (!p || s.write || !mapping) return true;
  const version = versionOf(s, p.versionId);
  if (!version) return true;
  const reason = cleanReason(p.reason);
  if (p.kind === "switchOn") {
    if (!p.review) return true;
    const bindings = chosenBindings(p.chooser);
    if (!bindings.length || bindings.some((b) => !b.requirement)) return true;
    startWrite(s, "switchOn", {}, { requestKey: newRequestKey(), mappingId: mapping.id, versionId: version.id, bindings, reason });
  } else if (p.kind === "activate") {
    const teams = p.withTeams ? chosenBindings(p.chooser) : [];
    if (p.withTeams && !p.review) return true;
    startWrite(s, "activate", { mappingId: mapping.id, versionId: version.id }, {
      requestKey: newRequestKey(), expectedActiveVersionId: null,
      ...(teams.length ? { activations: teams, activationReason: reason } : {}),
    }, { versionNumber: version.versionNumber });
  } else if (p.kind === "replace") {
    if (!p.review || p.loading || p.error || p.confirming) return true;
    // The list is read again when the button is pressed (J16 5.1) and must
    // be the same rows, not only as many.
    if (!(await listStillSame(s, p, p.activeVersionId, "The teams of the active version changed meanwhile. Check the list again.", render))) return true;
    const kept = p.keep ? Object.entries(p.kept).map(([bindingId, requirement]) => ({ bindingId, requirement })) : [];
    startWrite(s, "activate", { mappingId: mapping.id, versionId: version.id }, {
      requestKey: newRequestKey(), expectedActiveVersionId: p.activeVersionId, reason,
      ...(kept.length ? { activations: kept, activationReason: reason } : {}),
    }, { versionNumber: version.versionNumber, listed: p.rows.length });
  } else if (p.kind === "disable") {
    if (!p.review || p.loading || p.error || p.confirming) return true;
    if (version.status === "active"
      && !(await listStillSame(s, p, version.id, "The teams of this version changed meanwhile. Check the list again.", render))) return true;
    startWrite(s, "disable", { mappingId: mapping.id, versionId: version.id }, { requestKey: newRequestKey(), expectedStatus: p.status, reason },
      { versionNumber: version.versionNumber, listed: p.rows.length });
  } else if (p.kind === "switchOff") {
    if (!p.review) return true;
    startWrite(s, "switchOff", { activationId: p.activationId }, { requestKey: newRequestKey(), expectedState: "open", reason });
  } else {
    return true;
  }
  await send(render);
  return true;
}

// ---------------------------------------------------------------------------
// Typing and choosing: the values live in state, so a repaint never loses them.
// ---------------------------------------------------------------------------
// Returns at once whether the element was this screen's (app.js stops there);
// a choice that reads (a club, a team) runs on without being awaited.
export function handleMappingsInput(target, { render } = {}) {
  const el = target?.closest?.("[data-mm-field]");
  if (!el) return false;
  void applyInput(el, render);
  return true;
}
async function applyInput(el, render) {
  const s = state.trainingLoad.mappings;
  if (!s || s.write?.busy || s.write?.unconfirmed) return;
  const name = el.dataset.mmField;
  const value = el.type === "checkbox" ? el.checked : el.value;
  const repaint = () => render?.();
  if (name.startsWith("flow.") && s.flow) {
    const key = name.slice(5);
    if (!(key in s.flow.draft)) return true;
    s.flow.draft[key] = value;
    s.flow.dirty = true;
    if (s.flow.errors[key] || (key === "session" || key === "drill")) { delete s.flow.errors[key]; delete s.flow.errors.levels; }
    if (el.type === "checkbox") repaint();
    return true;
  }
  const p = s.panel;
  if (!p) return true;
  if (name === "reason") { p.reason = value; if (p.errors?.reason) delete p.errors.reason; return true; }
  if (name === "keep") { p.keep = Boolean(value); repaint(); return true; }
  if (name === "withTeams") {
    p.withTeams = Boolean(value);
    repaint();
    if (p.withTeams && p.kind === "activate") {
      await loadOrg(repaint);
      if (!p.chooser.clubId) p.chooser.clubId = onlyClubId(s);
      if (p.chooser.clubId && s.detail.mapping) await chooseClub(s, p.chooser, p.chooser.clubId, s.detail.mapping, versionOf(s, p.versionId), repaint);
      else repaint();
    }
    return true;
  }
  if (name === "club" && p.chooser) {
    if (!s.detail.mapping) return true;
    await chooseClub(s, p.chooser, value, s.detail.mapping, versionOf(s, p.versionId), repaint);
    return true;
  }
  if (name === "team" && p.chooser) {
    const bindingId = el.dataset.bindingId;
    if (value) p.chooser.selected[bindingId] = true; else delete p.chooser.selected[bindingId];
    delete p.errors?.teams;
    p.refusedTeam = null;
    repaint();
    return true;
  }
  if (name === "requirement" && p.chooser) {
    p.chooser.requirement = value;
    p.chooser.perTeam = {};
    delete p.errors?.requirement;
    repaint();
    return true;
  }
  if (name === "teamRequirement" && p.chooser) {
    p.chooser.perTeam[el.dataset.bindingId] = value;
    return true;
  }
  if (name === "keptRequirement" && p.kept) {
    if (p.kept[el.dataset.bindingId]) p.kept[el.dataset.bindingId] = value;
    return true;
  }
  if (p.kind === "preview") {
    if (name === "previewClub") {
      p.clubId = value; p.teamId = ""; p.candidates = []; p.candidateId = ""; p.result = null;
      repaint();
      if (value) await loadConnections(value, repaint);
      return true;
    }
    if (name === "previewTeam") {
      p.teamId = value;
      if (value) await loadCandidates(s, p, repaint); else repaint();
      return true;
    }
    if (name === "previewCandidate") {
      p.candidateId = value; p.result = null; p.error = ""; p.recheck = null;
      repaint();
      return true;
    }
  }
  return true;
}
