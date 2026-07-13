import { api } from "./api.js";
import { accessScopeLabel, canManageCoachProfile, isAthleteMode, roleLabel } from "./access.js";
import {
  renderInviteAccept as renderInviteAcceptAction,
  renderLogin as renderLoginAction,
  submitInviteAccept as submitInviteAcceptAction,
} from "./auth-actions.js";
import {
  renderAthleteHeaderToolbarHtml,
  renderAthleteListHtml,
  renderAthleteSettingsHtml,
} from "./athlete-view.js";
import {
  handleBuilderDraftAction,
  handleBuilderItemAction,
  handleBuilderPlanAction,
  handleBuilderWorkspaceAction,
  submitBuilderForm as submitBuilderFormAction,
} from "./builder-actions.js";
import { loadBuilderExercises, refreshBuilderDraft } from "./builder-data.js";
import { renderCopyPlanModal } from "./builder-modals.js";
import { renderBuilder } from "./builder-view.js";
import {
  loadCoaches as loadCoachesAction,
  openCoachProfile as openCoachProfileAction,
  submitCoachContactForm as submitCoachContactFormAction,
  submitCoachProfileForm as submitCoachProfileFormAction,
} from "./coach-profile-actions.js";
import { renderCoachDetailModalHtml, renderCoachesHtml } from "./coach-profiles.js";
import { els } from "./dom.js";
import {
  handleExerciseLibraryAction,
  loadExercises,
  submitExerciseTagForm as submitExerciseTagFormAction,
} from "./exercise-actions.js";
import {
  renderExerciseLibraryHtml,
} from "./exercise-library.js";
import {
  parseImageFallbacks,
  renderImage,
  renderMediaThumb,
} from "./media.js";
import { closeMedia, enterMediaFullscreen, handleFullscreenChange, openMedia } from "./media-modal.js";
import {
  ensureTemplateScopeIsVisible,
  renderAccessNav,
  renderLibraryNav,
  renderRailState,
  renderSettingsNavHtml,
  templateScopeMeta,
  visibleTemplateScopes,
} from "./navigation.js";
import {
  handleOrganizationAction,
  handleOrganizationFilterInput,
  handleOrganizationSelectChange,
  submitOrganizationForm as submitOrganizationFormAction,
} from "./organization-actions.js";
import {
  normalizeOrganizationSelection,
  renderOrganizationActions,
  renderOrganizationBrowser,
  renderOrganizationEditModal,
} from "./organization-view.js";
import { renderPlanMoreMenu } from "./plan-actions-view.js";
import {
  applyTemplateClientFilters,
  duplicateTemplateNames,
  programPriceLabel,
  renderProgramInfoModal,
  renderTemplateLibraryResultsHtml,
  renderTemplateFiltersHtml,
  templateCategoryOptions,
  templateFilterOptionMatches,
  templateFilterSuggestions,
  templateCategoryLabel,
  templateSecondaryLabel,
} from "./program-library.js";
import {
  addInlineProgramTag,
  closeProgramTagEditor,
  markTemplateUsed,
  openTemplatePreview,
  openTemplatePreviewFromCoachProgram,
  removeProgramTag,
  submitProgramTagForm as submitProgramTagFormAction,
  submitTemplateMetadataForm as submitTemplateMetadataFormAction,
  submitTemplateReviewForm as submitTemplateReviewFormAction,
} from "./program-library-actions.js";
import {
  loadTemplates as loadTemplatesData,
  loadTemplateOptionsInBackground as loadTemplateOptionsInBackgroundData,
} from "./program-library-data.js";
import { renderTemplatePreviewModalHtml } from "./program-preview.js";
import {
  emptyTemplateFilters,
  emptyTemplatePreview,
  state,
} from "./state.js";
import {
  addMonthsIso,
  clean,
  countLabel,
  debounce,
  escapeAttr,
  escapeHtml,
  formatDate,
  formatDayMonth,
  formatWeekday,
  groupBy,
  initialsFor,
  localDateIso,
  monthStartIso,
  orderedUnique,
  weekMondayIso,
} from "./utils.js";
import {
  allSlotItems,
  buildWeeklyCalendarMonth,
  clampMonth,
  defaultWeekIndex,
  flattenDayGroups,
  groupItems,
  selectedWeeklyDay,
  todayWeekIndex,
  weekIndexForDate,
  weeklyCalendarDayMap,
  weeklyCalendarMonthRange,
} from "./weekly-plan.js";

init();

async function init() {
  bindEvents();
  state.railExpanded = window.matchMedia("(min-width: 900px)").matches;
  renderRailState();
  if (window.location.pathname === "/invite") {
    await renderInviteAcceptAction({ renderUserControls, setStatus });
    return;
  }
  await loadSession();
  if (!state.currentUser) {
    renderLoginAction({ renderUserControls, setStatus });
    return;
  }
  renderUserControls();
  if (state.currentUser.role === "athlete" && !document.body.classList.contains("athlete-mode")) {
    window.location.replace("/athlete");
    return;
  }
  ensureBackGuard();
  await loadAthletes();
}

function bindEvents() {
  els.athleteSearch?.addEventListener("input", renderAthleteList);
  els.athletesToggle?.addEventListener("click", toggleAthletesList);
  els.railToggle?.addEventListener("click", toggleRail);
  els.signOut?.addEventListener("click", signOut);
  els.calendarToggle?.addEventListener("click", openWeeklyCalendarFromRail);
  els.tabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      if (state.activeTab !== tab.dataset.tab) pushAppHistory();
      state.activeTab = tab.dataset.tab;
      state.selectedProgramId = null;
      state.selectedTemplateId = null;
      state.navStack = [];
      if (state.activeTab === "weekly") state.openWeekCalendarOnLoad = true;
      collapseRailAfterNav();
      renderTabs();
      renderLibraryNav();
      loadActiveTab();
    });
  });
  els.libraryTabs.forEach((button) => {
    button.addEventListener("click", () => {
      if (state.activeTab !== button.dataset.libraryTab) pushAppHistory();
      state.activeTab = button.dataset.libraryTab;
      if (button.dataset.templateScope) {
        state.templateScope = isAthleteMode() && button.classList.contains("sidebar-nav-button") ? "all" : button.dataset.templateScope;
        ensureTemplateScopeIsVisible();
      }
      if (button.dataset.organizationSection) state.organization.section = button.dataset.organizationSection;
      state.selectedProgramId = null;
      state.selectedTemplateId = null;
      state.navStack = [];
      state.athletesExpanded = false;
      state.weekSelectorOpen = false;
      state.openWeekCalendarOnLoad = false;
      collapseRailAfterNav();
      renderAthleteListState();
      renderTabs();
      renderLibraryNav();
      loadActiveTab();
    });
  });
  els.athleteTabs.forEach((button) => {
    button.addEventListener("click", () => {
      const targetTab = button.dataset.athleteTab || "weekly";
      if (state.activeTab !== targetTab) pushAppHistory();
      state.selectedProgramId = null;
      state.selectedTemplateId = null;
      state.navStack = [];
      state.weekSelectorOpen = false;
      state.openWeekCalendarOnLoad = targetTab === "calendar";
      state.activeTab = targetTab === "calendar" ? "weekly" : targetTab;
      collapseRailAfterNav();
      renderTabs();
      renderLibraryNav();
      loadActiveTab();
    });
  });

  els.content.addEventListener("click", handleContentClick);
  els.toolbar.addEventListener("click", (event) => {
    const action = event.target.closest("[data-action]");
    if (!action?.dataset.action?.startsWith("builder-")) return;
    void handleBuilderAction(action).catch(renderBuilderError);
  });
  els.content.addEventListener("submit", handleContentSubmit);
  els.content.addEventListener("input", handleContentInput);
  els.content.addEventListener("change", handleContentChange);
  els.content.addEventListener("touchstart", handleSwipeStart, { passive: true });
  els.content.addEventListener("touchend", handleSwipeEnd, { passive: true });
  document.addEventListener("click", handleGlobalClick);
  document.addEventListener("error", handleImageError, true);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeMedia();
  });
  document.addEventListener("fullscreenchange", handleFullscreenChange);
  document.addEventListener("webkitfullscreenchange", handleFullscreenChange);
  window.addEventListener("popstate", handleBrowserBack);
}

async function loadSession() {
  const data = await api("/api/auth/me");
  state.currentUser = data.user || null;
}

async function handleContentSubmit(event) {
  const inviteForm = event.target.closest("#inviteAcceptForm");
  if (inviteForm) {
    event.preventDefault();
    await submitInviteAcceptAction(inviteForm);
    return;
  }

  const organizationForm = event.target.closest("[data-organization-form]");
  if (organizationForm) {
    event.preventDefault();
    await submitOrganizationFormAction(organizationForm, { loadAthletes, renderOrganizationPanel });
    return;
  }

  const tagForm = event.target.closest("[data-exercise-tag-form]");
  if (tagForm) {
    event.preventDefault();
    await submitExerciseTagFormAction(tagForm, { renderExercises, setLoading });
    return;
  }

  const programTagForm = event.target.closest("[data-program-tag-form]");
  if (programTagForm) {
    event.preventDefault();
    await submitProgramTagFormAction(programTagForm, { renderTemplateLibrary });
    return;
  }

  const templateMetadataForm = event.target.closest("[data-template-metadata-form]");
  if (templateMetadataForm) {
    event.preventDefault();
    await submitTemplateMetadataFormAction(templateMetadataForm, { loadTemplates });
    return;
  }

  const templateReviewForm = event.target.closest("[data-template-review-form]");
  if (templateReviewForm) {
    event.preventDefault();
    await submitTemplateReviewFormAction(templateReviewForm, { loadTemplates, renderTemplateLibrary });
    return;
  }

  const coachProfileForm = event.target.closest("[data-coach-profile-form]");
  if (coachProfileForm) {
    event.preventDefault();
    await submitCoachProfileFormAction(coachProfileForm, { loadCoaches });
    return;
  }

  const coachContactForm = event.target.closest("[data-coach-contact-form]");
  if (coachContactForm) {
    event.preventDefault();
    await submitCoachContactFormAction(coachContactForm, { renderCoachContext });
    return;
  }

  const form = event.target.closest("#loginForm");
  if (form) {
    event.preventDefault();
    const formData = new FormData(form);
    const error = form.querySelector(".login-error");
    if (error) error.textContent = "";
    const button = form.querySelector("button[type='submit']");
    if (button) button.disabled = true;
    try {
      const data = await api("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({
          email: formData.get("email"),
          password: formData.get("password"),
        }),
      });
      state.currentUser = data.user;
      document.body.classList.remove("login-mode");
      renderUserControls();
      if (state.currentUser.role === "athlete" && !document.body.classList.contains("athlete-mode")) {
        window.location.replace("/athlete");
        return;
      }
      ensureBackGuard();
      await loadAthletes();
    } catch (loginError) {
      if (error) error.textContent = loginError.message || "Login failed.";
    } finally {
      if (button) button.disabled = false;
    }
    return;
  }

  const builderForm = event.target.closest("[data-builder-form]");
  if (!builderForm) return;
  event.preventDefault();
  const submitButton = builderForm.querySelector("button[type='submit']");
  const error = builderForm.querySelector(".builder-error");
  if (error) error.textContent = "";
  if (submitButton) submitButton.disabled = true;
  try {
    await submitBuilderFormAction(builderForm, { loadBuilderExercises, renderBuilder });
  } catch (builderError) {
    if (error) error.textContent = builderError.message || "Could not save this change.";
    else renderBuilderError(builderError);
  } finally {
    if (submitButton) submitButton.disabled = false;
  }
}

