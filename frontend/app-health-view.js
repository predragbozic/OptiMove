// Settings -> App health (A2): groups of recorded errors by fingerprint. No message of any error exists here: only a place,
// a stable code, a status, counts, roles and times. Details (function@file names, a short fingerprint, the release) sit in
// the opened group.
import { visibleGroups, whereOf, whereOptions } from "./app-health-data.js";
import { state } from "./state.js";
import { escapeAttr, escapeHtml } from "./utils.js";

const ROLES = [["all", "All roles"], ["platform_admin", "Platform admin"], ["coach", "Coach"], ["athlete", "Athlete"], ["user", "Other"], ["none", "Signed out"]];
const DAYS = [[1, "24 hours"], [7, "7 days"], [30, "30 days"]];
const ROLE_LABEL = Object.fromEntries(ROLES);
// The closed set of codes the app writes, in words; the code itself stays beside the words.
const CODE_LABEL = {
  js_error: "A page crashed",
  unhandled_rejection: "A background task failed",
  no_response: "No answer from the server",
  unexpected_response: "An answer the app could not read",
  internal_error: "Server error",
};
export function codeWords(code, status) {
  return CODE_LABEL[code] || (status >= 500 ? "Server error" : "Error");
}
// The groups read asks for at most this many (GET /api/app-errors/groups, the server's default limit).
export const APP_HEALTH_GROUP_CAP = 100;
const placeLabel = (g) => (whereOf(g) === "/unmatched" ? "Unknown route" : whereOf(g));

export function formatSeen(value) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  const two = (n) => String(n).padStart(2, "0");
  return `${two(d.getDate())}.${two(d.getMonth() + 1)}.${d.getFullYear()} ${two(d.getHours())}:${two(d.getMinutes())}`;
}

const timesLabel = (n) => `${n} ${n === 1 ? "time" : "times"}`;

function chips(items, current, action, attr, busy = false) {
  return items.map(([value, label]) => `<button type="button" ${busy ? "disabled" : ""} class="app-health-chip ${String(current) === String(value) ? "is-active" : ""}" data-action="${action}" data-${attr}="${escapeAttr(value)}" aria-pressed="${String(current) === String(value) ? "true" : "false"}">${escapeHtml(label)}</button>`).join("");
}

function groupCard(g, selected) {
  const open = selected === g.fingerprint;
  const where = placeLabel(g);
  const kind = g.source === "client" ? "Browser" : "Server";
  return `
    <article class="app-health-group ${open ? "is-open" : ""}">
      <button type="button" class="app-health-row" data-action="app-health-open" data-fingerprint="${escapeAttr(g.fingerprint)}" aria-expanded="${open ? "true" : "false"}">
        <span class="app-health-where"><span class="app-health-kind">${kind}</span> ${escapeHtml(where)}</span>
        <span class="app-health-what">${escapeHtml(codeWords(g.code, g.status))}<small class="app-health-code">${escapeHtml(`${g.code || "unknown"}${g.status ? ` · HTTP ${g.status}` : ""}`)}</small></span>
        <span class="app-health-count">${escapeHtml(timesLabel(g.occurrences))} · ${escapeHtml(String(g.users))} ${g.users === 1 ? "person" : "people"}</span>
        <span class="app-health-seen">Since ${escapeHtml(formatSeen(g.firstSeenAt))} · last ${escapeHtml(formatSeen(g.lastSeenAt))}</span>
      </button>
      ${open ? `
        <dl class="app-health-detail">
          <div><dt>First seen</dt><dd>${escapeHtml(formatSeen(g.firstSeenAt))}</dd></div>
          <div><dt>Last seen</dt><dd>${escapeHtml(formatSeen(g.lastSeenAt))}</dd></div>
          <div><dt>Roles</dt><dd>${escapeHtml((g.roles || []).map((r) => ROLE_LABEL[r] || r).join(", ") || "—")}</dd></div>
          ${g.action ? `<div><dt>Last button pressed</dt><dd>${escapeHtml(g.action)}</dd></div>` : ""}
          <div><dt>Release</dt><dd>${escapeHtml(g.release ? g.release.slice(0, 8) : "unknown")}</dd></div>
          <div><dt>Where in the code</dt><dd>${escapeHtml(g.stackSignature || "not recorded")}</dd></div>
          <div><dt>Group</dt><dd>${escapeHtml(String(g.fingerprint).slice(0, 12))}</dd></div>
        </dl>` : ""}
    </article>`;
}

export function renderAppHealthPanelHtml() {
  const h = state.appHealth;
  const groups = h.groups ? visibleGroups(h.groups, h) : null;
  const places = whereOptions(h.groups);
  return `
    <section class="panel app-health" aria-labelledby="app-health-title">
      <header class="app-health-head">
        <div>
          <h3 id="app-health-title">App health</h3>
          <p class="muted">Errors the app hit, grouped by where and why. Nothing a person typed is recorded; rows older than 30 days are removed.</p>
        </div>
        <button type="button" class="plain-button" data-action="app-health-refresh" ${h.loading ? "disabled" : ""}>${h.loading ? "Loading…" : "Refresh"}</button>
      </header>
      <div class="app-health-filters" role="group" aria-label="Period">${chips(DAYS, h.days, "app-health-days", "days", h.loading)}</div>
      <div class="app-health-filters" role="group" aria-label="Role">${chips(ROLES, h.role, "app-health-role", "role")}</div>
      ${places.length ? `<details class="app-health-places" ${h.where !== "all" ? "open" : ""}><summary>Place: ${escapeHtml(h.where === "all" ? "Everywhere" : h.where)}</summary>
        <div class="app-health-filters" role="group" aria-label="Place">${chips([["all", "Everywhere"], ...places.map((p) => [p, p === "/unmatched" ? "Unknown route" : p])], h.where, "app-health-where", "where")}</div>
        ${(h.groups || []).length > places.length && places.length >= 40 ? `<p class="muted">Only the first ${places.length} places are listed.</p>` : ""}</details>` : ""}
      ${h.role !== "all" ? `<p class="muted app-health-note">Showing groups where at least one affected person is ${escapeHtml(ROLE_LABEL[h.role] || h.role)}. The counts cover everyone in the group.</p>` : ""}
      ${h.error ? `<p class="builder-error" role="alert">${escapeHtml(h.error)}</p>` : ""}
      ${(h.groups || []).length >= APP_HEALTH_GROUP_CAP ? `<p class="muted app-health-note app-health-truncated" role="note">Showing the ${APP_HEALTH_GROUP_CAP} most recently seen kinds of error. Older ones in this period may not be listed.</p>` : ""}
      ${groups === null ? (h.loading ? `<p class="muted">Loading…</p>` : h.error ? "" : `<p class="muted">Nothing is loaded yet. Press Refresh.</p>`) : groups.length
        ? `<p class="app-health-summary">${groups.length} ${groups.length === 1 ? "kind of error" : "kinds of errors"} · ${timesLabel(groups.reduce((n, g) => n + g.occurrences, 0))} · most recent first</p>

           <div class="app-health-list ${h.loading ? "is-loading" : ""}" aria-busy="${h.loading ? "true" : "false"}">${groups.map((g) => groupCard(g, h.selected)).join("")}</div>`
        : `<p class="muted app-health-empty">${(h.groups || []).length ? "No errors match these filters." : `No errors recorded in the last ${h.days === 1 ? "24 hours" : `${h.days} days`}.`}</p>${(h.groups || []).length ? `<button type="button" class="plain-button" data-action="app-health-clear">Clear filters</button>` : ""}`}
    </section>`;
}
