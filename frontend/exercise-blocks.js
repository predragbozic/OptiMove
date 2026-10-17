import { api } from "./api.js";
import { renderImage } from "./media.js";
import { emptyExerciseFilters, state } from "./state.js";
import { escapeAttr, escapeHtml } from "./utils.js";

let refreshCatalog = null;

export async function refreshExerciseBlocks() {
  return refreshCatalog ? refreshCatalog() : false;
}

export function renderExerciseBlocksHtml(data, search = "") {
  const blocks = [...data.blocks, ...(data.other.exerciseCount && (!search || "other".includes(search.toLowerCase())) ? [data.other] : [])];
  return `<div class="library-results-head"><h3>Exercise blocks</h3>
    <button class="plain-button compact-button" type="button" data-block-exercises>All exercises</button>
    ${data.canManageCollections ? '<button class="plain-button compact-button" type="button" data-action="exercise-collections-open">Create / manage blocks</button>' : ""}</div>
    <p class="muted">Active, visible exercises grouped into available packages. Other contains exercises outside application blocks.</p>
    <div class="exercise-block-grid">${blocks.map((block) => `<article class="panel exercise-block-card ${block.locked ? "is-locked" : ""}">
      <${block.locked ? 'div' : 'button'} class="exercise-block-cover" ${block.locked ? '' : `type="button" data-open-block="${escapeAttr(block.id)}" aria-label="Open ${escapeAttr(block.name)}"`}>
        ${block.coverImageUrl ? renderImage(block.coverImageUrl, "exercise-block-cover-image", block.name) : '<span class="exercise-block-placeholder" aria-hidden="true">▦</span>'}</${block.locked ? 'div' : 'button'}>
      <div class="exercise-block-card-body"><span class="item-badge">${Number(block.exerciseCount)} exercises</span>
        <h3>${escapeHtml(block.name)}</h3><p>${escapeHtml(block.description || "")}</p>
        <div class="chip-row">${block.locked ? '<span class="exercise-block-lock">🔒 Access required — contact your administrator</span>' : `<button class="plain-button compact-button" type="button" data-open-block="${escapeAttr(block.id)}">View exercises</button>`}
        ${data.canManageCollections && !block.locked && block.id !== "other" ? `<button class="plain-button compact-button" type="button" data-action="exercise-collections-open" data-collection-id="${escapeAttr(block.id)}">Edit / Assign</button>` : ""}</div></div></article>`).join("")}</div>
    ${blocks.length ? "" : '<p class="muted">No available blocks match this search.</p>'}`;
}

export async function openExerciseBlocks(handlers) {
  const [{ els }, { loadExercises }] = await Promise.all([import("./dom.js"), import("./exercise-actions.js")]);
  state.exerciseSearch.filters = emptyExerciseFilters();
  state.exerciseSearch.surface = "blocks";
  state.exerciseSearch.term = "";
  state.exerciseSearch.limit = 30;
  els.title.textContent = "Exercise Library";
  els.toolbar.innerHTML = '<label class="search-field exercise-search-field"><span>Find blocks</span><input type="search" class="builder-text-input" data-block-search placeholder="Block name or description"></label>';
  const input = els.toolbar.querySelector("[data-block-search]");
  const root = document.createElement("section");
  root.className = "exercise-block-catalog";
  els.content.replaceChildren(root);
  let generation = 0;
  let timer;
  const load = async () => {
    if (!root.isConnected || !input.isConnected) return false;
    const request = ++generation;
    root.innerHTML = '<p role="status">Loading blocks...</p>';
    try {
      const data = await api(`/api/exercise-collections/catalog?search=${encodeURIComponent(input.value.trim())}`);
      if (!root.isConnected || !input.isConnected || request !== generation) return;
      root.innerHTML = renderExerciseBlocksHtml(data, input.value.trim());
    } catch (error) {
      if (root.isConnected && request === generation) root.innerHTML = `<p class="error" role="alert">${escapeHtml(error.message || "Could not load blocks.")}</p>`;
    }
    return true;
  };
  refreshCatalog = load;
  input.addEventListener("input", () => {
    generation += 1;
    clearTimeout(timer);
    timer = setTimeout(load, 250);
  });
  root.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-open-block], [data-block-exercises]");
    if (!button) return;
    state.exerciseSearch.filters = emptyExerciseFilters();
    if (button.dataset.openBlock) state.exerciseSearch.filters.collection = button.dataset.openBlock;
    await loadExercises(handlers);
  });
  await load();
}
