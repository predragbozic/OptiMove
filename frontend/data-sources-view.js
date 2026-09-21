// Settings -> Data sources (phase F3b): what a platform admin sees.
//
// An administrative screen, not a technical panel: one primary action per
// section, plain language, and every error code hidden inside "Technical
// details". The only technical value shown in the open is the GPEXE Team ID
// itself, because the admin has to type it.
//
// Carbon informs the structure (one card per source, status first, the
// destructive step behind a named confirmation) - it is a design reference
// only, nothing from Carbon runs here.
import { dataSourcesTeamOptions, SETTINGS_HISTORY_LIMIT, selectedTeam, teamCoachOptions } from "./data-sources-data.js";
import { renderFilterableSelect } from "./organization-select.js";
import { state } from "./state.js";
import { escapeAttr, escapeHtml } from "./utils.js";

// What each refusal means for the admin who is reading it. The server's own
// message is kept for "Technical details"; this is the sentence that says
// what happened and what to do next. Nothing here promises a function that
// does not exist: there is no in-app way to move imported results to another
// GPEXE team.
export function adminMessage(info) {
  if (!info) return "";
  const code = info.code || "";
  if (code === "gpexe_team_change_blocked") {
    return "This team has already used its current GPEXE team - a check has run, an athlete is linked, or sessions are imported - so the connection stays as it is. A GPEXE athlete number and a session id mean something only inside one GPEXE team, so moving this team to another one is not supported: not here, and not for a platform administrator either. If the number is wrong, stop before any further import and decide with the owner what happens to what is already there. Technical details says what exactly is in the way.";
  }
  if (code === "gpexe_orphan_data") {
    return "This team already carries GPEXE data, but no connection is recorded. Connecting it now would read that data as the new team's own, so it is refused. There is no procedure for clearing it yet - it has to be decided with the owner before this team is connected.";
  }
  if (code === "gpexe_team_taken") return "That GPEXE team already feeds another OptiMove team. Check the number - one GPEXE team feeds one OptiMove team.";
  if (code === "gpexe_change_busy") return "A check or an import is running for this team. Try again when it has finished.";
  if (code === "invalid_gpexe_team_id") return "A GPEXE Team ID is a number of up to 12 digits.";
  if (code === "change_reason_required") return "Changing a connection that already exists needs a reason.";
  if (code === "change_reason_too_long") return "The reason is too long (at most 500 characters).";
  if (code === "reason_required") return "A reason is required.";
  if (code === "already_granted") return "This coach already has approval rights for this team.";
  if (code === "grantee_not_team_coach") return "Only an active coach of this team can be given approval rights.";
  if (info.status === 403) return "This needs platform admin access, which this account does not have (any more). Reload the app before trying again.";
  // A grant that is already gone answers the same 404 as a team that is not
  // there - the team is fine, so it must not say "choose a team again".
  if (info.status === 404 && info.scope === "grant") return "This right no longer exists. The list below is up to date.";
  if (info.status === 404) return "This team is not available in your workspace any more. Choose a team again.";
  if (info.status === 0) return "We can't tell whether the change was made. Reload this screen and check the state before trying again.";
  return "That did not work. Nothing was changed.";
}

function techHtml(entries) {
  const rows = entries.filter(([, value]) => value !== undefined && value !== null && value !== "");
  if (!rows.length) return "";
  return `<details class="data-sources-tech"><summary>Technical details</summary><dl>${rows
    .map(([key, value]) => `<dt>${escapeHtml(key)}</dt><dd>${escapeHtml(String(value))}</dd>`)
    .join("")}</dl></details>`;
}

function errorHtml(info) {
  if (!info) return "";
  return `
    <div class="data-sources-error" role="alert">
      <p>${escapeHtml(adminMessage(info))}</p>
      ${techHtml([["HTTP status", info.status || "no answer"], ["Code", info.code], ["Server message", info.message]])}
    </div>
  `;
}

function fmtDateTime(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const two = (n) => String(n).padStart(2, "0");
  return `${two(date.getDate())}.${two(date.getMonth() + 1)}.${date.getFullYear()} ${two(date.getHours())}:${two(date.getMinutes())}`;
}