function handleContentInput(event) {
  const orgFilter = event.target.closest("[data-org-select-filter]");
  if (orgFilter) {
    handleOrganizationFilterInput(orgFilter);
    return;
  }

  const copyWeekStartInput = event.target.closest("[data-builder-copy-week-start]");
  if (copyWeekStartInput) {
    state.builder.copyWeekStart = copyWeekStartInput.value;
    return;
  }
  const weekStartInput = event.target.closest("[data-builder-week-start]");
  if (weekStartInput) {
    state.builder.weekStart = weekStartInput.value;
    return;
  }
  const templateSearch = event.target.closest("[data-template-filter='search']");
  if (templateSearch) {
    state.templateFilters.search = templateSearch.value;
    state.selectedTemplateId = null;
    state.templatePreview = emptyTemplatePreview();
    debounceTemplateResultRender();
    return;
  }
  const templateTextFilter = event.target.closest("input[data-template-filter]");
  if (templateTextFilter && templateTextFilter.type !== "checkbox") {
    state.templateFilters[templateTextFilter.dataset.templateFilter] = templateTextFilter.value;
    syncTemplateFilterSuggestions(templateTextFilter);
    state.selectedTemplateId = null;
    state.templatePreview = emptyTemplatePreview();
    debounceTemplateResultRender();
    return;
  }
  const input = event.target.closest("[data-builder-exercise-search]");
  if (!input) return;
  state.builder.exerciseQuery = input.value;
  debounceBuilderSearch();
}

async function handleContentChange(event) {
  const orgFilter = event.target.closest("[data-org-select-filter]");
  if (orgFilter) {
    handleOrganizationFilterInput(orgFilter);
    return;
  }

  const organizationClubSelect = event.target.closest("[data-organization-club-select]");
  if (organizationClubSelect) {
    handleOrganizationSelectChange(organizationClubSelect.closest("form"));
    return;
  }

  const builderFilter = event.target.closest("[data-builder-exercise-filter]");
  if (builderFilter) {
    state.builder.exerciseFilters[builderFilter.dataset.builderExerciseFilter] =
      builderFilter.type === "checkbox" ? builderFilter.checked : builderFilter.value;
    debounceBuilderSearch();
    return;
  }

  const templateFilter = event.target.closest("[data-template-filter]");
  if (templateFilter) {
    if (templateFilter.dataset.templateFilter === "scope") state.templateScope = templateFilter.value || "my";
    else if (templateFilter.dataset.templateFilter === "freeOnly") state.templateFilters.pricing = templateFilter.checked ? "free" : "all";
    else state.templateFilters[templateFilter.dataset.templateFilter] = templateFilter.value;
    state.selectedTemplateId = null;
    state.templatePreview = emptyTemplatePreview();
    renderTemplateLibraryResults();
    return;
  }

  const metadataPricing = event.target.closest("[data-template-metadata-form] select[name='isFree']");
  if (metadataPricing) {
    const priceInput = metadataPricing.form?.querySelector("input[name='price']");
    if (priceInput) {
      priceInput.disabled = metadataPricing.value === "true";
      if (priceInput.disabled) priceInput.value = "";
    }
    return;
  }

  const form = event.target.closest("[data-builder-autosave]");
  if (!form || !event.target.matches("input, textarea")) return;
  try {
    await submitBuilderFormAction(form, { loadBuilderExercises, renderBuilder });
  } catch (error) {
    renderBuilderError(error);
  }
}

let builderSearchTimer = null;
function debounceBuilderSearch() {
  clearTimeout(builderSearchTimer);
  const focus = captureBuilderExerciseSearchFocus();
  builderSearchTimer = setTimeout(() => loadBuilderExercises({ afterRender: () => restoreBuilderExerciseSearchFocus(focus) }), 250);
}

let templateSearchTimer = null;
function debounceTemplateSearch() {
  clearTimeout(templateSearchTimer);
  const focus = captureTemplateFilterFocus();
  templateSearchTimer = setTimeout(() => loadTemplates({ restoreFocus: focus }), 250);
}

function debounceTemplateResultRender() {
  clearTimeout(templateSearchTimer);
  templateSearchTimer = setTimeout(renderTemplateLibraryResults, 160);
}

function captureTemplateFilterFocus() {
  const active = document.activeElement;
  if (!active?.matches?.("input[data-template-filter]")) return null;
  return {
    filter: active.dataset.templateFilter,
    start: active.selectionStart,
    end: active.selectionEnd,
  };
}

