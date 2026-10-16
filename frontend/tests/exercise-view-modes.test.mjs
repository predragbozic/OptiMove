import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";

// Tile / Big / List (and Details in the library) for the Exercise Library and
// the Builder's section editor: video cover images, the initials fallback,
// the remembered choice, the markup of each view and the two actions.

// #content is a fake whose section editor exists only while a test opens it.
const editor = { open: false, results: { innerHTML: "" }, switcher: { outerHTML: "" }, dose: { value: "3" } };
const fakePanel = {
  querySelector: (selector) => ({
    ".builder-exercise-results": editor.results,
    ".builder-library-head .exercise-view-switcher": editor.switcher,
  })[selector] || null,
};
const fakeContent = { querySelector: (selector) => (selector === ".builder-section-panel" && editor.open ? fakePanel : null) };
globalThis.document = { querySelector: (selector) => (selector === "#content" ? fakeContent : null), querySelectorAll: () => [] };
const stored = new Map();
const memoryStorage = {
  getItem: (key) => (stored.has(key) ? stored.get(key) : null),
  setItem: (key, value) => stored.set(key, String(value)),
};
globalThis.localStorage = memoryStorage;

const media = await import("../media.js");
const modes = await import("../exercise-view-modes.js");
const { renderExerciseLibraryHtml } = await import("../exercise-library.js");
const { renderBuilderExerciseResults } = await import("../builder-exercises.js");
const { state, emptyExerciseFilters } = await import("../state.js");
const { handleExerciseLibraryAction } = await import("../exercise-actions.js");
const { handleBuilderWorkspaceAction } = await import("../builder-actions.js");
const { renderBuilderExerciseViewChange } = await import("../builder-view.js");

const exercises = [
  { id: "a", name: "Hip Stretch", aim: "Hip mobility", image_url: "https://img.example/hip.jpg", video_url: "https://youtu.be/AAAAAAAAAA1", owner_scope: "system", is_favorite: true, tags: [{ id: 1, name: "warm-up" }] },
  { id: "b", name: "Wall Ankle Mob", aim: "", image_url: "", video_url: "https://www.youtube.com/watch?v=BBBBBBBBBB2", owner_scope: "user", tags: [] },
  { id: "c", name: "Plank", aim: "Trunk", image_url: "", video_url: "", owner_scope: "system", tags: [] },
];

function libraryHtml(view, { platformAdmin = false } = {}) {
  return renderExerciseLibraryHtml({
    exercises,
    itemIds: exercises.map((exercise) => `item-${exercise.id}`),
    markedExerciseIds: new Set(["b"]),
    search: { view, term: "", filters: emptyExerciseFilters(), canManageCollections: platformAdmin },
    tagEditor: { open: false },
  });
}

beforeEach(() => {
  stored.clear();
  globalThis.localStorage = memoryStorage;
});

test("1. a YouTube id is read only from YouTube's own hosts and link forms", () => {
  for (const url of [
    "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    "https://youtube.com/watch?feature=share&v=dQw4w9WgXcQ",
    "https://m.youtube.com/watch?v=dQw4w9WgXcQ",
    "https://youtu.be/dQw4w9WgXcQ?t=12",
    "https://www.youtube.com/shorts/dQw4w9WgXcQ",
    "https://www.youtube.com/embed/dQw4w9WgXcQ",
    "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ",
  ]) assert.equal(media.getYouTubeId(url), "dQw4w9WgXcQ", url);
  for (const url of [
    "https://evil.example/watch?v=dQw4w9WgXcQ",
    "https://youtube.com.evil.example/watch?v=dQw4w9WgXcQ",
    "javascript:alert(1)//youtube.com/watch?v=dQw4w9WgXcQ",
    "https://www.youtube.com/watch?v=short",
    "https://www.youtube.com/watch?v=dQw4w9WgXcQ\"><script>",
    "not a url",
    "",
  ]) assert.equal(media.getYouTubeId(url), "", url);
});

