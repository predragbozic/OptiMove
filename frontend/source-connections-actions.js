// Settings -> Source connections (F3c3): events and mutations.
//
// Rules that hold everywhere here: opening a form or typing sends nothing;
// every write goes through a form or a confirmation that names what it
// touches; a username and a password are read from the form on submit, sent
// once and retained nowhere by this code (not in state, a dataset, a URL,
// storage or a log); a second click while a write runs does nothing; Cancel
// only clears the screen; a lost answer is never resent blindly.
import {
  HOST_PROFILES,
  ACCOUNT_LABEL_MAX,
  UNBIND_REASON_MAX,
  acknowledgeQuestion,
  acknowledgeUncertainty,
  bindTeam,
  canAcknowledgeUncertainty,
  checkUnconfirmed,
  connectionById,
  createConnection,
  loadSourceConnections,
  newRequestKey,
  readCurrentState,
  resetSourceConnectionsForms,
  selectSourceConnectionsClub,
  sourceConnectionsAdminContext,
  submitCredentials,
  testConnection,
  unbindTeam,
  writeInFlight,
} from "./source-connections-data.js";
import { validateFilterableSelects } from "./organization-select.js";
import { state } from "./state.js";

function sc() {
  return state.sourceConnections;
}

// A refusal the screen can answer on its own, in the same shape the server's
// refusals arrive in, so one mapping renders both.
function localError(code) {
  return { status: 400, code, message: "" };
}

function clearNotice(d) {
  d.notice = "";
  d.noticeFor = "";
  d.ended = null;
}

export async function handleSourceConnectionsAction(action, { render, openDataSources } = {}) {
  const type = action.dataset.action;
  if (!type || !type.startsWith("source-connections-")) return false;
  const d = sc();
  const connectionId = action.dataset.connectionId || "";

  if (type === "source-connections-create-open") {
    if (writeInFlight()) return true;
    resetSourceConnectionsForms();
    clearNotice(d);
    d.createOpen = true;
    render();
    return true;
  }
  if (type === "source-connections-connect-open" || type === "source-connections-reconnect-open") {
    if (writeInFlight() || !connectionById(connectionId)) return true;
    resetSourceConnectionsForms();
    clearNotice(d);
    d.credentialOpen = { connectionId, action: type === "source-connections-reconnect-open" ? "reconnect" : "connect" };
    render();
    return true;
  }
  if (type === "source-connections-test") {
    if (writeInFlight()) return true;
    resetSourceConnectionsForms();
    clearNotice(d);
    await testConnection(render, connectionId);
    return true;
  }
  if (type === "source-connections-toggle-teams") {
    d.teamsOpen = d.teamsOpen === connectionId ? "" : connectionId;
    render();
    return true;
  }
  if (type === "source-connections-bind-open") {
    if (writeInFlight() || !connectionById(connectionId)) return true;
    const teamId = action.dataset.teamId || "";
    const sourceTeamId = action.dataset.sourceTeamId || "";
    if (!teamId || !sourceTeamId) return true;
    resetSourceConnectionsForms();
    clearNotice(d);
    d.bindReview = { connectionId, teamId, teamName: action.dataset.teamName || "the OptiMove team", sourceTeamId, sourceTeamName: action.dataset.sourceTeamName || "" };
    render();
    return true;
  }
  if (type === "source-connections-bind-confirm") {
    await bindTeam(render);
    return true;
  }
  if (type === "source-connections-unbind-open") {
    if (writeInFlight() || !connectionById(connectionId)) return true;
    resetSourceConnectionsForms();
    clearNotice(d);
    // One key per Unbind attempt: a lost answer is checked with the same
    // key, a fresh form gets a fresh one.
    d.unbindOpen = {
      connectionId, bindingId: action.dataset.bindingId || "", teamId: action.dataset.teamId || "", teamName: action.dataset.teamName || "the team",
      sourceTeamId: action.dataset.sourceTeamId || "", reason: "", requestKey: newRequestKey(),
    };
    render();
    return true;
  }
  if (type === "source-connections-check-result") {
    // Bind / Unbind only: the same request again, answered idempotently.
    await checkUnconfirmed(render);
    return true;
  }
  if (type === "source-connections-read-state") {
    // Connect / Reconnect / Test / create: a read that keeps the marker.
    await readCurrentState(render);
    return true;
  }
  if (type === "source-connections-acknowledge") {
    // Local only: no fetch; asked first, declined (or no way to ask) changes
    // nothing. Never asked while a read runs or for another club's marker.
    if (!canAcknowledgeUncertainty()) return true;
    const ask = globalThis.window?.confirm;
    const confirmed = typeof ask === "function" ? ask(acknowledgeQuestion(d.unconfirmed)) : false;
    if (!confirmed) return true;
    acknowledgeUncertainty();
    render();
    return true;
  }
  if (type === "source-connections-cancel") {
    // Closing a form never unlocks a write that is still running.
    resetSourceConnectionsForms();
    render();
    return true;
  }
  if (type === "source-connections-reload") {
    if (writeInFlight()) return true;
    await loadSourceConnections(render);
    return true;
  }
  if (type === "source-connections-open-pair") {
    // The approved pair is set through the existing Data sources contract
    // (platform admin only); this only switches the tab - behind the same
    // question as any other exit while a write runs.
    if (sourceConnectionsAdminContext()?.basis !== "platform_admin") return true;
    if (!confirmLeaveSourceConnections()) return true;
    // The list of GPEXE teams was read before the pair changes: it is dropped,
    // so the card asks for a new Test on return instead of showing a stale
    // "No approved OptiMove team yet".
    if (connectionId) delete d.lastAttempt[connectionId];
    d.teamsOpen = "";
    if (typeof openDataSources === "function") openDataSources();
    return true;
  }
  return false;
}

