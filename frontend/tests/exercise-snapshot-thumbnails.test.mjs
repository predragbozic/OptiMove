import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { renderExerciseThumb, replaceExerciseThumbWithInitials } from "../exercise-view-modes.js";
import { renderBuilderAddedList, renderBuilderStickyBar } from "../builder-exercises.js";
import { renderExerciseItemHtml } from "../exercise-view.js";
import { renderExerciseLibraryHtml } from "../exercise-library.js";
import { emptyExerciseFilters } from "../state.js";

const title = "Stolica na jednoj nozi";
const image = "https://example.com/exercise.png";
const video = "https://drive.google.com/file/d/VIDEO_1215/view";
const renderers = {
  library: (item) => renderExerciseThumb(item, "thumb"),
  builder: (item) => renderBuilderAddedList({ items: [{ id: "item", ...item }] }),
  sticky: (item) => renderBuilderStickyBar({ items: [item] }, "added"),
  horizontal: (item) => renderExerciseItemHtml(item, "item", "horizontal"),
  vertical: (item) => renderExerciseItemHtml(item, "item", "vertical"),
};

function pictures(html) {
  return [...new JSDOM(html).window.document.querySelectorAll("img")];
}

test("image and then video cover have the same fallback order in Library, Builder and plan", () => {
  for (const render of Object.values(renderers)) {
    const [picture] = pictures(render({ title, imageUrl: image, videoUrl: video }));
    assert.equal(picture.src, image);
    assert.match(picture.dataset.fallbacks, /thumbnail\?id=VIDEO_1215/);
    assert.equal(picture.dataset.fallbackInitials, "SN");
    assert.equal(replaceExerciseThumbWithInitials(picture), true);
  }
});

test("NULL-image 1215 snapshots show the existing video cover without changing playback", () => {
  for (const render of Object.values(renderers)) {
    const html = render({ title, imageUrl: null, videoUrl: video });
    assert.match(pictures(html)[0].src, /thumbnail\?id=VIDEO_1215/);
    if (render !== renderers.library) assert.match(html, /data-video="https:\/\/drive.google.com\/file\/d\/VIDEO_1215\/view"/);
  }
});

test("no media creates no image or unauthorized request; direct videos use initials", () => {
  for (const render of Object.values(renderers)) {
    assert.equal(pictures(render({ title })).length, 0);
    const html = render({ title, videoUrl: "https://example.com/direct.mp4" });
    assert.equal(pictures(html).length, 0);
    assert.match(html, /exercise-thumb-fallback/);
  }
});

test("FE-1 asset context belongs to the plan item and explicit none suppresses stale URLs", () => {
  const media = { image: { source: "asset", mediaId: "asset-image" }, video: { source: "none" },
    accessContext: { type: "program_item", id: "item-context" } };
  for (const render of Object.values(renderers)) {
    const html = render({ title, imageUrl: image, videoUrl: video, media });
    const [picture] = pictures(html);
    assert.equal(picture.hasAttribute("src"), false);
    assert.equal(picture.dataset.mediaId, "asset-image");
    assert.deepEqual(JSON.parse(picture.dataset.mediaAccessContext), media.accessContext);
    assert.doesNotMatch(html, /VIDEO_1215|example.com\/exercise/);
  }
});

test("Library Details also uses the common image/video fallback", () => {
  const html = renderExerciseLibraryHtml({ exercises: [{ id: "exercise", name: title, image_url: image, video_url: video }],
    itemIds: ["exercise"], markedExerciseIds: new Set(),
    search: { view: "details", term: "", filters: emptyExerciseFilters() }, tagEditor: { open: false } });
  assert.match(pictures(html).find((picture) => picture.className === "media-thumb").dataset.fallbacks, /VIDEO_1215/);
});
