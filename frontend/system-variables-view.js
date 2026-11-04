// Training Load -> Data configuration -> Variables -> From OptiMove (7i-B2,
// J15 section 8.2): the markup of OptiMove's ready-made (system) variables in
// a club - a row's status, the detail's acts, and the cards for a copy and for
// hiding and showing one. Every text that came from the server is escaped.
// What may be done is the server's `actions` for this caller, never a guess
// from a role.
import { escapeAttr, escapeHtml } from "./utils.js";
import { HIDDEN_FILTERS, STATUS_LABEL, clubFacts, statusOf } from "./system-variables-data.js";

// ---------------------------------------------------------------------------
// A row
// ---------------------------------------------------------------------------
export function statusChipsHtml(item) {
  const facts = clubFacts(item);
  const status = statusOf(facts);
  if (!status) return "";
  return `<span class="metric-variables-status-chips"><span class="item-badge metric-variables-status metric-variables-status-${status}">${escapeHtml(STATUS_LABEL[status])}</span>${facts.copyId ? `<span class="item-badge metric-variables-status metric-variables-status-copied">Copied</span>` : ""}</span>`;
}

// "Available / Hidden by your club / All" beside the Active / Archived select.
export function renderHiddenFilterHtml(s) {
  return `
    <label class="search-field metric-variables-state"><span>Availability</span>
      <select data-metric-variables-filter="hidden">
        ${HIDDEN_FILTERS.map((o) => `<option value="${o.value}" ${s.hidden === o.value ? "selected" : ""}>${escapeHtml(o.label)}</option>`).join("")}
      </select>
    </label>`;
}

// ---------------------------------------------------------------------------
// The detail of a system variable in a club
// ---------------------------------------------------------------------------
// One primary act by state (J15 8.2): Use when not used, Copy when used and not
// copied, Open your copy when used and copied; Show again is the only act of a
// hidden variable. The others are plain buttons.
// "Use for your teams" opens the switch-on panel of OptiMove's mapping of this
// variable on the Mappings screen: one button per data source (usually one).
// The mappings are read once the variable is open; until then it waits.
function useButtons(item, sys) {
  const label = item.label || "";
  const mine = sys?.variableId === item.id ? sys : null;
  if (!mine || mine.state === "loading") return [{ primary: true, html: `<button class="plain-button data-sources-primary" type="button" disabled>Use for your teams</button>` }];
  if (mine.state === "error") return [{ primary: true, html: `<button class="plain-button data-sources-primary" type="button" data-action="metric-variables-use-reload">Use for your teams: read the data sources again</button>` }];
  return mine.rows.map((row, index, all) => ({
    primary: index === 0,
    html: `<button class="plain-button ${index === 0 ? "data-sources-primary" : "ghost"}" type="button" data-action="training-load-section" data-section="mappings" data-mm-open-mapping="${escapeAttr(row.mappingId)}" data-mm-open-version="${escapeAttr(row.versionId)}" data-mm-from-label="${escapeAttr(label)}">${all.length > 1 ? `Use for your teams: ${escapeHtml(row.fieldLabel || "data source")}` : "Use for your teams"}</button>`,
  }));
}
export function renderSystemActionsHtml(item, actions, sys) {
  const facts = clubFacts(item);
  if (!facts?.admin || item.state !== "active") return "";
  const has = (name) => actions.includes(name);
  const buttons = [];
  if (facts.hidden) {
    if (has("show")) buttons.push({ action: "metric-variables-show-open", label: "Show again", primary: true });
  } else {
    if (has("use") && !facts.usedByTeams) buttons.push(...useButtons(item, sys));
    if (facts.copyId) buttons.push({ action: "metric-variables-open", label: "Open your copy", primary: facts.usedByTeams, variableId: facts.copyId });
    else if (has("copy")) buttons.push({ action: "metric-variables-copy-open", label: "Copy to my club", primary: facts.usedByTeams });
    if (has("hide")) buttons.push({ action: "metric-variables-hide-open", label: "Hide for my club" });
  }
  if (!buttons.length) return "";
  // One primary at most, always first.
  buttons.sort((a, b) => Number(Boolean(b.primary)) - Number(Boolean(a.primary)));
  return `<div class="metric-variables-actions">${buttons.map((b, index) => b.html || `<button class="plain-button ${index === 0 && b.primary ? "data-sources-primary" : "ghost"}" type="button" data-action="${b.action}"${b.variableId ? ` data-variable-id="${escapeAttr(b.variableId)}"` : ""}>${escapeHtml(b.label)}</button>`).join("")}</div>`;
}

