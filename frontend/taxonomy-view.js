import { builderIconGlyph } from "./builder-helpers.js";
import { renderImage } from "./media.js";
import { renderFilterableSelect } from "./organization-select.js";
import { state } from "./state.js";
import { escapeAttr, escapeHtml } from "./utils.js";

const NODE_TYPE_LABELS = { domain: "Domain presets", category: "Category presets", section: "Section presets" };
const NODE_TYPES = ["domain", "category", "section"];

const LIBRARY_KIND_META = {
  domain: { label: "Purpose", showColor: true },
  category: { label: "Quality", showColor: true },
  section: { label: "Group", showColor: true },
  tag: { label: "Tag", showColor: false },
  attractor: { label: "Attractor", showColor: false },
};
const LIBRARY_FILTER_KINDS = ["domain", "category", "section", "tag", "attractor"];

export const PASTEL_COLORS = [
  "#FFD3D3",
  "#FFE3C2",
  "#FFF3B0",
  "#E2F3C2",
  "#C7EFCF",
  "#C2F0E6",
  "#C4E4FF",
  "#D6D6FF",
  "#EAD1FF",
  "#FBD1E6",
];

export function renderTaxonomyPanelHtml(data) {
  const tags = state.taxonomy.templateTags || [];
  return `
    <section class="taxonomy-panel">
      ${state.taxonomy.error ? `<p class="builder-error">${escapeHtml(state.taxonomy.error)}</p>` : ""}
      <section class="panel taxonomy-intro">
        <p class="eyebrow">Builder tree presets</p>
        <h3>Domain, category and section presets</h3>
        <p class="muted">These show up as suggestions when adding a domain, category or section in the builder, with their color and icon prefilled. Typing something new that isn't in the list still works as before.</p>
      </section>
      ${NODE_TYPES.map((type) => renderNodePresetSection(type, data)).join("")}
      <section class="panel taxonomy-intro">
        <p class="eyebrow">Program library</p>
        <h3>Template groups</h3>
        <p class="muted">Shared labels for grouping templates, e.g. by phase or population.</p>
      </section>
      ${renderChipSection({
        title: "Template groups",
        rows: tags,
        kind: "template-tag",
        showColor: false,
        addPlaceholder: "e.g. Pre-season",
        data,
      })}
      <section class="panel taxonomy-intro">
        <p class="eyebrow">Exercise Library</p>
        <h3>Exercise filters</h3>
        <p class="muted">Purpose, Quality, Group, Tag and Attractor values shown as filters in the Exercise Library.</p>
      </section>
      ${LIBRARY_FILTER_KINDS.map((kind) => renderChipSection({
        title: LIBRARY_KIND_META[kind].label,
        rows: state.taxonomy.libraryRows[kind] || [],
        kind: `lib:${kind}`,
        showColor: LIBRARY_KIND_META[kind].showColor,
        addPlaceholder: `e.g. ${LIBRARY_KIND_META[kind].label}`,
        data,
      })).join("")}
    </section>
  `;
}

function renderChipSection({ title, rows, kind, showColor, addPlaceholder, data }) {
  const isAddOpen = state.taxonomy.addOpenKind === kind;
  return `
    <section class="panel tag-chip-section">
      <div class="tag-chip-head">
        <p class="eyebrow">${escapeHtml(title)}</p>
        <button class="text-action" type="button" data-action="taxonomy-toggle-add" data-taxonomy-kind="${escapeAttr(kind)}">${isAddOpen ? "Cancel" : "+ Add"}</button>
      </div>
      <div class="tag-chip-row">
        ${rows.length ? rows.map((row) => renderChip(kind, row, showColor)).join("") : `<span class="muted">Nothing yet.</span>`}
      </div>
      ${isAddOpen ? renderChipAddForm(kind, addPlaceholder, showColor, data) : ""}
    </section>
  `;
}

function renderChip(kind, row, showColor) {
  const style = showColor ? ` style="background:${escapeAttr(row.color || PASTEL_COLORS[0])}"` : "";
  return `
    <span class="tag-chip"${style}>
      ${escapeHtml(row.name)}
      <button class="tag-chip-remove" type="button" data-action="taxonomy-remove" data-taxonomy-kind="${escapeAttr(kind)}" data-taxonomy-id="${escapeAttr(row.id)}" aria-label="Remove ${escapeAttr(row.name)}">&times;</button>
    </span>
  `;
}

