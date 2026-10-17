import { api } from "./api.js";
import { escapeAttr, escapeHtml } from "./utils.js";
import { renderImage } from "./media.js";

let activePanel = null;
function userLabel(user) { return user.email ? `${user.name} (${user.email})` : user.name; }
const messages = {
  staleRevision: "This block changed elsewhere. Close and reopen it before saving.",
  exerciseAlreadyInBlock: "An exercise belongs to another block. Remove it there first.",
  invalidSelection: "An exercise or user is no longer available. Review your selection.",
  tryAgain: "The block is busy. Please try again.",
  notFound: "You no longer have permission to manage application blocks.",
};

export function renderExerciseCollectionsHtml(panel) {
  const picker = (kind, label, options, selected, more) => `
    <section>
      <h4>${label} (${selected.length})</h4>
      <div>${selected.map((item) => `<button type="button" class="plain-button compact-button" data-remove-kind="${kind}" data-id="${escapeAttr(item.id)}">${escapeHtml(kind === "users" ? userLabel(item) : item.name)} ×</button>`).join(" ") || '<p class="muted">None selected.</p>'}</div>
      <label class="search-field"><span>Find ${label.toLowerCase()}</span><input class="builder-text-input" type="search" data-search-kind="${kind}" value="${escapeAttr(panel.search[kind] || "")}"></label>
      <button type="button" class="plain-button" data-find-kind="${kind}" ${panel.busy ? "disabled" : ""}>Search</button>
      ${more ? '<p class="muted">First 100 matches shown. Refine the search to find more.</p>' : ""}
      <div class="exercise-block-picker">${options.filter((item) => !selected.some((chosen) => chosen.id === item.id)).map((item) => `<label class="exercise-block-pick"><input type="checkbox" data-pick-kind="${kind}" data-id="${escapeAttr(item.id)}" ${panel.pending?.[kind]?.some((chosen) => chosen.id === item.id) ? "checked" : ""} ${panel.busy || (kind === "exercises" && item.collectionId && item.collectionId !== panel.draft.id) ? "disabled" : ""}>${kind === "exercises" && item.imageUrl ? renderImage(item.imageUrl, "exercise-block-pick-image") : ""}<span>${escapeHtml(kind === "users" ? userLabel(item) : item.name)}${item.collectionId && item.collectionId !== panel.draft.id ? " (another block)" : ""}</span></label>`).join("")}</div>
      <button class="plain-button compact-button" type="button" data-add-selected="${kind}" ${panel.busy || !panel.pending?.[kind]?.length ? "disabled" : ""}>Add selected (${panel.pending?.[kind]?.length || 0})</button>
    </section>`;
  return `
    <button class="exercise-editor-backdrop" type="button" data-close-collections aria-label="Close"></button>
    <section class="panel exercise-editor-modal" role="dialog" aria-modal="true" aria-label="Application exercise blocks">
      <div class="builder-modal-head"><h3>Application exercise blocks</h3><button class="plain-button" type="button" data-close-collections>Close</button></div>
      <div class="exercise-editor-body">
        <p>Blocks control access to their system exercises. Locked previews do not grant access. Personal copies remain private and are hidden when that user's access is removed.</p>
        <label class="search-field"><span>Block</span><select class="builder-text-input" data-block-select ${panel.busy ? "disabled" : ""}><option value="">New block</option>${panel.collections.map((block) => `<option value="${escapeAttr(block.id)}" ${block.id === panel.draft.id ? "selected" : ""}>${escapeHtml(block.name)}</option>`).join("")}</select></label>
        <label class="search-field"><span>Block name</span><input class="builder-text-input" maxlength="120" data-block-name value="${escapeAttr(panel.draft.name)}" ${panel.busy ? "disabled" : ""}></label>
        <label class="search-field"><span>Description</span><textarea class="builder-text-input" maxlength="2000" data-block-description ${panel.busy ? "disabled" : ""}>${escapeHtml(panel.draft.description || "")}</textarea></label>
        <label class="search-field"><span>Cover image URL (optional)</span><input class="builder-text-input" type="url" data-block-cover value="${escapeAttr(panel.draft.coverImageUrl || "")}" ${panel.busy ? "disabled" : ""}></label>
        <div class="exercise-block-cover-tools"><button class="plain-button compact-button" type="button" data-clear-block-cover ${panel.busy || !panel.draft.coverImageUrl?.trim() ? "disabled" : ""}>Remove cover</button><span class="muted">Replace the URL to change this block's cover, or remove it to use the exercise image.</span></div>
        <p class="muted">Without a cover URL, the first exercise in alphabetical order supplies the image. Only system exercises can belong to an application block.</p>
        ${picker("exercises", "Application exercises", panel.options.exercises || [], panel.draft.exercises, panel.options.moreExercises)}
        <label class="exercise-block-pick"><input type="checkbox" data-block-all ${panel.draft.accessAll ? "checked" : ""} ${panel.busy ? "disabled" : ""}><span>Available to all users, including future users</span></label>
        <p class="muted">When off, only selected users and the system administrator have access. Existing selected users are kept when everyone is enabled.</p>
        <label class="search-field"><span>Block for users without access</span><select class="builder-text-input" data-block-preview ${panel.busy ? "disabled" : ""}><option value="hidden" ${panel.draft.blockPreview !== "locked" ? "selected" : ""}>Completely hidden</option><option value="locked" ${panel.draft.blockPreview === "locked" ? "selected" : ""}>Visible with a lock</option></select></label>
        <label class="search-field"><span>Exercises for users without access</span><select class="builder-text-input" data-exercise-preview ${panel.busy ? "disabled" : ""}><option value="hidden" ${panel.draft.exercisePreview !== "locked" ? "selected" : ""}>Completely hidden</option><option value="locked" ${panel.draft.exercisePreview === "locked" ? "selected" : ""}>Names visible with a lock (no media or instructions)</option></select></label>
        ${picker("users", "Users", panel.options.users || [], panel.draft.users, panel.options.moreUsers)}
        ${panel.error ? `<p role="alert" class="builder-error">${escapeHtml(panel.error)}</p>` : ""}
        ${panel.saved ? '<p role="status">Block saved.</p>' : ""}
      </div>
      <div class="builder-modal-actions"><button class="plain-button" type="button" data-save-block ${panel.busy ? "disabled" : ""}>${panel.busy ? "Saving..." : "Save block and access"}</button></div>
    </section>`;
}

