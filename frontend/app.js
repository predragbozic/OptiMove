import { api } from "./api.js";
import { accessScopeLabel, isAthleteMode, roleLabel } from "./access.js";
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
  handleCoachProfileAction,
  loadCoaches as loadCoachesAction,
  openCoachProfile as openCoachProfileAction,
  submitCoachContactForm as submitCoachContactFormAction,
  submitCoachProfileForm as submitCoachProfileFormAction,
} from "./coach-profile-actions.js";
import { renderCoachesHtml } from "./coach-profiles.js";
import { els } from "./dom.js";
import {
  handleExerciseDetailAction,
  handleExerciseLibraryAction,
  loadExercises,
  submitExerciseTagForm as submitExerciseTagFormAction,
} from "./exercise-actions.js";
import {
  isExerciseItem,
  renderExerciseDetailHtml,
  renderExerciseListHtml,
  renderOrganizationSummaryHtml,
} from "./exercise-view.js";
import {
  renderExerciseLibraryHtml,
} from "./exercise-library.js";
import {
  parseImageFallbacks,
} from "./media.js";
import { closeMedia, handleFullscreenChange, handleMediaAction } from "./media-modal.js";
import {
  closeMessagesIfOutside,
  handleMessageAction,
  loadMessages,
  renderMessages,
  submitMessageForm,
} from "./messages.js";
import {
  ensureTemplateScopeIsVisible,
  renderLibraryNav,
  renderRailState,
  templateScopeMeta,
  visibleTemplateScopes,
} from "./navigation.js";
import {
  handleOrganizationAction,
  handleOrganizationFilterInput,
  handleOrganizationSelectChange,
  submitOrganizationAccessForm,
  submitOrganizationForm as submitOrganizationFormAction,
} from "./organization-actions.js";
import {
  normalizeOrganizationSelection,
  renderOrganizationPanelHtml,
} from "./organization-view.js";
import {
  closeNotificationsIfOutside,
  handleNotificationAction,
  loadNotifications,
  renderNotifications,
} from "./notifications.js";
import { renderPlanMoreMenu } from "./plan-actions-view.js";
import {
  btaNodes as buildBtaNodes,
  categoryOrSectionNodes as buildCategoryOrSectionNodes,
  createNode,
  dayGroupNodesFromItems as buildDayGroupNodesFromItems,
  groupNodes as buildGroupNodes,
  nextNodes as buildNextNodes,
  sectionOrExerciseNodes as buildSectionOrExerciseNodes,
  sessionNodes as buildSessionNodes,
  structureNodes as buildStructureNodes,
} from "./program-structure.js";
import {
  applyTemplateAccessScope,
  applyTemplateClientFilters,
  renderProgramInfoModal,
  templateFilterOptionMatches,
  templateFilterSuggestions,
} from "./program-library.js";
import {
  renderTemplateDetailHtml,
  renderTemplateFiltersViewHtml,
  renderTemplateLibraryPageHtml,
  renderTemplateLibraryResultsOnlyHtml,
  renderTemplatePreviewModalViewHtml,
  renderTemplateToolbarHtml,
} from "./program-library-view.js";
import {
  handleTemplateLibraryAction,
  submitProgramTagForm as submitProgramTagFormAction,
  submitTemplateMetadataForm as submitTemplateMetadataFormAction,
  submitTemplateReviewForm as submitTemplateReviewFormAction,
} from "./program-library-actions.js";
import {
  loadTemplates as loadTemplatesData,
  loadTemplateOptionsInBackground as loadTemplateOptionsInBackgroundData,
} from "./program-library-data.js";
import {
  renderNodeDetailHtml,
  renderNodeButtonHtml,
  renderProgramDayCardHtml,
  renderProgramRootHtml,
  renderProgramToolbarHtml,
  renderWeeklyRootHtml,
  renderWeekCalendarDayHtml,
} from "./program-view.js";
import {
  emptyTemplateFilters,
  emptyTemplatePreview,
  state,
} from "./state.js";
import {
  clean,
  countLabel,
  debounce,
  escapeAttr,
  escapeHtml,
  formatDate,
  localDateIso,
  monthStartIso,
  weekMondayIso,
} from "./utils.js";
import {
  buildWeeklyCalendarMonth,
  clampMonth,
  defaultWeekIndex,
  flattenDayGroups,
  groupItems,
  selectedWeeklyDay,
  weeklyCalendarDayMap,
  weeklyCalendarMonthRange,
} from "./weekly-plan.js";
import { handleWeeklyAction } from "./weekly-actions.js";
import { renderUserControls } from "./user-controls.js";
import { startRealtimeInbox, stopRealtimeInbox } from "./realtime.js";