test("2. cover images: YouTube's public covers, Drive's thumbnail, nothing for other links; YouTube plays through the privacy embed", () => {
  assert.deepEqual(media.videoThumbnailSources("https://youtu.be/dQw4w9WgXcQ"), [
    "https://i.ytimg.com/vi/dQw4w9WgXcQ/mqdefault.jpg",
    "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg",
  ]);
  assert.deepEqual(media.videoThumbnailSources("https://drive.google.com/file/d/FILE_1/view?usp=sharing"), [
    "https://drive.google.com/thumbnail?id=FILE_1&sz=w640",
    "https://lh3.googleusercontent.com/d/FILE_1=w640",
  ]);
  assert.deepEqual(media.videoThumbnailSources("https://cdn.example/clip.mp4"), []);
  assert.deepEqual(media.videoThumbnailSources(""), []);
  assert.equal(media.toYouTubeEmbedUrl("https://youtu.be/dQw4w9WgXcQ", { autoplay: true }), "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?autoplay=1");
  assert.equal(media.toYouTubeEmbedUrl("https://cdn.example/clip.mp4"), "");
});

test("3. an exercise picture tries its own image, then its video cover, then shows initials", () => {
  const withBoth = modes.renderExerciseThumb(exercises[0], "thumb");
  assert.match(withBoth, /^<img class="thumb" src="https:\/\/img\.example\/hip\.jpg"/);
  const fallbacks = JSON.parse(withBoth.match(/data-fallbacks="([^"]+)"/)[1].replaceAll("&quot;", "\""));
  assert.deepEqual(fallbacks, ["https://i.ytimg.com/vi/AAAAAAAAAA1/mqdefault.jpg", "https://i.ytimg.com/vi/AAAAAAAAAA1/hqdefault.jpg"]);
  assert.match(withBoth, /data-fallback-initials="HS"/);

  const videoOnly = modes.renderExerciseThumb(exercises[1], "thumb");
  assert.match(videoOnly, /src="https:\/\/i\.ytimg\.com\/vi\/BBBBBBBBBB2\/mqdefault\.jpg"/);

  assert.equal(modes.renderExerciseThumb(exercises[2], "thumb"), `<span class="thumb exercise-thumb-fallback" aria-hidden="true">P</span>`);
  const hostile = modes.renderExerciseThumb({ name: "<b>x</b> \"y", image_url: "https://img.example/a.jpg\"onerror=\"alert(1)" }, "thumb");
  assert.doesNotMatch(hostile, /<b>|"onerror=/);
});

test("4. when every source failed, the picture becomes the initials in the same size", () => {
  let replacement = null;
  const image = {
    className: "exercise-view-thumb",
    dataset: { fallbackInitials: "WT" },
    ownerDocument: { createElement: () => ({ setAttribute(name, value) { this[name] = value; } }) },
    replaceWith(node) { replacement = node; },
  };
  assert.equal(modes.replaceExerciseThumbWithInitials(image), true);
  assert.equal(replacement.className, "exercise-view-thumb exercise-thumb-fallback");
  assert.equal(replacement.textContent, "WT");
  assert.equal(replacement["aria-hidden"], "true");
  assert.equal(modes.replaceExerciseThumbWithInitials({ dataset: {} }), false, "any other image is left to the other handlers");
});

test("5. the chosen view is remembered per surface, and an unknown or unreadable value falls back to the default", () => {
  assert.equal(modes.readExerciseViewPreference("library"), "details");
  assert.equal(modes.readExerciseViewPreference("builder"), "list");
  modes.saveExerciseViewPreference("library", "big");
  modes.saveExerciseViewPreference("builder", "tile");
  assert.equal(modes.readExerciseViewPreference("library"), "big");
  assert.equal(modes.readExerciseViewPreference("builder"), "tile");
  modes.saveExerciseViewPreference("builder", "details");
  assert.equal(stored.get("optimove.exerciseView.builder"), "list", "Details does not exist in the builder");
  stored.set("optimove.exerciseView.library", "<script>");
  assert.equal(modes.readExerciseViewPreference("library"), "details");
  globalThis.localStorage = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); } };
  assert.equal(modes.readExerciseViewPreference("library"), "details");
  assert.doesNotThrow(() => modes.saveExerciseViewPreference("library", "tile"));
  delete globalThis.localStorage;
  assert.equal(modes.readExerciseViewPreference("builder"), "list");
});

