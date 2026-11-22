// v87: positions. The list in Settings -> Tags & Presets, and an athlete's position in the athlete's Edit window
// (Settings -> Athletes). One position per athlete (the owner, 2026-11-22). Used by the Position average estimate.
import { state } from "./state.js";
import { escapeAttr, escapeHtml } from "./utils.js";

// A default is offered to every club, which may rename or hide it for itself; a club's own position is added by it.
const OWNER_WORD = { system: "Default", club: "Added by your club" };
// The row's actions, as the server offers them for this caller.
const ACTION_BUTTONS = { rename: "Rename", archive: "Archive", restore: "Restore", hide: "Hide", show: "Show" };

function messageHtml(forWhat) {
  const p = state.positions;
  if (!p.message || p.messageFor !== forWhat) return "";
  // A saved change reads as a plain confirmation with a check mark; a refusal in the error style.
  return p.messageOk
    ? `<p class="muted positions-saved" role="status" aria-live="polite">✓ ${escapeHtml(p.message)}</p>`
    : `<p class="builder-error" role="status" aria-live="polite">${escapeHtml(p.message)}</p>`;
}

function positionRowHtml(position) {
  const p = state.positions;
  const busy = p.busy ? "disabled" : "";
  if (p.renameId === position.id) {
    return `
      <li class="positions-row">
        <form class="tag-chip-add-row positions-rename-form" data-position-form="rename" data-position-id="${escapeAttr(position.id)}" data-position-expected="${escapeAttr(position.name)}">
          <label class="search-field"><span>New name</span><input name="name" required maxlength="60" value="${escapeAttr(position.name)}"></label>
          <button class="plain-button compact-button" type="submit" ${busy}>Save</button>
          <button class="text-action" type="button" data-action="positions-rename-cancel" ${busy}>Cancel</button>
        </form>
        ${messageHtml(`rename:${position.id}`)}
      </li>`;
  }
  // The state in words (never by colour alone): hidden for this club, or archived.
  const status = position.hidden ? `<span class="muted"> · hidden</span>` : position.archived ? `<span class="muted"> · archived</span>` : "";
  const renamed = position.defaultName ? `<small class="muted"> (default: ${escapeHtml(position.defaultName)})</small>` : "";
  const actions = (position.actions || []).map((a) => ACTION_BUTTONS[a]
    ? `<button class="text-action" type="button" data-action="positions-${a}" data-position-id="${escapeAttr(position.id)}" ${busy}>${ACTION_BUTTONS[a]}</button>` : "").join("");
  return `
    <li class="positions-row ${position.active ? "" : "is-archived"}">
      <span><strong>${escapeHtml(position.name)}</strong>${renamed}<small class="muted"> · ${escapeHtml(OWNER_WORD[position.ownerScope] ?? "")}</small>${status}</span>
      <span class="positions-actions">${actions}</span>
      ${messageHtml(`row:${position.id}`)}
    </li>`;
}

// The Tags & Presets section.
export function renderPositionsSectionHtml() {
  const p = state.positions;
  const body = p.loading && !p.loaded
    ? `<p class="muted" aria-live="polite">Reading positions…</p>`
    : p.error
      ? `<p class="builder-error" role="alert">${escapeHtml(p.error)}</p><button class="plain-button compact-button" type="button" data-action="positions-reload">Try again</button>`
      : `<ul class="positions-list">${p.list.length ? p.list.map(positionRowHtml).join("") : `<li class="muted">Nothing yet.</li>`}</ul>`;
  const add = p.canAdd ? (p.addOpen ? `
      <form class="tag-chip-add-form" data-position-form="add">
        <div class="tag-chip-add-row">
          <label class="search-field"><span>Position name</span><input name="name" required maxlength="60" placeholder="e.g. Defensive midfielder"></label>
          <button class="plain-button compact-button" type="submit" ${p.busy ? "disabled" : ""}>Add</button>
        </div>
        ${messageHtml("add")}
      </form>` : "") : "";
  return `
    <section class="panel taxonomy-intro">
      <p class="eyebrow">Athletes</p>
      <h3>Positions</h3>
      <p class="muted">Each athlete has one position, chosen in Settings → Athletes (Edit). The Position average estimate uses it.${p.canAdd === "club" ? " The defaults are suggestions: rename or hide them, or add your own. Changes apply to your club only." : ""}</p>
    </section>
    <section class="panel tag-chip-section positions-section">
      <div class="tag-chip-head">
        <p class="eyebrow">Positions</p>
        ${p.canAdd ? `<button class="text-action" type="button" data-action="positions-toggle-add">${p.addOpen ? "Cancel" : "+ Add"}</button>` : ""}
      </div>
      ${body}
      ${add}
    </section>`;
}

// The athlete's position in the Edit window: its own small form, saved on its own.
export function renderAthletePositionFormHtml(athleteId) {
  const p = state.positions;
  if (!p.loaded) {
    return p.error
      ? `<div class="organization-form organization-dialog-part"><h4>Position</h4><p class="builder-error" role="alert">${escapeHtml(p.error)}</p><button class="plain-button compact-button" type="button" data-action="positions-reload">Try again</button></div>`
      : `<div class="organization-form organization-dialog-part"><h4>Position</h4><p class="muted" aria-live="polite">Reading positions…</p></div>`;
  }
  if (!p.canSet) {
    return `<div class="organization-form organization-dialog-part"><h4>Position</h4><p class="muted">Positions are set in a club's or a team's workspace.</p></div>`;
  }
  const current = p.assignments[athleteId] ?? null;
  const currentPosition = current ? p.list.find((x) => x.id === current) : null;
  const options = p.list.filter((x) => x.active || x.id === current);
  return `
    <form class="organization-form organization-dialog-part" data-position-form="athlete" data-athlete-id="${escapeAttr(athleteId)}" data-position-expected="${escapeAttr(current ?? "")}">
      <div><h4>Position</h4><p class="muted">One position per athlete. Saved with Save position.</p></div>
      <label class="search-field"><span>Position</span>
        <select class="builder-text-input" name="positionId">
          <option value="" ${current ? "" : "selected"}>No position</option>
          ${options.map((x) => `<option value="${escapeAttr(x.id)}" ${x.id === current ? "selected" : ""}>${escapeHtml(x.name)}${x.active ? "" : x.hidden ? " (hidden)" : " (archived)"}</option>`).join("")}
          ${current && !currentPosition ? `<option value="${escapeAttr(current)}" selected>Current position (not on this list)</option>` : ""}
        </select>
      </label>
      <div class="organization-form-footer organization-dialog-footer">
        ${messageHtml(`athlete:${athleteId}`)}
        <button class="plain-button data-sources-primary" type="submit" ${p.busy ? "disabled" : ""}>Save position</button>
      </div>
    </form>`;
}