export function renderDataSourcesPanelHtml() {
  const d = state.dataSources;
  const team = selectedTeam();
  return `
    <section class="panel data-sources">
      <div class="data-sources-head">
        <p class="eyebrow">Platform</p>
        <h3>Data sources</h3>
        <p class="muted">Connect a team to the system its training data comes from, and decide which coaches may approve what that system sends. Only a platform admin sees this screen.</p>
      </div>
      ${renderTeamPickerHtml(d, team)}
      ${team ? renderTeamHtml(d, team) : ""}
    </section>
  `;
}

function renderTeamPickerHtml(d, team) {
  const options = dataSourcesTeamOptions();
  return `
    <form class="data-sources-team-form" data-data-sources-form="team">
      ${renderFilterableSelect({ name: "teamId", label: "Team", options, value: d.teamId, required: true, placeholder: "Type a team name" })}
      <button class="plain-button" type="submit" ${options.length ? "" : "disabled"}>Open team</button>
      ${options.length ? "" : `<p class="muted">No team is available in this workspace yet. Add one under Settings &gt; Teams first.</p>`}
    </form>
    ${team
      ? `<p class="data-sources-team">${escapeHtml(team.clubName ? `${team.clubName} · ${team.name}` : team.name)}</p>`
      : `<p class="muted data-sources-empty">Choose a team above to see its data sources.</p>`}
  `;
}

function renderTeamHtml(d, team) {
  if (d.loading && !d.status) return `<p class="muted">Loading...</p>`;
  // A read that failed says exactly that. If a write had just succeeded,
  // its answer stays on screen and the sentence says what is stale - a
  // change that was saved must never be reported as "nothing was changed".
  if (d.error) {
    return `
      <div class="data-sources-error" role="alert">
        <p>${d.notice
          ? `${escapeHtml(d.notice)} That change was saved, but this team could not be read again afterwards, so what is on screen is not up to date. Open the team again before making another change.`
          : "This team's data sources could not be loaded, so nothing is shown yet. Nothing was changed."}</p>
        ${techHtml([["HTTP status", d.error.status || "no answer"], ["Code", d.error.code], ["Server message", d.error.message]])}
        <button class="plain-button data-sources-primary" type="button" data-action="data-sources-reload">Try again</button>
      </div>
    `;
  }
  if (!d.status) return "";
  return `
    ${renderGpexeCardHtml(d, team)}
    ${renderApproversCardHtml(d, team)}
  `;
}

// ---------------------------------------------------------------------------
// GPEXE - the connection
// ---------------------------------------------------------------------------

function renderGpexeCardHtml(d, team) {
  const settings = d.status?.settings || null;
  const connected = Boolean(settings);
  return `
    <section class="data-sources-card">
      <div class="data-sources-card-head">
        <h4>GPEXE</h4>
        <span class="data-sources-state ${connected ? "is-on" : "is-off"}">${connected ? "Connected" : "Not connected"}</span>
      </div>
      ${d.notice && d.noticeFor === "connect" ? `<p class="data-sources-notice" role="status">${escapeHtml(d.notice)}</p>` : ""}
      ${d.status?.importSwitch?.enabled ? "" : `<p class="muted data-sources-switch">Import writing is off in this environment: coaches can check for sessions and review them, but nothing is written until it is turned on.</p>`}
      ${connected ? `
        <dl class="data-sources-facts">
          <dt>GPEXE Team ID</dt><dd>${escapeHtml(settings.gpexeTeamId)}</dd>
          <dt>Connected</dt><dd>${escapeHtml(fmtDateTime(settings.configuredAt))}</dd>
          ${settings.configuredByName ? `<dt>By</dt><dd>${escapeHtml(settings.configuredByName)}</dd>` : ""}
          ${settings.changeReason ? `<dt>Why it was set</dt><dd>${escapeHtml(settings.changeReason)}</dd>` : ""}
        </dl>
      ` : `<p class="muted">This team is not reading from GPEXE yet. Its coaches see no sessions until it is connected.</p>`}
      ${d.connectConfirm ? renderConnectConfirmHtml(d, team, connected) : d.connectOpen ? renderConnectFormHtml(d, connected) : (connected && d.status?.lastCheck
        ? `<p class="data-sources-warn">A check has already been started for this team, so its GPEXE team is final and cannot be changed any more - not here, and not for a platform administrator either.</p>`
        : `<button class="plain-button data-sources-primary" type="button" data-action="data-sources-connect-open">${connected ? "Change GPEXE team" : "Connect GPEXE"}</button>`)}
      ${!d.connectConfirm && !d.connectOpen ? errorHtml(d.connectError) : ""}
      ${renderHistoryHtml(d)}
    </section>
  `;
}

