import { api } from "./api.js";
import { els } from "./dom.js";
import { ensureTemplateScopeIsVisible, templateScopeMeta } from "./navigation.js";
import { TEMPLATE_SCOPES, state } from "./state.js";

export async function loadTemplates({
  renderError,
  renderTemplateLibrary,
  renderTemplateLibraryResults,
  restoreTemplateFilterFocus,
  setStatus,
  setLoading,
} = {}, options = {}) {
  try {
    state.navStack = [];
    ensureTemplateScopeIsVisible();
    const requestedScope = state.templateScope;
    const scope = templateScopeMeta();
    els.context.textContent = "Program library";
    els.title.textContent = scope.label;
    els.toolbar.innerHTML = "";
    if (!options.restoreFocus) setLoading("Loading program library...");
    const data = await api(templateSearchUrl());
    state.templateAllowedScopes = Array.isArray(data.allowedScopes) ? data.allowedScopes : TEMPLATE_SCOPES;
    ensureTemplateScopeIsVisible();
    if (state.templateScope !== requestedScope) return loadTemplates({
      renderError,
      renderTemplateLibrary,
      renderTemplateLibraryResults,
      restoreTemplateFilterFocus,
      setStatus,
      setLoading,
    }, options);
    state.lastTemplates = data.templates || [];
    if (!state.lastTemplates.some((template) => String(template.plan_id) === String(state.selectedTemplateId))) {
      state.selectedTemplateId = state.lastTemplates[0]?.plan_id || null;
    }
    if (!state.templateOptions.loaded) loadTemplateOptionsInBackground({ renderTemplateLibraryResults });
    renderTemplateLibrary(state.lastTemplates);
    restoreTemplateFilterFocus(options.restoreFocus);
  } catch (error) {
    setStatus?.("Error");
    renderError(error);
  }
}

export async function loadTemplateOptionsInBackground({ renderTemplateLibraryResults } = {}) {
  try {
    const filterOptions = await api("/api/templates/options");
    state.templateOptions = { ...filterOptions, loaded: true };
    if (state.activeTab === "templates" || state.activeTab === "athlete-library") renderTemplateLibraryResults();
  } catch (error) {
    state.templateOptions = { ...state.templateOptions, loaded: true, error: error.message || "Could not load filters." };
  }
}

export function templateSearchUrl() {
  const params = new URLSearchParams();
  params.set("scope", state.templateScope || "my_programs");
  return `/api/templates?${params.toString()}`;
}