function renderChipAddForm(kind, placeholder, showColor, data) {
  const { clubOptions, teamOptions, scopeOptions } = renderScopeOptions(data);
  return `
    <form class="tag-chip-add-form" data-taxonomy-form="${escapeAttr(kind)}">
      <div class="tag-chip-add-row">
        <input name="name" placeholder="${escapeAttr(placeholder)}" required autofocus>
        <select name="scope" data-taxonomy-scope-select>${scopeOptions.map(([value, label]) => `<option value="${value}">${escapeHtml(label)}</option>`).join("")}</select>
        ${teamOptions.length ? renderFilterableSelect({ name: "teamId", label: "Team", options: teamOptions, value: teamOptions.length === 1 ? teamOptions[0].value : "", placeholder: "Type team name" }) : ""}
        ${clubOptions.length ? renderFilterableSelect({ name: "clubId", label: "Club", options: clubOptions, value: clubOptions.length === 1 ? clubOptions[0].value : "", placeholder: "Type club name" }) : ""}
        <button class="plain-button compact-button" type="submit">Add</button>
      </div>
      ${showColor ? renderPastelSwatches("color", PASTEL_COLORS[0], { allowCustom: true }) : ""}
      <p class="builder-error" aria-live="polite"></p>
    </form>
  `;
}

export function renderPastelSwatches(name, selected, { allowCustom = false, collapsed = false } = {}) {
  const value = selected || "";
  const isCustom = Boolean(value) && allowCustom && !PASTEL_COLORS.some((color) => color.toLowerCase() === value.toLowerCase());
  const options = `
    <div class="pastel-palette-options">
      ${PASTEL_COLORS.map((color) => `
        <button type="button" class="pastel-swatch ${!isCustom && value && color.toLowerCase() === value.toLowerCase() ? "is-selected" : ""}" style="background:${color}" data-action="taxonomy-pick-color" data-color="${color}" aria-label="Pick color ${color}"></button>
      `).join("")}
      ${allowCustom ? `
        <label class="pastel-swatch pastel-swatch-custom ${isCustom ? "is-selected" : ""}" style="${isCustom ? `background:${escapeAttr(value)}` : ""}" title="Custom color">
          <input type="color" value="${escapeAttr(isCustom ? value : "#287e77")}" data-pastel-custom-color aria-label="Pick a custom color">
        </label>
      ` : ""}
    </div>
  `;
  if (!collapsed) {
    return `
      <div class="pastel-palette" data-pastel-target="${escapeAttr(name)}">
        <input type="hidden" name="${escapeAttr(name)}" value="${escapeAttr(value)}">
        ${options}
      </div>
    `;
  }
  return `
    <div class="pastel-palette pastel-palette-collapsed" data-pastel-target="${escapeAttr(name)}">
      <input type="hidden" name="${escapeAttr(name)}" value="${escapeAttr(value)}">
      <button type="button" class="pastel-current-swatch ${value ? "" : "is-empty"}" style="${value ? `background:${escapeAttr(value)}` : ""}" data-action="taxonomy-toggle-palette" aria-label="${value ? "Change color" : "Choose a color"}" title="${value ? "Change color" : "Choose a color"}"></button>
      ${options}
    </div>
  `;
}

function renderNodePresetSection(type, data) {
  const kind = `node-preset:${type}`;
  const rows = (state.taxonomy.nodePresets || []).filter((preset) => preset.node_type === type);
  const isAddOpen = state.taxonomy.addOpenKind === kind;
  return `
    <section class="panel tag-chip-section">
      <div class="tag-chip-head">
        <p class="eyebrow">${escapeHtml(NODE_TYPE_LABELS[type])}</p>
        <button class="text-action" type="button" data-action="taxonomy-toggle-add" data-taxonomy-kind="${escapeAttr(kind)}">${isAddOpen ? "Cancel" : "+ Add"}</button>
      </div>
      <div class="tag-chip-row">
        ${rows.length ? rows.map(renderNodePresetChip).join("") : `<span class="muted">Nothing yet.</span>`}
      </div>
      ${isAddOpen ? renderNodePresetAddForm(type, data) : ""}
    </section>
  `;
}

