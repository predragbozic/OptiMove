import { api } from "./api.js";
import { validateFilterableSelects } from "./organization-select.js";
import { state } from "./state.js";

export const LIBRARY_FILTER_KINDS = ["domain", "category", "section", "tag", "attractor"];

export async function loadTaxonomyData({ force = false } = {}) {
  if (state.taxonomy.loaded && !force) return;
  try {
    const [nodePresetsResult, templateTagsResult, ...libraryResults] = await Promise.all([
      api("/api/taxonomy/node-presets"),
      api("/api/taxonomy/template-tags"),
      ...LIBRARY_FILTER_KINDS.map((kind) => api(`/api/taxonomy/library/${kind}`)),
    ]);
    state.taxonomy.nodePresets = nodePresetsResult.presets || [];
    state.taxonomy.templateTags = templateTagsResult.tags || [];
    LIBRARY_FILTER_KINDS.forEach((kind, index) => {
      state.taxonomy.libraryRows[kind] = libraryResults[index].rows || [];
    });
    state.taxonomy.error = "";
    state.taxonomy.loaded = true;
  } catch (error) {
    state.taxonomy.error = error.message || "Could not load presets.";
  }
}

export async function submitTaxonomyForm(form, { renderOrganizationPanel }) {
  if (!validateFilterableSelects(form)) return;
  const type = form.dataset.taxonomyForm;
  const button = form.querySelector("button[type='submit']");
  const error = form.querySelector(".builder-error");
  if (error) error.textContent = "";
  if (button) button.disabled = true;
  const formData = new FormData(form);
  const payload = Object.fromEntries(formData.entries());
  const endpoint = resolveTaxonomyEndpoint(type);
  try {
    await api(endpoint, { method: "POST", body: JSON.stringify(payload) });
    state.taxonomy.addOpenKind = "";
    await loadTaxonomyData({ force: true });
    if (state.activeTab === "organization") await renderOrganizationPanel({ refresh: false });
  } catch (submitError) {
    if (error) error.textContent = submitError.message || "Could not save.";
  } finally {
    if (button) button.disabled = false;
  }
}

function resolveTaxonomyEndpoint(type) {
  if (type === "node-preset") return "/api/taxonomy/node-presets";
  if (type === "template-tag") return "/api/taxonomy/template-tags";
  if (type.startsWith("lib:")) return `/api/taxonomy/library/${type.slice(4)}`;
  return "";
}

export async function handleTaxonomyAction(action, { renderOrganizationPanel }) {
  const type = action.dataset.action;
  if (!type?.startsWith("taxonomy-")) return false;
  if (type === "taxonomy-toggle-add") {
    const kind = action.dataset.taxonomyKind || "";
    state.taxonomy.addOpenKind = state.taxonomy.addOpenKind === kind ? "" : kind;
    void renderOrganizationPanel({ refresh: false });
    return true;
  }
  if (type === "taxonomy-pick-color") {
    const palette = action.closest("[data-pastel-target]");
    const hidden = palette?.querySelector('input[type="hidden"]');
    if (hidden) hidden.value = action.dataset.color || "";
    palette?.querySelectorAll(".pastel-swatch").forEach((swatch) => {
      swatch.classList.toggle("is-selected", swatch === action);
    });
    return true;
  }
  if (type === "taxonomy-remove") {
    await removeTaxonomyRow(action.dataset.taxonomyKind, action.dataset.taxonomyId);
    await loadTaxonomyData({ force: true });
    void renderOrganizationPanel({ refresh: false });
    return true;
  }
  return false;
}

async function removeTaxonomyRow(kind, id) {
  if (!id) return;
  if (kind.startsWith("lib:")) {
    await api(`/api/taxonomy/library/${kind.slice(4)}/${encodeURIComponent(id)}`, { method: "DELETE" });
    return;
  }
  const path = kind === "node-preset" ? "node-presets" : "template-tags";
  await api(`/api/taxonomy/${path}/${encodeURIComponent(id)}`, { method: "DELETE" });
}
