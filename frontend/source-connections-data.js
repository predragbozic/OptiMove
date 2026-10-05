// Settings -> Source connections (F3c3): the data side.
//
// One administrative screen for the club's source credential connection
// (today GPEXE on the approved `server3` profile): create it, Connect (a
// one-time username / password exchange for a token the server stores
// encrypted and never returns), Test, Approve and bind (only the server-side
// approved pair OptiMove team <-> GPEXE team), Reconnect and Unbind. Every
// call goes to the F3c2d-F3c2f routes under
// /api/training-load/sources/gpexe/connections; the server decides every
// right again on every request - a platform admin (platform or club
// workspace) or the owning club's admin in that club's workspace, everything
// and everyone else the same 404 - so nothing here is the protection.
//
// Credentials: the username and the password are read from the form on
// submit, sent in that one request body and retained nowhere by this code -
// not in this state, a dataset, a URL, storage, a log or a notice. A lost
// answer to a Connect / Reconnect is never settled by a read and never by
// sending the pair a second time: its marker stays until the administrator
// acknowledges the uncertainty. A double click sends one request: every
// write sets its busy flag before its first await.
import { api } from "./api.js";
import { state } from "./state.js";

export const SOURCE_SYSTEM = "gpexe";
export const SOURCE_NAME = "GPEXE";
const BASE = `/api/training-load/sources/${SOURCE_SYSTEM}/connections`;
// The one host profile a connection may be created on today (owner decision
// 2026-09-29: server3 / rest_v1, a token from a one-time exchange). The
// server refuses every other key; this list only names what the form offers.
export const HOST_PROFILES = Object.freeze([{ hostKey: "server3", label: "GPEXE server3" }]);
export const CREDENTIAL_KIND = "exchanged_token";
export const UNBIND_REASON_MAX = 500;
export const ACCOUNT_LABEL_MAX = 120;

function sc() {
  return state.sourceConnections;
}

// Every call is bounded on the client as well, beyond the server's own worst
// case for an attempt (the user lock wait, the row lock, the 90 s network
// budget, the statements, the bounded COMMIT and its check add up to a little
// over 140 s): a request still open after that is a lost answer, never a
// refusal - and the server may still be finishing it, which the check-result
// sentence says.
export const REQUEST_BOUND_MS = 150_000;
function request(path, options = {}) {
  const signal = typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function" ? AbortSignal.timeout(REQUEST_BOUND_MS) : undefined;
  return api(path, signal ? { ...options, signal } : options);
}

export function errorInfo(error) {
  const data = error?.data && typeof error.data === "object" ? error.data : null;
  const status = Number(error?.status) || 0;
  return {
    status,
    // No answer at all (the network, a timeout, an abort) is its own code: the
    // screen then never claims the write failed.
    code: data?.error || (status ? "error" : "no_answer"),
    message: data?.message || "",
    expected: data?.expected || null,
    current: data?.current || null,
  };
}

// The 5xx answers the service itself writes, each a stated outcome; any other
// 5xx (a proxy, a restart, a body that is not JSON) says nothing about whether
// the write landed and is treated as a lost answer.
const CODED_5XX = new Set(["internal_error", "key_missing", "attempt_not_recorded", "source_unavailable", "source_answer_unexpected", "credential_unreadable", "network_budget_exhausted", "attempt_not_sent"]);

// Who is looking, from the facts the client already holds (/me and
// /api/organization). The server resolves the same two bases itself on every
// request; this only decides whether the tab is offered and which club the
// screen reads.
export function sourceConnectionsAdminContext() {
  const data = state.organization?.data || null;
  const ws = state.currentUser?.activeWorkspace || null;
  if (!data || !ws) return null;
  const scopeId = ws.scopeId ? String(ws.scopeId) : null;
  if (data.isPlatformAdmin && ws.type === "platform") return { basis: "platform_admin", workspaceType: "platform", clubId: null };
  if (data.isPlatformAdmin && ws.type === "club" && scopeId) return { basis: "platform_admin", workspaceType: "club", clubId: scopeId };
  if (ws.type === "club" && scopeId && (data.manageableClubIds || []).some((id) => String(id) === scopeId)) {
    return { basis: "club_admin", workspaceType: "club", clubId: scopeId };
  }
  return null;
}

