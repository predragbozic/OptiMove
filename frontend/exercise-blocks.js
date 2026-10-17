import { api } from "./api.js";
import { ICON_SETTINGS } from "./exercise-library.js";
import { imageSources, parseImageFallbacks, renderImage, videoThumbnailSources } from "./media.js";
import { emptyExerciseFilters, state } from "./state.js";
import { escapeAttr, escapeHtml } from "./utils.js";

let refreshCatalog = null;

export async function refreshExerciseBlocks() {
  return refreshCatalog ? refreshCatalog() : false;
}

export const COVER_SLIDE_INTERVAL_MS = 1000;
const COVER_SLIDE_LIMIT = 10;
const CHEVRON = { "-1": '<path d="M15 5l-7 7 7 7"></path>', 1: '<path d="M9 5l7 7-7 7"></path>' };

const PLACEHOLDER = '<span class="exercise-block-placeholder" aria-hidden="true">▦</span>';

// The pictures a card without a cover of its own steps through (the
// catalog's coverSlides, never sent for a locked block): each exercise's
// image first, then its video's cover - the order a library card walks.
// An exercise with no picture link, or showing a picture already in the
// turn, is left out.
export function blockCoverSlides(block) {
  if (block.locked || !Array.isArray(block.coverSlides)) return [];
  const seen = new Set();
  return block.coverSlides
    .map((slide) => [...imageSources(slide?.imageUrl), ...videoThumbnailSources(slide?.videoUrl, { large: true })])
    .filter((sources) => sources.length && !seen.has(sources[0]) && seen.add(sources[0]))
    .slice(0, COVER_SLIDE_LIMIT);
}

function renderSlideImage(sources, index) {
  const fallbacks = sources.slice(1);
  return `<img class="exercise-block-cover-image" src="${escapeAttr(sources[0])}" alt="" referrerpolicy="no-referrer" decoding="async" data-slide="${index}"${fallbacks.length ? ` data-fallbacks="${escapeAttr(JSON.stringify(fallbacks))}"` : ""}>`;
}

// A card's picture: the block's own cover; without one, its exercises'
// pictures - two or more step every second, with Previous / Next arrows and
// a dot per picture; otherwise the neutral placeholder. The placeholder
// always follows a picture and shows once the picture is image-missing.
function renderBlockCover(block) {
  const tag = block.locked ? "div" : "button";
  const open = block.locked ? "" : `type="button" data-open-block="${escapeAttr(block.id)}" data-block-name="${escapeAttr(block.name)}" aria-label="Open ${escapeAttr(block.name)}"`;
  const slides = blockCoverSlides(block);
  const picture = slides.length
    ? renderSlideImage(slides[0], 0)
    : block.coverImageUrl ? renderImage(block.coverImageUrl, "exercise-block-cover-image", block.name).replace("<img ", '<img referrerpolicy="no-referrer" ') : "";
  const cover = `<${tag} class="exercise-block-cover" ${open}>${picture}${PLACEHOLDER}</${tag}>`;
  if (slides.length < 2) return cover;
  const arrow = (step, label) => `<button class="exercise-block-cover-step ${step < 0 ? "is-previous" : "is-next"}" type="button" data-block-slide-step="${step}" aria-label="${label} picture: ${escapeAttr(block.name)}" title="${label} picture"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${CHEVRON[step]}</svg></button>`;
  return `<div class="exercise-block-cover-frame" data-block-id="${escapeAttr(block.id)}" data-block-slides="${escapeAttr(JSON.stringify(slides))}" data-slide-index="0">${cover}
    ${arrow(-1, "Previous")}${arrow(1, "Next")}
    <span class="exercise-block-cover-dots" aria-hidden="true">${slides.map((_, index) => `<span${index ? "" : ' class="is-active"'}></span>`).join("")}</span></div>`;
}

function readSlides(frame) {
  const slides = parseImageFallbacks(frame.dataset.blockSlides);
  return slides.filter((sources) => Array.isArray(sources) && sources.length);
}

function brokenSlides(frame) {
  return new Set(String(frame.dataset.brokenSlides || "").split(",").filter(Boolean).map(Number));
}

