// Settings -> Source connections (F3c3): what an administrator sees.
//
// One card per source connection of the club (today GPEXE on the approved
// server3 profile): its state first, then the facts, then one primary action
// at a time - Connect account, Test connection, Approve and bind, Reconnect,
// Unbind - each behind a form or a confirmation that names what it touches.
// Plain administrator language in the open; every code inside "Technical
// details". Never a credential part, never the source's own answer, never a
// team the server did not present. Carbon informs the structure (status
// first, the destructive step behind a named confirmation); nothing from
// Carbon runs here.
import {
  ACCOUNT_LABEL_MAX,
  HOST_PROFILES,
  SOURCE_NAME,
  UNBIND_REASON_MAX,
  activeClubId,
  clubNameOf,
  clubOptions,
  fmtDateTime,
  hostLabelOf,
  loadedForActiveClub,
  sourceConnectionsAdminContext,
  writeInFlight,
} from "./source-connections-data.js";
import { renderFilterableSelect } from "./organization-select.js";
import { state } from "./state.js";
import { escapeAttr, escapeHtml } from "./utils.js";

// What each refusal means for the administrator reading it, and the one
// thing to do next. The server's own sentence stays in "Technical details".
export function connectionMessage(info, context = "") {
  if (!info) return "";
  const code = info.code || "";
  // The one code whose meaning depends on where it is read: in the Connect /
  // Reconnect form it is the pair just typed; anywhere else the stored one.
  if (code === "source_auth_rejected" && context === "credential") {
    return `${SOURCE_NAME} refused this username and password. Nothing was stored; check them and try once more (every attempt counts toward 5 in 15 minutes).`;
  }
  const BY_CODE = {
    try_again: "Another change of this connection or of one of its teams is running (a test, a reconnect, a bind, an unbind, a check or an import). Try again when it has finished.",
    rights_changed: "Your administrator rights changed while the request ran. Nothing was stored. Reload the app.",
    team_setting_missing: "That OptiMove team has no approved GPEXE Team ID yet. A platform admin sets the pair under Settings > Data sources first.",
    team_setting_mismatch: "The chosen GPEXE team is not the one approved for that OptiMove team under Data sources. Nothing was bound.",
    team_already_bound: "That OptiMove team is already bound to a GPEXE team. End that binding first.",
    source_team_already_bound: "That GPEXE team already feeds another OptiMove team. One GPEXE team feeds one OptiMove team.",
    host_not_allowed: "That source host is not approved for new connections.",
    binding_refused: "The database refused the binding. Nothing was bound; reload and try again.",
    binding_already_ended: "This binding had already ended (another administrator may have ended it); the connection was read again and the list below is current.",
    network_budget_exhausted: "The source did not answer within the time allowed, so nothing was stored or bound. Try again later.",
    attempt_not_sent: "The attempt stopped before its first request reached the source; nothing was stored or bound. Try again later.",
    outcome_unknown: "The server did not confirm the result in time. Use Check result before trying again.",
    key_missing: "The server has no key to protect the credential with, so nothing was stored. This needs the platform operator.",
    internal_error: "The request failed on the server. Nothing was changed.",
    attempt_not_recorded: "The source answered, but the result could not be stored. Reload and check the state before trying again.",
    source_auth_throttled: `Too many attempts reached ${SOURCE_NAME} for this connection in a short time (connect, test and bind all count). Wait about 15 minutes before trying again.`,
    credential_unreadable: "The stored credential can no longer be read. Reconnect to store a new one.",
    request_key_reused: "This confirmation was already used for a different request. Start the Unbind again.",
    not_connected: "This connection has no stored credential yet. Connect the account first.",
    exchange_not_supported: "That host has no confirmed sign-in exchange.",
    credential_kind_unsupported: "Only a token obtained with a username and password is supported.",
    connection_not_verified: "The connection must be verified before a team is bound. Test it first.",
    confirmation_mismatch: "The connection changed since this screen was loaded (its owner or its bound teams); it was read again. Open Reconnect again to confirm the current facts.",
    binding_mismatch: "This binding changed since the screen was loaded; the connection was read again. Start the Unbind again if the binding is still listed.",
    already_connected: "This connection already has a stored credential. Use Reconnect to replace it.",
    owner_scope_unsupported: "The request was not accepted as sent. Reload the app and try again.",
    adapter_not_available: "OptiMove has no read adapter for that host yet.",
    invalid_body: "The request was not accepted as sent. Reload the app and try again.",
    jsonRequired: "The request was not accepted as sent. Reload the app and try again.",
    source_auth_rejected: context === "bind"
      ? `${SOURCE_NAME} refused the stored credential, so nothing was bound and the connection now needs a reconnect. Reconnect with a working username and password, then bind the team.`
      : `${SOURCE_NAME} refused the stored credential. Nothing was changed or bound; reconnect with a working username and password.`,
    source_team_not_visible: `${SOURCE_NAME} does not show that team to this account (a bound team, or the one chosen). Nothing was bound.`,
    source_unavailable: "The source did not answer. Nothing was changed; try again later.",
    source_answer_unexpected: "The source answered in a way OptiMove does not understand. Nothing was changed.",
    reason_required: "A reason is required.",
    reason_too_long: `The reason is too long (at most ${UNBIND_REASON_MAX} characters).`,
    account_label_required: "Name the account (one line, so it can be told apart later).",
    account_label_too_long: `The account name is too long (at most ${ACCOUNT_LABEL_MAX} characters).`,
    credentials_required: "Enter the username and the password.",
    no_answer: "We can't tell whether the change was made. Use Check result, or reload this screen, before trying again.",
  };
  if (BY_CODE[code]) return info.readAgainFailed ? `${BY_CODE[code].replace(/; the connection was read again and the list below is current\.|; it was read again\.|; the connection was read again\./, ".")} The connection could not be read again, so the list may be out of date; open the tab again.` : BY_CODE[code];
  if (info.status === 404) return "This connection, club or team is not available in your workspace (any more).";
  if (info.status === 403) return "This needs an administrator right your account does not hold (any more). Reload the app.";
  return "That did not work. Nothing was changed.";
}

