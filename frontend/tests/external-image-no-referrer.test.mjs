// Every <img> drawn from an address a person entered (a club or team logo, an athlete's photo, a cover, an avatar,
// an exercise's picture, an icon) asks for its picture without our page's address - referrerpolicy="no-referrer" -
// so a host with hotlink protection answers as it does for a direct visit. Google Drive pictures keep their
// fallbacks; a stored (R2) picture is untouched unless it can fall back to a person's link. Invented data only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";

globalThis.document = { querySelector: () => null, querySelectorAll: () => [], body: { classList: { contains: () => false } } };
globalThis.window = { matchMedia: () => ({ matches: false }) };
const { NO_REFERRER } = await import("../utils.js");
const M = await import("../media.js");
const { renderMetricIconHtml } = await import("../icon-render.js");
const { renderExerciseThumb, renderExerciseThumbBackdrop } = await import("../exercise-view-modes.js");
const LOGO = "https://img.example.invalid/club/logo.png?v=2";
const DRIVE = "https://drive.google.com/file/d/abcdefghijklmnopqrstuvwxy/view";
const one = (html) => { const tags = html.match(/<img\b[^>]*>/g) || []; assert.equal(tags.length, 1, html); return tags[0]; };
const policyCount = (tag) => tag.split("referrerpolicy=").length - 1;

test("1. renderImage: a logo, a photo, a cover - one referrerpolicy=\"no-referrer\", with every other attribute as before", () => {
  assert.equal(NO_REFERRER, 'referrerpolicy="no-referrer"');
  assert.equal(M.renderImage(LOGO, "organization-avatar", "Club Example"), `<img class="organization-avatar" src="https://img.example.invalid/club/logo.png?v=2" alt="Club Example" referrerpolicy="no-referrer">`);
  assert.match(M.renderImage(LOGO, "coach-home-strip-thumb", "", "", { lazy: true }), /alt="" referrerpolicy="no-referrer" loading="lazy" decoding="async">$/);
  assert.equal(M.renderImage("", "avatar"), "", "no address, no picture");
  // A Drive picture: the first source and its fallbacks as before; the attribute stays on the element while the
  // app's error handler walks the fallbacks (it only swaps src).
  const drive = one(M.renderImage(DRIVE, "avatar", "", "https://drive.google.com/file/d/abcdefghijklmnopqrstuvwxy/preview"));
  assert.match(drive, /src="https:\/\/drive\.google\.com\/thumbnail\?id=abcdefghijklmnopqrstuvwxy&amp;sz=w1000"/);
  assert.match(drive, /data-fallbacks="\[&quot;https:\/\/lh3\.googleusercontent\.com\/d\/abcdefghijklmnopqrstuvwxy=w1000&quot;,&quot;https:\/\/drive\.google\.com\/uc\?export=view&amp;id=abcdefghijklmnopqrstuvwxy&quot;\]"/);
  assert.match(drive, /data-preview-url=/);
  assert.equal(policyCount(drive), 1);
  assert.equal(policyCount(one(M.renderMediaThumb(LOGO, ""))), 1);
});

test("2. a stored picture: untouched on its own; with a person's links as fallbacks it carries the policy once", () => {
  assert.equal(policyCount(M.renderAssetImage("media-1", null, "media-thumb")), 0, "a stored picture alone is ours: nothing changes");
  const withLinks = M.renderAssetImage("media-1", null, "exercise-view-thumb", { fallbacks: [LOGO], attributes: 'loading="lazy"' });
  assert.equal(policyCount(withLinks), 1);
  assert.match(withLinks, / referrerpolicy="no-referrer"/);
  assert.equal(policyCount(M.renderAssetImage("media-1", null, "c", { fallbacks: [LOGO], attributes: 'referrerpolicy="no-referrer" decoding="async"' })), 1, "a caller that already says it is not doubled");
});

test("3. an exercise's picture and its backdrop, an icon by address", () => {
  const exercise = { name: "Back squat", image_url: LOGO };
  const thumb = renderExerciseThumb(exercise, "exercise-view-thumb", { backdrop: true });
  const tags = thumb.match(/<img\b[^>]*>/g) || [];
  assert.equal(tags.length, 2, thumb);
  for (const tag of tags) assert.equal(policyCount(tag), 1, tag);
  assert.equal(policyCount(one(renderExerciseThumbBackdrop([LOGO]))), 1);
  assert.equal(renderMetricIconHtml("https://img.example.invalid/icon.png", { className: "metric-icon" }), `<img src="https://img.example.invalid/icon.png" alt="" referrerpolicy="no-referrer" class="metric-icon" />`);
  assert.equal(policyCount(renderMetricIconHtml("icon:heart")), 0, "a library icon is not a picture from an address");
});

test("4. no <img> of the app is left asking with our address: every one with a src in a template carries the policy, a stored one aside", async () => {
  const dir = new URL("../", import.meta.url);
  const exempt = new Map([
    // The exercise editor's local preview: a blob: of the file just chosen on this device.
    ["exercise-editor.js", /<img src="\$\{escapeAttr\(field\.previewUrl\)\}" alt="">/],
  ]);
  const found = [];
  for (const file of (await readdir(dir)).filter((f) => f.endsWith(".js"))) {
    const source = await readFile(new URL(file, dir), "utf8");
    // Each template line that opens an <img> with an interpolated src (or the shared exercise attributes).
    for (const line of source.split("\n")) {
      if (!/<img\b[^>]*?(\bsrc="\$\{|\$\{imageAttributes\()/.test(line)) continue;
      if (exempt.get(file)?.test(line)) continue;
      found.push(file);
      for (const tag of line.split("<img").slice(1)) {
        if (!/^[^>]*?(\bsrc="\$\{|\$\{imageAttributes\()/.test(tag)) continue;
        const ok = tag.includes("${NO_REFERRER}") || tag.includes('referrerpolicy="no-referrer"') || tag.includes("${imageAttributes(");
        assert.ok(ok, `${file}: <img${tag.slice(0, 140)}`);
      }
    }
  }
  for (const file of ["media.js", "messages.js", "icon-render.js", "builder-structure.js", "builder-modals.js", "exercise-view-modes.js", "exercise-blocks.js"]) assert.ok(found.includes(file), `${file} was looked at`);
  assert.match(await readFile(new URL("exercise-view-modes.js", dir), "utf8"), /return `src="\$\{escapeAttr\(sources\[0\]\)\}" alt="" \$\{NO_REFERRER\} loading="lazy"/);
  // The page itself sets no policy of its own that would override the per-picture one in the wrong direction.
  assert.doesNotMatch(await readFile(new URL("index.html", dir), "utf8"), /name="referrer"/);
});