// Puts picture `index` of a card on screen. The same <img> gets the new
// address, so the browser keeps the last picture until the next is ready.
function showBlockCover(frame, index) {
  const sources = readSlides(frame)[index];
  const image = frame.querySelector(".exercise-block-cover-image");
  if (!sources || !image) return false;
  image.classList.remove("image-missing");
  if (sources.length > 1) image.dataset.fallbacks = JSON.stringify(sources.slice(1));
  else delete image.dataset.fallbacks;
  image.dataset.slide = String(index);
  image.src = sources[0];
  frame.dataset.slideIndex = String(index);
  frame.querySelectorAll(".exercise-block-cover-dots > span").forEach((dot, dotIndex) => dot.classList.toggle("is-active", dotIndex === index));
  return true;
}

// Shows the next (step 1) or previous (step -1) picture of a card, passing
// over pictures that did not load, and asks for the one after it so the
// next step has it ready.
export function stepBlockCover(frame, step) {
  const slides = readSlides(frame);
  const broken = brokenSlides(frame);
  if (slides.length - broken.size < 1) return false;
  const direction = step < 0 ? -1 : 1;
  const after = (from) => {
    let index = from;
    for (let tries = 0; tries < slides.length; tries += 1) {
      index = (index + direction + slides.length) % slides.length;
      if (!broken.has(index)) break;
    }
    return index;
  };
  const index = after(Number(frame.dataset.slideIndex) || 0);
  if (!showBlockCover(frame, index)) return false;
  const next = after(index);
  const view = frame.ownerDocument?.defaultView;
  if (next !== index && view?.Image) {
    const preload = new view.Image();
    preload.referrerPolicy = "no-referrer";
    preload.src = slides[next][0];
  }
  return true;
}

// A picture whose every address failed (the app's image error handler has
// already marked it image-missing): it leaves the card's turn and the card
// moves on; with no picture left the placeholder behind it shows.
export function dropBrokenBlockCover(image) {
  const frame = image?.closest?.("[data-block-slides]");
  if (!frame || !image.classList.contains("image-missing")) return false;
  const slides = readSlides(frame);
  const broken = brokenSlides(frame);
  broken.add(Number(image.dataset.slide ?? frame.dataset.slideIndex) || 0);
  frame.dataset.brokenSlides = [...broken].join(",");
  frame.querySelectorAll(".exercise-block-cover-dots > span").forEach((dot, dotIndex) => dot.classList.toggle("is-broken", broken.has(dotIndex)));
  const left = slides.length - broken.size;
  if (left <= 1) frame.classList.add("is-single");
  return left >= 1 ? stepBlockCover(frame, 1) : true;
}

// One step of every card's own turn: only cards on screen whose picture has
// loaded, never while the mouse pointer or the keyboard focus is on the
// card (a touch screen keeps :hover on whatever was last tapped, so there
// only focus counts), never once the coach used its arrows, never in a
// hidden tab, and not at all when the device asks for reduced motion (the
// arrows still work).
export function advanceBlockCovers(root) {
  const view = root.ownerDocument?.defaultView;
  if (!view || view.document.hidden || view.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches) return 0;
  const touchOnly = view.matchMedia?.("(hover: none)")?.matches === true;
  let stepped = 0;
  for (const frame of root.querySelectorAll("[data-block-slides]")) {
    if (frame.dataset.slidesPaused || frame.classList.contains("is-single")) continue;
    const card = frame.closest(".exercise-block-card") || frame;
    let hovered = false;
    if (!touchOnly) {
      try { hovered = card.matches(":hover"); } catch { hovered = false; }
    }
    if (hovered || card.contains(view.document.activeElement)) continue;
    if (frame.querySelector(".exercise-block-cover-image")?.complete === false) continue;
    const rect = frame.getBoundingClientRect();
    if (rect.bottom <= 0 || rect.top >= view.innerHeight || rect.width === 0) continue;
    if (stepBlockCover(frame, 1)) stepped += 1;
  }
  return stepped;
}

// A card the coach stopped with its arrows stays stopped on the picture they
// chose when the catalog is drawn again (a search, a realtime refresh), for
// as long as this Blocks view is open.
function restoreStoppedBlockCovers(root, stopped) {
  for (const frame of root.querySelectorAll("[data-block-slides]")) {
    if (!stopped.has(frame.dataset.blockId)) continue;
    frame.dataset.slidesPaused = "manual";
    const index = stopped.get(frame.dataset.blockId);
    if (index > 0 && index < readSlides(frame).length) showBlockCover(frame, index);
  }
}