export function stateBadge(value) {
  switch (value) {
    case "verified": return { label: "Verified", cls: "is-on" };
    case "linked_untested": return { label: "Connected, not tested", cls: "is-pending" };
    case "needs_reconnect": return { label: "Needs reconnect", cls: "is-warn" };
    case "source_unavailable": return { label: "Source unavailable", cls: "is-warn" };
    default: return { label: "Not connected", cls: "is-off" };
  }
}

function lastProblemText(code) {
  if (code === "source_auth_rejected") return `${SOURCE_NAME} refused the stored credential`;
  if (code === "source_unavailable") return `${SOURCE_NAME} did not answer`;
  if (code === "source_answer_unexpected") return `${SOURCE_NAME} answered in a way OptiMove does not understand`;
  if (code === "source_team_not_visible") return `A bound ${SOURCE_NAME} team is no longer visible to this account`;
  if (code === "network_budget_exhausted" || code === "attempt_not_sent") return `The attempt ran out of time before ${SOURCE_NAME} answered`;
  if (code === "attempt_not_recorded") return "A result could not be stored";
  if (code === "credential_unreadable") return "The stored credential can no longer be read";
  return code ? "A problem was recorded" : "";
}

function techHtml(entries) {
  const rows = entries.filter(([, value]) => value !== undefined && value !== null && value !== "");
  if (!rows.length) return "";
  return `<details class="data-sources-tech"><summary>Technical details</summary><dl>${rows
    .map(([key, value]) => `<dt>${escapeHtml(key)}</dt><dd>${escapeHtml(String(value))}</dd>`)
    .join("")}</dl></details>`;
}