function emptyDraft() { return { id: "", name: "", description: "", coverImageUrl: "", accessAll: false, blockPreview: "hidden", exercisePreview: "hidden", exercises: [], users: [] }; }

function render(panel) {
  if (activePanel !== panel) return;
  const focused = panel.element.contains(document.activeElement) ? document.activeElement : null;
  const focusAttributes = focused ? Array.from(focused.attributes).filter((attribute) => attribute.name.startsWith("data-")).map((attribute) => [attribute.name, attribute.value]) : [];
  panel.element.innerHTML = renderExerciseCollectionsHtml(panel);
  panel.element.querySelectorAll("[data-close-collections]").forEach((button) => button.addEventListener("click", () => {
    if (panel.busy) return;
    if (!panel.saved && panel.dirty && !window.confirm("Discard unsaved block changes?")) return;
    panel.element.remove();
    document.removeEventListener("keydown", panel.keydown);
    for (const [element, inert] of panel.background) element.inert = inert;
    document.body.style.overflow = panel.previousOverflow;
    activePanel = null;
    panel.previousFocus?.focus();
  }));
  panel.element.querySelector("[data-block-name]").addEventListener("input", (event) => {
    panel.draft.name = event.target.value;
    panel.dirty = true;
    panel.saved = false;
  });
  panel.element.querySelector("[data-block-select]").addEventListener("change", (event) => {
    if (panel.dirty && !window.confirm("Discard unsaved block changes?")) { render(panel); return; }
    const selected = panel.collections.find((block) => block.id === event.target.value);
    panel.draft = selected ? structuredClone(selected) : emptyDraft();
    panel.original = structuredClone(panel.draft);
    panel.pending = { exercises: [], users: [] };
    panel.dirty = false;
    panel.saved = false;
    panel.error = "";
    render(panel);
  });
  for (const kind of ["exercises", "users"]) {
    panel.element.querySelector(`[data-search-kind="${kind}"]`).addEventListener("input", (event) => { panel.search[kind] = event.target.value; });
    panel.element.querySelector(`[data-find-kind="${kind}"]`).addEventListener("click", () => findOptions(panel));
  }
  for (const [selector, field] of [["[data-block-description]", "description"], ["[data-block-cover]", "coverImageUrl"], ["[data-block-all]", "accessAll"], ["[data-block-preview]", "blockPreview"], ["[data-exercise-preview]", "exercisePreview"]]) {
    panel.element.querySelector(selector).addEventListener(field === "accessAll" || field.endsWith("Preview") ? "change" : "input", (event) => {
      panel.draft[field] = field === "accessAll" ? event.target.checked : event.target.value;
      if (field === "coverImageUrl") panel.element.querySelector("[data-clear-block-cover]").disabled = !event.target.value.trim();
      panel.dirty = true;
      panel.saved = false;
    });
  }
  panel.element.querySelector("[data-clear-block-cover]").addEventListener("click", () => {
    if (panel.busy) return;
    panel.draft.coverImageUrl = "";
    panel.element.querySelector("[data-block-cover]").value = "";
    panel.element.querySelector("[data-clear-block-cover]").disabled = true;
    panel.dirty = true;
    panel.saved = false;
    panel.element.querySelector("[data-block-cover]").focus();
  });
  panel.element.querySelectorAll("[data-pick-kind]").forEach((control) => control.addEventListener("change", () => {
    const kind = control.dataset.pickKind;
    const item = panel.options[kind].find((option) => option.id === control.dataset.id);
    panel.pending[kind] = panel.pending[kind].filter((chosen) => chosen.id !== control.dataset.id);
    if (control.checked && item) panel.pending[kind].push(item);
    const button = panel.element.querySelector(`[data-add-selected="${kind}"]`);
    button.disabled = !panel.pending[kind].length;
    button.textContent = `Add selected (${panel.pending[kind].length})`;
  }));
  panel.element.querySelectorAll("[data-add-selected]").forEach((button) => button.addEventListener("click", () => {
    const kind = button.dataset.addSelected;
    for (const item of panel.pending[kind]) if (!panel.draft[kind].some((chosen) => chosen.id === item.id)) panel.draft[kind].push(item);
    panel.pending[kind] = [];
    panel.dirty = true;
    panel.saved = false;
    render(panel);
  }));
  for (const mode of ["add", "remove"]) {
    panel.element.querySelectorAll(`[data-${mode}-kind]`).forEach((button) => button.addEventListener("click", () => {
      if (panel.busy) return;
      const kind = button.dataset[`${mode}Kind`];
      const item = panel.options[kind].find((option) => option.id === button.dataset.id);
      if (mode === "add" && item && !panel.draft[kind].some((chosen) => chosen.id === item.id)) panel.draft[kind].push(item);
      if (mode === "remove") panel.draft[kind] = panel.draft[kind].filter((chosen) => chosen.id !== button.dataset.id);
      panel.dirty = true;
      panel.saved = false;
      render(panel);
    }));
  }
  panel.element.querySelector("[data-save-block]").addEventListener("click", () => saveBlock(panel));
  const replacement = Array.from(panel.element.querySelectorAll("button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled)"))
    .find((control) => focusAttributes.length && focusAttributes.every(([name, value]) => control.getAttribute(name) === value));
  (replacement || panel.element.querySelector("[data-block-select]:not(:disabled)") || panel.element.querySelector("[data-close-collections]")).focus();
}