test("6. the switcher offers Tile, Big, List and Details in the library, and three views in the builder", () => {
  const library = modes.renderExerciseViewSwitcher("library", "big", "exercise-library-view");
  assert.deepEqual([...library.matchAll(/data-view="([a-z]+)"/g)].map((match) => match[1]), ["tile", "big", "list", "details"]);
  assert.match(library, /data-view="big" aria-pressed="true"/);
  assert.equal([...library.matchAll(/aria-pressed="true"/g)].length, 1);
  const builder = modes.renderExerciseViewSwitcher("builder", "details", "builder-exercise-view");
  assert.deepEqual([...builder.matchAll(/data-view="([a-z]+)"/g)].map((match) => match[1]), ["tile", "big", "list"]);
  assert.match(builder, /data-view="list" aria-pressed="true"/, "an unknown view shows the default as chosen");
  assert.match(builder, /data-action="builder-exercise-view"/);
});

test("7. the library keeps the original card under Details, and Tile, Big and List share one card with the same actions", () => {
  const details = libraryHtml("details");
  assert.match(details, /class="exercise-grid"/);
  assert.equal([...details.matchAll(/<article class="exercise-card">/g)].length, 3);
  assert.doesNotMatch(details, /exercise-view-grid/);

  for (const view of ["tile", "big", "list"]) {
    const html = libraryHtml(view);
    assert.match(html, new RegExp(`class="exercise-view-grid is-${view}"`));
    assert.doesNotMatch(html, /<article class="exercise-card">/);
    assert.equal([...html.matchAll(/<article class="exercise-view-card">/g)].length, 3);
  }
  const tile = libraryHtml("tile");
  const cards = tile.split(`<article class="exercise-view-card">`).slice(1);
  assert.match(cards[0], /data-action="exercise-toggle-favorite"[^>]*data-favorite="true"[^>]*aria-pressed="true"/);
  assert.match(cards[1], /data-action="exercise-toggle-mark"[^>]*aria-pressed="true"/);
  assert.match(cards[1], /data-action="open-media"[^>]*data-image=""[^>]*data-video="https:\/\/www\.youtube\.com\/watch\?v=BBBBBBBBBB2"/, "a video-only exercise previews its video");
  assert.doesNotMatch(cards[2], /data-action="open-media"/, "no media, nothing to preview");
  assert.match(cards[0], /data-action="open-exercise" data-item-id="item-a"/);
  assert.match(cards[0], /Tags \(1\)/);
  assert.match(cards[0], /exercise-copy-open/);
  assert.doesNotMatch(cards[0], /exercise-edit-open/, "an application exercise is edited only by a platform admin");
  assert.doesNotMatch(cards[1], /exercise-copy-open/);
  assert.match(cards[1], /exercise-edit-open/, "the coach's own exercise");
  assert.match(libraryHtml("tile", { platformAdmin: true }).split(`<article class="exercise-view-card">`)[1], /exercise-edit-open/);
  assert.match(libraryHtml("unknown"), /class="exercise-grid"/, "an unknown view is Details");
});