// Why an act is not offered, and what the variable is in this club.
export function renderSystemNotesHtml(item, actions, sys) {
  const facts = clubFacts(item);
  if (!facts || item.state !== "active") return "";
  const chips = statusChipsHtml(item);
  const lines = [];
  let seeTeams = "";
  if (facts.admin && !facts.hidden) {
    if (!facts.hasDataSource) lines.push("OptiMove has not connected a data source to it yet.");
    else if (!facts.usedByTeams && !actions.includes("use")) lines.push("Link a team to GPEXE first (Settings → Source connections).");
    if (facts.usedByTeams && !actions.includes("hide")) {
      lines.push("Hide is off while teams use it. Switch it off for your teams first.");
      const rows = sys?.variableId === item.id && sys.state === "ready" ? sys.rows : [];
      seeTeams = rows.map((row, _i, all) => `<button class="plain-button ghost" type="button" data-action="training-load-section" data-section="mappings" data-mm-open-mapping="${escapeAttr(row.mappingId)}">See the teams using it${all.length > 1 ? `: ${escapeHtml(row.fieldLabel || "data source")}` : ""}</button>`).join("");
    }
  }
  if (facts.hidden && !facts.admin) lines.push("Your club's administrator has hidden this variable. It stays in recorded values and charts already made.");
  return `${chips ? `<div class="metric-variables-status-line">${chips}</div>` : ""}${lines.map((l) => `<p class="muted">${escapeHtml(l)}</p>`).join("")}${seeTeams ? `<div class="metric-variables-seeteams">${seeTeams}</div>` : ""}`;
}

// ---------------------------------------------------------------------------
// The cards: copy, hide, show
// ---------------------------------------------------------------------------
function unconfirmedHtml(form) {
  return `
    <div class="metric-variables-unconfirmed" role="alert">
      <p><strong>Result not confirmed.</strong> No confirmation arrived, so it is not known whether it was saved. Check result sends the same request again: it is never saved twice.</p>
      ${form.checkNote ? `<p>${escapeHtml(form.checkNote)}</p>` : ""}
      <div class="data-sources-form-actions">
        <button class="plain-button data-sources-primary" type="button" data-action="metric-variables-check-result" ${form.busy ? "disabled" : ""}>${form.busy ? "Checking..." : "Check result"}</button>
        <button class="plain-button ghost" type="button" data-action="metric-variables-cancel" ${form.busy ? "disabled" : ""}>Close without checking</button>
      </div>
    </div>`;
}

function fieldHtml(form, field, label, { max, hint = "", token = false } = {}) {
  const locked = form.busy || form.unconfirmed;
  const error = form.errors[field];
  const ids = [hint ? `mv-hint-${field}` : "", error ? `mv-err-${field}` : ""].filter(Boolean).join(" ");
  return `
    <label class="search-field"><span>${escapeHtml(label)}</span>
      <input type="text" data-mv-field="${field}" value="${escapeAttr(form.draft[field] ?? "")}" ${max ? `maxlength="${max}"` : ""} autocomplete="off"${token ? ` autocapitalize="none" autocorrect="off" spellcheck="false"` : ""} ${locked ? "disabled" : ""}${ids ? ` aria-describedby="${ids}"` : ""}${error ? ` aria-invalid="true"` : ""}>
      ${hint ? `<span class="muted" id="mv-hint-${field}">${escapeHtml(hint)}</span>` : ""}
      ${error ? `<span class="metric-variables-field-error" id="mv-err-${field}">${escapeHtml(error)}</span>` : ""}
    </label>`;
}

function linksSentence(links) {
  if (links.state === "loading") return "Counting the GPEXE field links it comes with...";
  if (links.state === "error") return "It comes with its GPEXE field links, as drafts. Review and activate them on the copy's page.";
  if (links.count === 0) return "It has no GPEXE field link yet.";
  return `It comes with ${links.count} ${links.count === 1 ? "link" : "links"} to GPEXE fields, as drafts. Review and activate them on the copy's page.`;
}