function renderConnectFormHtml(d, connected) {
  const draft = d.connectDraft || { gpexeTeamId: "", reason: "" };
  return `
    <form class="data-sources-form" data-data-sources-form="connect">
      <p class="data-sources-form-title">${connected ? "Change the GPEXE team" : "Connect this team to GPEXE"}</p>
      <label class="search-field"><span>GPEXE Team ID</span>
        <input name="gpexeTeamId" inputmode="numeric" pattern="[0-9]{1,12}" required autocomplete="off" value="${escapeAttr(draft.gpexeTeamId)}" placeholder="e.g. 1473">
      </label>
      <p class="muted">The number GPEXE uses for that team. It is not checked against GPEXE here, and a wrong number can only be corrected before the first check runs.</p>
      ${connected ? `
        <label class="search-field"><span>Why is it changing?</span>
          <textarea name="reason" required maxlength="500" rows="2" placeholder="Short note for the record">${escapeHtml(draft.reason)}</textarea>
        </label>
        <p class="data-sources-warn">A GPEXE athlete number and session id mean something only inside one GPEXE team. Once a check has been started for this team, or an athlete is linked, its GPEXE team is final - not here, and not for a platform administrator either.</p>
      ` : `
        <label class="search-field"><span>Note (optional)</span>
          <textarea name="reason" maxlength="500" rows="2" placeholder="Kept with the record">${escapeHtml(draft.reason)}</textarea>
        </label>
        <p class="data-sources-warn">Check the number before you confirm. There is no Disconnect, and as soon as a check has been started for this team its GPEXE team is final - not here, and not for a platform administrator either.</p>
      `}
      ${errorHtml(d.connectError)}
      <div class="data-sources-form-actions">
        <button class="plain-button" type="submit">Review</button>
        <button class="plain-button ghost" type="button" data-action="data-sources-cancel">Cancel</button>
      </div>
    </form>
  `;
}

// Both sides named, and what it means, before anything is written.
function renderConnectConfirmHtml(d, team, connected) {
  const confirm = d.connectConfirm;
  const current = d.status?.settings?.gpexeTeamId || "";
  const teamName = team.clubName ? `${team.clubName} · ${team.name}` : team.name;
  const sameValue = current && String(current) === String(confirm.gpexeTeamId);
  return `
    <div class="data-sources-confirm">
      <p class="data-sources-confirm-line"><strong>GPEXE team ${escapeHtml(confirm.gpexeTeamId)}</strong> → <strong>${escapeHtml(teamName)}</strong></p>
      <p>${sameValue
        ? "This is the team's current GPEXE team, so nothing will change."
        : connected
          ? `From now on this team reads its sessions from GPEXE team ${escapeHtml(confirm.gpexeTeamId)} instead of ${escapeHtml(String(current))}. A change is only accepted while nothing has been read from GPEXE for this team, so it may still be refused - the server decides. Once it is accepted, its GPEXE team is final.`
          : "From now on this team's sessions and athlete numbers are read from that GPEXE team. Nothing is imported by this step, and there is no Disconnect: once a check has been started, its GPEXE team is final - not here, and not for a platform administrator either."}</p>
      ${confirm.reason ? `<p class="muted">Reason: ${escapeHtml(confirm.reason)}</p>` : ""}
      ${errorHtml(d.connectError)}
      <div class="data-sources-form-actions">
        <button class="plain-button data-sources-primary" type="button" data-action="data-sources-connect-save" ${d.connectBusy ? "disabled" : ""}>${d.connectBusy ? "Saving..." : "Confirm"}</button>
        <button class="plain-button ghost" type="button" data-action="data-sources-cancel" ${d.connectBusy ? "disabled" : ""}>Cancel</button>
      </div>
    </div>
  `;
}