let inboxPollId = null;

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
  renderNotifications();
  renderMessages();
  if (state.currentUser.role === "athlete" && !document.body.classList.contains("athlete-mode")) {
    window.location.replace("/athlete");
    return;
  }
  ensureBackGuard();
  void loadNotifications({ silent: true });
  void loadMessages({ silent: true });
  startRealtimeInbox();
  startInboxPolling();
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
        state.programLibrarySection = "programs";
        state.templateScope = button.dataset.templateScope;
        ensureTemplateScopeIsVisible();
      }
      if (button.dataset.programLibrarySection) state.programLibrarySection = button.dataset.programLibrarySection;
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
  document.addEventListener("submit", handleGlobalSubmit);
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

  const organizationAccessForm = event.target.closest("[data-organization-access-form]");
  if (organizationAccessForm) {
    event.preventDefault();
    await submitOrganizationAccessForm(organizationAccessForm, { refreshOrganizationData, renderOrganizationPanel });
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
      renderNotifications();
      renderMessages();
      void loadNotifications({ silent: true });
      void loadMessages({ silent: true });
      startInboxPolling();
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
  const messageSearch = event.target.closest("[data-message-search]");
  if (messageSearch) {
    const cursor = messageSearch.selectionStart;
    state.messages.search = messageSearch.value;
    renderMessages();
    requestAnimationFrame(() => {
      const nextInput = els.messagePanel?.querySelector("[data-message-search]");
      if (!nextInput) return;
      nextInput.focus();
      if (Number.isInteger(cursor)) nextInput.setSelectionRange(cursor, cursor);
    });
    return;
  }

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
    if (templateFilter.dataset.templateFilter === "scope") state.templateScope = templateFilter.value || "my_programs";
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

async function signOut() {
  try {
    await api("/api/auth/logout", { method: "POST" });
  } finally {
    stopInboxPolling();
    state.currentUser = null;
    window.location.replace("/");
  }
}

function startInboxPolling() {
  if (inboxPollId || !state.currentUser) return;
  inboxPollId = window.setInterval(() => {
    if (!state.currentUser || document.hidden) return;
    void loadNotifications({ silent: true });
  }, 25000);
}

function stopInboxPolling() {
  if (inboxPollId) {
    window.clearInterval(inboxPollId);
    inboxPollId = null;
  }
  stopRealtimeInbox();
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

async function handleGlobalClick(event) {
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
  if (!action) {
    closeNotificationsIfOutside(event.target);
    closeMessagesIfOutside(event.target);
    return;
  }
  if (await handleNotificationAction(action, { openProgramRequests })) {
    renderMessages();
    return;
  }
  if (await handleMessageAction(action)) {
    renderNotifications();
    return;
  }
  if (action.dataset.action === "close-media") closeMedia();
  if (action.dataset.action === "home") goHome();
  closeNotificationsIfOutside(event.target);
  closeMessagesIfOutside(event.target);
}

async function handleGlobalSubmit(event) {
  const messageForm = event.target.closest("[data-message-form]");
  if (!messageForm) return;
  event.preventDefault();
  await submitMessageForm(messageForm);
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
  if (state.activeTab === "templates" && state.currentUser?.role !== "athlete") {
    await refreshOrganizationData({ silent: true });
  }
  return loadTemplatesData(programLibraryDataContext(), options);
}

async function openProgramRequests() {
  state.activeTab = "templates";
  state.programLibrarySection = "requests";
  state.templatePreview = emptyTemplatePreview();
  state.selectedTemplateId = null;
  state.navStack = [];
  state.athletesExpanded = false;
  renderTabs();
  renderLibraryNav();
  await loadTemplates();
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
  if (type === "program-library-requests") {
    state.activeTab = "templates";
    state.programLibrarySection = "requests";
    state.templatePreview = emptyTemplatePreview();
    await loadTemplates();
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
  if (handleExerciseDetailAction(action, {
    getItemById,
    moveExerciseDetail,
    pushAppHistory,
    renderCurrentNode,
    renderExerciseDetail,
  })) return;
  if (await handleExerciseLibraryAction(action, { renderExercises, setLoading })) return;
  if (handleCoachProfileAction(action, { renderCoachContext, renderCurrentNode })) return;
  if (handleTemplateLibraryAction(action, { loadTemplates, renderCoachContext, renderTemplateLibrary })) return;
  if (await handleOrganizationAction(action, {
    loadAthletes,
    refreshOrganizationData,
    renderAfterOrganizationAccessChange,
    renderOrganizationPanel,
  })) return;
  if (handleWeeklyAction(action, { moveWeek, renderWeeklyRoot })) return;
  handleMediaAction(action);
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
  els.content.innerHTML = renderOrganizationPanelHtml({
    currentUser: state.currentUser,
    data,
    error: state.organization.error,
    role,
    scope,
  });
}

async function refreshOrganizationData({ silent = false } = {}) {
  try {
    state.organization.data = await api("/api/organization");
    state.organization.error = "";
  } catch (error) {
    state.organization.error = error.message || "Could not load organization.";
    if (!silent) throw error;
  }
}

async function renderAfterOrganizationAccessChange({ refresh = false } = {}) {
  if (refresh) await refreshOrganizationData({ silent: true });
  if (state.activeTab === "organization") return renderOrganizationPanel({ refresh: false });
  if (state.activeTab === "templates") return renderTemplateLibrary(state.lastTemplates || []);
  if (state.activeTab === "athlete-library") return renderTemplateLibrary(state.lastTemplates || []);
  return renderCurrentNode();
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
  state.templateScope = state.templateScope === "workspace" || state.templateScope === "all" ? "my_programs" : state.templateScope;
  await loadTemplates();
}

function renderWeeklyRoot(data) {
  renderLibraryNav();
  const weeks = data?.weeks || [];
  if (!weeks.length) return renderEmpty("This athlete has no weekly plans.");
  const activeWeek = weeks[Math.max(0, Math.min(weeks.length - 1, state.selectedWeekIndex))] || weeks[0];
  const weekSelectorMarkup = state.weekSelectorOpen ? renderWeekCalendarPicker(weeks, activeWeek) : "";

  els.content.innerHTML = renderWeeklyRootHtml({
    activeWeek,
    copyPlanModal: renderCopyPlanModal(state),
    makeNode,
    renderPlanMoreMenu,
    selectedWeekIndex: state.selectedWeekIndex,
    weekSelectorMarkup,
    weeks,
  });
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
  return renderWeekCalendarDayHtml(day, selectedDate);
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

function renderProgramToolbar(programs) {
  els.toolbar.querySelector(".program-toolbar")?.remove();
  els.toolbar.insertAdjacentHTML("beforeend", renderProgramToolbarHtml(programs, state.selectedProgramId, renderPlanMoreMenu));
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

  els.content.innerHTML = renderProgramRootHtml({
    copyPlanModal: renderCopyPlanModal(state),
    data,
    groups,
    isMicrocycle,
    program,
    renderNodeButton,
    renderPlanMoreMenu,
    renderProgramDayCard,
  });
}
function programDayGroupNodes(dayGroups) {
  return (dayGroups || []).map((group, index) => makeNode("dayGroup", group.dayNote || `Block ${index + 1}`, groupItems(group), {
    subtitle: countLabel(groupItems(group)),
    blockIndex: index + 1,
  }));
}

function renderProgramDayCard(node) {
  return renderProgramDayCardHtml(node, makeNode);
}

function renderNode(node) {
  const next = nextNodes(node);
  const crumbs = state.navStack.map((entry) => entry.label);
  const siblingState = nodeSiblingState();
  els.content.innerHTML = renderNodeDetailHtml({
    crumbs,
    next,
    node,
    renderNodeButton,
    siblingState,
    terminalHtml: next.length ? "" : renderTerminalNode(node),
  });
}
function renderTerminalNode(node) {
  if (!(node.items || []).some(isExerciseItem)) return renderOrganizationSummary(node);
  return renderExerciseList(node.items);
}

function nextNodes(node) {
  return buildNextNodes(node, makeNode);
}

function btaNodes(items) {
  return buildBtaNodes(items, makeNode);
}

function sessionNodes(items) {
  return buildSessionNodes(items, makeNode);
}

function structureNodes(items) {
  return buildStructureNodes(items, makeNode);
}

function categoryOrSectionNodes(items) {
  return buildCategoryOrSectionNodes(items, makeNode);
}

function sectionOrExerciseNodes(items) {
  return buildSectionOrExerciseNodes(items, makeNode);
}

function dayGroupNodesFromItems(items) {
  return buildDayGroupNodesFromItems(items, makeNode);
}

function groupNodes(items, type) {
  return buildGroupNodes(items, type, makeNode);
}

function renderNodeButton(node) {
  return renderNodeButtonHtml(node);
}

function renderTemplateToolbar(templates) {
  const scope = templateScopeMeta();
  els.context.textContent = "Program library";
  els.title.textContent = scope.label;
  els.toolbar.innerHTML = renderTemplateToolbarHtml(templates, state.selectedTemplateId);
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

  els.content.innerHTML = renderTemplateDetailHtml({
    groups,
    isMicrocycle,
    renderNodeButton,
    renderProgramDayCard,
    selected,
    state,
  });
}
function renderTemplateLibrary(templates) {
  const scope = templateScopeMeta();
  const visibleTemplates = visibleTemplateLibraryRows(templates);
  els.context.textContent = "Program library";
  els.title.textContent = scope.label;
  els.toolbar.innerHTML = "";

  els.content.innerHTML = renderTemplateLibraryPageHtml({
    coaches: state.coaches,
    currentUser: state.currentUser,
    programInfo: state.programInfo,
    selectedTemplateId: state.selectedTemplateId,
    state,
    templates: visibleTemplates,
    templateFiltersHtml: renderTemplateFilters(),
    templatePreviewHtml: renderTemplatePreviewModal(),
  });
}

function renderTemplateLibraryResults() {
  const visibleTemplates = visibleTemplateLibraryRows(state.lastTemplates || []);
  const count = document.querySelector("[data-template-count]");
  if (count) count.textContent = `${visibleTemplates.length} ${visibleTemplates.length === 1 ? "program" : "programs"}`;
  document.querySelector(".program-preview-overlay")?.remove();
  const target = document.querySelector("[data-template-results]");
  if (target) target.innerHTML = renderTemplateLibraryResultsOnlyHtml(visibleTemplates, state.selectedTemplateId, state.currentUser);
}

function visibleTemplateLibraryRows(templates) {
  const filtered = applyTemplateClientFilters(templates, state.templateFilters);
  return applyTemplateAccessScope(filtered, state.templateScope, state.currentUser);
}

function canUseProgramAdminFilters() {
  return ["platform", "club"].includes(String(state.currentUser?.accessScope || "").toLowerCase());
}

function renderTemplateFilters() {
  const filters = state.templateFilters;
  const options = state.templateOptions || {};
  return renderTemplateFiltersViewHtml({
    activeScope: state.templateScope,
    activeSection: state.programLibrarySection || "programs",
    filters,
    lastTemplates: state.lastTemplates,
    options,
    requestCount: (state.organization?.data?.accessRequests || []).filter((row) => row.status === "requested").length,
    scopes: visibleTemplateScopes(),
    scopeLabel: (scope) => templateScopeMeta(scope).label,
    showAdminFilters: canUseProgramAdminFilters(),
    showRequests: !isAthleteMode(),
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

  return renderTemplatePreviewModalViewHtml({
    currentUserRole: state.currentUser?.accessScope || state.currentUser?.role,
    detail,
    groups,
    isMicrocycle,
    preview: state.templatePreview,
    athletes: state.athletes,
    programTagEditor: state.programTagEditor,
    renderNodeButton,
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
  return renderExerciseListHtml(items, itemIds, layout);
}

function renderOrganizationSummary(node) {
  return renderOrganizationSummaryHtml(node);
}

function renderExerciseDetail(item, itemId = state.exerciseDetail.currentId) {
  if (itemId) state.exerciseDetail.currentId = itemId;
  const ids = state.exerciseDetail.ids || [];
  const markup = renderExerciseDetailHtml({ item, itemId: state.exerciseDetail.currentId, ids, getItemById });
  els.content.querySelector(".exercise-detail-overlay")?.remove();
  els.content.insertAdjacentHTML("beforeend", markup);
  setExerciseOverlayBackgroundInert(true);
}

function makeNode(type, label, items, options = {}) {
  return createNode(type, label, items, options);
}

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