const CARD = {
  copy: { title: "Copy", submit: "Copy", busy: "Copying..." },
  hide: { title: "Hide", submit: "Hide for my club", busy: "Hiding..." },
  show: { title: "Show again", submit: "Show again", busy: "Showing..." },
};

export function renderSystemFormHtml(form) {
  const card = CARD[form.mode];
  const name = escapeHtml(form.variableLabel);
  let body = "";
  if (form.mode === "copy") {
    body = `
      <p class="muted">Do not enter athlete names, ids, dates of birth or measured values.</p>
      ${fieldHtml(form, "label", "Name", { max: 80 })}
      <p>${escapeHtml(linksSentence(form.links))}</p>
      <p>It will not follow later changes OptiMove makes.</p>
      <details class="data-sources-tech" ${form.errors.key ? "open" : ""}><summary>Advanced</summary>
        ${fieldHtml(form, "key", "Key", { max: 63, token: true, hint: "Keep it unless you have a reason to change it. It cannot be changed later." })}
      </details>`;
  } else if (form.mode === "hide") {
    body = `<p>${name} disappears from this club's lists and pickers, and from those of its teams' coaches. Recorded values, results and charts already made stay.</p>`;
  } else {
    body = `<p>${name} is listed again in this club's lists and pickers, and in those of its teams' coaches.</p>`;
  }
  return `
    <form class="data-sources-form metric-variables-form" data-metric-variables-form="${form.mode}" novalidate autocomplete="off">
      <h2 id="metric-variables-title">${card.title} ${name}${form.mode === "copy" ? " to my club" : form.mode === "hide" ? " for my club" : ""}</h2>
      ${body}
      ${form.error ? `<p class="error" role="alert">${escapeHtml(form.error)}</p>` : ""}
      ${form.unconfirmed ? unconfirmedHtml(form) : `
        <div class="data-sources-form-actions">
          <button class="plain-button data-sources-primary" type="submit" ${form.busy ? "disabled" : ""}>${form.busy ? card.busy : card.submit}</button>
          <button class="plain-button ghost" type="button" data-action="metric-variables-cancel" ${form.busy ? "disabled" : ""}>Cancel</button>
        </div>`}
    </form>`;
}

// ---------------------------------------------------------------------------
// On a copy: Move your teams to this copy (J15 8.2)
// ---------------------------------------------------------------------------
const REQUIREMENT = { required: "Required", optional: "Optional" };
const OUTCOME = { moved: "Moved", refused: "Not moved", unknown: "Result not confirmed" };

function moveTeamsHtml(move, { withOutcome }) {
  // Without the outcomes (the list before the review) a team already moved is not "still" on OptiMove's variable.
  const teams = withOutcome ? move.teams : move.teams.filter((t) => t.outcome !== "moved");
  return `<ul class="metric-variables-move-teams">${teams.map((t) => `
    <li><strong>${escapeHtml(t.teamName)}</strong> <span class="muted">${escapeHtml(REQUIREMENT[t.requirement] || "")}${t.fieldLabel ? ` · ${escapeHtml(t.fieldLabel)}` : ""}</span>
      ${withOutcome && t.outcome ? `<span class="item-badge metric-variables-move-${t.outcome}">${escapeHtml(OUTCOME[t.outcome])}</span>` : ""}
      ${t.outcome === "refused" && t.note ? `<span class="metric-variables-field-note" role="alert">${escapeHtml(t.note)}</span>` : ""}
    </li>`).join("")}</ul>`;
}