test("8. the builder renders the same result cards in the chosen view, with Load more outside the grid", () => {
  const node = { items: [{ exerciseId: "a" }] };
  for (const view of ["tile", "big", "list"]) {
    const html = renderBuilderExerciseResults(exercises, new Set(), node, { view, hasMore: true });
    assert.match(html, new RegExp(`^<div class="builder-exercise-view is-${view}">`));
    assert.match(html, /<\/div><button type="button" class="plain-button" data-action="builder-load-more-exercises"/);
    assert.equal([...html.matchAll(/data-action="builder-pick-exercise"/g)].length, 3);
  }
  assert.match(renderBuilderExerciseResults(exercises, new Set(), node, { view: "details" }), /^<div class="builder-exercise-view is-list">/);
  assert.match(renderBuilderExerciseResults(exercises, new Set(), node), /^<div class="builder-exercise-view is-list">/);
  const html = renderBuilderExerciseResults(exercises, new Set(), node, { view: "tile" });
  assert.match(html, /Added 1×/);
  assert.match(html, /src="https:\/\/i\.ytimg\.com\/vi\/BBBBBBBBBB2\/mqdefault\.jpg"/, "a video-only exercise shows its video cover");
  assert.match(html, /builder-exercise-preview-empty"><span class="builder-exercise-thumb exercise-thumb-fallback" aria-hidden="true">P<\/span>/);
});

test("9. clicking anywhere folds the open ⋯ menus except the one whose button was pressed", () => {
  const menu = (name) => ({ name, open: true, removeAttribute() { this.open = false; } });
  const first = menu("first");
  const second = menu("second");
  const root = { querySelectorAll: () => [first, second].filter((item) => item.open) };
  modes.closeExerciseViewMenus({ closest: (selector) => (selector === ".exercise-view-menu > summary" ? { parentElement: first } : null) }, root);
  assert.equal(first.open, true);
  assert.equal(second.open, false);
  modes.closeExerciseViewMenus({ closest: () => null }, root);
  assert.equal(first.open, false);
});

test("10. switching the view saves the choice and repaints the library or the builder from what is already loaded", async () => {
  const painted = [];
  state.lastExerciseResults = exercises;
  assert.equal(await handleExerciseLibraryAction({ dataset: { action: "exercise-library-view", view: "big" } }, { renderExercises: (rows) => painted.push(rows) }), true);
  assert.equal(state.exerciseSearch.view, "big");
  assert.equal(stored.get("optimove.exerciseView.library"), "big");
  assert.deepEqual(painted, [exercises]);
  await handleExerciseLibraryAction({ dataset: { action: "exercise-library-view", view: "bogus" } }, { renderExercises: () => {} });
  assert.equal(state.exerciseSearch.view, "details");

  let builderPaints = 0;
  assert.equal(await handleBuilderWorkspaceAction({ dataset: { action: "builder-exercise-view", view: "tile" } }, { renderBuilder: () => { builderPaints += 1; }, renderBuilderExerciseViewChange: () => false }), true);
  assert.equal(state.builder.exerciseView, "tile");
  assert.equal(stored.get("optimove.exerciseView.builder"), "tile");
  assert.equal(builderPaints, 1, "no section editor on screen: the whole builder is painted");
  await handleBuilderWorkspaceAction({ dataset: { action: "builder-exercise-view", view: "big" } }, { renderBuilder: () => { builderPaints += 1; }, renderBuilderExerciseViewChange: () => true });
  assert.equal(builderPaints, 1, "with the section editor open only the switcher and the results are repainted");
});

test("11. in the open section editor a view switch repaints only the switcher and the results, so a typed dose survives", () => {
  const section = { id: "s1", type: "section", items: [{ exerciseId: "a" }] };
  state.builder.draft = { blocks: [{ sessions: [{ nodes: [section] }] }] };
  state.builder.selectedNodeId = "s1";
  state.builder.exercises = exercises;
  state.builder.exerciseView = "big";
  editor.open = false;
  assert.equal(renderBuilderExerciseViewChange(), false, "editor closed: the caller paints the whole builder");
  editor.open = true;
  editor.results.innerHTML = "old";
  assert.equal(renderBuilderExerciseViewChange(), true);
  assert.match(editor.results.innerHTML, /^<div class="builder-exercise-view is-big">/);
  assert.match(editor.switcher.outerHTML, /data-view="big" aria-pressed="true"/);
  assert.equal(editor.dose.value, "3", "nothing else of the editor is touched");
  state.builder.selectedNodeId = "missing";
  assert.equal(renderBuilderExerciseViewChange(), false);
});