async function findOptions(panel) {
  const generation = ++panel.generation;
  try {
    const params = new URLSearchParams({ exerciseSearch: panel.search.exercises, userSearch: panel.search.users });
    const options = await api(`/api/exercise-collections/options?${params}`);
    if (activePanel !== panel || generation !== panel.generation) return;
    panel.options = options;
    panel.error = "";
  } catch (error) {
    if (activePanel !== panel || generation !== panel.generation) return;
    panel.error = messages[error.message] || "Could not load block choices.";
  }
  render(panel);
}

async function saveBlock(panel) {
  if (panel.busy) return;
  if (!panel.draft.name.trim()) { panel.error = "Enter a block name."; render(panel); return; }
  const removedExercises = panel.original.exercises.filter((old) => !panel.draft.exercises.some((item) => item.id === old.id));
  const removedUsers = panel.original.users.filter((old) => !panel.draft.users.some((item) => item.id === old.id));
  const confirmation = [
    `Save “${panel.draft.name}” with ${panel.draft.exercises.length} exercises and ${panel.draft.users.length} selected users?`,
    panel.draft.accessAll ? "All users, including future users, can access these system exercises." : "Only the application administrator and selected users can access these system exercises.",
    `Without access: block ${panel.draft.blockPreview || "hidden"}; exercise names ${panel.draft.exercisePreview || "hidden"}. Locked previews never include original exercise media or instructions.`,
    // Switching all-users access off revokes everyone without an individual grant.
    panel.original.accessAll && !panel.draft.accessAll ? "Everyone who is not a selected user loses access to these exercises, including their personal copies." : "",
    removedUsers.length && !panel.draft.accessAll ? `Remove access, including personal copies, for: ${removedUsers.map(userLabel).join(", ")}.` : "",
    panel.draft.users.length ? `Selected users: ${panel.draft.users.map(userLabel).join(", ")}.` : "",
    removedExercises.length ? `Removing these exercises from the block makes their originals available to all coaches: ${removedExercises.map((exercise) => exercise.name).join(", ")}. Personal copies stay private.` : "",
  ].filter(Boolean).join("\n\n");
  if (!window.confirm(confirmation)) return;
  panel.busy = true;
  panel.saved = false;
  panel.error = "";
  render(panel);
  try {
    const result = await api(`/api/exercise-collections${panel.draft.id ? `/${encodeURIComponent(panel.draft.id)}` : ""}`, {
      method: panel.draft.id ? "PATCH" : "POST",
      body: JSON.stringify({ name: panel.draft.name, expectedRevision: panel.draft.revision,
        description: panel.draft.description, coverImageUrl: panel.draft.coverImageUrl, accessAll: panel.draft.accessAll,
        blockPreview: panel.draft.blockPreview, exercisePreview: panel.draft.exercisePreview,
        exerciseIds: panel.draft.exercises.map((item) => item.id), userIds: panel.draft.users.map((item) => item.id) }),
    });
    if (activePanel !== panel) return;
    panel.collections = panel.collections.filter((block) => block.id !== result.collection.id).concat(result.collection);
    panel.draft = structuredClone(result.collection);
    panel.original = structuredClone(result.collection);
    panel.saved = true;
    panel.dirty = false;
    await findOptions(panel);
    try { await panel.onSave(result.collection); }
    catch { panel.error = "The block was saved. Reopen Exercise Library to refresh the list."; }
  } catch (error) {
    if (activePanel !== panel) return;
    panel.error = messages[error.message] || "Save was not confirmed. Close and reopen to check the block before retrying.";
  } finally {
    panel.busy = false;
    render(panel);
  }
}