export function renderMoveHtml(move, item) {
  if (!move || move.copyId !== item.id || move.state === "none") return "";
  if (move.state === "loading") return `<p class="muted" role="status">Looking for the teams that still use OptiMove's variable...</p>`;
  if (move.state === "error") {
    // Only on a variable known to be a copy: a failed lookup of the original says nothing on an ordinary variable.
    if (!move.original) return "";
    return `<div class="error" role="alert"><p>The teams that use OptiMove's variable could not be read.</p><button class="plain-button" type="button" data-action="metric-variables-move-reload">Try again</button></div>`;
  }
  const original = escapeHtml(move.original.label);
  const intro = `<p>Copied from OptiMove's ${original}. Sessions imported before your teams move stay under OptiMove's ${original}.</p>`;
  const settled = move.teams.length > 0 && move.teams.every((t) => t.outcome === "moved");
  if (!move.teams.length || settled) {
    const canHide = move.original.state === "active" && move.original.actions.includes("hide");
    return `<section class="metric-variables-move">${intro}
      ${settled ? `<p role="status">All ${move.teams.length === 1 ? "1 team is" : `${move.teams.length} teams are`} on this copy now.</p>` : ""}
      ${canHide ? `<p><button class="plain-button ghost" type="button" data-action="metric-variables-hide-original" data-variable-id="${escapeAttr(move.original.id)}">Hide OptiMove's ${original} for your club</button></p>` : ""}
    </section>`;
  }
  const locked = move.busy || move.unconfirmed;
  const pending = move.teams.filter((t) => t.outcome === null || t.outcome === "refused").length;
  const blocker = move.teams.some((t) => !t.targetVersionId) ? "Activate the copy's GPEXE field links first." : "";
  if (!move.review) {
    return `<section class="metric-variables-move">${intro}
      <h3>Teams that still use OptiMove's ${original}</h3>
      ${moveTeamsHtml(move, { withOutcome: false })}
      ${blocker ? `<p class="muted">${escapeHtml(blocker)}</p>` : ""}
      <p><button class="plain-button data-sources-primary" type="button" data-action="metric-variables-move-open" ${blocker ? "disabled" : ""}>Move your teams to this copy</button></p>
    </section>`;
  }
  return `<section class="metric-variables-move">${intro}
    <h3>${move.teams.some((t) => t.outcome === "moved") ? `Not moved yet: ${pending === 1 ? "1 team" : `${pending} teams`}` : `Move ${pending === 1 ? "1 team" : `${pending} teams`} to this copy`}</h3>
    ${moveTeamsHtml(move, { withOutcome: true })}
    <p>These teams stop getting OptiMove's ${original} and start getting this copy; new sessions fill the copy. There is a short gap while a team is switched over.</p>
    <p>Each team keeps its Required or Optional setting. Sessions already imported stay under OptiMove's ${original}.</p>
    <p>Your existing charts of ${original} get no new points after the move.</p>
    <label class="search-field"><span>Reason</span>
      <textarea data-mv-move-reason maxlength="500" rows="2" ${locked ? "disabled" : ""}${move.reasonError ? ` aria-invalid="true" aria-describedby="mv-err-move-reason"` : ""}>${escapeHtml(move.reason)}</textarea>
      <span class="muted">For example: moving to the club's own copy. Do not enter athlete names, ids, dates of birth or measured values.</span>
      ${move.reasonError ? `<span class="metric-variables-field-error" id="mv-err-move-reason">${escapeHtml(move.reasonError)}</span>` : ""}
    </label>
    ${move.unconfirmed ? `
      <div class="metric-variables-unconfirmed" role="alert">
        <p><strong>Result not confirmed.</strong> No confirmation arrived for ${move.teams.filter((t) => t.outcome === "unknown").length === 1 ? "a team" : "some teams"}, so it is not known whether they were moved. Check result sends the same request again: a team is never moved twice.</p>
        <div class="data-sources-form-actions">
          <button class="plain-button data-sources-primary" type="button" data-action="metric-variables-move-check" ${move.busy ? "disabled" : ""}>${move.busy ? "Checking..." : "Check result"}</button>
        </div>
      </div>` : `
      <div class="data-sources-form-actions">
        <button class="plain-button data-sources-primary" type="button" data-action="metric-variables-move-confirm" ${move.busy || !pending ? "disabled" : ""}>${move.busy ? "Moving..." : `${move.teams.some((t) => t.outcome === "moved") ? "Try again for" : "Move"} ${pending === 1 ? "1 team" : `${pending} teams`}`}</button>
        <button class="plain-button ghost" type="button" data-action="metric-variables-move-back" ${move.busy ? "disabled" : ""}>Back</button>
      </div>`}
  </section>`;
}
