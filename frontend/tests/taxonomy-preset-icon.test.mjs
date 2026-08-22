import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";

// Live bug report: a domain/category/section preset's icon showed correctly
// everywhere it's actually used (the Builder's own preset picker, the plan
// tree/Calendar once placed) but not in Settings > Tags & Presets, where the
// preset itself is managed - the icon appeared to just be missing there.
// Confirmed with the reporting coach that the real-world case is a pasted
// Google Drive share link (same as exercise images elsewhere in the app) -
// renderTaxonomyIcon used to build a bare <img src="${iconUrl}">, which
// does not work for a Drive "view" link; the plan tree/Calendar render this
// exact same node.iconUrl value through renderImage (media.js), which
// converts a Drive link into its real thumbnail URL with a multi-source
// fallback chain. Separately (a real but rarer case), a preset set via the
// Builder's older icon:<name> glyph codes (not a URL at all) also rendered
// nothing here, while the Builder's own rendering already had a glyph
// fallback for those.
//
// taxonomy-view.js has a clean, document-free import chain (media.js,
// organization-select.js, state.js, utils.js only) so it's imported
// directly here, unlike most of this suite's app.js/builder-*.js-adjacent
// tests.

const { renderTaxonomyPanelHtml } = await import("../taxonomy-view.js");
const { state } = await import("../state.js");

function emptyOrgData() {
  return { clubs: [], teams: [], canCreateClub: false };
}

beforeEach(() => {
  state.taxonomy = {
    loaded: true,
    error: "",
    nodePresets: [],
    templateTags: [],
    libraryRows: { domain: [], category: [], section: [], tag: [], attractor: [] },
    addOpenKind: "",
  };
});

test("a preset with a plain (non-Drive) http(s) icon_url still renders as a direct <img>", () => {
  state.taxonomy.nodePresets = [{ id: "p1", node_type: "domain", name: "Strength", color: "#C2F0E6", icon_url: "https://example.com/strength.png" }];

  const html = renderTaxonomyPanelHtml(emptyOrgData());

  assert.match(html, /<img class="taxonomy-icon" src="https:\/\/example\.com\/strength\.png" alt="">/);
});

test("a preset with a Google Drive share link renders through the same Drive-aware renderImage() the plan tree/Calendar already use for this exact value - converted to a real thumbnail URL, with fallback sources", () => {
  state.taxonomy.nodePresets = [{ id: "pd", node_type: "domain", name: "Strength", color: "#C2F0E6", icon_url: "https://drive.google.com/file/d/ABC123XYZ/view?usp=sharing" }];

  const html = renderTaxonomyPanelHtml(emptyOrgData());

  assert.match(html, /<img class="taxonomy-icon" src="https:\/\/drive\.google\.com\/thumbnail\?id=ABC123XYZ&amp;sz=w1000" alt=""/, "a bare <img src> pointed straight at the Drive 'view' link never rendered anything - it must be converted to the real thumbnail URL first");
  assert.match(html, /data-fallbacks="[^"]*lh3\.googleusercontent\.com/, "the same multi-source fallback chain used everywhere else (media.js) must carry over here too, for when the primary thumbnail URL fails");
});

test("a preset with an icon:<name> glyph code (the Builder's older icon picker values) now falls back to the same glyph the Builder itself shows, instead of rendering nothing", () => {
  state.taxonomy.nodePresets = [{ id: "p2", node_type: "domain", name: "Strength", color: "#C2F0E6", icon_url: "icon:dumbbell" }];

  const html = renderTaxonomyPanelHtml(emptyOrgData());

  assert.match(html, /<span class="taxonomy-icon taxonomy-icon-glyph">\[\]<\/span>/, "icon:dumbbell must render its real glyph ('[]'), not be silently dropped");
  assert.doesNotMatch(html, /<img class="taxonomy-icon"/, "a glyph code must never be treated as an image src");
});

test("a preset with no icon_url at all renders no icon markup (not an empty glyph box)", () => {
  state.taxonomy.nodePresets = [{ id: "p3", node_type: "domain", name: "Strength", color: "#C2F0E6", icon_url: "" }];

  const html = renderTaxonomyPanelHtml(emptyOrgData());

  assert.doesNotMatch(html, /taxonomy-icon-glyph/);
  assert.doesNotMatch(html, /<img class="taxonomy-icon"/);
});

test("every known glyph code from builderIconOptions() renders its own distinct glyph in the Settings preset list", () => {
  state.taxonomy.nodePresets = [
    { id: "a", node_type: "category", name: "Target preset", color: "#FFD3D3", icon_url: "icon:target" },
    { id: "b", node_type: "category", name: "Bolt preset", color: "#FFE3C2", icon_url: "icon:bolt" },
    { id: "c", node_type: "category", name: "Calendar preset", color: "#FFF3B0", icon_url: "icon:calendar" },
    { id: "d", node_type: "category", name: "Heart preset", color: "#E2F3C2", icon_url: "icon:heart" },
  ];

  const html = renderTaxonomyPanelHtml(emptyOrgData());

  for (const glyph of ["o", "\\*", "#", "\\+"]) {
    assert.match(html, new RegExp(`<span class="taxonomy-icon taxonomy-icon-glyph">${glyph}</span>`));
  }
});
