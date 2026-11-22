// Settings -> Tags & Presets -> Session types (ST-5): the list, in the coach's words. No key, id or code is shown.
import { SESSION_TYPE_LABEL_MAX, sessionTypesState } from "./session-types-data.js";
import { escapeAttr, escapeHtml } from "./utils.js";

function noticeHtml(st) {
  const n = st.notice;
  if (!n) return "";
  const busy = Boolean(st.sending);
  const buttons = [
    n.tone === "unconfirmed" ? `<button type="button" class="primary-button" data-action="session-types-check" ${busy ? "disabled" : ""}>Check result</button>` : "",
    n.tone === "saved" && n.undo ? `<button type="button" class="plain-button" data-action="session-types-undo" ${busy ? "disabled" : ""}>Undo</button>` : "",
  ].join("");
  return `<div class="session-types-notice is-${escapeAttr(n.tone)}" role="${n.tone === "saved" ? "status" : "alert"}"><p>${escapeHtml(n.text)}</p>${buttons}</div>`;
}

function rowHtml(st, type, locked) {
  const editing = st.editing?.key === type.key;
  const dis = locked ? "disabled" : "";
  const owner = type.ownerScope === "club" ? "Your club's" : "OptiMove";
  if (editing) {
    return `
      <li class="session-types-row is-editing">
        <form class="session-types-form" data-session-types-form="rename" data-key="${escapeAttr(type.key)}">
          <label class="session-types-field"><span>New name for ${escapeHtml(type.label)}</span>
            <input type="text" name="label" maxlength="${SESSION_TYPE_LABEL_MAX}" value="${escapeAttr(st.editing.label)}" data-session-type-rename autocomplete="off" ${dis}></label>
          <button type="submit" class="primary-button" data-action="session-types-rename-save" data-key="${escapeAttr(type.key)}" ${dis}>Save name</button>
          <button type="button" class="plain-button" data-action="session-types-rename-cancel" ${dis}>Cancel</button>
        </form>
      </li>`;
  }
  return `
    <li class="session-types-row${type.active ? "" : " is-archived"}">
      <span class="session-types-name"><strong>${escapeHtml(type.label)}</strong> <small class="muted">${escapeHtml(owner)}${type.active ? "" : " · archived"}</small></span>
      ${type.editable ? `<span class="session-types-actions">
        ${type.active ? `<button type="button" class="plain-button" data-action="session-types-rename" data-key="${escapeAttr(type.key)}" aria-label="Rename ${escapeAttr(type.label)}" ${dis}>Rename</button>` : ""}
        <button type="button" class="plain-button" data-action="${type.active ? "session-types-archive" : "session-types-restore"}" data-key="${escapeAttr(type.key)}" aria-label="${type.active ? "Archive" : "Restore"} ${escapeAttr(type.label)}" ${dis}>${type.active ? "Archive" : "Restore"}</button>
      </span>` : ""}
    </li>`;
}

export function renderSessionTypesPanelHtml() {
  const st = sessionTypesState();
  if (st.unavailable) return "";
  const locked = Boolean(st.sending || st.unconfirmed);
  const active = (st.types || []).filter((t) => t.active);
  const archived = (st.types || []).filter((t) => !t.active);
  const whose = st.canAdd === "club" ? "your club" : st.canAdd === "system" ? "every club" : "";
  return `
    <section class="panel session-types-settings">
      <p class="eyebrow">Training Load</p>
      <h3>Session types</h3>
      <p class="muted">What a session was: chosen when a session is imported, and on the session's roster for an athlete who did something else. Estimates compare a session only with sessions of the same type.</p>
      ${st.error ? `<p class="builder-error" role="alert">${escapeHtml(st.error)} <button type="button" class="plain-button" data-action="session-types-reload">Try again</button></p>` : ""}
      ${st.loading && !st.loaded ? `<p class="muted" role="status">Loading...</p>` : ""}
      ${noticeHtml(st)}
      ${st.loaded ? `
        <ul class="session-types-list">${active.map((t) => rowHtml(st, t, locked)).join("") || `<li class="muted">No session types.</li>`}</ul>
        ${st.canAdd ? `
          <form class="session-types-form session-types-add" data-session-types-form="add">
            <label class="session-types-field"><span>New session type for ${escapeHtml(whose)}</span>
              <input type="text" name="label" maxlength="${SESSION_TYPE_LABEL_MAX}" value="${escapeAttr(st.newLabel || "")}" placeholder="For example Gym" data-session-type-new autocomplete="off" ${locked ? "disabled" : ""}></label>
            <button type="submit" class="primary-button" data-action="session-types-add" ${locked ? "disabled" : ""}>${st.sending?.kind === "add" ? "Adding..." : "Add"}</button>
          </form>` : `<p class="muted">${st.canAdd === null && (st.types || []).some((t) => t.ownerScope === "club") ? "Your club's administrator adds and renames the club's session types." : "A club administrator can add the club's own session types in the club's workspace."}</p>`}
        ${archived.length ? `
          <details class="session-types-archived">
            <summary>Archived (${archived.length})</summary>
            <ul class="session-types-list">${archived.map((t) => rowHtml(st, t, locked)).join("")}</ul>
          </details>` : ""}
      ` : ""}
    </section>`;
}