function errorHtml(info, context = "") {
  if (!info) return "";
  return `
    <div class="data-sources-error" role="alert">
      <p>${escapeHtml(connectionMessage(info, context))}</p>
      ${techHtml([["HTTP status", info.status || "no answer"], ["Code", info.code], ["Server message", info.message]])}
    </div>
  `;
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

export function renderSourceConnectionsPanelHtml() {
  const ctx = sourceConnectionsAdminContext();
  if (!ctx) return "";
  const d = state.sourceConnections;
  const clubId = activeClubId();
  const clubName = clubNameOf(clubId);
  return `
    <section class="panel data-sources source-connections" ${writeInFlight() ? 'aria-busy="true"' : ""}>
      <div class="data-sources-head">
        <p class="eyebrow">${escapeHtml(ctx.workspaceType === "platform" ? "Platform" : clubName || "Club")}</p>
        <h3>Source connections</h3>
        <p class="muted">${ctx.basis === "platform_admin"
          ? "A club's account at the system its training data comes from. The access token is stored encrypted on the server; a password is exchanged for it once and never kept. Teams read through it only after their approved pair (Settings > Data sources) is bound here."
          : "Your club's account at the system its training data comes from. The access token is stored encrypted on the server; a password is exchanged for it once and never kept. A team reads through it only after a platform admin has approved its GPEXE team and you have bound that pair here."}</p>
      </div>
      ${ctx.workspaceType === "platform" ? renderClubPickerHtml(d, clubId, clubName) : ""}
      ${clubId ? renderClubHtml(d, ctx, clubId, clubName) : ""}
    </section>
  `;
}

function renderClubPickerHtml(d, clubId, clubName) {
  const options = clubOptions();
  return `
    <form class="data-sources-team-form" data-source-connections-form="club">
      ${renderFilterableSelect({ name: "clubId", label: "Club", options, value: clubId, required: true, placeholder: "Type a club name" })}
      <button class="plain-button" type="submit" ${options.length ? "" : "disabled"}>Open club</button>
      ${options.length ? "" : `<p class="muted">No club is available yet. Add one under Settings &gt; Clubs first.</p>`}
    </form>
    ${clubId ? `<p class="data-sources-team">${escapeHtml(clubName || "Club")}</p>` : `<p class="muted data-sources-empty">Choose a club above to see its source connections.</p>`}
  `;
}

function renderClubHtml(d, ctx, clubId, clubName) {
  // After a workspace switch the loaded list may belong to the previous club:
  // nothing of it is shown, and the panel's one-shot read brings this club's -
  // once an outcome of the previous club that is not confirmed yet has been
  // checked (that block is the one thing of it that stays reachable).
  if (!loadedForActiveClub() || (d.loading && !d.connections)) {
    if (!loadedForActiveClub() && writeInFlight()) {
      const previous = clubNameOf(d.clubId) || "the previous club";
      return d.unconfirmed
        ? `<p class="data-sources-warn" role="status">A change made for ${escapeHtml(previous)} is not confirmed yet. Open ${escapeHtml(previous)}'s workspace to check its result (from here the server answers only for this club); this club is read after that.</p>`
        : `<p class="muted" role="status">A change for ${escapeHtml(previous)} is still running; this club is read when it has finished.</p>`;
    }
    return `<p class="muted" role="status">Loading...</p>`;
  }
  if (d.error) {
    // A 404 is the same for a club outside the caller's rights and for one
    // that does not exist: the sentence says neither.
    if (d.error.status === 404) {
      return `<div class="data-sources-error" role="alert"><p>No source connections are available in this workspace.</p></div>`;
    }
    return `
      <div class="data-sources-error" role="alert">
        <p>${d.notice
          ? `${escapeHtml(d.notice)} That change was made, but the club could not be read again afterwards, so what is on screen is not up to date. Reload before making another change.`
          : "The club's source connections could not be loaded, so nothing is shown yet. Nothing was changed."}</p>
        ${techHtml([["HTTP status", d.error.status || "no answer"], ["Code", d.error.code], ["Server message", d.error.message]])}
        <button class="plain-button data-sources-primary" type="button" data-action="source-connections-reload">Try again</button>
      </div>
    `;
  }
  if (!d.connections) return "";
  const pending = d.unconfirmed;
  return `
    ${pending && pending.action === "create" ? renderUnconfirmedHtml(d, pending) : ""}
    ${d.connections.length ? d.connections.map((connection) => renderConnectionCardHtml(d, ctx, connection, clubName)).join("") : renderEmptyHtml(d, clubName)}
  `;
}

// No connection yet: one card with the create form behind one button.
function renderEmptyHtml(d, clubName) {
  return `
    <section class="data-sources-card">
      <div class="data-sources-card-head">
        <h4>${escapeHtml(SOURCE_NAME)}</h4>
        <span class="data-sources-state is-off">Not connected</span>
      </div>
      ${d.notice && !d.noticeFor ? `<p class="data-sources-notice" role="status">${escapeHtml(d.notice)}</p>` : ""}
      <p class="muted">${escapeHtml(clubName || "This club")} has no ${escapeHtml(SOURCE_NAME)} connection yet. Its teams cannot read ${escapeHtml(SOURCE_NAME)} through a club account until one is created, connected, tested and bound.</p>
      ${d.createOpen ? renderCreateFormHtml(d) : `<button class="plain-button data-sources-primary" type="button" data-action="source-connections-create-open" ${writeInFlight() ? "disabled" : ""}>Create connection</button>`}
      ${d.createOpen ? "" : errorHtml(d.createError)}
    </section>
  `;
}

function renderCreateFormHtml(d) {
  const draft = d.createDraft || { hostKey: HOST_PROFILES[0].hostKey, accountLabel: "" };
  return `
    <form class="data-sources-form" data-source-connections-form="create" autocomplete="off">
      <p class="data-sources-form-title">Create the ${escapeHtml(SOURCE_NAME)} connection</p>
      <label class="search-field"><span>Host profile</span>
        <select name="hostKey" required>
          ${HOST_PROFILES.map((host) => `<option value="${escapeAttr(host.hostKey)}" ${host.hostKey === draft.hostKey ? "selected" : ""}>${escapeHtml(host.label)}</option>`).join("")}
        </select>
      </label>
      <p class="muted">Only an approved host profile can be chosen. The server reads from that host only, through its confirmed paths; no address is typed anywhere.</p>
      <label class="search-field"><span>Account name</span>
        <input name="accountLabel" type="text" required maxlength="${ACCOUNT_LABEL_MAX}" autocomplete="off" value="${escapeAttr(draft.accountLabel)}" placeholder="e.g. Club GPEXE account">
      </label>
      <p class="muted">A label for this screen only - not the username. The username and the password come in the next step and are never shown.</p>
      ${errorHtml(d.createError)}
      <div class="data-sources-form-actions">
        <button class="plain-button data-sources-primary" type="submit" ${d.createBusy ? "disabled" : ""}>${d.createBusy ? "Creating..." : "Create and continue"}</button>
        <button class="plain-button ghost" type="button" data-action="source-connections-cancel" ${d.createBusy ? "disabled" : ""}>Cancel</button>
      </div>
    </form>
  `;
}

function renderConnectionCardHtml(d, ctx, connection, clubName) {
  const id = String(connection.id);
  const badge = stateBadge(connection.state);
  const bound = connection.boundTeams || [];
  const attempt = d.lastAttempt?.[id] || null;
  const pending = d.unconfirmed && String(d.unconfirmed.connectionId) === id ? d.unconfirmed : null;
  const busy = writeInFlight();
  const formOpen = (d.credentialOpen && String(d.credentialOpen.connectionId) === id) || (d.bindReview && String(d.bindReview.connectionId) === id) || (d.unbindOpen && String(d.unbindOpen.connectionId) === id);
  return `
    <section class="data-sources-card source-connection" data-connection-id="${escapeAttr(id)}">
      <div class="data-sources-card-head">
        <h4>${escapeHtml(SOURCE_NAME)} · ${escapeHtml(hostLabelOf(connection))}</h4>
        <span class="data-sources-state ${badge.cls}">${escapeHtml(badge.label)}</span>
      </div>
      ${d.notice && d.noticeFor === id ? `<p class="data-sources-notice" role="status">${escapeHtml(d.notice)}</p>` : ""}
      ${d.staleAfterWrite === id ? `<p class="data-sources-warn" role="status">The request was settled, but the connection could not be read again afterwards, so the facts below may be out of date. Open the tab again before the next change.</p>` : ""}
      <dl class="data-sources-facts">
        <dt>Account</dt><dd>${escapeHtml(connection.accountLabel || "")}</dd>
        <dt>Credential</dt><dd>${connection.hasCredential ? "Access token stored, encrypted. It is never shown." : "None stored yet."}</dd>
        <dt>Last verified</dt><dd>${connection.lastVerifiedAt ? escapeHtml(fmtDateTime(connection.lastVerifiedAt)) : "Never"}</dd>
        ${connection.lastErrorCode ? `<dt>Last problem</dt><dd>${escapeHtml(lastProblemText(connection.lastErrorCode))}${connection.lastErrorAt ? ` (${escapeHtml(fmtDateTime(connection.lastErrorAt))})` : ""}</dd>` : ""}
        <dt>Bound teams</dt><dd>${bound.length ? escapeHtml(plural(bound.length, "team", "teams")) : "None yet"}</dd>
      </dl>
      ${pending ? renderUnconfirmedHtml(d, pending) : ""}
      ${d.credentialOpen && String(d.credentialOpen.connectionId) === id ? renderCredentialFormHtml(d, connection, clubName) : ""}
      ${d.bindReview && String(d.bindReview.connectionId) === id ? renderBindReviewHtml(d, connection, clubName) : ""}
      ${d.unbindOpen && String(d.unbindOpen.connectionId) === id ? renderUnbindFormHtml(d, connection) : ""}
      ${formOpen || pending ? "" : renderActionsHtml(d, connection, attempt, busy)}
      ${!formOpen && d.testError && String(d.testError.connectionId) === id ? errorHtml(d.testError, d.testError.context || "") : ""}
      ${!formOpen && d.unbindError && String(d.unbindError.connectionId) === id ? errorHtml(d.unbindError) : ""}
      ${attempt && !formOpen ? renderAttemptHtml(d, ctx, connection, attempt, busy) : ""}
      ${renderBoundTeamsHtml(d, connection, busy, formOpen)}
      ${d.ended && d.noticeFor === id ? renderEndedHtml(d.ended) : ""}
    </section>
  `;
}

function renderActionsHtml(d, connection, attempt, busy) {
  const id = String(connection.id);
  const hasCredential = connection.hasCredential === true;
  const testing = d.testBusy === id;
  return `
    <div class="data-sources-form-actions source-connections-actions">
      ${hasCredential ? `
        <button class="plain-button ${connection.state === "needs_reconnect" ? "" : "data-sources-primary"}" type="button" data-action="source-connections-test" data-connection-id="${escapeAttr(id)}" ${busy ? "disabled" : ""}>${testing ? "Testing..." : "Test connection"}</button>
        <button class="plain-button ${connection.state === "needs_reconnect" ? "data-sources-primary" : ""}" type="button" data-action="source-connections-reconnect-open" data-connection-id="${escapeAttr(id)}" ${busy ? "disabled" : ""}>Reconnect</button>
        ${attempt?.result?.sourceTeams && connection.state === "verified" ? `<button class="plain-button" type="button" data-action="source-connections-toggle-teams" data-connection-id="${escapeAttr(id)}" aria-expanded="${d.teamsOpen === id ? "true" : "false"}" aria-controls="source-connections-teams-${escapeAttr(id)}">${d.teamsOpen === id ? `Hide ${escapeHtml(SOURCE_NAME)} teams` : `Show ${escapeHtml(SOURCE_NAME)} teams`}</button>` : ""}
      ` : `
        <button class="plain-button data-sources-primary" type="button" data-action="source-connections-connect-open" data-connection-id="${escapeAttr(id)}" ${busy ? "disabled" : ""}>Connect account</button>
      `}
    </div>
    ${hasCredential && !attempt ? `<p class="muted">Test the connection to list the ${escapeHtml(SOURCE_NAME)} teams this account can see; a team is bound from that list.</p>` : ""}
  `;
}

// The username and the password: one form, one request, nothing kept. The
// password field asks the browser not to offer or save a password
// (autocomplete="new-password" is the hint browsers honour); the username
// field is plain text with autocomplete off.
function renderCredentialFormHtml(d, connection, clubName) {
  const reconnect = d.credentialOpen.action === "reconnect";
  const bound = (connection.boundTeams || []).length;
  return `
    <form class="data-sources-form source-connections-credential" data-source-connections-form="credential" method="post" action="#" autocomplete="off">
      <p class="data-sources-form-title">${reconnect ? `Reconnect the ${escapeHtml(SOURCE_NAME)} account` : `Connect the ${escapeHtml(SOURCE_NAME)} account`}</p>
      ${reconnect ? `
        <p class="data-sources-warn">This replaces the stored credential of the <strong>${escapeHtml(SOURCE_NAME)}</strong> connection of <strong>${escapeHtml(clubName || "this club")}</strong> (${escapeHtml(connection.accountLabel || "")} on ${escapeHtml(hostLabelOf(connection))}). ${bound ? `<strong>${escapeHtml(plural(bound, "bound team", "bound teams"))}</strong> will read through the new one.` : "<strong>No team is bound yet.</strong>"} The old credential is never shown and cannot be recovered. If ${escapeHtml(SOURCE_NAME)} refuses the new username and password, the stored credential stays as it is.</p>
      ` : `
        <p class="muted">${escapeHtml(connection.accountLabel || "")} on ${escapeHtml(hostLabelOf(connection))}.</p>
      `}
      <label class="search-field"><span>${escapeHtml(SOURCE_NAME)} username</span>
        <input name="username" type="text" required maxlength="254" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" inputmode="email" data-1p-ignore data-lpignore="true" data-bwignore data-form-type="other">
      </label>
      <label class="search-field"><span>${escapeHtml(SOURCE_NAME)} password</span>
        <input name="password" type="password" required maxlength="512" autocomplete="new-password" autocapitalize="off" spellcheck="false" data-1p-ignore data-lpignore="true" data-bwignore data-form-type="other">
      </label>
      <p class="muted source-connections-note">The password is exchanged for an access token right away, in this one request. OptiMove stores only that token, encrypted; the password is not saved anywhere and is never shown. ${escapeHtml(SOURCE_NAME)} is read once to check the token${bound ? " and every bound team" : ""}; nothing is imported.</p>
      ${errorHtml(d.credentialError, "credential")}
      <div class="data-sources-form-actions">
        <button class="plain-button data-sources-primary" type="submit" ${d.credentialBusy ? "disabled" : ""}>${d.credentialBusy ? (reconnect ? "Reconnecting..." : "Connecting...") : (reconnect ? "Reconnect" : "Connect")}</button>
        <button class="plain-button ghost" type="button" data-action="source-connections-cancel" ${d.credentialBusy ? "disabled" : ""}>Cancel</button>
      </div>
    </form>
  `;
}

// A lost answer. Nothing is repeated blindly: a Connect / Reconnect / Test is
// checked by reading the connection again; an Unbind or a bind is asked of
// the server again with the same key / pair, which it answers idempotently.
function renderUnconfirmedHtml(d, pending) {
  const what = pending.action === "unbind" ? "Unbind" : pending.action === "bind" ? "binding" : pending.action === "reconnect" ? "Reconnect" : pending.action === "test" ? "test" : pending.action === "create" ? "creation of the connection" : "Connect";
  return `
    <div class="data-sources-error source-connections-unconfirmed" role="alert">
      <p><strong>Result not confirmed.</strong> The answer to the ${escapeHtml(what)} was lost, so this screen cannot say whether it was made. ${pending.action === "unbind" || pending.action === "bind"
        ? "Check result asks the server for the same request again - it is never done twice."
        : pending.action === "create"
          ? "Check result reads the club's connections again."
          : "Check result reads the connection again; the username and password are not sent again."}</p>
      <div class="data-sources-form-actions">
        <button class="plain-button data-sources-primary" type="button" data-action="source-connections-check-result" ${d.checkBusy ? "disabled" : ""}>${d.checkBusy ? "Checking..." : "Check result"}</button>
      </div>
    </div>
  `;
}

function renderAttemptHtml(d, ctx, connection, attempt, busy) {
  const id = String(connection.id);
  const result = attempt.result || {};
  const teams = Array.isArray(result.sourceTeams) ? result.sourceTeams : null;
  const bound = connection.boundTeams || [];
  const open = d.teamsOpen === id;
  const verb = attempt.action === "test" ? "test" : attempt.action === "reconnect" ? "reconnect" : "connect";
  const stamp = `The last ${verb} (${fmtDateTime(attempt.at)})`;
  const outcomeText = result.outcome === "ok"
    ? `${stamp} succeeded${result.boundTeamsChecked ? `; ${plural(result.boundTeamsChecked, "bound team was", "bound teams were")} read` : ""}.`
    : result.outcome === "refused"
      ? `${stamp} was refused by ${SOURCE_NAME}: the stored credential does not work. Reconnect with a working username and password.`
      : result.state === "linked_untested" && verb !== "test"
        ? `${stamp} stored the access token, but the check read did not succeed (${lastProblemText(result.code) || "no answer"}). Test the connection.`
        : `${stamp} did not succeed: ${connectionMessage({ code: result.code })}`;
  return `
    <div class="source-connections-attempt">
      <p class="${result.outcome === "ok" ? "muted" : "data-sources-warn"}">${escapeHtml(outcomeText)}</p>
      ${teams && open ? `
        <div class="source-connections-teams" id="source-connections-teams-${escapeAttr(id)}">
          <p class="data-sources-form-title">${escapeHtml(SOURCE_NAME)} teams this account can see${typeof result.sourceTeamCount === "number" ? ` (${result.sourceTeamCount})` : ""}${result.sourceTeamsTruncated ? " - first page only" : ""}</p>
          <p class="muted">${ctx.basis === "platform_admin"
            ? "Every team the account sees, with the approved OptiMove team where a pair exists under Data sources. Nothing is preselected; a team is bound only from here, after a review."
            : "Only the teams approved for one of your club's OptiMove teams are listed. A team the account sees without an approved pair is not shown here; ask a platform admin to approve it under Data sources."}</p>
          ${teams.length ? `
            <ul class="source-connections-team-list">
              ${teams.map((team) => {
                const sourceTeamId = String(team.sourceTeamId);
                const boundRow = bound.find((b) => String(b.sourceTeamId) === sourceTeamId || (team.approvedTeamId && String(b.teamId) === String(team.approvedTeamId)));
                return `
                  <li>
                    <div>
                      <strong>${escapeHtml(SOURCE_NAME)} team ${escapeHtml(sourceTeamId)}</strong>
                      ${team.name ? `<span class="muted">${escapeHtml(team.name)}</span>` : ""}
                      <span class="muted">${team.approvedTeamId ? `Approved for ${escapeHtml(team.approvedTeamName || "an OptiMove team")}` : "No approved OptiMove team yet"}</span>
                    </div>
                    ${boundRow
                      ? `<span class="data-sources-state is-on">Bound${boundRow.teamName ? ` · ${escapeHtml(boundRow.teamName)}` : ""}</span>`
                      : team.approvedTeamId
                        ? `<button class="plain-button" type="button" data-action="source-connections-bind-open" data-connection-id="${escapeAttr(id)}" data-team-id="${escapeAttr(String(team.approvedTeamId))}" data-team-name="${escapeAttr(team.approvedTeamName || "")}" data-source-team-id="${escapeAttr(sourceTeamId)}" data-source-team-name="${escapeAttr(team.name || "")}" ${busy || connection.state !== "verified" ? "disabled" : ""}>Bind</button>`
                        : ctx.basis === "platform_admin"
                          ? `<button class="plain-button ghost" type="button" data-action="source-connections-open-pair" data-connection-id="${escapeAttr(id)}" ${busy ? "disabled" : ""}>Set the pair for ${escapeHtml(SOURCE_NAME)} team ${escapeHtml(sourceTeamId)} in Data sources</button>`
                          : ""}
                  </li>
                `;
              }).join("")}
            </ul>
          ` : `<p class="muted">${ctx.basis === "platform_admin" ? "The account sees no team." : "None of the teams this account sees is approved for your club yet."}</p>`}
          <p class="muted">After a pair is set or changed under Data sources, run Test connection again to refresh this list.</p>
        </div>
      ` : ""}
      ${result.sourceTeamsUnavailable ? `<p class="data-sources-warn">The ${escapeHtml(SOURCE_NAME)} team list is withheld right now: the approved pairs under Data sources name the same ${escapeHtml(SOURCE_NAME)} team twice. A platform admin has to settle that first.</p>` : ""}
    </div>
  `;
}

// Both sides and every fact named, before anything is written.
function renderBindReviewHtml(d, connection, clubName) {
  const review = d.bindReview;
  return `
    <div class="data-sources-confirm">
      <p class="data-sources-form-title">Review the binding</p>
      <p class="data-sources-confirm-line"><strong>${escapeHtml(review.teamName)}</strong> ↔ <strong>${escapeHtml(SOURCE_NAME)} team ${escapeHtml(review.sourceTeamId)}</strong></p>
      <dl class="data-sources-facts">
        <dt>Source</dt><dd>${escapeHtml(SOURCE_NAME)}</dd>
        <dt>Host</dt><dd>${escapeHtml(hostLabelOf(connection))}</dd>
        <dt>Club</dt><dd>${escapeHtml(clubName || "")}</dd>
        <dt>OptiMove team</dt><dd>${escapeHtml(review.teamName)}</dd>
        <dt>${escapeHtml(SOURCE_NAME)} team</dt><dd>${escapeHtml(review.sourceTeamId)}${review.sourceTeamName ? ` · ${escapeHtml(review.sourceTeamName)}` : ""}</dd>
      </dl>
      <p>From now on ${escapeHtml(review.teamName)}'s checks read ${escapeHtml(SOURCE_NAME)} team ${escapeHtml(review.sourceTeamId)} through this connection's stored token. The older server-wide ${escapeHtml(SOURCE_NAME)} access (the environment token) is never used for this team again - not even after an Unbind. The server reads that team once more before anything is stored, and nothing is imported by this step.</p>
      ${errorHtml(d.bindError)}
      <div class="data-sources-form-actions">
        <button class="plain-button data-sources-primary" type="button" data-action="source-connections-bind-confirm" ${d.bindBusy ? "disabled" : ""}>${d.bindBusy ? "Binding..." : "Confirm binding"}</button>
        <button class="plain-button ghost" type="button" data-action="source-connections-cancel" ${d.bindBusy ? "disabled" : ""}>Cancel</button>
      </div>
    </div>
  `;
}

function renderBoundTeamsHtml(d, connection, busy, formOpen) {
  const bound = connection.boundTeams || [];
  if (!bound.length) return "";
  return `
    <div class="source-connections-bound">
      <p class="data-sources-form-title">Bound teams</p>
      <ul class="data-sources-people source-connections-bound-list">
        ${bound.map((b) => `
          <li>
            <div>
              <strong>${escapeHtml(b.teamName || "Team")}${b.teamActive === false ? " (archived)" : ""}</strong>
              <span class="muted">${escapeHtml(SOURCE_NAME)} team ${escapeHtml(String(b.sourceTeamId))} · since ${escapeHtml(fmtDateTime(b.boundAt))}</span>
            </div>
            <button class="plain-button ghost" type="button" data-action="source-connections-unbind-open" data-connection-id="${escapeAttr(String(connection.id))}" data-binding-id="${escapeAttr(String(b.bindingId))}" data-team-id="${escapeAttr(String(b.teamId))}" data-team-name="${escapeAttr(b.teamName || "Team")}" data-source-team-id="${escapeAttr(String(b.sourceTeamId))}" ${busy || formOpen ? "disabled" : ""}>Unbind</button>
          </li>
        `).join("")}
      </ul>
    </div>
  `;
}

function renderUnbindFormHtml(d, connection) {
  const open = d.unbindOpen;
  return `
    <form class="data-sources-confirm" data-source-connections-form="unbind">
      <p class="data-sources-confirm-line">End the binding of <strong>${escapeHtml(open.teamName)}</strong> to <strong>${escapeHtml(SOURCE_NAME)} team ${escapeHtml(open.sourceTeamId)}</strong></p>
      <p class="data-sources-warn">After this, ${escapeHtml(open.teamName)} reads nothing from ${escapeHtml(SOURCE_NAME)} until it is bound again. <strong>It does not fall back to the older server-wide ${escapeHtml(SOURCE_NAME)} access (the environment token).</strong> The ended binding stays recorded on the server (this screen lists active bindings only); sessions already imported stay as they are. ${escapeHtml(SOURCE_NAME)} is not contacted by this step.</p>
      <label class="search-field"><span>Reason (kept in the record)</span>
        <textarea name="reason" required maxlength="${UNBIND_REASON_MAX}" rows="2" placeholder="Short note for the record">${escapeHtml(open.reason || "")}</textarea>
      </label>
      ${errorHtml(d.unbindError)}
      <div class="data-sources-form-actions">
        <button class="plain-button data-sources-primary source-connections-danger" type="submit" ${d.unbindBusy ? "disabled" : ""}>${d.unbindBusy ? "Ending..." : "End the binding"}</button>
        <button class="plain-button ghost" type="button" data-action="source-connections-cancel" ${d.unbindBusy ? "disabled" : ""}>Cancel</button>
      </div>
    </form>
  `;
}

function renderEndedHtml(ended) {
  return `
    <details class="data-sources-history" open>
      <summary>Ended just now</summary>
      <ul>
        <li>
          <strong>${escapeHtml(ended.teamName || "Team")} · ${escapeHtml(SOURCE_NAME)} team ${escapeHtml(String(ended.sourceTeamId))}</strong>
          <span class="muted">bound ${escapeHtml(fmtDateTime(ended.boundAt))} - ended ${escapeHtml(fmtDateTime(ended.endedAt))}</span>
          ${ended.endReason ? `<span class="data-sources-history-reason">${escapeHtml(ended.endReason)}</span>` : ""}
        </li>
      </ul>
    </details>
  `;
}
