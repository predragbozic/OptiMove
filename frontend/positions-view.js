// v88: positions. The list in Settings -> Tags & Presets, and an athlete's position in the athlete's Edit window
// (Settings -> Athletes). One position per athlete (the owner, 2026-11-22). Used by the Position average estimate.
import { state } from "./state.js";
import { escapeAttr, escapeHtml } from "./utils.js";

const OWNER_WORD = { system: "OptiMove", club: "Your club" };

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
  const status = position.active ? "" : `<span class="muted"> · archived</span>`;
  const actions = position.editable ? `
      <button class="text-action" type="button" data-action="positions-rename" data-position-id="${escapeAttr(position.id)}" ${busy}>Rename</button>
      <button class="text-action" type="button" data-action="${position.active ? "positions-archive" : "positions-restore"}" data-position-id="${escapeAttr(position.id)}" ${busy}>${position.active ? "Archive" : "Restore"}</button>` : "";
  return `
    <li class="positions-row ${position.active ? "" : "is-archived"}">
      <span><strong>${escapeHtml(position.name)}</strong><small class="muted"> · ${escapeHtml(OWNER_WORD[position.ownerScope] ?? "")}</small>${status}</span>
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
      <p class="muted">Each athlete has one position, chosen in Settings → Athletes (Edit). The Position average estimate uses it.</p>
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
      ? `<div class="organization-form organization-dialog-part"><h4>Position</h4><p class="builder-error" role="alert">${escapeHtml(p.error)}</p></div>`
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
          ${options.map((x) => `<option value="${escapeAttr(x.id)}" ${x.id === current ? "selected" : ""}>${escapeHtml(x.name)}${x.active ? "" : " (archived)"}</option>`).join("")}
        </select>
      </label>
      ${current && !currentPosition ? `<p class="muted">The current position is not on this workspace's list.</p>` : ""}
      <div class="organization-form-footer organization-dialog-footer">
        ${messageHtml(`athlete:${athleteId}`)}
        <button class="plain-button data-sources-primary" type="submit" ${p.busy ? "disabled" : ""}>Save position</button>
      </div>
    </form>`;
}