function restoreTemplateFilterFocus(focus) {
  if (!focus?.filter) return;
  requestAnimationFrame(() => {
    const escapedFilter = window.CSS?.escape ? CSS.escape(focus.filter) : String(focus.filter).replace(/"/g, '\\"');
    const input = document.querySelector(`input[data-template-filter="${escapedFilter}"]`);
    if (!input) return;
    input.focus({ preventScroll: true });
    if (typeof input.setSelectionRange === "function" && focus.start !== null && focus.end !== null) {
      input.setSelectionRange(focus.start, focus.end);
    }
  });
}

function captureBuilderExerciseSearchFocus() {
  const active = document.activeElement;
  if (!active?.matches?.("[data-builder-exercise-search]")) return null;
  return {
    start: active.selectionStart,
    end: active.selectionEnd,
  };
}

function restoreBuilderExerciseSearchFocus(focus) {
  if (!focus) return;
  requestAnimationFrame(() => {
    const input = document.querySelector("[data-builder-exercise-search]");
    if (!input) return;
    input.focus({ preventScroll: true });
    if (typeof input.setSelectionRange === "function" && focus.start !== null && focus.end !== null) {
      input.setSelectionRange(focus.start, focus.end);
    }
  });
}

function syncTemplateFilterSuggestions(input) {
  const listId = input.getAttribute("list");
  if (!listId) return;
  const list = document.getElementById(listId);
  if (!list) return;
  const prefix = clean(input.value).toLowerCase();
  const values = templateFilterSuggestions(input.dataset.templateFilter, state.templateOptions, state.lastTemplates);
  const matches = prefix ? values.filter((value) => templateFilterOptionMatches(value, prefix)) : values;
  list.innerHTML = `<option value="All"></option>${matches.map((value) => `<option value="${escapeAttr(value)}"></option>`).join("")}`;
}

function renderUserControls() {
  const authenticated = Boolean(state.currentUser);
  if (els.signOut) els.signOut.hidden = !authenticated;
  if (els.userRole) {
    els.userRole.hidden = !authenticated;
    els.userRole.textContent = authenticated ? roleLabel(state.currentUser) : "";
  }
  renderAccessNav();
}

async function signOut() {
  try {
    await api("/api/auth/logout", { method: "POST" });
  } finally {
    state.currentUser = null;
    window.location.replace("/");
  }
}

function toggleAthletesList() {
  if (!state.athletesExpanded) pushAppHistory();
  state.athletesExpanded = !state.athletesExpanded;
  if (state.athletesExpanded) state.weekSelectorOpen = false;
  renderAthleteList();
  renderLibraryNav();
  if (state.athletesExpanded) {
    requestAnimationFrame(() => {
      els.athleteList.scrollIntoView({ block: "nearest", behavior: "smooth" });
    });
  }
}

function toggleRail() {
  state.railExpanded = !state.railExpanded;
  renderRailState();
}

function collapseRailAfterNav() {
  if (state.railExpanded && !window.matchMedia("(min-width: 900px)").matches) {
    state.railExpanded = false;
    renderRailState();
  }
}

function openWeeklyCalendarFromRail() {
  const shouldToggleLoadedWeekly = state.activeTab === "weekly" && state.lastWeeklyData && state.selectedAthleteId;
  if (state.activeTab !== "weekly" || (shouldToggleLoadedWeekly && !state.weekSelectorOpen)) pushAppHistory();
  state.activeTab = "weekly";
  state.selectedProgramId = null;
  state.selectedTemplateId = null;
  state.navStack = [];
  state.athletesExpanded = false;
  state.openWeekCalendarOnLoad = !shouldToggleLoadedWeekly;
  collapseRailAfterNav();
  renderAthleteListState();
  renderTabs();
  renderLibraryNav();
  if (shouldToggleLoadedWeekly) {
    state.weekSelectorOpen = !state.weekSelectorOpen;
    const weeks = state.lastWeeklyData.weeks || [];
    const activeWeek = weeks[Math.max(0, Math.min(weeks.length - 1, state.selectedWeekIndex))] || weeks[0];
    state.weekCalendarMonth = monthStartIso(activeWeek?.weekStart || localDateIso());
    renderWeeklyRoot(state.lastWeeklyData);
    return;
  }
  loadActiveTab();
}

function handleImageError(event) {
  const image = event.target;
  if (!(image instanceof HTMLImageElement)) return;

  const fallbacks = parseImageFallbacks(image.dataset.fallbacks);
  const next = fallbacks.shift();
  if (next) {
    image.dataset.fallbacks = JSON.stringify(fallbacks);
    image.src = next;
    return;
  }

  if (image.classList.contains("avatar")) {
    const fallback = document.createElement("span");
    fallback.className = "avatar-fallback";
    fallback.textContent = image.alt || "?";
    image.replaceWith(fallback);
    return;
  }

  if (image.classList.contains("athlete-hero-image")) {
    const fallback = document.createElement("div");
    fallback.className = "athlete-hero-fallback";
    fallback.textContent = image.alt || "?";
    image.replaceWith(fallback);
    return;
  }

  if (image.classList.contains("media-thumb") || image.classList.contains("media-image-full") || image.classList.contains("media-image-secondary")) {
    const previewUrl = image.dataset.previewUrl || "";
    if (previewUrl) {
      const frame = document.createElement("iframe");
      frame.className = image.classList.contains("media-thumb") ? "media-preview-frame" : "media-frame";
      frame.src = previewUrl;
      frame.setAttribute("loading", "lazy");
      frame.setAttribute("tabindex", "-1");
      frame.setAttribute("aria-hidden", "true");
      image.replaceWith(frame);
      return;
    }
  }

  image.classList.add("image-missing");
}

function goHome() {
  state.navStack = [];
  renderCurrentNode();
}

function handleGlobalClick(event) {
  const tab = event.target.closest("[data-tab]");
  if (tab) {
    const nextTab = tab.dataset.tab;
    if (nextTab === "weekly" && state.activeTab === "weekly" && state.lastWeeklyData) {
      openWeeklyCalendarFromRail();
      return;
    }
    if (state.activeTab !== nextTab) pushAppHistory();
    state.activeTab = nextTab;
    state.selectedProgramId = null;
    state.selectedTemplateId = null;
    state.navStack = [];
    if (state.activeTab === "weekly") state.openWeekCalendarOnLoad = tab.dataset.openCalendar === "true";
    renderTabs();
    renderLibraryNav();
    loadActiveTab();
    return;
  }

  const action = event.target.closest("[data-action]");
  if (!action) return;
  if (action.dataset.action === "close-media") closeMedia();
  if (action.dataset.action === "home") goHome();
}

function handleSwipeStart(event) {
  if (!isSwipeContext(event.target)) return;
  const touch = event.changedTouches?.[0];
  if (!touch) return;
  state.touch = { startX: touch.clientX, startY: touch.clientY, startTime: Date.now() };
}

function handleSwipeEnd(event) {
  if (!isSwipeContext(event.target)) return;
  const touch = event.changedTouches?.[0];
  if (!touch) return;
  const deltaX = touch.clientX - state.touch.startX;
  const deltaY = touch.clientY - state.touch.startY;
  const elapsed = Math.max(1, Date.now() - state.touch.startTime);
  const velocityX = Math.abs(deltaX) / elapsed;
  const velocityY = Math.abs(deltaY) / elapsed;
  if (els.content.querySelector(".exercise-detail") && Math.abs(deltaY) >= 72 && velocityY >= 0.22 && Math.abs(deltaY) > Math.abs(deltaX) * 1.35) {
    moveExerciseDetail(deltaY < 0 ? 1 : -1);
    return;
  }
  const velocity = velocityX;
  if (Math.abs(deltaX) < 86 || velocity < 0.28 || Math.abs(deltaX) < Math.abs(deltaY) * 1.8) return;
  handleHorizontalSwipe(deltaX < 0 ? 1 : -1);
}

function isSwipeContext(target) {
  if (!els.mediaModal?.hidden) return false;
  if (target.closest(".calendar-grid, .week-selector, .week-calendar-picker, .program-day-grid, .exercise-list")) return false;
  return Boolean(target.closest(".exercise-detail, .panel, .node-grid"));
}

function handleHorizontalSwipe(direction) {
  if (els.content.querySelector(".exercise-detail")) {
    const ids = state.exerciseDetail.ids || [];
    const currentIndex = ids.indexOf(state.exerciseDetail.currentId);
    if (direction < 0 && currentIndex <= 0) {
      returnToNodeParent();
      return;
    }
    moveExerciseDetail(direction);
    return;
  }

  if (state.navStack.length) {
    const siblingState = nodeSiblingState();
    if (direction > 0 && siblingState.canGoNext) {
      moveNodeSibling(1);
      return;
    }
    if (direction < 0 && siblingState.canGoPrevious) {
      moveNodeSibling(-1);
      return;
    }
    if (direction < 0) {
      state.navStack.pop();
      renderCurrentNode();
    }
    return;
  }

  if (state.activeTab === "weekly") {
    moveWeek(direction);
  }
}

function pushAppHistory() {
  ensureBackGuard();
  window.history.pushState({ optimove: true }, "", window.location.href);
  state.appHistoryDepth += 1;
}

function ensureBackGuard() {
  if (state.backGuardReady || !state.currentUser) return;
  window.history.replaceState({ optimoveBase: true }, "", window.location.href);
  window.history.pushState({ optimoveGuard: true }, "", window.location.href);
  state.backGuardReady = true;
}

function handleBrowserBack() {
  if (state.allowBrowserExit) return;
  if (state.appHistoryDepth > 0) {
    state.appHistoryDepth -= 1;
    handleAppBack();
    return;
  }
  if (handleAppBack()) {
    window.history.pushState({ optimoveGuard: true }, "", window.location.href);
    return;
  }
  if (window.confirm("Exit OptiMove?")) {
    state.allowBrowserExit = true;
    window.history.back();
    return;
  }
  window.history.pushState({ optimoveGuard: true }, "", window.location.href);
}

function handleAppBack() {
  if (!els.mediaModal?.hidden) {
    closeMedia();
    return true;
  }

  if (els.content.querySelector(".exercise-detail")) {
    returnToNodeParent();
    return true;
  }

  if (state.navStack.length) {
    state.navStack.pop();
    renderCurrentNode();
    return true;
  }

  if (state.weekSelectorOpen) {
    state.weekSelectorOpen = false;
    renderWeeklyRoot(state.lastWeeklyData);
    return true;
  }

  if (state.athletesExpanded) {
    state.athletesExpanded = false;
    renderAthleteListState();
    return true;
  }

  if (state.activeTab !== "weekly") {
    state.activeTab = "weekly";
    state.selectedProgramId = null;
    state.selectedTemplateId = null;
    state.openWeekCalendarOnLoad = false;
    renderTabs();
    renderLibraryNav();
    void loadActiveTab();
    return true;
  }

  return false;
}

async function loadAthletes() {
  document.body.classList.remove("login-mode");
  setStatus("Loading");
  try {
    const data = await api("/api/admin/athletes");
    state.athletes = data.adminRows || [];
    const athleteParam = new URLSearchParams(window.location.search).get("athlete");
    const requestedAthlete = state.athletes.find((athlete) => athlete.athlete_id === athleteParam);
    state.selectedAthleteId = requestedAthlete?.athlete_id || state.athletes[0]?.athlete_id || null;
    renderAthleteList();
    await loadActiveTab();
    setStatus("Online");
  } catch (error) {
    setStatus("Error");
    renderError(error);
  }
}

async function loadActiveTab() {
  renderTabs();
  renderLibraryNav();
  if (state.activeTab === "athlete-settings") return renderAthleteSettings();
  if (state.activeTab === "athlete-library") return renderAthleteLibrary();
  if (state.activeTab === "organization") return renderOrganizationPanel();
  if (state.activeTab === "weekly") return loadWeekly();
  if (state.activeTab === "programs") return loadPrograms();
  if (state.activeTab === "templates") return loadTemplates();
  if (state.activeTab === "coaches") return loadCoaches();
  if (state.activeTab === "builder") return loadBuilder();
  return loadExercises({ renderExercises, setLoading });
}

async function loadCoaches() {
  els.context.textContent = "Coach directory";
  els.title.textContent = "Coaches";
  els.toolbar.innerHTML = "";
  return loadCoachesAction({ setLoading, renderCoaches });
}

async function loadWeekly() {
  if (!state.selectedAthleteId) return renderEmpty("No athlete selected.");
  state.navStack = [];
  setLoading("Loading weekly plans...");
  const data = await api(`/api/athletes/${encodeURIComponent(state.selectedAthleteId)}/program-data?program=__weekly__`);
  state.lastWeeklyData = data;
  state.selectedWeekIndex = defaultWeekIndex(data.weeks || []);
  state.weekSelectorOpen = Boolean(state.openWeekCalendarOnLoad);
  state.openWeekCalendarOnLoad = false;
  if (state.weekSelectorOpen) {
    const activeWeek = data.weeks?.[state.selectedWeekIndex] || data.weeks?.[0];
    state.weekCalendarMonth = monthStartIso(activeWeek?.weekStart || localDateIso());
  }
  renderAthleteHeader(data);
  renderWeeklyRoot(data);
}

async function loadPrograms() {
  if (!state.selectedAthleteId) return renderEmpty("No athlete selected.");
  state.navStack = [];
  setLoading("Loading specific programs...");
  const data = await api(`/api/athletes/${encodeURIComponent(state.selectedAthleteId)}/program-data?program=__all_programs__`);
  state.lastProgramBundle = data;
  const programs = data.programs || [];
  if (!state.selectedProgramId) state.selectedProgramId = programs[0]?.id || null;
  renderAthleteHeader(data);
  renderProgramToolbar(programs);
  renderProgramRoot(programs.find((program) => program.id === state.selectedProgramId));
}

async function loadTemplates(options = {}) {
  return loadTemplatesData(programLibraryDataContext(), options);
}

async function loadTemplateOptionsInBackground() {
  return loadTemplateOptionsInBackgroundData({ renderTemplateLibraryResults });
}

function programLibraryDataContext() {
  return {
    renderError,
    renderTemplateLibrary,
    renderTemplateLibraryResults,
    restoreTemplateFilterFocus,
    setStatus,
    setLoading,
  };
}

async function openCoachProfile(profileId) {
  return openCoachProfileAction(profileId, { renderCoachContext });
}

function renderCoachContext() {
  if (state.activeTab === "coaches") return renderCoaches();
  if (state.activeTab === "templates" || state.activeTab === "athlete-library") return renderTemplateLibrary(state.lastTemplates);
  return renderCurrentNode();
}

function renderCoaches() {
  els.content.innerHTML = renderCoachesHtml({
    coaches: state.coaches,
    currentUser: state.currentUser,
    programInfo: state.programInfo,
    renderProgramInfoModal,
    renderTemplatePreviewModal,
  });
}

async function handleContentClick(event) {
  const action = event.target.closest("[data-action]");
  if (!action) return;

  const type = action.dataset.action;
  if (type.startsWith("builder-")) {
    void handleBuilderAction(action).catch(renderBuilderError);
    return;
  }
  if (type === "back") {
    if (state.appHistoryDepth > 0) window.history.back();
    else handleAppBack();
    return;
  }
  if (type === "home") {
    goHome();
    return;
  }
  if (type === "exercise-back") {
    if (state.appHistoryDepth > 0) window.history.back();
    else handleAppBack();
    return;
  }
  if (type === "node") {
    const node = getNodeById(action.dataset.nodeId);
    if (!node) return;
    pushAppHistory();
    state.navStack.push(node);
    renderCurrentNode();
    return;
  }
  if (type === "node-prev" || type === "node-next") {
    moveNodeSibling(type === "node-next" ? 1 : -1);
    return;
  }
  if (type === "exercise-layout") {
    state.exerciseLayout = action.dataset.layout === "vertical" ? "vertical" : "horizontal";
    renderCurrentNode();
    return;
  }
  if (type === "open-exercise") {
    const item = getItemById(action.dataset.itemId);
    if (!item) return;
    pushAppHistory();
    renderExerciseDetail(item, action.dataset.itemId);
    return;
  }
  if (type === "exercise-prev") {
    moveExerciseDetail(-1);
    return;
  }
  if (type === "exercise-next") {
    moveExerciseDetail(1);
    return;
  }
  if (type === "exercise-jump") {
    const item = getItemById(action.dataset.itemId);
    if (!item) return;
    renderExerciseDetail(item, action.dataset.itemId);
    return;
  }
  if (await handleExerciseLibraryAction(action, { renderExercises, setLoading })) return;
  if (type === "template-open") {
    void openTemplatePreview(action.dataset.templateId, () => renderTemplateLibrary(state.lastTemplates));
    return;
  }
  if (type === "coach-program-open") {
    const program = (state.coaches.detail?.programs || []).find((row) => String(row.plan_id) === String(action.dataset.templateId));
    if (program?.plan_id) {
      state.coaches = { ...state.coaches, selected: null, detail: null, contactOpen: false, error: "" };
      void openTemplatePreviewFromCoachProgram(program, renderCurrentNode);
    }
    return;
  }
  if (type === "coach-program-info") {
    const program = (state.coaches.detail?.programs || []).find((row) => String(row.plan_id) === String(action.dataset.templateId));
    if (program) {
      state.programInfo = { open: true, program };
      renderCoachContext();
    }
    return;
  }
  if (type === "template-info") {
    const template = state.lastTemplates.find((row) => String(row.plan_id) === String(action.dataset.templateId));
    if (template) {
      state.programInfo = { open: true, program: template };
      renderTemplateLibrary(state.lastTemplates);
    }
    return;
  }
  if (type === "program-info-close") {
    state.programInfo = { open: false, program: null };
    if (state.activeTab === "coaches") renderCoachContext();
    else renderTemplateLibrary(state.lastTemplates);
    return;
  }
  if (type === "template-scope") {
    state.templateScope = action.dataset.scope || "my";
    state.selectedTemplateId = null;
    state.templatePreview = emptyTemplatePreview();
    void loadTemplates();
    return;
  }
  if (type === "template-settings-toggle") {
    state.templatePreview = { ...state.templatePreview, settingsOpen: !state.templatePreview.settingsOpen };
    renderTemplateLibrary(state.lastTemplates);
    return;
  }
  if (type === "template-use") {
    void markTemplateUsed(action.dataset.templateId, { renderTemplateLibrary });
    return;
  }
  if (type === "template-assign") {
    const selected = state.lastTemplates.find((template) => String(template.plan_id) === String(action.dataset.templateId));
    if (!selected) return;
    state.builder.copyPlanId = selected.plan_id;
    state.builder.copyPlanName = selected.plan_name || "Program";
    state.builder.copyAthleteId = "";
    state.builder.copyPlanType = "program";
    state.builder.copyWeekStart = "";
    renderTemplateLibrary(state.lastTemplates);
    return;
  }
  if (type === "template-review-toggle") {
    state.templatePreview = {
      ...state.templatePreview,
      reviewOpen: !state.templatePreview.reviewOpen,
      reviewError: "",
      reviewMessage: "",
    };
    renderTemplateLibrary(state.lastTemplates);
    return;
  }
  if (type === "template-reviews-toggle") {
    state.templatePreview = { ...state.templatePreview, reviewsOpen: !state.templatePreview.reviewsOpen };
    renderTemplateLibrary(state.lastTemplates);
    return;
  }
  if (type === "template-close") {
    state.templatePreview = emptyTemplatePreview();
    if (state.activeTab === "coaches") renderCoachContext();
    else renderTemplateLibrary(state.lastTemplates);
    return;
  }
  if (type === "coach-programs-focus") {
    const section = document.querySelector("[data-coach-programs]");
    section?.scrollIntoView({ behavior: "smooth", block: "start" });
    return;
  }
  if (type === "coach-open") {
    void openCoachProfile(action.dataset.profileId);
    return;
  }
  if (type === "coach-close") {
    state.coaches = { ...state.coaches, selected: null, detail: null, editOpen: false, contactOpen: false, error: "" };
    renderCoachContext();
    return;
  }
  if (type === "coach-edit-toggle") {
    if (!canManageCoachProfile()) return;
    state.coaches.editOpen = !state.coaches.editOpen;
    renderCoachContext();
    return;
  }
  if (type === "coach-contact-toggle") {
    state.coaches.contactOpen = !state.coaches.contactOpen;
    renderCoachContext();
    return;
  }
  if (type === "program-tags-close") {
    closeProgramTagEditor({ renderTemplateLibrary });
    return;
  }
  if (type === "program-tag-add") {
    void addInlineProgramTag(action.dataset.planId, { renderTemplateLibrary });
    return;
  }
  if (type === "program-tag-remove") {
    void removeProgramTag(action.dataset.planId, action.dataset.tagId, { renderTemplateLibrary });
    return;
  }
  if (await handleOrganizationAction(action, { loadAthletes, renderOrganizationPanel })) return;
  if (type === "week-prev" || type === "week-next") {
    const delta = type === "week-prev" ? -1 : 1;
    moveWeek(delta);
    return;
  }
  if (type === "week-toggle") {
    state.weekSelectorOpen = !state.weekSelectorOpen;
    if (state.weekSelectorOpen) {
      const weeks = state.lastWeeklyData?.weeks || [];
      const activeWeek = weeks[Math.max(0, Math.min(weeks.length - 1, state.selectedWeekIndex))] || weeks[0];
      state.weekCalendarMonth = monthStartIso(activeWeek?.weekStart || localDateIso());
    }
    renderWeeklyRoot(state.lastWeeklyData);
    return;
  }
  if (type === "week-calendar-close") {
    state.weekSelectorOpen = false;
    renderWeeklyRoot(state.lastWeeklyData);
    return;
  }
  if (type === "week-calendar-prev" || type === "week-calendar-next") {
    const delta = type === "week-calendar-prev" ? -1 : 1;
    state.weekCalendarMonth = addMonthsIso(state.weekCalendarMonth || localDateIso(), delta);
    renderWeeklyRoot(state.lastWeeklyData);
    return;
  }
  if (type === "week-today") {
    const weeks = state.lastWeeklyData?.weeks || [];
    state.selectedWeekIndex = todayWeekIndex(weeks);
    state.weekCalendarMonth = monthStartIso(localDateIso());
    state.selectedWeekDay = localDateIso();
    state.pendingScrollDate = localDateIso();
    state.navStack = [];
    renderWeeklyRoot(state.lastWeeklyData);
    return;
  }
  if (type === "week-select") {
    state.selectedWeekIndex = Number(action.dataset.weekIndex) || 0;
    state.selectedWeekDay = "";
    state.navStack = [];
    renderWeeklyRoot(state.lastWeeklyData);
    return;
  }
  if (type === "week-day-select") {
    const date = action.dataset.date || "";
    const weeks = state.lastWeeklyData?.weeks || [];
    const weekIndex = weekIndexForDate(weeks, date);
    if (weekIndex < 0) return;
    state.selectedWeekIndex = weekIndex;
    state.selectedWeekDay = date;
    state.pendingScrollDate = date;
    state.weekSelectorOpen = false;
    state.weekCalendarMonth = monthStartIso(date);
    state.navStack = [];
    renderWeeklyRoot(state.lastWeeklyData);
    return;
  }
  if (type === "open-media") {
    openMedia(action.dataset.title || "Exercise media", action.dataset.image || "", action.dataset.video || "");
    return;
  }
  if (type === "enter-fullscreen") {
    enterMediaFullscreen();
    return;
  }
  if (type === "close-media") {
    closeMedia();
  }
}

function renderCurrentNode() {
  if (state.navStack.length) return renderNode(state.navStack[state.navStack.length - 1]);
  if (state.activeTab === "weekly") return renderWeeklyRoot(state.lastWeeklyData);
  if (state.activeTab === "programs") {
    const programs = state.lastProgramBundle?.programs || [];
    return renderProgramRoot(programs.find((program) => program.id === state.selectedProgramId));
  }
  if (state.activeTab === "templates") return loadTemplates();
  if (state.activeTab === "coaches") return loadCoaches();
  if (state.activeTab === "builder") return renderBuilder();
  if (state.activeTab === "exercises") return renderExercises(state.lastExerciseResults);
  if (state.activeTab === "athlete-settings") return renderAthleteSettings();
  if (state.activeTab === "athlete-library") return renderAthleteLibrary();
}

function moveWeek(delta) {
  const weeks = state.lastWeeklyData?.weeks || [];
  if (!weeks.length) return;
  const nextIndex = Math.max(0, Math.min(weeks.length - 1, state.selectedWeekIndex + delta));
  if (nextIndex === state.selectedWeekIndex) return;
  state.selectedWeekIndex = nextIndex;
  state.navStack = [];
  renderWeeklyRoot(state.lastWeeklyData);
}

function renderTabs() {
  const isLibraryTab = ["organization", "templates", "exercises", "builder", "coaches"].includes(state.activeTab);
  const tabs = document.querySelectorAll(".tab");
  const tabsContainer = tabs[0]?.closest(".tabs");
  if (tabsContainer) tabsContainer.hidden = isLibraryTab;
  tabs.forEach((tab) => tab.classList.toggle("is-active", tab.dataset.tab === state.activeTab));
}

function renderAthleteListState() {
  els.athleteList.classList.toggle("is-expanded", state.athletesExpanded);
  els.athletesToggle?.setAttribute("aria-expanded", String(state.athletesExpanded));
  document.body.classList.toggle("athletes-drawer-open", state.athletesExpanded);
}

async function renderOrganizationPanel({ refresh = true } = {}) {
  state.athletesExpanded = false;
  state.weekSelectorOpen = false;
  state.navStack = [];
  renderAthleteListState();
  renderLibraryNav();
  els.context.textContent = "Workspace settings";
  els.title.textContent = "Settings";
  els.toolbar.innerHTML = "";

  if (refresh || !state.organization.data) {
    setLoading("Loading organization...");
    try {
      state.organization.data = await api("/api/organization");
      state.organization.error = "";
    } catch (error) {
      state.organization.error = error.message || "Could not load organization.";
      state.organization.data = null;
    }
  }

  const data = state.organization.data || { clubs: [], teams: [], athletes: [], users: [], canCreateClub: false, canCreateTeam: false, canCreateAthlete: true, canCreateUser: true };
  normalizeOrganizationSelection(data);
  const role = roleLabel();
  const scope = accessScopeLabel();
  els.content.innerHTML = `
    <section class="content-section organization-view">
      <section class="panel organization-hero">
        <div>
          <p class="eyebrow">Signed in as</p>
          <h3>${escapeHtml(state.currentUser?.name || state.currentUser?.email || "User")}</h3>
          <p class="muted">${escapeHtml(state.currentUser?.email || "")}</p>
        </div>
        <div class="organization-scope-card">
          <span>${escapeHtml(role)}</span>
          <strong>${escapeHtml(scope)}</strong>
        </div>
      </section>
      ${state.organization.error ? `<p class="builder-error">${escapeHtml(state.organization.error)}</p>` : ""}
      ${renderSettingsNavHtml()}
      ${renderOrganizationActions(data)}
      ${renderOrganizationBrowser(data)}
      ${state.organizationEditor.open ? renderOrganizationEditModal(data) : ""}
    </section>
  `;
}

function renderAthleteList() {
  const search = els.athleteSearch.value.trim().toLowerCase();
  const filteredAthletes = state.athletes.filter((athlete) => {
    const haystack = `${athlete.athlete_id} ${athlete.athlete}`.toLowerCase();
    return haystack.includes(search);
  });
  const athletes = filteredAthletes;

  els.athleteList.innerHTML = renderAthleteListHtml(athletes, state.selectedAthleteId);

  renderAthleteListState();

  els.athleteList.querySelectorAll(".athlete-button").forEach((button) => {
    button.addEventListener("click", () => {
      state.selectedAthleteId = button.dataset.athleteId;
      state.athletesExpanded = false;
      state.activeTab = "weekly";
      state.selectedProgramId = null;
      state.selectedTemplateId = null;
      state.navStack = [];
      state.openWeekCalendarOnLoad = false;
      collapseRailAfterNav();
      renderAthleteList();
      renderTabs();
      renderLibraryNav();
      loadActiveTab();
    });
  });
}

function renderAthleteHeader(data) {
  const athlete = state.athletes.find((entry) => entry.athlete_id === state.selectedAthleteId);
  const isAthleteMode = document.body.classList.contains("athlete-mode");
  els.context.textContent = athlete ? (isAthleteMode ? "Athlete" : "Selected athlete") : "Program view";
  els.title.textContent = athlete?.athlete || "Plans";
  els.toolbar.innerHTML = "";

  if (!athlete) return;
  els.toolbar.innerHTML = renderAthleteHeaderToolbarHtml(athlete, { isAthleteMode });
  renderTabs();
}

function renderAthleteSettings() {
  const athlete = state.athletes.find((entry) => entry.athlete_id === state.selectedAthleteId);
  renderAthleteHeader({});
  els.context.textContent = "Athlete settings";
  els.title.textContent = "Settings";
  els.content.innerHTML = renderAthleteSettingsHtml(athlete);
}

async function renderAthleteLibrary() {
  renderAthleteHeader({});
  state.templateScope = state.templateScope === "workspace" ? "all" : state.templateScope;
  await loadTemplates();
}

function renderWeeklyRoot(data) {
  renderLibraryNav();
  const weeks = data?.weeks || [];
  if (!weeks.length) return renderEmpty("This athlete has no weekly plans.");
  const activeWeek = weeks[Math.max(0, Math.min(weeks.length - 1, state.selectedWeekIndex))] || weeks[0];
  const weekRange = `${formatDate(activeWeek.weekStart)} - ${formatDate(activeWeek.weekEnd)}`;
  const weekSelectorMarkup = state.weekSelectorOpen ? renderWeekCalendarPicker(weeks, activeWeek) : "";

  els.content.innerHTML = `
    <div class="content-section">
      <div class="week-nav-wrap">
      <section class="week-nav-panel">
        <button class="plain-button week-arrow-button" data-action="week-prev" ${state.selectedWeekIndex <= 0 ? "disabled" : ""} aria-label="Previous week">‹</button>
        <button class="week-title-button" type="button" data-action="week-toggle" aria-expanded="${state.weekSelectorOpen}" aria-label="Choose weekly plan date">
          <strong>${escapeHtml(weekRange)}</strong>
        </button>
        <button class="plain-button week-today-button" data-action="week-today">Today</button>
        <button class="plain-button week-arrow-button" data-action="week-next" ${state.selectedWeekIndex >= weeks.length - 1 ? "disabled" : ""} aria-label="Next week">›</button>
        ${activeWeek.planId ? renderPlanMoreMenu(activeWeek.planId, "weekly") : ""}
      </section>
      ${weekSelectorMarkup}
      </div>
      <section class="panel">
        <div class="calendar-grid">
          ${(activeWeek.days || []).map(renderDayEntry).join("")}
        </div>
      </section>
    </div>
    ${renderCopyPlanModal(state)}
  `;
  if (state.pendingScrollDate) {
    const date = state.pendingScrollDate;
    state.pendingScrollDate = "";
    requestAnimationFrame(() => scrollCalendarToDate(date));
  }
}

function renderWeekCalendarPicker(weeks, activeWeek) {
  const availableMonths = weeklyCalendarMonthRange(weeks);
  if (!availableMonths.length) return "";
  const firstMonth = availableMonths[0];
  const lastMonth = availableMonths[availableMonths.length - 1];
  const selectedMonth = clampMonth(state.weekCalendarMonth || monthStartIso(activeWeek.weekStart), firstMonth, lastMonth);
  state.weekCalendarMonth = selectedMonth;
  const month = buildWeeklyCalendarMonth(selectedMonth, weeklyCalendarDayMap(weeks));
  return `
    <section class="week-calendar-picker" aria-label="Weekly plan calendar">
      <article class="week-calendar-month">
        <div class="week-calendar-head">
          <button class="plain-button icon-button" data-action="week-calendar-prev" ${selectedMonth <= firstMonth ? "disabled" : ""} aria-label="Previous month"><span class="button-icon">‹</span></button>
          <h4>${escapeHtml(month.label)}</h4>
          <button class="plain-button icon-button" data-action="week-calendar-next" ${selectedMonth >= lastMonth ? "disabled" : ""} aria-label="Next month"><span class="button-icon">›</span></button>
        </div>
        <button class="plain-button week-calendar-close" data-action="week-calendar-close">Close calendar</button>
        <div class="week-calendar-weekdays">
          ${["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((day) => `<span>${day}</span>`).join("")}
        </div>
        <div class="week-calendar-days">
          ${month.days.map((day) => renderWeekCalendarDay(day, activeWeek, selectedWeeklyDay(activeWeek, state.selectedWeekDay))).join("")}
        </div>
      </article>
    </section>
  `;
}

function renderWeekCalendarDay(day, activeWeek, selectedDate) {
  const classes = [
    "week-calendar-day",
    day.isOutside ? "is-outside" : "",
    day.hasItems ? "has-items" : "",
    day.date === localDateIso() ? "is-today" : "",
    day.date === selectedDate ? "is-active-week" : "",
  ].filter(Boolean).join(" ");
  const content = `
    <span class="week-calendar-day-number">${escapeHtml(String(day.dayNumber))}</span>
    ${day.hasItems ? `<span class="week-calendar-dot"></span><span class="week-calendar-count">${day.itemCount}</span>` : ""}
  `;
  if (!day.hasItems) {
    return `<span class="${classes}" aria-label="${escapeAttr(day.date)}">${content}</span>`;
  }
  return `
    <button class="${classes}" data-action="week-day-select" data-date="${escapeAttr(day.date)}" aria-label="${escapeAttr(`${formatDate(day.date)}, ${day.itemCount} items`)}">
      ${content}
    </button>
  `;
}

function renderDayEntry(day) {
  const items = allSlotItems(day.slots);
  const isToday = day.date === localDateIso();
  return `
    <article class="calendar-day ${isToday ? "is-today" : ""}" data-date="${escapeAttr(day.date)}">
      <div class="calendar-day-head">
        <span class="calendar-weekday">${escapeHtml(formatWeekday(day.date))}</span>
        <span class="calendar-date">${escapeHtml(formatDayMonth(day.date))}${isToday ? " · Today" : ""}</span>
      </div>
      ${day.dayNote ? `<div class="calendar-note">${escapeHtml(day.dayNote)}</div>` : ""}
      <div class="calendar-events">
        ${items.length ? renderCalendarHierarchy(items) : `<div class="calendar-empty">No entries</div>`}
      </div>
    </article>
  `;
}

function renderCalendarHierarchy(items) {
  return sessionNodes(items).map(renderCalendarSession).join("");
}

function scrollCalendarToDate(date) {
  const grid = els.content.querySelector(".calendar-grid");
  if (!grid) return;
  const day = grid.querySelector(`[data-date="${date}"]`);
  if (!day) {
    grid.scrollTo({ left: 0, behavior: "smooth" });
    return;
  }
  const trailingSpace = Math.max(0, grid.clientWidth - day.offsetWidth);
  grid.style.paddingRight = `${trailingSpace}px`;
  grid.scrollTo({ left: Math.max(0, day.offsetLeft - grid.offsetLeft), behavior: "smooth" });
}

function renderCalendarSession(node) {
  if (node.type === "amPm") {
    return `
      <div class="calendar-session">
        <div class="calendar-session-label">${escapeHtml(node.label)}</div>
        ${renderCalendarBtaGroups(node.items)}
      </div>
    `;
  }

  if (node.type === "session") {
    return `
      <div class="calendar-session">
        <div class="calendar-session-label">${escapeHtml(node.label)}</div>
        ${renderCalendarBtaGroups(node.items)}
      </div>
    `;
  }

  if (node.type === "bta") return renderCalendarBtaGroup(node);
  return renderCalendarEvent(node);
}

function renderCalendarBtaGroups(items) {
  const nodes = btaNodes(items);
  if (nodes.length) return nodes.map(renderCalendarBtaGroup).join("");
  const directNodes = structureNodes(items);
  return directNodes.length ? directNodes.map(renderCalendarEvent).join("") : "";
}

function renderCalendarBtaGroup(node) {
  const children = structureNodes(node.items);
  const eventNodes = children.length ? children : [node];
  return `
    <div class="calendar-bta">
      <div class="calendar-bta-label">${escapeHtml(node.label)}</div>
      <div class="calendar-bta-events">
        ${eventNodes.map(renderCalendarEvent).join("")}
      </div>
    </div>
  `;
}

function renderCalendarEvent(node) {
  if (!node.items.length) return "";
  const shortNote = node.shortNote || node.note || "";
  return `
    <button class="calendar-event" data-action="node" data-node-id="${escapeAttr(node.id)}" style="${node.color ? `--node-color:${escapeAttr(node.color)}` : ""}">
      <span class="calendar-event-head">
        ${node.icon ? `${renderImage(node.icon, "calendar-event-icon")}<span class="calendar-event-dot calendar-event-dot-fallback"></span>` : `<span class="calendar-event-dot"></span>`}
        <span class="calendar-event-title">${escapeHtml(node.label)}</span>
      </span>
      ${shortNote ? `<span class="calendar-event-note">${escapeHtml(shortNote)}</span>` : ""}
      <span class="calendar-event-count">${escapeHtml(node.subtitle || countLabel(node.items))}</span>
    </button>
  `;
}

function renderProgramToolbar(programs) {
  els.toolbar.querySelector(".program-toolbar")?.remove();
  els.toolbar.insertAdjacentHTML("beforeend", `
    <div class="chip-row program-toolbar">
      ${programs.map((program) => `
        <button class="chip ${program.id === state.selectedProgramId ? "is-active" : ""}" data-program-id="${escapeAttr(program.id)}">
          ${escapeHtml(program.name)}
        </button>
      `).join("")}
      ${state.selectedProgramId ? renderPlanMoreMenu(state.selectedProgramId, "program") : ""}
    </div>
  `);
  els.toolbar.querySelectorAll(".program-toolbar .chip").forEach((button) => {
    button.addEventListener("click", () => {
      state.selectedProgramId = button.dataset.programId;
      state.navStack = [];
      renderProgramToolbar(programs);
      renderProgramRoot(programs.find((program) => program.id === state.selectedProgramId));
    });
  });
}

function renderProgramRoot(program) {
  if (!program) return renderEmpty("This athlete has no specific programs.");
  const data = program.data || {};
  const isMicrocycle = data.mode === "microcycle";
  const groups = isMicrocycle
    ? (data.microcycles || []).map((microcycle) => makeNode("microcycle", microcycle.name, flattenDayGroups(microcycle.dayGroups), {
        subtitle: `${(microcycle.dayGroups || []).length} ${(microcycle.dayGroups || []).length === 1 ? "block" : "blocks"}`,
      }))
    : programDayGroupNodes(data.dayGroups || []);

  els.content.innerHTML = `
    <section class="panel">
      <div class="section-heading">
        <div>
          <p class="eyebrow">Specific program</p>
          <h3>${escapeHtml(program.name)}</h3>
        </div>
        <div class="builder-source-actions"><span class="item-badge">${data.rows?.length || 0} items</span>${renderPlanMoreMenu(program.id, "program")}</div>
      </div>
      ${isMicrocycle
        ? `<div class="node-grid">${groups.map(renderNodeButton).join("")}</div>`
        : `<div class="program-day-grid">${groups.map(renderProgramDayCard).join("")}</div>`}
    </section>
    ${renderCopyPlanModal(state)}
  `;
}

function programDayGroupNodes(dayGroups) {
  return (dayGroups || []).map((group, index) => makeNode("dayGroup", group.dayNote || `Block ${index + 1}`, groupItems(group), {
    subtitle: countLabel(groupItems(group)),
    blockIndex: index + 1,
  }));
}

function renderProgramDayCard(node) {
  return `
    <article class="program-day-card">
      <div class="program-day-head">
        <div>
          <h4>${escapeHtml(node.label)}</h4>
        </div>
        <span class="item-badge">${escapeHtml(node.subtitle || countLabel(node.items))}</span>
      </div>
      <div class="calendar-events">
        ${node.items.length ? renderCalendarHierarchy(node.items) : `<div class="calendar-empty">No entries</div>`}
      </div>
    </article>
  `;
}

function renderNode(node) {
  const next = nextNodes(node);
  const crumbs = state.navStack.map((entry) => entry.label);
  const siblingState = nodeSiblingState();
  els.content.innerHTML = `
    <section class="panel node-detail-panel">
      <div class="drill-header">
        <div>
          <p class="eyebrow">${escapeHtml(node.typeLabel || node.type)}</p>
          <h3>${escapeHtml(node.label)}</h3>
          <div class="breadcrumb">${crumbs.map(escapeHtml).join(" / ")}</div>
        </div>
      </div>
      <div class="node-detail-body">
        ${node.note ? `<p class="node-note">${escapeHtml(node.note)}</p>` : ""}
        ${next.length
          ? `<div class="node-grid">${next.map(renderNodeButton).join("")}</div>`
          : renderTerminalNode(node)}
      </div>
      <nav class="node-detail-footer">
        <button class="footer-nav-button" type="button" data-action="back"><span class="button-icon">←</span><span>Back</span></button>
        ${siblingState.hasSiblings ? `<button class="footer-nav-button" type="button" data-action="node-prev" ${siblingState.canGoPrevious ? "" : "disabled"}><span class="button-icon">‹</span><span>Previous</span></button>` : ""}
        ${siblingState.hasSiblings ? `<span class="exercise-position">${siblingState.index + 1} / ${siblingState.total}</span>` : ""}
        ${siblingState.hasSiblings ? `<button class="footer-nav-button" type="button" data-action="node-next" ${siblingState.canGoNext ? "" : "disabled"}><span class="button-icon">›</span><span>Next</span></button>` : ""}
        <button class="footer-nav-button" type="button" data-action="home"><span class="button-icon">⌂</span><span>Home</span></button>
      </nav>
    </section>
  `;
}

function renderTerminalNode(node) {
  if (!(node.items || []).some(isExerciseItem)) return renderOrganizationSummary(node);
  return renderExerciseList(node.items);
}

function nextNodes(node) {
  if (node.type === "amPm") return btaNodes(node.items);
  if (node.type === "dayGroup") return sessionNodes(node.items);
  if (node.type === "bta" || node.type === "session") return structureNodes(node.items);
  if (node.type === "microcycle") return dayGroupNodesFromItems(node.items);
  if (node.type === "domain") return categoryOrSectionNodes(node.items);
  if (node.type === "category") return sectionOrExerciseNodes(node.items);
  if (node.type === "section") return [];
  return structureNodes(node.items);
}

function btaNodes(items) {
  const order = ["B", "T", "A", ""];
  const labels = { B: "Before training", T: "Training", A: "After training", "": "Session" };
  return order
    .map((keyValue) => {
      const filtered = items.filter((item) => (item.bta || "") === keyValue);
      if (!filtered.length) return null;
      return makeNode("bta", labels[keyValue], filtered, {
        subtitle: countLabel(filtered),
        color: keyValue === "B" ? "#487b65" : keyValue === "T" ? "#1f6f68" : keyValue === "A" ? "#9a6a3a" : "#667085",
      });
    })
    .filter(Boolean);
}

function sessionNodes(items) {
  const explicitItems = items.filter((item) => item.amPm === "AM" || item.amPm === "PM");
  const blankItems = items.filter((item) => item.amPm !== "AM" && item.amPm !== "PM");

  if (!explicitItems.length) {
    const nodes = btaNodes(items);
    return nodes.length ? nodes : structureNodes(items);
  }

  return [
    makeNode("amPm", "AM", explicitItems.filter((item) => item.amPm === "AM"), { color: "#2f6f8f" }),
    makeNode("amPm", "PM", explicitItems.filter((item) => item.amPm === "PM"), { color: "#6d5d9f" }),
    makeNode("session", "Session", blankItems, { subtitle: countLabel(blankItems), color: "#667085" }),
  ].filter((node) => node.items.length);
}

function structureNodes(items) {
  const domainNames = orderedUnique(items, "domain");
  const missingDomain = items.some((item) => !clean(item.domain));
  if (domainNames.length && !missingDomain) return groupNodes(items, "domain");

  const categoryNames = orderedUnique(items, "category");
  const missingCategory = items.some((item) => !clean(item.category));
  if (categoryNames.length && !missingCategory) return groupNodes(items, "category");

  const sectionNames = orderedUnique(items, "section");
  if (sectionNames.length) return groupNodes(items, "section");

  return [];
}

function categoryOrSectionNodes(items) {
  const categoryNames = orderedUnique(items, "category");
  const missingCategory = items.some((item) => !clean(item.category));
  if (categoryNames.length && !missingCategory) return groupNodes(items, "category");

  const sectionNames = orderedUnique(items, "section");
  if (sectionNames.length) return groupNodes(items, "section");

  return [];
}

function sectionOrExerciseNodes(items) {
  const sectionNames = orderedUnique(items, "section");
  if (sectionNames.length) return groupNodes(items, "section");
  return [];
}

function dayGroupNodesFromItems(items) {
  const grouped = groupBy(items, (item) => item.dayNote || "Program");
  return grouped.map((group) => makeNode("dayGroup", group.label, group.items, { subtitle: countLabel(group.items) }));
}

function groupNodes(items, type) {
  return groupBy(items, (item) => clean(item[type]) || "GENERAL").map((group) => {
    const meta = group.items.find(Boolean) || {};
    return makeNode(type, group.label, group.items, {
      subtitle: countLabel(group.items),
      color: meta[`${type}_color`] || "",
      icon: meta[`${type}_icon_url`] || "",
      shortNote: meta[`${type}_short_note`] || "",
      note: meta[`${type}_note`] || meta[`${type}_short_note`] || "",
    });
  });
}

function renderNodeButton(node) {
  if (!node.items.length) return "";
  return `
    <button class="node-card" data-action="node" data-node-id="${escapeAttr(node.id)}" style="${node.color ? `--node-color:${escapeAttr(node.color)}` : ""}">
      <span class="node-card-head">
        ${node.icon ? `${renderImage(node.icon, "node-icon")}<span class="node-dot node-dot-fallback"></span>` : `<span class="node-dot"></span>`}
        <span>
          <span class="node-title">${escapeHtml(node.label)}</span>
          <span class="node-sub">${escapeHtml(node.subtitle || countLabel(node.items))}</span>
        </span>
      </span>
      ${node.note ? `<span class="node-note-short">${escapeHtml(node.note)}</span>` : ""}
    </button>
  `;
}

function renderTemplateToolbar(templates) {
  const scope = templateScopeMeta();
  els.context.textContent = "Program library";
  els.title.textContent = scope.label;
  const duplicateNames = duplicateTemplateNames(templates);
  els.toolbar.innerHTML = `
    <div class="chip-row template-toolbar">
      ${templates.map((template) => `
        <button class="chip ${template.plan_id === state.selectedTemplateId ? "is-active" : ""}" data-template-id="${escapeAttr(template.plan_id)}">
          <span class="chip-main">${escapeHtml(template.plan_name)}</span>
          ${templateSecondaryLabel(template, duplicateNames) ? `<span class="chip-sub">${escapeHtml(templateSecondaryLabel(template, duplicateNames))}</span>` : ""}
        </button>
      `).join("")}
      ${state.selectedTemplateId ? renderPlanMoreMenu(state.selectedTemplateId, "template") : ""}
    </div>
  `;
  els.toolbar.querySelectorAll("[data-template-id]").forEach((button) => {
    button.addEventListener("click", async () => {
      state.selectedTemplateId = button.dataset.templateId;
      state.navStack = [];
      await loadTemplates();
    });
  });
}

function renderTemplateList(templates, selected, detail) {
  const scope = templateScopeMeta();
  els.context.textContent = "Program library";
  els.title.textContent = scope.label;
  const data = detail || {};
  const isMicrocycle = data.mode === "microcycle";
  const groups = isMicrocycle
    ? (data.microcycles || []).map((microcycle) => makeNode("microcycle", microcycle.name, flattenDayGroups(microcycle.dayGroups), {
        subtitle: `${(microcycle.dayGroups || []).length} ${(microcycle.dayGroups || []).length === 1 ? "block" : "blocks"}`,
      }))
    : programDayGroupNodes(data.dayGroups || []);

  els.content.innerHTML = `
    <section class="content-section">
      <section class="panel">
        <div class="section-heading">
          <div>
            <p class="eyebrow">Template</p>
            <h3>${escapeHtml(selected.plan_name)}</h3>
            <p class="muted">${escapeHtml([templateCategoryLabel(selected), programPriceLabel(selected)].filter(Boolean).join(" · "))}</p>
          </div>
          <div class="builder-source-actions">${renderPlanMoreMenu(selected.plan_id, "template")}</div>
        </div>
        ${isMicrocycle
          ? `<div class="node-grid">${groups.map(renderNodeButton).join("")}</div>`
          : `<div class="program-day-grid">${groups.map(renderProgramDayCard).join("")}</div>`}
      </section>
    </section>
    ${renderCopyPlanModal(state)}
  `;
}

function renderTemplateLibrary(templates) {
  const scope = templateScopeMeta();
  const visibleTemplates = applyTemplateClientFilters(templates, state.templateFilters);
  els.context.textContent = "Program library";
  els.title.textContent = scope.label;
  els.toolbar.innerHTML = "";

  els.content.innerHTML = `
    <section class="content-section program-library-page">
      <div class="program-library-head">
        <p class="muted" data-template-count>${visibleTemplates.length} ${visibleTemplates.length === 1 ? "program" : "programs"}</p>
      </div>
      ${renderTemplateFilters()}
      <div class="program-library-shelves" data-template-results>
        ${renderTemplateLibraryResultsHtml(visibleTemplates, state.selectedTemplateId)}
      </div>
    </section>
    ${renderTemplatePreviewModal()}
    ${renderProgramInfoModal(state.programInfo)}
    ${renderCoachDetailModalHtml(state.coaches, state.currentUser)}
    ${renderCopyPlanModal(state)}
  `;
}

function renderTemplateLibraryResults() {
  const visibleTemplates = applyTemplateClientFilters(state.lastTemplates || [], state.templateFilters);
  const count = document.querySelector("[data-template-count]");
  if (count) count.textContent = `${visibleTemplates.length} ${visibleTemplates.length === 1 ? "program" : "programs"}`;
  document.querySelector(".program-preview-overlay")?.remove();
  const target = document.querySelector("[data-template-results]");
  if (target) target.innerHTML = renderTemplateLibraryResultsHtml(visibleTemplates, state.selectedTemplateId);
}

function canUseProgramAdminFilters() {
  return ["platform", "club"].includes(String(state.currentUser?.accessScope || "").toLowerCase());
}

function renderTemplateFilters() {
  const filters = state.templateFilters;
  const options = state.templateOptions || {};
  const showAdminFilters = canUseProgramAdminFilters();
  const scopes = visibleTemplateScopes();
  const tagPrefix = clean(filters.tag).toLowerCase();
  const visibleTags = tagPrefix ? (options.tags || []).filter((tag) => templateFilterOptionMatches(tag, tagPrefix)) : (options.tags || []);
  const categories = templateCategoryOptions(options, state.lastTemplates);
  const categoryPrefix = clean(filters.category).toLowerCase();
  const visibleCategories = categoryPrefix ? categories.filter((category) => templateFilterOptionMatches(category, categoryPrefix)) : categories;
  const creatorOptions = templateFilterSuggestions("creator", options, state.lastTemplates);
  const creatorPrefix = clean(filters.creator).toLowerCase();
  const visibleCreators = creatorPrefix ? creatorOptions.filter((creator) => templateFilterOptionMatches(creator, creatorPrefix)) : creatorOptions;
  const clubOptions = templateFilterSuggestions("club", options, state.lastTemplates);
  const clubPrefix = clean(filters.club).toLowerCase();
  const visibleClubs = clubPrefix ? clubOptions.filter((club) => templateFilterOptionMatches(club, clubPrefix)) : clubOptions;
  return renderTemplateFiltersHtml({
    filters,
    options,
    showAdminFilters,
    scopes,
    activeScope: state.templateScope,
    scopeLabel: (scope) => templateScopeMeta(scope).label,
    visibleTags,
    visibleCategories,
    creatorOptions,
    visibleCreators,
    clubOptions,
    visibleClubs,
  });
}

function renderTemplatePreviewModal() {
  if (!state.templatePreview.open) return "";
  const selected = state.lastTemplates.find((template) => String(template.plan_id) === String(state.selectedTemplateId));
  const detail = state.templatePreview.detail || {};
  const isMicrocycle = detail.mode === "microcycle";
  const groups = state.templatePreview.loading || state.templatePreview.error
    ? []
    : isMicrocycle
      ? (detail.microcycles || []).map((microcycle) => makeNode("microcycle", microcycle.name, flattenDayGroups(microcycle.dayGroups), {
          subtitle: `${(microcycle.dayGroups || []).length} ${(microcycle.dayGroups || []).length === 1 ? "block" : "blocks"}`,
        }))
      : programDayGroupNodes(detail.dayGroups || []);

  return renderTemplatePreviewModalHtml({
    currentUserRole: state.currentUser?.role,
    detail,
    groups,
    isMicrocycle,
    preview: state.templatePreview,
    programTagEditor: state.programTagEditor,
    renderNodeButton,
    renderPlanMoreMenu,
    renderProgramDayCard,
    selected,
    templateOptions: state.templateOptions,
  });
}
async function loadBuilder() {
  state.navStack = [];
  els.context.textContent = "Program builder";
  els.title.textContent = "Build a program";
  els.toolbar.innerHTML = "";
  if (!state.builder.draft) {
    renderBuilder();
    return;
  }
  setLoading("Loading draft program...");
  const data = await api(`/api/builder/plans/${encodeURIComponent(state.builder.draft.plan.id)}`);
  state.builder.draft = data;
  await loadBuilderExercises();
}

function renderCopyPlanSource() {
  if (state.activeTab === "weekly") return renderWeeklyRoot(state.lastWeeklyData);
  if (state.activeTab === "programs") return renderProgramRoot((state.lastProgramBundle?.programs || []).find((program) => program.id === state.selectedProgramId));
  return loadTemplates();
}

async function handleBuilderAction(action) {
  if (await handleBuilderPlanAction(action, { renderCopyPlanSource, renderTabs, renderLibraryNav, loadBuilderExercises })) return;
  if (await handleBuilderWorkspaceAction(action, { renderBuilder })) return;
  if (await handleBuilderDraftAction(action, { renderBuilder, renderBuilderError, renderTabs, renderLibraryNav, loadWeekly, loadPrograms, loadTemplates, refreshBuilderDraft })) return;
  if (await handleBuilderItemAction(action, { renderBuilder, renderBuilderError, refreshBuilderDraft })) return;
}

function renderBuilderError(error) {
  const message = error?.message || "Could not save this change.";
  els.content.insertAdjacentHTML("afterbegin", `<p class="builder-error builder-page-error" role="alert">${escapeHtml(message)}</p>`);
}

function renderExercises(exercises) {
  state.lastExerciseResults = exercises;
  els.context.textContent = "Exercise library";
  els.title.textContent = "Exercise Library";
  if (!exercises.length) return renderEmpty("No exercises for this search.");
  const itemIds = registerItems(exercises);
  state.exerciseDetail = { ids: itemIds, currentId: null };
  els.content.innerHTML = renderExerciseLibraryHtml({
    exercises,
    itemIds,
    markedExerciseIds: state.markedExerciseIds,
    search: state.exerciseSearch,
    tagEditor: state.tagEditor,
  });
}

function renderExerciseList(items) {
  const itemIds = items.map((item) => (isExerciseItem(item) ? registerItem(item) : ""));
  const exerciseIds = itemIds.filter(Boolean);
  state.exerciseDetail = { ids: exerciseIds, currentId: null };
  const layout = state.exerciseLayout === "vertical" ? "vertical" : "horizontal";
  return `
    ${exerciseIds.length ? `
      <div class="exercise-layout-toolbar" aria-label="Exercise layout">
        <span class="muted">Layout</span>
        <button class="chip layout-chip ${layout === "horizontal" ? "is-active" : ""}" data-action="exercise-layout" data-layout="horizontal">
          <span class="layout-icon layout-icon-horizontal"></span><span>Horizontal</span>
        </button>
        <button class="chip layout-chip ${layout === "vertical" ? "is-active" : ""}" data-action="exercise-layout" data-layout="vertical">
          <span class="layout-icon layout-icon-vertical"></span><span>Vertical</span>
        </button>
      </div>
    ` : ""}
    <div class="exercise-list is-${layout} ${items.length === 1 ? "is-single" : ""}">
      ${items.map((item, index) => renderItem(item, itemIds[index])).join("")}
    </div>
  `;
}

function renderItem(item, itemId) {
  const color = item.section_color || item.category_color || item.domain_color || "#1f6f68";
  const image = item.image || item.image_url || "";
  const video = item.video || item.video_url || "";
  const doseRows = exerciseDoseRows(item);
  const hasMedia = Boolean(image || video);
  const isVertical = state.exerciseLayout === "vertical";
  if (!isExerciseItem(item)) return renderOrganizationItem(item, color);
  if (isVertical) {
    return `
      <article class="plan-item exercise-item exercise-item-vertical ${hasMedia ? "" : "no-media"}" style="border-left-color:${escapeAttr(color)}">
        <div class="exercise-item-top">
          <div class="exercise-media-stack">
            <button class="exercise-open exercise-title-open" data-action="open-exercise" data-item-id="${escapeAttr(itemId)}">
              <span class="item-title">${escapeHtml(item.title || "Untitled")}</span>
            </button>
            ${hasMedia ? `
              <button class="exercise-media" data-action="open-media" data-title="${escapeAttr(item.title || "Exercise media")}" data-image="${escapeAttr(image)}" data-video="${escapeAttr(video)}">
                ${image ? renderMediaThumb(image, "") : `<span class="media-fallback">Video</span>`}
              </button>
            ` : ""}
          </div>
          <button class="exercise-open plan-exercise-open exercise-item-summary" data-action="open-exercise" data-item-id="${escapeAttr(itemId)}">
            ${doseRows.length ? renderDoseMini(doseRows) : ""}
            ${item.description ? `<span class="item-description">${escapeHtml(item.description)}</span>` : ""}
          </button>
        </div>
      </article>
    `;
  }
  return `
    <article class="plan-item exercise-item ${hasMedia ? "" : "no-media"}" style="border-left-color:${escapeAttr(color)}">
      ${hasMedia ? `
        <button class="exercise-media" data-action="open-media" data-title="${escapeAttr(item.title || "Exercise media")}" data-image="${escapeAttr(image)}" data-video="${escapeAttr(video)}">
          ${image ? renderMediaThumb(image, "") : `<span class="media-fallback">Video</span>`}
        </button>
      ` : ""}
      <button class="exercise-open plan-exercise-open" data-action="open-exercise" data-item-id="${escapeAttr(itemId)}">
        <span class="item-head">
          <span class="item-title">${escapeHtml(item.title || "Untitled")}</span>
        </span>
        ${doseRows.length ? renderDoseMini(doseRows) : ""}
        ${item.description ? `<span class="item-description">${escapeHtml(item.description)}</span>` : ""}
      </button>
    </article>
  `;
}

function renderOrganizationItem(item, color) {
  const title = item.title || item.category || item.section || item.domain || "Entry";
  return `
    <article class="plan-item exercise-item organization-item no-media" style="border-left-color:${escapeAttr(color)}">
      <div class="item-head">
        <span class="item-title">${escapeHtml(title)}</span>
      </div>
      ${item.description ? `<span class="item-description">${escapeHtml(item.description)}</span>` : ""}
    </article>
  `;
}

function renderOrganizationSummary(node) {
  const meta = (node.items || []).find(Boolean) || {};
  const icon = node.icon || meta[`${node.type}_icon_url`] || meta.category_icon_url || meta.section_icon_url || meta.domain_icon_url || "";
  const color = node.color || meta[`${node.type}_color`] || meta.category_color || meta.section_color || meta.domain_color || "#1f6f68";
  const note = node.note || meta.description || meta[`${node.type}_note`] || meta[`${node.type}_short_note`] || "";
  const doseRows = exerciseDoseRows(meta);
  return `
    <article class="organization-summary" style="--node-color:${escapeAttr(color)}">
      <div class="node-card-head">
        ${icon ? `${renderImage(icon, "node-icon")}<span class="node-dot node-dot-fallback"></span>` : `<span class="node-dot"></span>`}
        <div>
          <h4>${escapeHtml(node.label)}</h4>
          ${note ? `<p>${escapeHtml(note)}</p>` : ""}
        </div>
      </div>
      ${doseRows.length ? renderDoseMini(doseRows) : ""}
    </article>
  `;
}

function isExerciseItem(item) {
  const type = clean(item.item_type).toLowerCase();
  if (["category", "section", "domain"].includes(type)) return false;
  if (type === "exercise") return true;
  if (item.exercise_id || item.exercise_code) return true;
  if (item.image || item.image_url || item.video || item.video_url) return true;
  if (exerciseDoseRows(item).length) return true;
  return !type;
}

function exerciseDoseRows(item) {
  return [
    ["Sets", item.sets],
    ["Reps", item.reps],
    ["Load", item.load],
  ].filter(([, value]) => clean(value));
}

function renderDoseMini(rows) {
  return `
    <span class="dose-mini-grid">
      ${rows.map(([label, value]) => `
        <span class="dose-mini-cell">
          <span>${escapeHtml(label)}</span>
          <strong>${escapeHtml(value)}</strong>
        </span>
      `).join("")}
    </span>
  `;
}

function renderExerciseDetail(item, itemId = state.exerciseDetail.currentId) {
  if (itemId) state.exerciseDetail.currentId = itemId;
  const ids = state.exerciseDetail.ids || [];
  const currentIndex = ids.indexOf(state.exerciseDetail.currentId);
  const hasSequence = currentIndex >= 0 && ids.length > 1;
  const canGoPrevious = hasSequence && currentIndex > 0;
  const canGoNext = hasSequence;
  const title = clean(item.title || item.name || "Exercise");
  const image = item.image || item.image_url || "";
  const video = item.video || item.video_url || "";
  const hierarchy = [item.domain, item.category, item.section].filter(Boolean).join(" / ");
  const doseRows = [
    ...exerciseDoseRows(item),
    ["Place", item.place],
    ["Complexity", item.complexity],
  ].filter(([, value]) => clean(value));
  const noteRows = [
    ["Aim", item.aim],
    ["Description", item.description],
    ["Execution notes", item.execution_notes],
    ["Instruction", item.instruction],
  ].filter(([, value]) => clean(value));

  const markup = `
    <div class="exercise-detail-overlay">
      <div class="exercise-detail-backdrop" data-action="exercise-back"></div>
      <section class="panel exercise-detail">
        ${hasSequence ? `<div class="exercise-sequence-indicator" aria-label="Exercise ${currentIndex + 1} of ${ids.length}">${ids.map((id) => `<i class="${id === state.exerciseDetail.currentId ? "is-active" : ""}"></i>`).join("")}</div>` : ""}
        <div class="drill-header">
          <div>
            <p class="eyebrow">Exercise</p>
            <h3>${escapeHtml(title)}</h3>
            ${hierarchy ? `<div class="breadcrumb">${escapeHtml(hierarchy)}</div>` : ""}
          </div>
        </div>

        <div class="exercise-detail-layout">
          <div class="exercise-detail-media">
            ${image || video
              ? `<button class="exercise-media detail-media" data-action="open-media" data-title="${escapeAttr(title)}" data-image="${escapeAttr(image)}" data-video="${escapeAttr(video)}">
                  ${image ? renderMediaThumb(image) : `<span class="media-fallback">Video</span>`}
                </button>`
              : `<div class="detail-media-empty">No image</div>`}
          </div>

          <div class="exercise-detail-main">
            ${doseRows.length ? `
              <div class="detail-grid">
                ${doseRows.map(([label, value]) => `
                  <div class="detail-cell">
                    <span>${escapeHtml(label)}</span>
                    <strong>${escapeHtml(value)}</strong>
                  </div>
                `).join("")}
              </div>
            ` : ""}

            ${noteRows.length ? `
              <div class="detail-notes">
                ${noteRows.map(([label, value]) => `
                  <section>
                    <p class="eyebrow">${escapeHtml(label)}</p>
                    <p>${escapeHtml(value)}</p>
                  </section>
                `).join("")}
              </div>
            ` : `<div class="empty">No additional exercise notes.</div>`}
          </div>

          ${hasSequence ? `
            <div class="exercise-sibling-strip">
              <p class="eyebrow">Other exercises in this section</p>
              <div class="exercise-sibling-row">
                ${ids.map((id) => {
                  const sibling = getItemById(id);
                  if (!sibling) return "";
                  const isActive = id === state.exerciseDetail.currentId;
                  const siblingTitle = clean(sibling.title || sibling.name || "Exercise");
                  const siblingImage = sibling.image || sibling.image_url || "";
                  return `
                    <button class="exercise-sibling-card ${isActive ? "is-active" : ""}" type="button" data-action="exercise-jump" data-item-id="${escapeAttr(id)}" ${isActive ? "disabled" : ""}>
                      ${siblingImage ? renderImage(siblingImage, "exercise-sibling-image") : `<span class="exercise-sibling-fallback">${escapeHtml(initialsFor(siblingTitle))}</span>`}
                      <span>${escapeHtml(siblingTitle)}</span>
                    </button>
                  `;
                }).join("")}
              </div>
            </div>
          ` : ""}
        </div>

        <nav class="exercise-detail-footer">
          <button class="footer-nav-button" type="button" data-action="exercise-back"><span class="button-icon">←</span><span>Back</span></button>
          ${hasSequence ? `<button class="footer-nav-button" type="button" data-action="exercise-prev" ${canGoPrevious ? "" : "disabled"}><span class="button-icon">‹</span><span>Previous</span></button>` : ""}
          ${hasSequence ? `<span class="exercise-position">${currentIndex + 1} / ${ids.length}</span>` : ""}
          ${hasSequence ? `<button class="footer-nav-button" type="button" data-action="exercise-next" ${canGoNext ? "" : "disabled"}><span class="button-icon">›</span><span>Next</span></button>` : ""}
          <button class="footer-nav-button" type="button" data-action="home"><span class="button-icon">⌂</span><span>Home</span></button>
        </nav>
      </section>
    </div>
  `;
  els.content.querySelector(".exercise-detail-overlay")?.remove();
  els.content.insertAdjacentHTML("beforeend", markup);
  setExerciseOverlayBackgroundInert(true);
}

function makeNode(type, label, items, options = {}) {
  return {
    id: crypto.randomUUID(),
    type,
    typeLabel: typeLabels[type] || type,
    label: label || "Program",
    items: items || [],
    subtitle: options.subtitle || "",
    color: options.color || "",
    icon: options.icon || "",
    shortNote: options.shortNote || "",
    note: options.note || "",
    blockIndex: options.blockIndex || "",
  };
}

const typeLabels = {
  amPm: "AM/PM",
  bta: "Session",
  domain: "Domain",
  category: "Category",
  section: "Section",
  dayGroup: "Block",
  microcycle: "Microcycle",
  template: "Template",
};

function getNodeById(id) {
  return nodeRegistry.get(id) || null;
}

function getItemById(id) {
  return itemRegistry.get(id) || null;
}

const nodeRegistry = new Map();
const itemRegistry = new Map();
const originalMakeNode = makeNode;
makeNode = function registeredNode(type, label, items, options = {}) {
  const node = originalMakeNode(type, label, items, options);
  nodeRegistry.set(node.id, node);
  return node;
};

function registerItem(item) {
  const id = crypto.randomUUID();
  itemRegistry.set(id, item);
  return id;
}

function registerItems(items) {
  return (items || []).map((item) => registerItem(item));
}

function moveExerciseDetail(delta) {
  const ids = state.exerciseDetail.ids || [];
  const currentIndex = ids.indexOf(state.exerciseDetail.currentId);
  if (currentIndex < 0) return;
  const nextIndex = currentIndex + delta;
  if (nextIndex < 0) return;
  if (nextIndex >= ids.length) {
    returnToNodeParent();
    return;
  }
  const nextId = ids[nextIndex];
  const item = getItemById(nextId);
  if (!item) return;
  renderExerciseDetail(item, nextId);
}

function returnToNodeParent() {
  const overlay = els.content.querySelector(".exercise-detail-overlay");
  if (overlay) {
    overlay.remove();
    setExerciseOverlayBackgroundInert(false);
    return;
  }
  if (state.navStack.length > 1) {
    state.navStack.pop();
    renderCurrentNode();
    return;
  }
  renderCurrentNode();
}

function setExerciseOverlayBackgroundInert(isInert) {
  [...els.content.children].forEach((child) => {
    if (child.classList.contains("exercise-detail-overlay")) return;
    if (isInert) {
      child.setAttribute("inert", "");
      child.setAttribute("aria-hidden", "true");
      return;
    }
    child.removeAttribute("inert");
    child.removeAttribute("aria-hidden");
  });
}

function nodeSiblingState() {
  if (state.navStack.length < 2) {
    return { hasSiblings: false, index: -1, total: 0, canGoPrevious: false, canGoNext: false };
  }
  const current = state.navStack[state.navStack.length - 1];
  const siblings = siblingNodes();
  const index = siblings.findIndex((node) => sameNodePosition(node, current));
  const total = siblings.length;
  return {
    hasSiblings: total > 1 && index >= 0,
    index,
    total,
    canGoPrevious: index > 0,
    canGoNext: index >= 0 && index < total - 1,
  };
}

function moveNodeSibling(delta) {
  if (state.navStack.length < 2) return;
  const current = state.navStack[state.navStack.length - 1];
  const siblings = siblingNodes();
  const index = siblings.findIndex((node) => sameNodePosition(node, current));
  const nextIndex = index + delta;
  if (index < 0 || nextIndex < 0 || nextIndex >= siblings.length) return;
  state.navStack[state.navStack.length - 1] = siblings[nextIndex];
  renderCurrentNode();
}

function siblingNodes() {
  const parent = state.navStack[state.navStack.length - 2];
  return parent ? nextNodes(parent) : [];
}

function sameNodePosition(left, right) {
  return left.type === right.type && clean(left.label) === clean(right.label);
}

function setStatus(text) {
  els.status.textContent = text;
}

function setLoading(text) {
  els.content.innerHTML = `<div class="empty">${escapeHtml(text)}</div>`;
}

function renderEmpty(message) {
  els.content.innerHTML = `<div class="empty">${escapeHtml(message)}</div>`;
}

function renderError(error) {
  els.content.innerHTML = `<div class="error">${escapeHtml(error.message || String(error))}</div>`;
}