function renderNodePresetChip(preset) {
  return `
    <span class="tag-chip" style="background:${escapeAttr(preset.color || PASTEL_COLORS[0])}">
      ${renderTaxonomyIcon(preset.icon_url)}
      ${escapeHtml(preset.name)}
      <button class="tag-chip-remove" type="button" data-action="taxonomy-remove" data-taxonomy-kind="node-preset" data-taxonomy-id="${escapeAttr(preset.id)}" aria-label="Remove ${escapeAttr(preset.name)}">&times;</button>
    </span>
  `;
}

function renderNodePresetAddForm(type, data) {
  const { clubOptions, teamOptions, scopeOptions } = renderScopeOptions(data);
  return `
    <form class="tag-chip-add-form" data-taxonomy-form="node-preset">
      <input type="hidden" name="nodeType" value="${escapeAttr(type)}">
      <div class="tag-chip-add-row">
        <input name="name" placeholder="e.g. ${escapeAttr(NODE_TYPE_LABELS[type])}" required autofocus>
        <input name="iconUrl" type="url" placeholder="Icon URL (optional)">
        <select name="scope" data-taxonomy-scope-select>${scopeOptions.map(([value, label]) => `<option value="${value}">${escapeHtml(label)}</option>`).join("")}</select>
        ${teamOptions.length ? renderFilterableSelect({ name: "teamId", label: "Team", options: teamOptions, value: teamOptions.length === 1 ? teamOptions[0].value : "", placeholder: "Type team name" }) : ""}
        ${clubOptions.length ? renderFilterableSelect({ name: "clubId", label: "Club", options: clubOptions, value: clubOptions.length === 1 ? clubOptions[0].value : "", placeholder: "Type club name" }) : ""}
        <button class="plain-button compact-button" type="submit">Add</button>
      </div>
      ${renderPastelSwatches("color", PASTEL_COLORS[0], { allowCustom: true })}
      <p class="builder-error" aria-live="polite"></p>
    </form>
  `;
}

// Two distinct root causes fixed here for the same live bug report (a
// preset's icon showed correctly everywhere it's actually used - the
// Builder's preset picker, the plan tree/Calendar - but never in this
// Settings list where the preset itself is managed):
// 1. A coach-pasted icon URL is very often a Google Drive share link (same
//    as exercise images elsewhere in the app), which does NOT work as a
//    bare <img src>. renderImage (media.js) is what the plan tree/Calendar
//    already use to render this exact same node.iconUrl value - it converts
//    a Drive link into its real thumbnail URL with a multi-source fallback
//    chain the existing global image-error handler (app.js) walks through
//    on load failure. A plain <img src="..."> here (the previous version)
//    never got any of that conversion.
// 2. Presets set via the Builder's older icon:<name> glyph codes
//    (icon:target, icon:bolt, etc. - builderIconOptions() in builder-
//    helpers.js) are not real image URLs at all - the Builder's own
//    rendering (renderPresetPickerIcon/renderBuilderNodeIcon, builder-
//    structure.js) falls back to builderIconGlyph() for these; this screen
//    returned nothing for them too.
function renderTaxonomyIcon(iconUrl) {
  if (!iconUrl) return "";
  if (/^https?:\/\//i.test(iconUrl)) return renderImage(iconUrl, "taxonomy-icon");
  return `<span class="taxonomy-icon taxonomy-icon-glyph">${escapeHtml(builderIconGlyph(iconUrl))}</span>`;
}

function renderScopeOptions(data) {
  const clubOptions = (data.clubs || []).map((club) => ({ value: club.id, label: club.name }));
  const teamOptions = (data.teams || []).map((team) => ({ value: team.id, label: `${team.name}${team.club_name ? ` - ${team.club_name}` : ""}` }));
  const scopeOptions = [["user", "Just me"]];
  if (teamOptions.length) scopeOptions.push(["team", "My team"]);
  if (clubOptions.length) scopeOptions.push(["club", "My club"]);
  if (data.canCreateClub) scopeOptions.push(["system", "Shared with everyone"]);
  return { clubOptions, teamOptions, scopeOptions };
}