// Reads one named field of the form. `form.elements` is what a browser
// gives; the suites drive these handlers with the same shape.
function field(form, name) {
  return form.elements?.[name] ?? form.querySelector?.(`[name="${name}"]`) ?? null;
}
function fieldValue(form, name, { trim = true } = {}) {
  const value = String(field(form, name)?.value ?? "");
  return trim ? value.trim() : value;
}
function clearField(form, name) {
  const element = field(form, name);
  if (element && "value" in element) {
    try { element.value = ""; } catch { /* a read-only test double */ }
  }
}

export async function submitSourceConnectionsForm(form, { render }) {
  const kind = form.dataset.sourceConnectionsForm;
  const d = sc();

  if (kind === "club") {
    if (form.querySelectorAll && !validateFilterableSelects(form)) return;
    if (writeInFlight()) return;
    await selectSourceConnectionsClub(fieldValue(form, "clubId"), render);
    return;
  }

  if (kind === "create") {
    // No idempotency key on this route: nothing is sent while a write runs
    // or an answer is unconfirmed (the form is closed then anyway).
    if (writeInFlight()) return;
    const hostKey = fieldValue(form, "hostKey");
    const accountLabel = fieldValue(form, "accountLabel");
    d.createDraft = { hostKey, accountLabel };
    if (!HOST_PROFILES.some((host) => host.hostKey === hostKey)) {
      d.createError = localError("host_not_allowed");
      render();
      return;
    }
    if (!accountLabel) {
      d.createError = localError("account_label_required");
      render();
      return;
    }
    if (accountLabel.length > ACCOUNT_LABEL_MAX) {
      d.createError = localError("account_label_too_long");
      render();
      return;
    }
    d.createError = null;
    await createConnection(render);
    return;
  }

  if (kind === "credential") {
    if (!d.credentialOpen || d.credentialBusy) return;
    // The pair lives in these two locals for the length of one request.
    // The password is not trimmed (it may begin or end with a space).
    let username = fieldValue(form, "username");
    let password = fieldValue(form, "password", { trim: false });
    clearField(form, "password");
    if (!username || !password) {
      username = password = "";
      d.credentialError = localError("credentials_required");
      render();
      return;
    }
    d.credentialError = null;
    try {
      await submitCredentials(render, { username, password });
    } finally {
      username = password = "";
    }
    return;
  }

  if (kind === "unbind") {
    if (!d.unbindOpen) return;
    const reason = fieldValue(form, "reason");
    d.unbindOpen = { ...d.unbindOpen, reason };
    if (!reason) {
      d.unbindError = localError("reason_required");
      render();
      return;
    }
    if (reason.length > UNBIND_REASON_MAX) {
      d.unbindError = localError("reason_too_long");
      render();
      return;
    }
    d.unbindError = null;
    await unbindTeam(render);
  }
}

// Leaving the screen while a write runs, or while its answer is not
// confirmed, would lose the only view of that outcome: ask first. Declined
// changes nothing.
export function confirmLeaveSourceConnections() {
  if (!writeInFlight()) return true;
  const ask = globalThis.window?.confirm;
  return typeof ask === "function"
    ? ask("A source connection change is still running or its result is not confirmed. Leave this screen anyway?")
    : true;
}

export function handleSourceConnectionsBeforeUnload(event) {
  if (!writeInFlight()) return;
  event.preventDefault();
  event.returnValue = "";
}