function renderHistoryHtml(d) {
  // Every write appends a row, the newest of which is the value shown above
  // ("Connected"), so only the ones before it are earlier values.
  const current = d.status?.settings?.configuredAt;
  const page = d.history || [];
  const rows = page.filter((row) => !current || String(row.configuredAt) !== String(current));
  if (!rows.length) return "";
  return `
    <details class="data-sources-history" ${d.historyOpen ? "open" : ""}>
      <summary data-action="data-sources-toggle-history">Earlier values (${page.length >= SETTINGS_HISTORY_LIMIT ? `${rows.length} most recent` : rows.length})</summary>
      <ul>
        ${rows.map((row) => `
          <li>
            <strong>GPEXE team ${escapeHtml(row.gpexeTeamId)}</strong>
            <span class="muted">${escapeHtml(fmtDateTime(row.configuredAt))}${row.configuredByName ? ` · ${escapeHtml(row.configuredByName)}` : ""}</span>
            ${row.changeReason ? `<span class="data-sources-history-reason">${escapeHtml(row.changeReason)}</span>` : ""}
          </li>
        `).join("")}
      </ul>
    </details>
  `;
}

// ---------------------------------------------------------------------------
// Who may approve an import
// ---------------------------------------------------------------------------

function renderApproversCardHtml(d, team) {
  const rows = d.approvers || [];
  const active = rows.filter((row) => row.active);
  const past = rows.filter((row) => !row.active);
  const coaches = teamCoachOptions();
  return `
    <section class="data-sources-card">
      <div class="data-sources-card-head">
        <h4>Who may approve imports</h4>
        <span class="data-sources-state ${active.length ? "is-on" : "is-off"}">${active.length ? `${active.length} ${active.length === 1 ? "coach" : "coaches"} with rights` : "No coach yet"}</span>
      </div>
      ${d.notice && d.noticeFor === "approvers" ? `<p class="data-sources-notice" role="status">${escapeHtml(d.notice)}</p>` : ""}
      <p class="muted">A platform admin can always approve. A coach of this team needs to be given the right here.</p>
      ${active.length ? `
        <ul class="data-sources-people">
          ${active.map((row) => `
            <li>
              <div>
                <strong>${escapeHtml(row.userName)}</strong>
                <span class="muted">Since ${escapeHtml(fmtDateTime(row.grantedAt))}</span>
                ${row.grantReason ? `<span class="muted">${escapeHtml(row.grantReason)}</span>` : ""}
              </div>
              <button class="plain-button ghost" type="button" data-action="data-sources-revoke-open" data-grant-id="${escapeAttr(row.id)}" data-user-name="${escapeAttr(row.userName)}">Remove rights</button>
            </li>
          `).join("")}
        </ul>
      ` : `<p class="muted">No coach of this team can approve an import yet.</p>`}
      ${d.revokeConfirm ? renderRevokeConfirmHtml(d, team) : ""}
      ${d.grantConfirm ? renderGrantConfirmHtml(d, team) : d.grantOpen ? renderGrantFormHtml(d, coaches) : `
        <button class="plain-button data-sources-primary" type="button" data-action="data-sources-grant-open" ${coaches.length ? "" : "disabled"}>Give approval rights</button>
        ${coaches.length ? "" : (active.length
          ? `<p class="muted">Every active coach of this team already has the right.</p>`
          : `<p class="muted">This team has no active coach yet. Add one under Settings &gt; Users first.</p>`)}
      `}
      ${!d.grantOpen && !d.grantConfirm && !d.revokeConfirm ? `${errorHtml(d.grantError)}${errorHtml(d.revokeError)}` : ""}
      ${past.length ? `
        <details class="data-sources-history">
          <summary>Rights removed earlier (${past.length})</summary>
          <ul>
            ${past.map((row) => `
              <li>
                <strong>${escapeHtml(row.userName)}</strong>
                <span class="muted">${escapeHtml(fmtDateTime(row.grantedAt))} - ${escapeHtml(fmtDateTime(row.revokedAt))}</span>
                ${row.revokeReason ? `<span class="data-sources-history-reason">${escapeHtml(row.revokeReason)}</span>` : ""}
              </li>
            `).join("")}
          </ul>
        </details>
      ` : ""}
    </section>
  `;
}

