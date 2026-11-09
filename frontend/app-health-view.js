// Settings -> App health (A2): groups of recorded errors by fingerprint. No message of any error exists here: only a place,
// a stable code, a status, counts, roles and times. Details (function@file names, a short fingerprint, the release) sit in
// the opened group.
import { visibleGroups, whereOf, whereOptions } from "./app-health-data.js";
import { state } from "./state.js";
import { escapeAttr, escapeHtml } from "./utils.js";

const ROLES = [["all", "All roles"], ["platform_admin", "Platform admin"], ["coach", "Coach"], ["athlete", "Athlete"], ["user", "Other"], ["none", "Signed out"]];
const DAYS = [[1, "24 hours"], [7, "7 days"], [30, "30 days"]];
const ROLE_LABEL = Object.fromEntries(ROLES);

export function formatSeen(value) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  const two = (n) => String(n).padStart(2, "0");
  return `${two(d.getDate())}.${two(d.getMonth() + 1)}.${d.getFullYear()} ${two(d.getHours())}:${two(d.getMinutes())}`;
}

function chips(items, current, action, attr) {
  return items.map(([value, label]) => `<button type="button" class="app-health-chip ${String(current) === String(value) ? "is-active" : ""}" data-action="${action}" data-${attr}="${escapeAttr(value)}" aria-pressed="${String(current) === String(value) ? "true" : "false"}">${escapeHtml(label)}</button>`).join("");
}

function groupCard(g, selected) {
  const open = selected === g.fingerprint;
  const where = whereOf(g);
  const kind = g.source === "client" ? "Browser" : "Server";
  return `
    <article class="app-health-group ${open ? "is-open" : ""}">
      <button type="button" class="app-health-row" data-action="app-health-open" data-fingerprint="${escapeAttr(g.fingerprint)}" aria-expanded="${open ? "true" : "false"}">
        <span class="app-health-where"><span class="app-health-kind">${kind}</span> ${escapeHtml(where)}</span>
        <span class="app-health-what">${escapeHtml(g.code)}${g.status ? ` · ${escapeHtml(String(g.status))}` : ""}</span>
        <span class="app-health-count">${escapeHtml(String(g.occurrences))}× · ${escapeHtml(String(g.users))} ${g.users === 1 ? "person" : "people"}</span>
        <span class="app-health-seen">Last ${escapeHtml(formatSeen(g.lastSeenAt))}</span>
      </button>
      ${open ? `
        <dl class="app-health-detail">
          <div><dt>First seen</dt><dd>${escapeHtml(formatSeen(g.firstSeenAt))}</dd></div>
          <div><dt>Last seen</dt><dd>${escapeHtml(formatSeen(g.lastSeenAt))}</dd></div>
          <div><dt>Roles</dt><dd>${escapeHtml((g.roles || []).map((r) => ROLE_LABEL[r] || r).join(", ") || "—")}</dd></div>
          ${g.action ? `<div><dt>Action</dt><dd>${escapeHtml(g.action)}</dd></div>` : ""}
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
      <div class="app-health-filters" role="group" aria-label="Period">${chips(DAYS, h.days, "app-health-days", "days")}</div>
      <div class="app-health-filters" role="group" aria-label="Role">${chips(ROLES, h.role, "app-health-role", "role")}</div>
      ${places.length ? `<div class="app-health-filters" role="group" aria-label="Where">${chips([["all", "Everywhere"], ...places.map((p) => [p, p])], h.where, "app-health-where", "where")}</div>` : ""}
      ${h.error ? `<p class="builder-error" role="alert">${escapeHtml(h.error)}</p>` : ""}
      ${groups === null ? (h.loading ? `<p class="muted">Loading…</p>` : "") : groups.length
        ? `<div class="app-health-list">${groups.map((g) => groupCard(g, h.selected)).join("")}</div>`
        : `<p class="muted app-health-empty">${(h.groups || []).length ? "No errors match these filters." : `No errors recorded in the last ${h.days === 1 ? "24 hours" : `${h.days} days`}.`}</p>`}
    </section>`;
}
