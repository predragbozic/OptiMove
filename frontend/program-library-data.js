import { api } from "./api.js";
import { currentUserWorkspaceContextParts } from "./access.js";
import { els } from "./dom.js";
import { ensureTemplateScopeIsVisible, templateScopeMeta } from "./navigation.js";
import { TEMPLATE_SCOPES, state } from "./state.js";
import { buildContextKey, invalidateCacheNamespace, loadCachedView } from "./view-cache.js";

const TEMPLATES_CACHE_NAMESPACE = "templates";

// /api/templates only ever varies server-side by `scope` (see
// templateSearchUrl below) - every other filter in state.templateFilters
// (search text, category, tag, creator, club, ownerType, visibility,
// lifecycle, pricing) is applied entirely client-side against the already-
// fetched state.lastTemplates (see renderTemplateLibraryResults), so
// switching between filter VALUES never needs a network request at all,
// cached or otherwise, and can never show one filter's results under a
// different filter's label. Only a scope switch (My Programs/OptiMove/
// Marketplace) is a genuinely different server payload, hence the only
// view-specific part of this context key.
function templatesContextKey(scope) {
  return buildContextKey([...currentUserWorkspaceContextParts(), scope || "my_programs"]);
}

export function invalidateTemplatesCache() {
  invalidateCacheNamespace(TEMPLATES_CACHE_NAMESPACE);
}

export async function loadTemplates({
  renderError,
  renderTemplateLibrary,
  renderTemplateLibraryResults,
  restoreTemplateFilterFocus,
  setStatus,
  setLoading,
} = {}, options = {}) {
  state.navStack = [];
  ensureTemplateScopeIsVisible();
  const requestedScope = state.templateScope;
  const scopeMeta = templateScopeMeta();
  els.context.textContent = "Program library";
  els.title.textContent = scopeMeta.label;
  els.toolbar.innerHTML = "";

  const handlers = { renderError, renderTemplateLibrary, renderTemplateLibraryResults, restoreTemplateFilterFocus, setStatus, setLoading };
  await loadCachedView({
    namespace: TEMPLATES_CACHE_NAMESPACE,
    contextKey: templatesContextKey(requestedScope),
    forceRefresh: Boolean(options.forceRefresh),
    fetcher: () => api(templateSearchUrl(requestedScope)),
    showLoading: () => { if (!options.restoreFocus) setLoading("Loading program library..."); },
    applyData: (data) => applyTemplatesResult(data, requestedScope, handlers, options),
    applyError: (error) => {
      setStatus?.("Error");
      renderError(error);
    },
    getCurrentContextKey: () => templatesContextKey(state.templateScope),
  });
}

function applyTemplatesResult(data, requestedScope, handlers, options) {
  state.templateAllowedScopes = Array.isArray(data.allowedScopes) ? data.allowedScopes : TEMPLATE_SCOPES;
  ensureTemplateScopeIsVisible();
  if (state.templateScope !== requestedScope) {
    // The requested scope turned out not to be allowed (e.g. a permission
    // change) - re-run for whatever ensureTemplateScopeIsVisible() actually
    // landed on, exactly like the pre-cache implementation's own recursive
    // call. This goes through loadTemplates() again, so it gets its own,
    // correctly-keyed cache entry for the new scope.
    return loadTemplates(handlers, options);
  }
  state.lastTemplates = data.templates || [];
  if (!state.lastTemplates.some((template) => String(template.plan_id) === String(state.selectedTemplateId))) {
    state.selectedTemplateId = state.lastTemplates[0]?.plan_id || null;
  }
  if (!state.templateOptions.loaded) loadTemplateOptionsInBackground({ renderTemplateLibraryResults: handlers.renderTemplateLibraryResults });
  handlers.renderTemplateLibrary(state.lastTemplates);
  handlers.restoreTemplateFilterFocus(options.restoreFocus);
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

export function templateSearchUrl(scope = state.templateScope) {
  const params = new URLSearchParams();
  params.set("scope", scope || "my_programs");
  return `/api/templates?${params.toString()}`;
}