// The clubs a platform admin may open from the platform workspace: the ones
// Settings already loaded. The server still answers 404 for a club outside
// the caller's rights, so this list is a convenience, not the rule.
export function clubOptions() {
  return (state.organization?.data?.clubs || [])
    .filter((club) => club.is_active !== false)
    .map((club) => ({ value: String(club.id), label: club.name || "Club" }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

export function clubNameOf(clubId) {
  const id = String(clubId || "");
  const club = (state.organization?.data?.clubs || []).find((row) => String(row.id) === id)
    || (state.currentUser?.clubs || []).find((row) => String(row.id) === id);
  return club?.name || "";
}

export function teamNameOf(teamId) {
  const id = String(teamId || "");
  const team = (state.organization?.data?.teams || []).find((row) => String(row.id) === id);
  return team?.name || "";
}

// The club the screen reads: fixed by the workspace for a club admin or a
// platform admin inside a club, chosen on screen in the platform workspace.
export function activeClubId() {
  const ctx = sourceConnectionsAdminContext();
  if (!ctx) return "";
  return ctx.clubId || sc().clubId || "";
}

export function hostLabelOf(connection) {
  return connection?.hostLabel || HOST_PROFILES.find((h) => h.hostKey === connection?.hostKey)?.label || connection?.hostKey || "";
}

export function connectionById(id) {
  return (sc().connections || []).find((row) => String(row.id) === String(id)) || null;
}

export function resetSourceConnectionsForms() {
  const d = sc();
  d.createOpen = false;
  d.createDraft = { hostKey: HOST_PROFILES[0].hostKey, accountLabel: "" };
  d.createError = null;
  d.credentialOpen = null;
  d.credentialError = null;
  d.bindReview = null;
  d.bindError = null;
  d.unbindOpen = null;
  d.unbindError = null;
  d.testError = null;
}

function resetClubState(clubId) {
  const d = sc();
  d.generation += 1;
  // A write in flight when the club changes never gets to clear its own
  // flag (its finally belongs to the old generation), so the context change
  // clears them here. Closing a form does not: that would unlock a write
  // that is still running.
  d.createBusy = false;
  d.credentialBusy = false;
  d.testBusy = "";
  d.bindBusy = false;
  d.unbindBusy = false;
  d.checkBusy = false;
  d.clubId = String(clubId || "");
  d.connections = null;
  d.error = null;
  d.notice = "";
  d.noticeFor = "";
  d.lastAttempt = {};
  d.teamsOpen = "";
  d.unconfirmed = null;
  d.staleAfterWrite = "";
  resetSourceConnectionsForms();
}

// The tab was opened (again): the club on screen is read again, because
// another administrator may have connected, tested or bound meanwhile. The
// lazy load in app.js runs only while nothing is loaded and nothing failed.
export function enterSourceConnectionsSection() {
  const d = sc();
  if (writeInFlight()) return;
  d.connections = null;
  d.error = null;
  // The presented team list, the open list, a notice and the ended row belong
  // to the previous visit (and possibly to a previous role): dropped.
  d.lastAttempt = {};
  d.teamsOpen = "";
  d.notice = "";
  d.noticeFor = "";
  d.ended = null;
  d.staleAfterWrite = "";
}

// The one-shot read the Settings panel triggers: nothing loaded and nothing
// failed, or - after a workspace switch - a loaded club that is no longer the
// context's club (a club admin of two clubs, a platform admin moving between
// clubs). A write in flight never triggers it.
export function sourceConnectionsNeedLoad() {
  const ctx = sourceConnectionsAdminContext();
  const d = sc();
  if (!ctx || d.loading || writeInFlight()) return false;
  if (ctx.clubId && d.clubId !== ctx.clubId) return true;
  return !d.connections && !d.error;
}

// The loaded list belongs to the club on screen; after a workspace switch it
// may not, and then nothing of it is shown.
export function loadedForActiveClub() {
  const d = sc();
  return Boolean(d.clubId) && d.clubId === activeClubId();
}

// A write is running, or its answer was lost and not yet checked: leaving
// the screen now would lose the only view of that outcome.
export function writeInFlight() {
  const d = sc();
  return Boolean(d.createBusy || d.credentialBusy || d.testBusy || d.bindBusy || d.unbindBusy || d.checkBusy || d.unconfirmed);
}

export async function selectSourceConnectionsClub(clubId, render) {
  if (String(clubId || "") === sc().clubId && sc().connections) return;
  resetClubState(clubId);
  await loadSourceConnections(render);
}

// Entering the tab. In the platform workspace nothing is loaded until a club
// is chosen; in a club workspace the club is the workspace's own.
export async function loadSourceConnections(render) {
  const ctx = sourceConnectionsAdminContext();
  const d = sc();
  if (!ctx) {
    d.loading = false;
    return;
  }
  if (ctx.clubId && d.clubId !== ctx.clubId) resetClubState(ctx.clubId);
  if (!ctx.clubId && d.clubId && !clubOptions().some((club) => club.value === d.clubId)) resetClubState("");
  if (!d.clubId) {
    d.loading = false;
    return;
  }
  const generation = d.generation;
  const clubId = d.clubId;
  d.loading = true;
  d.error = null;
  render();
  try {
    const response = await request(`${BASE}?clubId=${encodeURIComponent(clubId)}`);
    if (generation !== d.generation) return;
    d.connections = Array.isArray(response.connections) ? response.connections : [];
  } catch (error) {
    if (generation !== d.generation) return;
    d.error = errorInfo(error);
  } finally {
    if (generation === d.generation) {
      d.loading = false;
      render();
    }
  }
}

function replaceConnection(connection) {
  const d = sc();
  if (!connection?.id) return;
  const list = d.connections || [];
  const index = list.findIndex((row) => String(row.id) === String(connection.id));
  if (index === -1) list.push(connection);
  else list[index] = connection;
  d.connections = list;
}

// After a write the route already returns the connection as it is now;
// only when that read failed (connectionReadError) is it read again here.
// The write has settled by then: a failed refresh marks the card as possibly
// out of date and never turns the answer into a failure.
async function adoptAnswer(response, connectionId) {
  const d = sc();
  if (response?.connection && !response.connectionReadError) {
    replaceConnection(response.connection);
    d.staleAfterWrite = "";
    return;
  }
  try {
    await reloadConnection(connectionId);
    d.staleAfterWrite = "";
  } catch {
    d.staleAfterWrite = String(connectionId);
  }
}

export async function reloadConnection(connectionId) {
  const response = await request(`${BASE}/${encodeURIComponent(connectionId)}`);
  replaceConnection(response.connection);
  return response.connection;
}

function lostAnswer(info) {
  if (info.status === 0 || info.code === "outcome_unknown") return true;
  return info.status >= 500 && !CODED_5XX.has(info.code);
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

export async function createConnection(render) {
  const d = sc();
  const clubId = activeClubId();
  const draft = d.createDraft || {};
  if (!clubId || d.createBusy) return;
  const generation = d.generation;
  d.createBusy = true;
  d.createError = null;
  render();
  try {
    const response = await request(BASE, {
      method: "POST",
      body: JSON.stringify({ ownerScope: "club", ownerClubId: clubId, hostKey: draft.hostKey, accountLabel: draft.accountLabel, credentialKind: CREDENTIAL_KIND }),
    });
    if (generation !== d.generation) return;
    replaceConnection(response.connection);
    resetSourceConnectionsForms();
    // The next step is the account: the Connect form opens on the new row.
    d.credentialOpen = { connectionId: String(response.connection.id), action: "connect" };
    d.noticeFor = String(response.connection.id);
    d.notice = "The connection is created. Connect the account to store its access token.";
  } catch (error) {
    if (generation !== d.generation) return;
    const info = errorInfo(error);
    if (lostAnswer(info)) {
      // The row may exist and the route has no idempotency key: the form is
      // closed, nothing can be sent again, and Check result reads the club's
      // list - the only honest answer.
      resetSourceConnectionsForms();
      d.unconfirmed = { action: "create", connectionId: null };
    } else {
      d.createError = info;
    }
  } finally {
    if (generation === d.generation) {
      d.createBusy = false;
      render();
    }
  }
}

// ---------------------------------------------------------------------------
// Connect / Reconnect: the one request that carries the pair
// ---------------------------------------------------------------------------

export async function submitCredentials(render, { username, password }) {
  const d = sc();
  const open = d.credentialOpen;
  if (!open || d.credentialBusy) return;
  const connection = connectionById(open.connectionId);
  if (!connection) return;
  const generation = d.generation;
  const connectionId = String(connection.id);
  const action = open.action === "reconnect" ? "reconnect" : "connect";
  d.credentialBusy = true;
  d.credentialError = null;
  render();
  let body;
  try {
    const fields = action === "reconnect"
      ? { username, password, confirmation: { sourceSystem: SOURCE_SYSTEM, ownerClubId: String(connection.ownerClubId), affectedTeamCount: (connection.boundTeams || []).length } }
      : { username, password };
    body = JSON.stringify(fields);
    fields.username = undefined;
    fields.password = undefined;
    const response = await request(`${BASE}/${encodeURIComponent(connectionId)}/${action}`, { method: "POST", body });
    if (generation !== d.generation) return;
    await adoptAnswer(response, connectionId);
    if (generation !== d.generation) return;
    d.lastAttempt[connectionId] = { action, at: new Date().toISOString(), result: response.result || null };
    resetSourceConnectionsForms();
    d.noticeFor = connectionId;
    d.notice = attemptNotice(action, response.result);
    if (response.result?.state === "verified") d.teamsOpen = connectionId;
  } catch (error) {
    if (generation !== d.generation) return;
    const info = errorInfo(error);
    if (lostAnswer(info)) {
      // Never the pair again: the connection is read to learn what was stored.
      resetSourceConnectionsForms();
      d.unconfirmed = { action, connectionId };
    } else if (info.code === "confirmation_mismatch") {
      // The facts the confirmation named changed: the connection is read
      // again and the form closes, so the next Reconnect names the current
      // ones (and asks for the pair again).
      resetSourceConnectionsForms();
      d.testError = { ...info, connectionId };
      await reloadConnection(connectionId).catch(() => { d.testError.readAgainFailed = true; });
    } else {
      d.credentialError = info;
    }
  } finally {
    body = undefined;
    if (generation === d.generation) {
      d.credentialBusy = false;
      render();
    }
  }
}

function attemptNotice(action, result) {
  const verb = action === "reconnect" ? "reconnected" : action === "test" ? "tested" : "connected";
  if (!result) return `The connection was ${verb}.`;
  if (result.state === "verified") return `The connection is verified${result.boundTeamsChecked ? ` and its ${result.boundTeamsChecked === 1 ? "bound team reads" : `${result.boundTeamsChecked} bound teams read`}` : ""}.`;
  if (result.state === "linked_untested") {
    const why = result.code === "source_answer_unexpected" ? "the source answered in a way OptiMove does not understand" : (result.code === "network_budget_exhausted" || result.code === "attempt_not_sent") ? "the attempt ran out of time" : "the source did not answer";
    return `The access token is stored, but the check read did not succeed (${why}). Test the connection again later.`;
  }
  if (result.state === "needs_reconnect") return "The source refused the stored credential. Reconnect with a working username and password.";
  if (result.state === "source_unavailable") return "The source did not answer. The stored credential is kept; test again later.";
  return `The connection was ${verb}.`;
}

// ---------------------------------------------------------------------------
// Test
// ---------------------------------------------------------------------------

export async function testConnection(render, connectionId) {
  const d = sc();
  const connection = connectionById(connectionId);
  if (!connection || d.testBusy) return;
  const generation = d.generation;
  const id = String(connection.id);
  d.testBusy = id;
  d.testError = null;
  d.notice = "";
  render();
  try {
    const response = await request(`${BASE}/${encodeURIComponent(id)}/test`, { method: "POST", body: JSON.stringify({}) });
    if (generation !== d.generation) return;
    await adoptAnswer(response, id);
    if (generation !== d.generation) return;
    d.lastAttempt[id] = { action: "test", at: new Date().toISOString(), result: response.result || null };
    // The attempt line below the actions carries the outcome and the time;
    // a notice is added only when a next step is needed.
    d.noticeFor = response.result?.state === "verified" ? "" : id;
    d.notice = response.result?.state === "verified" ? "" : attemptNotice("test", response.result);
    if (response.result?.state === "verified") d.teamsOpen = id;
  } catch (error) {
    if (generation !== d.generation) return;
    const info = errorInfo(error);
    if (lostAnswer(info)) d.unconfirmed = { action: "test", connectionId: id };
    else d.testError = { ...info, connectionId: id };
  } finally {
    if (generation === d.generation) {
      d.testBusy = "";
      render();
    }
  }
}

// ---------------------------------------------------------------------------
// Approve and bind
// ---------------------------------------------------------------------------

export async function bindTeam(render) {
  const d = sc();
  const review = d.bindReview;
  if (!review || d.bindBusy) return;
  const generation = d.generation;
  const id = String(review.connectionId);
  d.bindBusy = true;
  d.bindError = null;
  render();
  try {
    const response = await request(`${BASE}/${encodeURIComponent(id)}/bindings`, { method: "POST", body: JSON.stringify({ teamId: review.teamId, sourceTeamId: review.sourceTeamId }) });
    if (generation !== d.generation) return;
    await adoptAnswer(response, id);
    if (generation !== d.generation) return;
    resetSourceConnectionsForms();
    d.noticeFor = id;
    d.notice = response.result?.idempotent
      ? `${review.teamName} was already bound to ${SOURCE_NAME} team ${review.sourceTeamId}; nothing changed.`
      : `${review.teamName} now reads from ${SOURCE_NAME} team ${review.sourceTeamId}.`;
  } catch (error) {
    if (generation !== d.generation) return;
    const info = errorInfo(error);
    if (lostAnswer(info)) {
      // The same bind again is answered idempotently by the server, so
      // "Check result" may repeat it.
      d.unconfirmed = { action: "bind", connectionId: id, body: { teamId: review.teamId, sourceTeamId: review.sourceTeamId }, teamName: review.teamName };
      resetSourceConnectionsForms();
    } else if (info.code === "source_auth_rejected") {
      // The source refused the stored credential: the server moved the
      // connection to needs_reconnect, so the card is read again and the
      // review closes - Reconnect is the next step, not Bind.
      resetSourceConnectionsForms();
      d.testError = { ...info, connectionId: id, context: "bind" };
      await reloadConnection(id).catch(() => { d.testError.readAgainFailed = true; });
    } else {
      d.bindError = info;
    }
  } finally {
    if (generation === d.generation) {
      d.bindBusy = false;
      render();
    }
  }
}

// ---------------------------------------------------------------------------
// Unbind: local, idempotent by requestKey
// ---------------------------------------------------------------------------

export function newRequestKey() {
  const c = globalThis.crypto;
  if (c?.randomUUID) return c.randomUUID();
  // RFC 4122 v4 from getRandomValues (an insecure context or an older
  // browser has no randomUUID); the route accepts a UUID only.
  const bytes = new Uint8Array(16);
  if (c?.getRandomValues) c.getRandomValues(bytes);
  else for (let i = 0; i < 16; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export async function unbindTeam(render, { fromUnconfirmed = false } = {}) {
  const d = sc();
  const open = fromUnconfirmed ? d.unconfirmed : d.unbindOpen;
  if (!open || d.unbindBusy || d.checkBusy) return;
  const generation = d.generation;
  const id = String(open.connectionId);
  if (fromUnconfirmed) d.checkBusy = true;
  else d.unbindBusy = true;
  d.unbindError = null;
  render();
  try {
    const response = await request(`${BASE}/${encodeURIComponent(id)}/bindings/${encodeURIComponent(open.bindingId)}/unbind`, {
      method: "POST",
      body: JSON.stringify({ requestKey: open.requestKey, reason: open.reason, expected: { teamId: open.teamId, sourceTeamId: open.sourceTeamId } }),
    });
    if (generation !== d.generation) return;
    await adoptAnswer(response, id);
    if (generation !== d.generation) return;
    d.unconfirmed = null;
    resetSourceConnectionsForms();
    d.noticeFor = id;
    d.ended = response.result?.binding || null;
    d.notice = `${open.teamName} no longer reads from ${SOURCE_NAME} team ${open.sourceTeamId}. The ended binding stays recorded on the server (this screen lists active bindings only); the team does not fall back to the older server-wide ${SOURCE_NAME} access.`;
  } catch (error) {
    if (generation !== d.generation) return;
    const info = errorInfo(error);
    if (lostAnswer(info)) {
      // The same key again asks the server for the same answer: nothing is
      // ended twice.
      d.unconfirmed = { action: "unbind", connectionId: id, bindingId: open.bindingId, teamId: open.teamId, teamName: open.teamName, sourceTeamId: open.sourceTeamId, reason: open.reason, requestKey: open.requestKey };
      d.unbindOpen = null;
    } else if (fromUnconfirmed && info.code === "try_again") {
      // As for a bind: a repeat refused as "try again" (a lock held
      // elsewhere) decides nothing - the marker and Check result stay.
      d.noticeFor = id;
      d.notice = TRY_AGAIN_NOTICE;
    } else if (fromUnconfirmed || info.code === "binding_already_ended" || info.code === "binding_mismatch") {
      // The binding is not what the screen showed: the connection is read
      // again (its bound list without that row) and the sentence stands
      // beside the card, not inside a form that no longer applies.
      d.unconfirmed = null;
      d.unbindOpen = null;
      d.unbindError = { ...info, connectionId: id };
      await reloadConnection(id).catch(() => { d.unbindError.readAgainFailed = true; });
    } else {
      d.unbindError = info;
    }
  } finally {
    if (generation === d.generation) {
      d.unbindBusy = false;
      d.checkBusy = false;
      render();
    }
  }
}

// Which lost answers can be settled, and which cannot. A bind and an Unbind
// are repeated with the same pair / the same requestKey, which the server
// answers idempotently: the repeat IS the outcome. A Connect, Reconnect, Test
// or create has no such key: a read shows the state the server holds now, but
// cannot tell whether the lost attempt landed (a Reconnect on a verified
// connection looks the same before and after; a list does not say which row
// an attempt created; the server may still be finishing the request). The
// backend returns no attempt revision to compare against, so nothing here
// pretends to - the marker stays, every other write stays locked, until the
// administrator acknowledges the uncertainty explicitly (a local step).
export const IDEMPOTENT_ACTIONS = Object.freeze(["bind", "unbind"]);
export const isIdempotentPending = (pending) => Boolean(pending) && IDEMPOTENT_ACTIONS.includes(pending.action);
// The question before the acknowledgement names the consequence of acting
// again for that action: a new Connect / Reconnect can change the stored
// credential; a new create can add a second connection (the create route
// has no idempotency key and the club no uniqueness rule, and no connection
// can be removed from this screen).
export function acknowledgeQuestion(pending) {
  const head = "The server may still be finishing the previous request, and its outcome stays unknown. Continuing only removes this warning and unlocks the other changes on this screen - nothing is sent and nothing is checked. A new Connect or Reconnect can change the stored credential.";
  const create = pending?.action === "create" ? " If the connection was created after all, creating it again makes a second connection, which this screen cannot remove." : "";
  return `${head}${create} Continue?`;
}
const TRY_AGAIN_NOTICE = "Check result could not run: another change of this connection or of one of its teams was in progress (for example a test, a check or an import). Nothing was decided and the result is still not confirmed. Try Check result again in a minute.";
const READ_FAILED_NOTICE = "The current state could not be read just now. Nothing was sent again, and the result is still not confirmed. Try Read current state again in a minute.";
const LIST_READ_FAILED_NOTICE = "The club's connections could not be read just now. Nothing was sent again, and the result is still not confirmed. Try Read current state again in a minute.";
const ACK_NOUN = Object.freeze({ connect: "Connect", reconnect: "Reconnect", test: "test" });

// "Check result" for a lost bind or Unbind: the same request again. A marker
// belongs to the club whose list is loaded. After a workspace switch the
// screen shows only a sentence for it, and none of these steps (Check result,
// Read current state, the acknowledgement) runs from another club's context:
// a read there would load (and reset to) the other club and drop the marker,
// a repeat would be answered for the wrong workspace, an acknowledgement
// would lift a lock the screen does not show.
export async function checkUnconfirmed(render) {
  const d = sc();
  const pending = d.unconfirmed;
  if (!pending || d.checkBusy || !loadedForActiveClub()) return;
  if (!isIdempotentPending(pending)) return;
  if (pending.action === "unbind") return unbindTeam(render, { fromUnconfirmed: true });
  const generation = d.generation;
  d.checkBusy = true;
  render();
  try {
    const response = await request(`${BASE}/${encodeURIComponent(pending.connectionId)}/bindings`, { method: "POST", body: JSON.stringify(pending.body) });
    if (generation !== d.generation) return;
    await adoptAnswer(response, pending.connectionId);
    if (generation !== d.generation) return;
    d.noticeFor = String(pending.connectionId);
    d.notice = `${pending.teamName} reads from ${SOURCE_NAME} team ${pending.body.sourceTeamId}${response.result?.idempotent ? " (the earlier request had gone through)" : ""}.`;
    d.unconfirmed = null;
  } catch (error) {
    if (generation !== d.generation) return;
    const info = errorInfo(error);
    // A repeat refused as "try again" (a lock held elsewhere) decides nothing:
    // the outcome stays unconfirmed and Check result stays offered.
    if (info.code === "try_again") {
      d.noticeFor = String(pending.connectionId);
      d.notice = TRY_AGAIN_NOTICE;
    } else if (!lostAnswer(info)) {
      d.unconfirmed = null;
      d.testError = { ...info, connectionId: pending.connectionId };
    }
  } finally {
    if (generation === d.generation) {
      d.checkBusy = false;
      render();
    }
  }
}

// "Read current state" for a lost Connect, Reconnect, Test or create: the
// connection (or the club's list) is read and shown; the marker is NOT
// cleared - this read proves nothing about the lost attempt - and nothing is
// sent again.
export async function readCurrentState(render) {
  const d = sc();
  const pending = d.unconfirmed;
  if (!pending || d.checkBusy || isIdempotentPending(pending) || !loadedForActiveClub()) return;
  const generation = d.generation;
  d.checkBusy = true;
  render();
  try {
    if (pending.action === "create") {
      // The club's list, read directly: never through loadSourceConnections,
      // whose club reset would drop the marker (a platform admin's club that
      // left the picker meanwhile).
      let response;
      try {
        response = await request(`${BASE}?clubId=${encodeURIComponent(d.clubId)}`);
      } catch {
        // The list could not be read either: nothing is known yet, and an
        // older read's sentence is replaced so it never reads as this one.
        if (generation !== d.generation) return;
        d.notice = LIST_READ_FAILED_NOTICE;
        d.noticeFor = "";
        return;
      }
      if (generation !== d.generation) return;
      d.connections = Array.isArray(response.connections) ? response.connections : [];
      d.notice = "The connections below are what the server holds now. Whether one of them came from the lost request is not known; the server may still be finishing it.";
      d.noticeFor = "";
    } else {
      const connection = await reloadConnection(pending.connectionId);
      if (generation !== d.generation) return;
      d.noticeFor = String(pending.connectionId);
      d.notice = `Read current state: the connection is ${stateLabel(connection?.state)}${connection?.lastVerifiedAt ? `, last verified ${fmtDateTime(connection.lastVerifiedAt)}` : ""}. Nothing was sent again. The state can look the same whether or not the ${ACK_NOUN[pending.action] || pending.action} went through, and the server may still be finishing it, so the result stays not confirmed.`;
    }
  } catch (error) {
    if (generation !== d.generation) return;
    const info = errorInfo(error);
    d.noticeFor = String(pending.connectionId);
    d.notice = READ_FAILED_NOTICE;
    if (!lostAnswer(info)) d.testError = { ...info, connectionId: pending.connectionId };
  } finally {
    if (generation === d.generation) {
      d.checkBusy = false;
      render();
    }
  }
}

// The explicit, local step that lifts the lock after a lost Connect,
// Reconnect, Test or create: nothing is sent, nothing is proven; the outcome
// of the lost attempt stays unknown, and the next Connect or Reconnect may
// change the stored credential. The caller asks the administrator first.
export function acknowledgeUncertainty() {
  const d = sc();
  const pending = d.unconfirmed;
  if (!pending || isIdempotentPending(pending) || d.checkBusy || !loadedForActiveClub()) return false;
  d.unconfirmed = null;
  d.noticeFor = pending.connectionId ? String(pending.connectionId) : "";
  d.notice = pending.action === "create"
    ? "You continued without knowing whether the connection was created. The list may be out of date: before creating a connection, choose Source connections again in Settings to read it, so the club does not get a second one."
    : `You continued without knowing whether the ${ACK_NOUN[pending.action] || pending.action} went through; its outcome stays unknown. A new Connect or Reconnect can change the stored credential. What is shown may be out of date: before the next change, choose Source connections again in Settings to read it.`;
  return true;
}

// Whether the acknowledgement may be asked at all (the action asks the
// administrator only when it would do something).
export function canAcknowledgeUncertainty() {
  const d = sc();
  return Boolean(d.unconfirmed) && !isIdempotentPending(d.unconfirmed) && !d.checkBusy && loadedForActiveClub();
}

export function stateLabel(value) {
  switch (value) {
    case "verified": return "Verified";
    case "linked_untested": return "Connected, not tested";
    case "needs_reconnect": return "Needs reconnect";
    case "source_unavailable": return "Source unavailable";
    case "not_connected": return "Not connected";
    default: return "unknown";
  }
}

export function fmtDateTime(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const two = (n) => String(n).padStart(2, "0");
  return `${two(date.getDate())}.${two(date.getMonth() + 1)}.${date.getFullYear()} ${two(date.getHours())}:${two(date.getMinutes())}`;
}