// No coach is preselected: the first option is an empty one, so a mistaken
// submit cannot name somebody.
function renderGrantFormHtml(d, coaches) {
  return `
    <form class="data-sources-form" data-data-sources-form="grant">
      <p class="data-sources-form-title">Give approval rights</p>
      <label class="search-field"><span>Coach</span>
        <select name="userId" required>
          <option value="">Choose a coach</option>
          ${coaches.map((coach) => `<option value="${escapeAttr(coach.value)}">${escapeHtml(coach.label)}</option>`).join("")}
        </select>
      </label>
      <label class="search-field"><span>Why?</span>
        <textarea name="reason" required maxlength="500" rows="2" placeholder="Short note for the record"></textarea>
      </label>
      ${errorHtml(d.grantError)}
      <div class="data-sources-form-actions">
        <button class="plain-button" type="submit">Review</button>
        <button class="plain-button ghost" type="button" data-action="data-sources-cancel">Cancel</button>
      </div>
    </form>
  `;
}

function renderGrantConfirmHtml(d, team) {
  const confirm = d.grantConfirm;
  const teamName = team.clubName ? `${team.clubName} · ${team.name}` : team.name;
  return `
    <div class="data-sources-confirm">
      <p class="data-sources-confirm-line"><strong>${escapeHtml(confirm.userName)}</strong> → <strong>${escapeHtml(teamName)}</strong></p>
      <p>${escapeHtml(confirm.userName)} will be able to approve GPEXE imports for ${escapeHtml(teamName)}. An approved session is written into the team's results.</p>
      <p class="muted">Reason: ${escapeHtml(confirm.reason)}</p>
      ${errorHtml(d.grantError)}
      <div class="data-sources-form-actions">
        <button class="plain-button data-sources-primary" type="button" data-action="data-sources-grant-save" ${d.grantBusy ? "disabled" : ""}>${d.grantBusy ? "Saving..." : "Confirm"}</button>
        <button class="plain-button ghost" type="button" data-action="data-sources-cancel" ${d.grantBusy ? "disabled" : ""}>Cancel</button>
      </div>
    </div>
  `;
}

function renderRevokeConfirmHtml(d, team) {
  const confirm = d.revokeConfirm;
  const teamName = team.clubName ? `${team.clubName} · ${team.name}` : team.name;
  return `
    <form class="data-sources-confirm" data-data-sources-form="revoke">
      <p class="data-sources-confirm-line">Remove approval rights from <strong>${escapeHtml(confirm.userName)}</strong> for <strong>${escapeHtml(teamName)}</strong></p>
      <p>${escapeHtml(confirm.userName)} will no longer be able to approve GPEXE imports for this team. Sessions already imported stay as they are, and you can give the right again later.</p>
      <label class="search-field"><span>Why?</span>
        <textarea name="reason" required maxlength="500" rows="2" placeholder="Short note for the record">${escapeHtml(confirm.reason || "")}</textarea>
      </label>
      ${errorHtml(d.revokeError)}
      <div class="data-sources-form-actions">
        <button class="plain-button data-sources-primary" type="submit" ${d.revokeBusy ? "disabled" : ""}>${d.revokeBusy ? "Removing..." : "Remove rights"}</button>
        <button class="plain-button ghost" type="button" data-action="data-sources-cancel" ${d.revokeBusy ? "disabled" : ""}>Cancel</button>
      </div>
    </form>
  `;
}