export function renderExerciseBlocksHtml(data, search = "") {
  const blocks = [...data.blocks, ...(data.other.exerciseCount && (!search || "other".includes(search.toLowerCase())) ? [data.other] : [])];
  // Block administration lives here, behind the gear: never on the plain library.
  return `<div class="library-results-head exercise-blocks-head"><h3>Exercise blocks</h3>
    <div class="exercise-browse-controls">
      <button class="exercise-browse-button" type="button" data-block-exercises>All exercises</button>
      ${data.canManageCollections ? `<button class="exercise-browse-button is-icon" type="button" data-action="exercise-collections-open" aria-label="Manage application blocks" title="Manage application blocks">${ICON_SETTINGS}</button>` : ""}
    </div></div>
    <p class="muted">Active, visible exercises grouped into available packages. Other contains exercises outside application blocks.</p>
    <div class="exercise-block-grid">${blocks.map((block) => `<article class="panel exercise-block-card ${block.locked ? "is-locked" : ""}">
      ${renderBlockCover(block)}
      <div class="exercise-block-card-body"><span class="item-badge">${Number(block.exerciseCount)} exercises</span>
        <h3>${escapeHtml(block.name)}</h3><p>${escapeHtml(block.description || "")}</p>
        <div class="chip-row">${block.locked ? '<span class="exercise-block-lock"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><rect x="5" y="10" width="14" height="11" rx="2"></rect><path d="M8 10V7a4 4 0 0 1 8 0v3"></path><path d="M12 14v3"></path></svg><span>Access required — contact your administrator</span></span>' : `<button class="plain-button compact-button" type="button" data-open-block="${escapeAttr(block.id)}" data-block-name="${escapeAttr(block.name)}">View exercises</button>`}
        ${data.canManageCollections && !block.locked && block.id !== "other" ? `<button class="plain-button compact-button" type="button" data-action="exercise-collections-open" data-collection-id="${escapeAttr(block.id)}">Edit block</button>` : ""}</div></div></article>`).join("")}</div>
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
  // Cards the coach stopped with the arrows: block id -> the picture chosen.
  const stopped = new Map();
  const load = async () => {
    if (!root.isConnected || !input.isConnected) return false;
    const request = ++generation;
    root.innerHTML = '<p role="status">Loading blocks...</p>';
    try {
      const data = await api(`/api/exercise-collections/catalog?search=${encodeURIComponent(input.value.trim())}`);
      if (!root.isConnected || !input.isConnected || request !== generation) return;
      root.innerHTML = renderExerciseBlocksHtml(data, input.value.trim());
      restoreStoppedBlockCovers(root, stopped);
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
  // The app's own image error handler (on the document, capture) runs first:
  // it tries the next address, and marks the picture image-missing when none
  // is left - only then does the card drop that picture.
  root.addEventListener("error", (event) => {
    if (event.target?.classList?.contains("exercise-block-cover-image")) dropBrokenBlockCover(event.target);
  }, true);
  // The window that owns the page runs the turn, and it ends on the first
  // step after the catalog leaves the page.
  const view = root.ownerDocument.defaultView;
  const turn = view.setInterval(() => {
    if (!root.isConnected) view.clearInterval(turn);
    else advanceBlockCovers(root);
  }, COVER_SLIDE_INTERVAL_MS);
  root.addEventListener("click", async (event) => {
    const step = event.target.closest("[data-block-slide-step]");
    if (step) {
      // The coach chose the picture: this card stops turning on its own.
      const frame = step.closest("[data-block-slides]");
      if (frame) {
        frame.dataset.slidesPaused = "manual";
        stepBlockCover(frame, Number(step.dataset.blockSlideStep));
        stopped.set(frame.dataset.blockId, Number(frame.dataset.slideIndex));
      }
      return;
    }
    const button = event.target.closest("[data-open-block], [data-block-exercises]");
    if (!button) return;
    state.exerciseSearch.filters = emptyExerciseFilters();
    if (button.dataset.openBlock) state.exerciseSearch.filters.collection = button.dataset.openBlock;
    state.exerciseSearch.collectionName = button.dataset.blockName || "";
    await loadExercises(handlers);
  });
  await load();
}