export async function openExerciseCollections(onSave, collectionId = "") {
  if (activePanel) return;
  const element = document.createElement("div");
  element.className = "exercise-editor-overlay exercise-collections-overlay";
  const panel = { element, previousFocus: document.activeElement, onSave, collections: [], draft: emptyDraft(), original: emptyDraft(),
    options: {}, pending: { exercises: [], users: [] }, search: { exercises: "", users: "" }, generation: 0, busy: false, error: "", saved: false, dirty: false };
  activePanel = panel;
  panel.previousOverflow = document.body.style.overflow;
  panel.background = Array.from(document.body.children).map((child) => [child, child.inert]);
  for (const [child] of panel.background) child.inert = true;
  document.body.style.overflow = "hidden";
  panel.keydown = (event) => {
    if (event.key === "Escape") { element.querySelector("[data-close-collections]").click(); return; }
    if (event.key !== "Tab") return;
    const controls = Array.from(element.querySelectorAll("button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled)"));
    const first = controls[0];
    const last = controls.at(-1);
    if (event.shiftKey && (document.activeElement === first || !element.contains(document.activeElement))) {
      event.preventDefault(); last?.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault(); first?.focus();
    }
  };
  document.addEventListener("keydown", panel.keydown);
  document.body.append(element);
  render(panel);
  element.querySelector("[data-block-select]").focus();
  try {
    const result = await api("/api/exercise-collections");
    if (activePanel !== panel) return;
    panel.collections = result.collections;
    if (collectionId) {
      const selected = panel.collections.find((block) => block.id === collectionId);
      if (selected) panel.draft = structuredClone(selected);
      panel.original = structuredClone(panel.draft);
    }
    await findOptions(panel);
  } catch (error) {
    panel.error = messages[error.message] || "Could not load application blocks.";
    render(panel);
  }
}
