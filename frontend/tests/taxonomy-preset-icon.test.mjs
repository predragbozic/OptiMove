import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";

// Live bug report: a domain/category/section preset's icon showed correctly
// everywhere it's actually used (the Builder's own preset picker, the plan
// tree once placed) but not in Settings > Tags & Presets, where the preset
// itself is managed - the icon appeared to just be missing there. Root
// cause: presets created via the Builder's older icon:<name> glyph codes
// (icon:target, icon:bolt, ... - builderIconOptions() in builder-helpers.js)
// are not real image URLs. The Builder's own rendering
// (renderPresetPickerIcon/renderBuilderNodeIcon, builder-structure.js)
// already falls back to builderIconGlyph() for these; taxonomy-view.js's
// renderTaxonomyIcon returned nothing at all for the exact same values.
//
// taxonomy-view.js has a clean, document-free import chain (organization-
// select.js, state.js, utils.js only) so it's imported directly here,
// unlike most of this suite's app.js/builder-*.js-adjacent tests.

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

test("a preset with a real http(s) icon_url still renders as an <img>, unchanged", () => {
  state.taxonomy.nodePresets = [{ id: "p1", node_type: "domain", name: "Strength", color: "#C2F0E6", icon_url: "https://example.com/strength.png" }];

  const html = renderTaxonomyPanelHtml(emptyOrgData());

  assert.match(html, /<img class="taxonomy-icon" src="https:\/\/example\.com\/strength\.png" alt="">/);
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
