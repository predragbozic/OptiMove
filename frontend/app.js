import { api } from "./api.js";
import { openExerciseClassification } from "./exercise-classification.js";
import { accessScopeLabel, currentUserWorkspaceContextParts, isAthleteMode, roleLabel } from "./access.js";
import {
  renderInviteAccept as renderInviteAcceptAction,
  renderLogin as renderLoginAction,
  submitInviteAccept as submitInviteAcceptAction,
  submitInviteLogin as submitInviteLoginAction,
} from "./auth-actions.js";
import {
  renderJoinPage as renderJoinPageAction,
  submitJoinApply as submitJoinApplyAction,
  submitJoinLogin as submitJoinLoginAction,
} from "./join-actions.js";
import {
  renderVerifyEmailPage as renderVerifyEmailPageAction,
  submitResendVerification as submitResendVerificationAction,
} from "./email-verification-actions.js";
import {
  renderForgotPassword as renderForgotPasswordAction,
  renderResetPassword as renderResetPasswordAction,
  submitForgotPassword as submitForgotPasswordAction,
  submitResetPassword as submitResetPasswordAction,
} from "./password-reset-actions.js";
import {
  renderConfirmEmailChange as renderConfirmEmailChangeAction,
  submitConfirmEmailChange as submitConfirmEmailChangeAction,
} from "./email-change-actions.js";
import { renderCheckInContent, renderCheckInPage as renderCheckInPageAction, submitCheckInLogin as submitCheckInLoginAction } from "./check-in-actions.js";
import { handleDataSourcesAction, submitDataSourcesForm } from "./data-sources-actions.js";
import { enterDataSourcesSection, loadDataSources } from "./data-sources-data.js";
import { handleStorageAdminAction, submitStorageAdminForm } from "./media-storage-admin-actions.js";
import { enterStorageAdminSection, loadStorageAdmin, storageAdminContext, storageAdminNeedsLoad } from "./media-storage-admin-data.js";
import { handleSourceConnectionsAction, handleSourceConnectionsBeforeUnload, submitSourceConnectionsForm } from "./source-connections-actions.js";
import { handleVariablesAction, handleVariablesInput, submitVariablesForm } from "./metric-variables-actions.js";
import { closeIconPicker, handleIconPickerInput, trapIconPickerTab } from "./icon-picker.js";
import { enterIconGallery, handleIconGalleryAction, handleIconGalleryInput } from "./icon-gallery.js";
import { handleSourceFieldsAction, handleSourceFieldsInput, submitSourceFieldsForm } from "./source-fields-actions.js";
import { enterSourceConnectionsSection, loadSourceConnections, sourceConnectionsNeedLoad } from "./source-connections-data.js";
import { endTestsCalendarDrag, extendTestsCalendarDrag, handleTestsAction, handleTestsScheduleAthleteSearchInput, handleTestsScheduleFormField, handleTestsSliderInput, isTestsCalendarDragging, openAssignment as openTestAssignmentForm, startTestsCalendarDrag, submitTestsForm } from "./tests-actions.js";
import { loadPendingCount as loadTestsPendingCount, loadTests, reportDeviceTimezone } from "./tests-data.js";
import { renderTests, renderTestsBadge } from "./tests-view.js";
import {
  renderAthleteHeaderToolbarHtml,
  renderAthleteListHtml,
  renderAthleteSettingsHtml,
} from "./athlete-view.js";
import { renderCoachAccountHtml } from "./coach-account.js";
import {
  renderAthleteProgramCardsRailHtml,
  renderAthleteProgramsPanelHtml,
} from "./athlete-programs-view.js";
import {
  handleBuilderDraftAction,
  handleBuilderItemAction,
  handleBuilderPlanAction,
  handleBuilderWorkspaceAction,
  builderLibraryDropBlocked,
  dropBuilderLibraryExercise,
  moveBuilderItemTo,
  submitBuilderForm as submitBuilderFormAction,
} from "./builder-actions.js";
import { ensureBuilderExercises, loadBuilderDrafts, loadBuilderExercises, loadBuilderNodePresets, refreshBuilderDraft } from "./builder-data.js";
import { renderCopyPlanModal } from "./builder-modals.js";
import { renderBuilder, renderBuilderAddFeedback, renderBuilderExerciseViewChange, renderBuilderFiltersChange, renderBuilderSectionItems, renderBuilderDiscardProgress, renderBuilderBatchSwitchProgress, renderBuilderDraftOpenProgress } from "./builder-view.js";
import { clearBuilderItemEdits, rememberBuilderItemEdit } from "./builder-item-edits.js";
import {
  handleCoachProfileAction,
  loadCoaches as loadCoachesAction,
  openCoachProfile as openCoachProfileAction,
  submitCoachContactForm as submitCoachContactFormAction,
  submitCoachProfileForm as submitCoachProfileFormAction,
} from "./coach-profile-actions.js";
import { renderCoachesHtml } from "./coach-profiles.js";
import { coachHomePickerRows, renderCoachHomeHtml, renderCoachHomeAthleteRows } from "./coach-home.js";
import { bindCoachHomeCarousels, captureCoachHomeView, handleCoachHomeAction, renderCoachHomeSection, restoreCoachHomeView } from "./coach-home-actions.js";
import { athleteMatches, clearAthleteFilters, handleAthleteFilter } from "./athlete-list-tools.js";
import { invalidateCoachHomeCache, loadCoachHome as loadCoachHomeData, loadCoachHomeExtras, loadMoreCoachHomeExercises, resetCoachHomeForWorkspaceChange } from "./coach-home-data.js";
import { renderAthleteHomeHtml } from "./athlete-home.js";
import { invalidateAthleteHomeCache, loadAthleteHome as loadAthleteHomeData } from "./athlete-home-data.js";
import { calendarToggled as importsCalendarToggled, clearPendingIdentityLoads } from "./gpexe-import-data.js";
import { activityRosterDisclosureToggled, closeActivityRosterOverlay } from "./activity-roster-actions.js";
import { bindTrainingLoadAnalysisLayoutInteractions, closeTrainingLoadAnalysisOverlay, confirmLeaveTrainingLoad, discardTrainingLoadLeaveDrafts, handleTrainingLoadAction, handleTrainingLoadBeforeUnload, loadTrainingLoadSectionData, setTrainingLoadAnalysisEditorText, openExternalAssignmentFromNotification, resetTrainingLoadForWorkspaceChange, setTrainingLoadAnalysisSearch, setTrainingLoadSection, syncDataAnalysisSharedWeek } from "./training-load-actions.js";
import { loadPlannedRpeSetting, loadTrainingLoadAthleteToday, loadTrainingLoadWeekly } from "./training-load-data.js";
import { renderTrainingLoadCoachHtml } from "./training-load-view.js";
import "./training-load-analysis-echarts.js";
import { els } from "./dom.js";
import {
  handleExerciseDetailAction,
  handleExerciseLibraryAction,
  invalidateExercisesCache,
  resetExercisesForWorkspaceChange,
  loadExercises,
  reloadExerciseLibrarySurface,
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
  syncExerciseFilterSearch,
} from "./exercise-library.js";
import { closeExerciseViewMenus, replaceExerciseThumbWithInitials } from "./exercise-view-modes.js";
import { startBuilderItemDrag } from "./builder-item-drag.js";
import { dropBuilderLibraryDrag, endBuilderLibraryDrag, endStaleBuilderLibraryDrag, leaveBuilderLibraryDrag, overBuilderLibraryDrag, startBuilderLibraryDrag } from "./builder-library-drag.js";
import { dropVariableDrag, endVariableDrag, leaveVariableDrag, overVariableDrag, startVariableDrag } from "./data-config-drag.js";
import { dropBlocked, dropVariableOnCategory } from "./metric-classification-drag.js";
import { AUTOGROW_SELECTOR, autosizeTextarea } from "./textarea-autosize.js";
import { toggleClampedTitle } from "./title-clamp.js";
import { openExerciseCollections } from "./exercise-collections.js";
import {
  handleExerciseEditorAction,
  handleExerciseEditorChange,
  handleExerciseEditorInput,
  handleExerciseMediaBeforeUnload,
  openExerciseEditor,
  renderExerciseEditorHtml,
} from "./exercise-editor.js";
import {
  parseImageFallbacks,
} from "./media.js";
import { closeMedia, handleFullscreenChange, handleMediaAction } from "./media-modal.js";
import { startAppUpdateWatch } from "./app-update.js";
import { installThumbnailResolver, retryExpiredMediaImage } from "./media-playback.js";
import {
  closeMessagesIfOutside,
  handleMessageAction,
  handleMessagesBack,
  handleMessagesPanelInput,
  loadMessages,
  openMessageConversation,
  renderMessages,
  resetMessagesState,
  submitMessageForm,
} from "./messages.js";
import {
  ensureTemplateScopeIsVisible,
  renderLibraryNav,
  renderMobileNavState,
  renderRailState,
  templateScopeMeta,
  visibleTemplateScopes,
} from "./navigation.js";
import {
  closeAthleteAccountModal,
  closeAthleteInviteModal,
  closeManageAccountModal,
  handleOrganizationAction,
  handleOrganizationFilterInput,
  handleOrganizationSelectChange,
  syncGrantBlockButton,
  syncOrganizationAccessGroupMaster,
  submitAthleteAccountEmailChangeForm,
  submitOrganizationAccessForm,
  submitOrganizationForm as submitOrganizationFormAction,
} from "./organization-actions.js";
import {
  normalizeOrganizationSelection,
  renderOrganizationPanelHtml,
} from "./organization-view.js";
import {
  handleTaxonomyAction,
  loadTaxonomyData,
  submitTaxonomyForm,
} from "./taxonomy-actions.js";
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
  captureMetadataFormDraft,
  capturePreviewScroll,
  handleTemplateMetadataKeydown,
  restoreMetadataFormDraft,
  restorePreviewScroll,
  scheduleProgramCoverPreview,
  showProgramCoverPreviewError,
  syncTemplateMetadataForm,
} from "./program-preview.js";
import {
  handleTemplateLibraryAction,
  openTemplatePreviewFromCoachProgram,
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
  renderProgramNodeOverlayHtml,
  renderProgramRootHtml,
  renderProgramToolbarHtml,
  renderWeeklyRootHtml,
  renderWeekCalendarDayHtml,
} from "./program-view.js";
import {
  emptyBuilderState,
  emptyTemplateFilters,
  emptyTemplatePreview,
  state,
} from "./state.js";
import {
  addDaysIso,
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
  flattenDayGroups,
  groupItems,
  selectedWeeklyDay,
  weekIndexForDate,
  weeklyCalendarDayMap,
  weeklyCalendarMonthRange,
} from "./weekly-plan.js";
import { handleWeeklyAction } from "./weekly-actions.js";
import { loadWeekly as loadWeeklyData } from "./weekly-data.js";
import { invalidateProgramsCache, loadPrograms as loadProgramsData } from "./programs-data.js";
import { renderUserControls } from "./user-controls.js";
import { startRealtimeInbox, stopRealtimeInbox } from "./realtime.js";
import { closeWorkspaceSwitcherIfOutside, handleWorkspaceAction, renderWorkspaceSwitcher } from "./workspace-actions.js";
import { buildContextKey, clearAllViewCache, dedupeRequest, loadCachedView, setCacheData, setCacheError } from "./view-cache.js";

let inboxPollId = null;
let coachHomeRows = [];
let coachHomePicker = { mode: "", query: "" };
let workspaceRosterGeneration = 0;

init();

async function init() {
  bindEvents();
  state.railExpanded = window.matchMedia("(min-width: 900px)").matches;
  state.exerciseLayout = window.matchMedia("(max-width: 760px)").matches ? "vertical" : "horizontal";
  renderRailState();
  // A newer deploy than the one this page runs: a notice at the top with
  // Refresh and Later (the app installed on an iPhone keeps an old version
  // until iOS restarts it). Never refreshes by itself; an unsaved Training
  // Load draft (a dashboard layout, Advanced settings) is asked about first.
  startAppUpdateWatch({ mayLeave: () => confirmLeaveTrainingLoad(null, { discard: false }) });
  if (window.location.pathname === "/invite") {
    await renderInviteAcceptAction({ renderUserControls, setStatus });
    return;
  }
  if (window.location.pathname === "/join") {
    await renderJoinPageAction({ renderUserControls, setStatus });
    return;
  }
  if (window.location.pathname === "/verify-email") {
    await renderVerifyEmailPageAction({ renderUserControls, setStatus });
    return;
  }
  if (window.location.pathname === "/forgot-password") {
    await renderForgotPasswordAction({ renderUserControls, setStatus });
    return;
  }
  if (window.location.pathname === "/reset-password") {
    await renderResetPasswordAction({ renderUserControls, setStatus });
    return;
  }
  if (window.location.pathname === "/confirm-email-change") {
    await renderConfirmEmailChangeAction({ renderUserControls, setStatus });
    return;
  }
  if (window.location.pathname.startsWith("/tests/check-in/")) {
    await renderCheckInPageAction({ renderUserControls, setStatus });
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
  if (state.currentUser.activeWorkspace?.type === "athlete" && !document.body.classList.contains("athlete-mode")) {
    window.location.replace("/athlete");
    return;
  }
  applyDefaultInitialTab();
  ensureBackGuard();
  void loadNotifications({ silent: true });
  void loadMessages({ silent: true });
  // Phase 4 correction: reported at authenticated app bootstrap, not only
  // when the athlete happens to manually open the Tests tab - the nav
  // badge fetch right below already calls GET /athlete/today, which can
  // itself trigger materialization server-side, so the timezone report
  // must complete first (see tests-data.js's reportDeviceTimezone for the
  // full race-condition reasoning). No-ops instantly for a coach session.
  await reportDeviceTimezone();
  void loadTestsPendingCount().then(renderTestsBadge);
  startRealtimeInbox((connected) => {
    state.realtimeOffline = !connected;
    renderConnectionIndicator();
  }, refreshExerciseLibraryAccess);
  startInboxPolling();
  await loadAthletes();
}

// Called both from init()'s bootstrap path (a page load/reload with an
// already-active session) and from the login-form submit handler in
// handleGlobalSubmit (a fresh sign-in while already on /athlete, where
// document.body already carries athlete-mode and so never takes the
// window.location.replace("/athlete") branch that would otherwise force a
// full reload through init() again) - both are real ways an athlete session
// can begin, and each needs this decided exactly once, the same way.
// state.activeTab is always fresh off state.js's own default ("weekly") the
// first time either path runs it - it is never restored from a previous
// session - so this only ever changes it once per sign-in.
function applyDefaultInitialTab() {
  if (isAthleteMode()) {
    // Athlete Home is the athlete shell's own landing screen - Weekly plan
    // remains a separate, explicitly-chosen tab (see the sidebar's own
    // data-athlete-tab="calendar" button), so a sign-in must never land an
    // athlete session on "weekly" the way it used to before this tab
    // existed.
    if (state.activeTab === "coach-home" || state.activeTab === "weekly") state.activeTab = "athlete-home";
  } else if (state.activeTab === "weekly" && !state.selectedAthleteId) {
    state.activeTab = "coach-home";
  }
}

// A menu library item (Coaches, Builder, Program Library and its sections,
// Exercise Library, Tests, Training load, Settings, Account), from the menu
// itself or from a Home card that opens the same place. Resolves once the
// tab has loaded; false when the coach chose to stay (an unsaved Training
// Load draft).
function openLibraryTab({ libraryTab, templateScope, programLibrarySection, organizationSection } = {}) {
  if (!confirmLeaveTrainingLoad(libraryTab)) return Promise.resolve(false);
  if (state.activeTab !== libraryTab) pushAppHistory();
  state.activeTab = libraryTab;
  if (templateScope) {
    state.programLibrarySection = "programs";
    state.templateScope = templateScope;
    if (state.templateScope !== "my_programs") state.templateFilters.lifecycle = "all";
    ensureTemplateScopeIsVisible();
  }
  if (programLibrarySection) state.programLibrarySection = programLibrarySection;
  if (organizationSection) {
    state.organization.section = organizationSection;
    state.organization.addFormOpen = false;
  }
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
  return Promise.resolve(loadActiveTab()).then(() => true);
}

function bindEvents() {
  els.athleteSearch?.addEventListener("input", renderAthleteList);
  els.athletesToggle?.addEventListener("click", toggleAthletesList);
  els.railToggle?.addEventListener("click", toggleRail);
  els.mobileNavToggle?.addEventListener("click", toggleMobileNav);
  els.mobileNavBackdrop?.addEventListener("click", closeMobileNav);
  els.signOut?.addEventListener("click", signOut);
  els.calendarToggle?.addEventListener("click", openWeeklyCalendarFromRail);
  els.tabs.forEach((tab) => {
    tab.addEventListener("click", (event) => {
      // Dashboards UX H2: an unsaved Dashboards layout asks before leaving
      // Training Load. Declined: stop here - and stop the same click from
      // reaching handleGlobalClick's own [data-tab] branch as well.
      if (!confirmLeaveTrainingLoad(tab.dataset.tab)) {
        event.stopPropagation();
        return;
      }
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
    button.addEventListener("click", () => { void openLibraryTab(button.dataset); });
  });
  els.athleteTabs.forEach((button) => {
    button.addEventListener("click", () => {
      const targetTab = button.dataset.athleteTab || "weekly";
      if (!confirmLeaveTrainingLoad(targetTab === "calendar" ? "weekly" : targetTab)) return;
      if (state.activeTab !== targetTab) pushAppHistory();
      state.selectedProgramId = null;
      state.selectedTemplateId = null;
      state.navStack = [];
      state.weekSelectorOpen = false;
      // hotfix/athlete-mobile-navigation: was targetTab === "calendar" -
      // same bug as athlete-home-quick-tab, see athlete-mobile-navigation.test.mjs.
      state.openWeekCalendarOnLoad = false;
      state.activeTab = targetTab === "calendar" ? "weekly" : targetTab;
      collapseRailAfterNav();
      renderTabs();
      renderLibraryNav();
      loadActiveTab();
    });
  });

  els.content.addEventListener("click", handleContentClick);
  // Builder section editor on phones: a name cut to two lines unfolds on tap.
  els.content.addEventListener("click", (event) => { toggleClampedTitle(event.target); });
  // A click anywhere on the page folds an open exercise card "⋯" menu. iOS
  // Safari sends no click to the document for a tap on a non-interactive
  // area, so a press outside every menu folds them too (never one inside a
  // menu: folding it on press would hide the item before its click lands);
  // Escape folds them all (the Escape handler below).
  document.addEventListener("click", (event) => closeExerciseViewMenus(event.target, els.content));
  document.addEventListener("pointerdown", (event) => {
    if (!event.target?.closest?.(".exercise-view-menu")) closeExerciseViewMenus(event.target, els.content);
  });
  els.toolbar.addEventListener("click", (event) => {
    const action = event.target.closest("[data-action]");
    if (!action?.dataset.action?.startsWith("builder-")) return;
    void handleBuilderAction(action).catch(renderBuilderError);
  });
  els.content.addEventListener("submit", handleContentSubmit);
  els.content.addEventListener("input", handleContentInput);
  els.content.addEventListener("keydown", handleBuilderSearchKeydown);
  els.content.addEventListener("keydown", handleTemplateMetadataKeydown);
  // Text fields that grow with their text (textarea-autosize.js), wherever
  // they are rendered (the content area and the Builder's modals).
  document.addEventListener("input", (event) => {
    if (event.target.matches?.(AUTOGROW_SELECTOR)) autosizeTextarea(event.target);
  });
  els.content.addEventListener("change", handleContentChange);
  // Data configuration -> Variables: a select or a level box also reports its
  // choice through "change", for a browser that fires no "input" for it.
  els.content.addEventListener("change", (event) => handleVariablesInput(event.target, { render: renderActiveTrainingLoadSurface }));
  // Data configuration -> Source fields: the operator select reports through "change" too.
  els.content.addEventListener("change", (event) => handleSourceFieldsInput(event.target));
  // Imports (phase 4b): the sessions calendar is a <details>; the browser
  // opens and folds it itself, and its own "toggle" event (it does not
  // bubble, hence the capture) keeps that state for the next repaint. A
  // click handler would race the browser's toggle.
  els.content.addEventListener("toggle", (event) => {
    const panel = event.target;
    if (panel?.dataset?.rosterDisclosure) {
      activityRosterDisclosureToggled(panel);
      return;
    }
    if (!panel?.classList?.contains("imports-calendar")) return;
    // Inserting an open <details> fires "toggle" too: only a change from
    // what was rendered is the coach's own choice.
    if (panel.open === (panel.dataset.renderedOpen === "1")) return;
    importsCalendarToggled(panel.open);
  }, true);
  // hotfix/mobile-messages-test-regression: #messagePanel lives in the
  // topbar's <header>, not inside #content, so the search input's `input`
  // events can never reach the listener above - a separate, equally
  // one-time delegated listener directly on the persistent #messagePanel
  // node. Attached once here (bindEvents runs once at startup), never
  // per-render - see handleMessagesPanelInput's own comment in messages.js.
  els.messagePanel?.addEventListener("input", handleMessagesPanelInput);
  els.content.addEventListener("focusin", handleContentFocusIn);
  els.content.addEventListener("touchstart", handleSwipeStart, { passive: true });
  els.content.addEventListener("touchend", handleSwipeEnd, { passive: true });
  // Specific-dates calendar click-and-drag (Phase 2.5): Pointer Events, not
  // separate mouse/touch listeners - one code path drives mouse AND touch
  // drags identically (see handleContentPointerMove's own comment for why
  // mouseover-style delegation can't work for touch). pointerdown starts a
  // drag on a day cell, pointermove (on `document`, gated to only look up a
  // day cell while a drag is actually in progress) extends it while the
  // pointer is held down, and pointerup/pointercancel - both on `document`,
  // not #content, since the pointer can be released/cancelled anywhere -
  // always end it. See tests-actions.js's start/extend/endTestsCalendarDrag.
  els.content.addEventListener("pointerdown", handleContentPointerDown);
  // Data configuration's Categories screen on a computer: drag a variable onto
  // a category (PR-2). Each handler leaves alone a drag that is not its own.
  els.content.addEventListener("dragstart", (event) => { startVariableDrag(event, { isBlocked: dropBlocked }); });
  els.content.addEventListener("dragover", overVariableDrag);
  els.content.addEventListener("dragleave", leaveVariableDrag);
  els.content.addEventListener("drop", (event) => {
    dropVariableDrag(event, {
      onDrop: (variableId, categoryId) => { void dropVariableOnCategory(variableId, categoryId, { render: renderActiveTrainingLoadSurface }); },
    });
  });
  els.content.addEventListener("dragend", endVariableDrag);
  // Builder section on a computer: drag a library exercise onto the Added list.
  els.content.addEventListener("dragstart", (event) => { startBuilderLibraryDrag(event, { isBlocked: builderLibraryDropBlocked }); });
  els.content.addEventListener("dragover", overBuilderLibraryDrag);
  els.content.addEventListener("dragleave", leaveBuilderLibraryDrag);
  els.content.addEventListener("drop", (event) => {
    dropBuilderLibraryDrag(event, {
      onDrop: (exerciseId, index) => {
        void dropBuilderLibraryExercise(exerciseId, index, { renderBuilder, renderBuilderSectionItems, renderBuilderAddFeedback, refreshBuilderDraft }).catch(renderBuilderError);
      },
    });
  });
  els.content.addEventListener("dragend", endBuilderLibraryDrag);
  document.addEventListener("pointermove", endStaleBuilderLibraryDrag, { passive: true });
  document.addEventListener("pointermove", handleContentPointerMove);
  document.addEventListener("touchstart", (event) => {
    const normalized = normalizeTouchPointerEvent(event);
    if (normalized) handleContentPointerDown(normalized);
  }, { passive: false, capture: true });
  document.addEventListener("touchmove", (event) => {
    const normalized = normalizeTouchPointerEvent(event);
    if (normalized) handleContentPointerMove(normalized);
  }, { passive: false, capture: true });
  // Item 2 (Daily auto-close): endTestsCalendarDrag() returns true exactly
  // when it just auto-closed the calendar on a genuinely completed range -
  // that's a structural show/hide the lightweight patchTestsCalendarDom()
  // can't express, so only THAT case gets a full renderTests().
  document.addEventListener("pointerup", () => { if (endTestsCalendarDrag()) renderTests(); });
  document.addEventListener("pointercancel", () => { if (endTestsCalendarDrag()) renderTests(); });
  document.addEventListener("touchend", () => { if (endTestsCalendarDrag()) renderTests(); }, { passive: true, capture: true });
  document.addEventListener("touchcancel", () => { if (endTestsCalendarDrag()) renderTests(); }, { passive: true, capture: true });
  document.addEventListener("click", handleGlobalClick);
  document.addEventListener("submit", handleGlobalSubmit);
  document.addEventListener("error", handleImageError, true);
  // R2 pictures (FE-1): whatever renders one, its short-lived address is
  // asked for in a batch on the next frame - see media-playback.js.
  installThumbnailResolver(document.body);
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    // feature/mobile-messages-fullscreen: same priority chain as
    // handleAppBack() above, sharing the exact same function so the two
    // can never drift apart - see handleMessagesBack()'s own comment.
    if (handleMessagesBack()) return;
    // No unsaved-changes state exists inside the Specific Program overlay
    // today (it's a read-only detail view), so Escape can always close it.
    closeSpecificProgramOverlay();
    if (state.athleteExitConfirmOpen) closeAthleteExitConfirm();
    if (state.mobileNavOpen) closeMobileNav();
    closeMedia();
    closeExerciseViewMenus(null, els.content);
    if (state.organizationUserManage.open) closeManageAccountModal(renderOrganizationPanel);
    if (state.organizationInvite.open) closeAthleteInviteModal(renderOrganizationPanel);
    if (state.athleteAccountManage.open) closeAthleteAccountModal(renderOrganizationPanel);
    if (state.workspaceSwitcher.open) {
      state.workspaceSwitcher.open = false;
      renderWorkspaceSwitcher();
    }
    // The shared icon picker closes without choosing; the focus goes back
    // to the button that opened it.
    if (state.iconPicker) {
      const closed = closeIconPicker();
      if (closed?.host === "metric-variables" && state.activeTab === "training-load") renderTrainingLoad();
      if (closed?.returnFocus) document.querySelector(closed.returnFocus)?.focus?.();
      return;
    }
    // Dashboards UX H1: picker/menus, the dashboard dialog and the metric
    // panel close on Escape (topmost first - see closeTrainingLoadAnalysisOverlay).
    if (state.activeTab === "training-load" && state.trainingLoad.section === "analysis" && closeTrainingLoadAnalysisOverlay()) {
      renderTrainingLoad();
    }
    // Phase 5a3b: the roster's reason list / sheet and its inline
    // confirmation close on Escape (never while a save is in flight).
    if (state.activeTab === "training-load" && closeActivityRosterOverlay()) {
      renderTrainingLoad();
    }
  });
  document.addEventListener("fullscreenchange", handleFullscreenChange);
  document.addEventListener("webkitfullscreenchange", handleFullscreenChange);
  // The open icon picker is modal: Tab stays inside it.
  document.addEventListener("keydown", (event) => { trapIconPickerTab(event); });
  window.addEventListener("popstate", handleBrowserBack);
  // Imports (phase 4b): a running batch import or an unconfirmed outcome
  // asks (the browser's own dialog) before a reload or close.
  window.addEventListener("beforeunload", handleTrainingLoadBeforeUnload);
  // Settings -> Source connections (F3c3): a Connect / Test / bind / Unbind
  // in flight, or an unconfirmed outcome, asks the same way.
  window.addEventListener("beforeunload", handleSourceConnectionsBeforeUnload);
  // Exercise media (FE-2): an upload in flight asks the same way.
  window.addEventListener("beforeunload", (event) => handleExerciseMediaBeforeUnload(event, state));
}

async function loadSession() {
  const data = await api("/api/auth/me");
  state.currentUser = data.user || null;
}

async function handleContentSubmit(event) {
  // Dashboards UX H1: the "New dashboard"/"Rename" dialog is a real <form>
  // so Enter submits it - routed to the same training-load-* handler as a
  // click would be, never a page navigation.
  // The form deliberately carries no data-action (handleContentClick would
  // otherwise submit it on any click inside) - the submit action is
  // synthesized here, with querySelector so the handler can read the live
  // inputs off the form.
  const trainingLoadForm = event.target.closest("form[data-tl-analysis-form]");
  if (trainingLoadForm) {
    event.preventDefault();
    await handleTrainingLoadAction({
      dataset: { action: `training-load-analysis-${trainingLoadForm.dataset.tlAnalysisForm}-form-submit` },
      querySelector: (selector) => trainingLoadForm.querySelector(selector),
    }, { renderTrainingLoad: renderActiveTrainingLoadSurface, openWeeklyPlanForAthleteOnDate });
    return;
  }

  // Training Load -> Data configuration -> Variables: create a variable or a
  // new version of one.
  const variablesForm = event.target.closest("[data-metric-variables-form]");
  if (variablesForm) {
    event.preventDefault();
    await submitVariablesForm(variablesForm, { render: renderActiveTrainingLoadSurface });
    return;
  }
  // Training Load -> Data configuration -> Source fields: confirm a unit or a meaning.
  if (event.target.closest("[data-source-fields-form]")) {
    event.preventDefault();
    await submitSourceFieldsForm({ render: renderActiveTrainingLoadSurface });
    return;
  }

  const inviteForm = event.target.closest("#inviteAcceptForm");
  if (inviteForm) {
    event.preventDefault();
    await submitInviteAcceptAction(inviteForm, { loadSession });
    return;
  }

  const inviteLoginForm = event.target.closest("#inviteLoginForm");
  if (inviteLoginForm) {
    event.preventDefault();
    await submitInviteLoginAction(inviteLoginForm, { loadSession });
    return;
  }

  const joinApplyForm = event.target.closest("#joinApplyForm");
  if (joinApplyForm) {
    event.preventDefault();
    await submitJoinApplyAction(joinApplyForm);
    return;
  }

  const joinLoginForm = event.target.closest("#joinLoginForm");
  if (joinLoginForm) {
    event.preventDefault();
    await submitJoinLoginAction(joinLoginForm);
    return;
  }

  const resendVerificationForm = event.target.closest("#resendVerificationForm");
  if (resendVerificationForm) {
    event.preventDefault();
    await submitResendVerificationAction(resendVerificationForm);
    return;
  }

  const forgotPasswordForm = event.target.closest("#forgotPasswordForm");
  if (forgotPasswordForm) {
    event.preventDefault();
    await submitForgotPasswordAction(forgotPasswordForm);
    return;
  }

  const resetPasswordForm = event.target.closest("#resetPasswordForm");
  if (resetPasswordForm) {
    event.preventDefault();
    await submitResetPasswordAction(resetPasswordForm);
    return;
  }

  const organizationForm = event.target.closest("[data-organization-form]");
  if (organizationForm) {
    event.preventDefault();
    await submitOrganizationFormAction(organizationForm, { loadAthletes, renderOrganizationPanel });
    return;
  }

  const dataSourcesForm = event.target.closest("[data-data-sources-form]");
  if (dataSourcesForm) {
    event.preventDefault();
    await submitDataSourcesForm(dataSourcesForm, { render: renderDataSourcesSurface });
    return;
  }

  const sourceConnectionsForm = event.target.closest("[data-source-connections-form]");
  if (sourceConnectionsForm) {
    event.preventDefault();
    await submitSourceConnectionsForm(sourceConnectionsForm, { render: renderDataSourcesSurface });
    return;
  }

  // Settings -> Storage (R2 media, PR 5): the defaults form and a limit form.
  const storageAdminForm = event.target.closest("[data-storage-admin-form]");
  if (storageAdminForm) {
    event.preventDefault();
    await submitStorageAdminForm(storageAdminForm, { render: renderDataSourcesSurface });
    return;
  }

  const organizationAccessForm = event.target.closest("[data-organization-access-form]");
  if (organizationAccessForm) {
    event.preventDefault();
    await submitOrganizationAccessForm(organizationAccessForm, { refreshOrganizationData, renderOrganizationPanel });
    return;
  }

  const athleteAccountEmailChangeForm = event.target.closest("[data-organization-athlete-account-form='email-change-request']");
  if (athleteAccountEmailChangeForm) {
    event.preventDefault();
    await submitAthleteAccountEmailChangeForm(athleteAccountEmailChangeForm, { renderOrganizationPanel });
    return;
  }

  const taxonomyForm = event.target.closest("[data-taxonomy-form]");
  if (taxonomyForm) {
    event.preventDefault();
    await submitTaxonomyForm(taxonomyForm, { renderOrganizationPanel });
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

  const testsForm = event.target.closest("[data-tests-form]");
  if (testsForm) {
    event.preventDefault();
    await submitTestsForm(testsForm, { renderTests: renderActiveTestsSurface });
    return;
  }

  const checkInLoginForm = event.target.closest("#checkInLoginForm");
  if (checkInLoginForm) {
    event.preventDefault();
    await submitCheckInLoginAction(checkInLoginForm);
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
      // Defensive, not load-bearing: signOut() always does a hard
      // window.location.replace("/"), which already resets the entire
      // `state` module (including organization.data) AND view-cache.js's
      // in-memory store via a fresh page load/module re-evaluation before
      // this login form can ever be submitted again. Cleared explicitly
      // anyway so cached data (Organization, and since perf/main-navigation-
      // cache, Coaches/Program Library/Exercise Library/Builder drafts too)
      // can never be attributed to the wrong account, even if that reload
      // behavior changes later.
      state.organization.data = null;
      clearAllViewCache();
      resetMessagesState();
      // /login only returns the compatible base user shape - reload the
      // full /me shape (capabilities/activeWorkspace/availableWorkspaces)
      // before deciding which shell to land in below.
      await loadSession();
      document.body.classList.remove("login-mode");
      renderUserControls();
      renderNotifications();
      renderMessages();
      void loadNotifications({ silent: true });
      void loadMessages({ silent: true });
      startInboxPolling();
      if (state.currentUser.activeWorkspace?.type === "athlete" && !document.body.classList.contains("athlete-mode")) {
        window.location.replace("/athlete");
        return;
      }
      applyDefaultInitialTab();
      ensureBackGuard();
      await loadAthletes();
    } catch (loginError) {
      if (error) error.textContent = loginError.message || "Login failed.";
    } finally {
      if (button) button.disabled = false;
    }
    return;
  }

  // security/verified-email-change: password-only now - see
  // PUT /api/auth/me/credentials's own header comment in
  // backend/src/routes/auth.js for why this can never touch users.email,
  // even via a hand-crafted request.
  const passwordChangeForm = event.target.closest("[data-account-form='password-change']");
  if (passwordChangeForm) {
    event.preventDefault();
    const formData = new FormData(passwordChangeForm);
    const error = passwordChangeForm.querySelector(".builder-error");
    const success = passwordChangeForm.querySelector(".builder-success");
    if (error) error.textContent = "";
    if (success) success.textContent = "";
    const button = passwordChangeForm.querySelector("button[type='submit']");
    const newPassword = String(formData.get("newPassword") || "");
    const confirmNewPassword = String(formData.get("confirmNewPassword") || "");
    const currentPassword = String(formData.get("currentPassword") || "");
    if (newPassword !== confirmNewPassword) {
      if (error) error.textContent = "New passwords do not match.";
      return;
    }
    if (button) button.disabled = true;
    try {
      await api("/api/auth/me/credentials", {
        method: "PUT",
        body: JSON.stringify({ newPassword, currentPassword }),
      });
      passwordChangeForm.reset();
      if (success) success.textContent = "Password changed. Other signed-in devices have been signed out.";
    } catch (submitError) {
      if (error) error.textContent = submitError.message || "Could not change your password.";
    } finally {
      if (button) button.disabled = false;
    }
    return;
  }

  // security/verified-email-change: only ever REQUESTS a verified change -
  // users.email is untouched until the link sent to the new address is
  // confirmed. See POST /api/auth/account/email-change/request.
  const emailChangeRequestForm = event.target.closest("[data-account-form='email-change-request']");
  if (emailChangeRequestForm) {
    event.preventDefault();
    const formData = new FormData(emailChangeRequestForm);
    const error = emailChangeRequestForm.querySelector(".builder-error");
    const success = emailChangeRequestForm.querySelector(".builder-success");
    if (error) error.textContent = "";
    if (success) success.textContent = "";
    const button = emailChangeRequestForm.querySelector("button[type='submit']");
    const newEmail = String(formData.get("newEmail") || "").trim();
    const currentPassword = String(formData.get("currentPassword") || "");
    if (button) button.disabled = true;
    try {
      await api("/api/auth/account/email-change/request", {
        method: "POST",
        body: JSON.stringify({ newEmail, currentPassword }),
      });
      await refreshAccountSettingsView();
    } catch (submitError) {
      if (error) error.textContent = emailChangeErrorMessage(submitError);
      if (button) button.disabled = false;
    }
    return;
  }

  // feature/athlete-programs-profile: PATCH /api/athlete-profile only ever
  // touches public.athletes (first_name/last_name/image_url/birth_date/
  // phone/country/city) - it never reaches users.email/password/role, so
  // this can never interact with the Login email or Change password forms
  // above/below it. Every field here is on the endpoint's allowlist (see
  // backend/src/routes/athleteProfile.js) - the body sent below is
  // exhaustive, never spreads formData directly, so a stray/renamed input
  // can't silently smuggle an extra field into the request. On success,
  // invalidate the Home cache (Home shows this same name/photo) so the
  // next visit to Home reflects the change instead of serving a stale
  // cached response - Home isn't on screen right now, so there's nothing
  // to update in place there, only its cache entry.
  const personalDataForm = event.target.closest("[data-account-form='personal-data']");
  if (personalDataForm) {
    event.preventDefault();
    const formData = new FormData(personalDataForm);
    const error = personalDataForm.querySelector(".builder-error");
    const success = personalDataForm.querySelector(".builder-success");
    if (error) error.textContent = "";
    if (success) success.textContent = "";
    const button = personalDataForm.querySelector("button[type='submit']");
    const firstName = String(formData.get("firstName") || "").trim();
    const lastName = String(formData.get("lastName") || "").trim();
    const birthDate = String(formData.get("birthDate") || "").trim();
    const phone = String(formData.get("phone") || "").trim();
    const country = String(formData.get("country") || "").trim();
    const city = String(formData.get("city") || "").trim();
    const imageUrl = String(formData.get("imageUrl") || "").trim();
    if (button) button.disabled = true;
    try {
      const updated = await api("/api/athlete-profile", {
        method: "PATCH",
        body: JSON.stringify({ firstName, lastName, birthDate, phone, country, city, imageUrl }),
      });
      invalidateAthleteHomeCache();
      // Re-render in place with the server's own returned values (no extra
      // profile fetch, no loading-placeholder flash) so the avatar preview,
      // name inputs, and a success message all update in one pass - Home
      // itself isn't on screen right now, so its cache invalidation above
      // is what makes ITS greeting/photo correct on the next visit there.
      if (state.activeTab === "athlete-settings") {
        const emailChangeStatus = await api("/api/auth/account/email-change/status").catch(() => null);
        if (state.activeTab !== "athlete-settings") return;
        const athlete = state.athletes.find((entry) => entry.athlete_id === state.selectedAthleteId);
        els.content.innerHTML = renderAthleteSettingsHtml(athlete, state.currentUser, emailChangeStatus, updated);
        const savedForm = els.content.querySelector("[data-account-form='personal-data']");
        const savedSuccess = savedForm?.querySelector(".builder-success");
        if (savedSuccess) savedSuccess.textContent = "Personal data saved.";
      }
    } catch (submitError) {
      if (error) error.textContent = submitError.message || "Could not save your personal data.";
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
    await submitBuilderFormAction(builderForm, { loadBuilderExercises, ensureBuilderExercises: ensureBuilderExercisesQuietly, renderBuilder, renderBuilderSectionItems, renderBuilderAddFeedback });
  } catch (builderError) {
    if (error) error.textContent = builderError.message || "Could not save this change.";
    else renderBuilderError(builderError);
  } finally {
    if (submitButton) submitButton.disabled = false;
  }
}

function applyBuilderNodePresetMatch(nameInput) {
  const form = nameInput.closest("form");
  if (!form) return;
  const nodeType = form.querySelector('[name="nodeType"]')?.value || "";
  const typedName = nameInput.value.trim().toLowerCase();
  if (!typedName) return;
  const preset = (state.builder.nodePresets || []).find(
    (candidate) => candidate.node_type === nodeType && candidate.name.trim().toLowerCase() === typedName,
  );
  if (!preset) return;
  const colorInput = form.querySelector('[name="color"]');
  const iconInput = form.querySelector('[name="iconUrl"]');
  if (colorInput && preset.color) colorInput.value = preset.color;
  if (iconInput) iconInput.value = preset.icon_url || "";
}

// Live "type to narrow it down" filtering for the domain/category/section
// preset picker (renderPresetPicker, builder-structure.js) - restores what
// a native <datalist> gave for free before Phase D replaced it with this
// icon-capable custom list (icons aren't possible in a native datalist
// option). Every keystroke here is a targeted DOM patch (row .hidden
// toggles + one classList.toggle on the container), never a renderBuilder()
// - the whole point is to keep typing in this exact input, so a full
// re-render that replaces the input node would drop focus mid-keystroke.
function filterBuilderPresetPicker(nameInput) {
  const form = nameInput.closest("form");
  const picker = form?.querySelector(".builder-preset-picker");
  if (!picker) return;
  const typed = nameInput.value.trim().toLowerCase();
  const options = picker.querySelectorAll(".builder-preset-picker-option");
  let anyVisible = false;
  options.forEach((option) => {
    const matches = !typed || (option.dataset.presetNameLower || "").includes(typed);
    option.hidden = !matches;
    if (matches) anyVisible = true;
  });
  picker.classList.toggle("is-open", Boolean(typed) && anyVisible);
}

const FOCUS_SCROLL_TOP_SELECTOR = "[data-builder-exercise-search], .builder-quick-dose input, .builder-section-library .exercise-filter-field select, .builder-section-library .exercise-filter-field input";

function handleContentFocusIn(event) {
  if (window.innerWidth > 560) return;
  const field = event.target.closest?.(FOCUS_SCROLL_TOP_SELECTOR);
  if (!field) return;
  requestAnimationFrame(() => field.scrollIntoView({ behavior: "smooth", block: "start" }));
}

function handleContentPointerDown(event) {
  // Builder section: drag an added exercise by its grip to a new position.
  if (startBuilderItemDrag(event, {
    // Also while a library exercise dropped on the list is being added
    // and placed (dropBuilderLibraryExercise).
    isBlocked: builderLibraryDropBlocked,
    onDrop: (itemId, index) => {
      void moveBuilderItemTo(itemId, index, { renderBuilder, renderBuilderSectionItems, refreshBuilderDraft }).catch(renderBuilderError);
    },
  })) return true;
  const dayEl = event.target.closest('[data-action="tests-calendar-day-mousedown"]');
  if (!dayEl) return false;
  if (startTestsCalendarDrag(dayEl)) {
    event.preventDefault(); // stops the browser's own text-selection/touch-scroll from fighting the calendar drag
    return true;
  }
  return false;
}

// Pointer Events don't give touch drags the mouse's own "mouseover fires on
// whatever element is now under the pointer" behavior - a touch pointer's
// move events keep reporting the ORIGINAL pointerdown target throughout the
// whole gesture (same underlying platform behavior as plain Touch Events).
// document.elementFromPoint() is the standard, input-agnostic way around
// that: it works identically for mouse and touch, so this one handler
// drives both instead of needing separate mouse/touch code paths.
// isTestsCalendarDragging() gates the elementFromPoint() call itself (not
// cheap to run on every pointermove across the whole app) to only the
// moments a calendar drag is actually in progress.
function handleContentPointerMove(event) {
  if (!isTestsCalendarDragging()) return false;
  const dayEl = document.elementFromPoint(event.clientX, event.clientY)?.closest?.('[data-action="tests-calendar-day-mousedown"]');
  if (!dayEl) return false;
  if (extendTestsCalendarDrag(dayEl)) {
    event.preventDefault(); // stops the page/panel from scrolling under an in-progress touch drag
    return true;
  }
  return false;
}

function normalizeTouchPointerEvent(event) {
  const touch = event.touches?.[0] || event.changedTouches?.[0];
  if (!touch) return null;
  return {
    pointerIdFallback: "touch",
    clientX: touch.clientX,
    clientY: touch.clientY,
    target: event.target,
    preventDefault: () => {
      if (event.cancelable) event.preventDefault();
    },
  };
}

// Builder section editor: the search already runs while the coach types, so
// Enter (the keyboard's Search key) only puts the field away - on a phone the
// keyboard closes and the search row shows Tile / Big / List again.
function handleBuilderSearchKeydown(event) {
  if (event.key !== "Enter" || event.isComposing || !event.target.matches?.("[data-builder-exercise-search]")) return;
  event.preventDefault();
  event.target.blur();
}

function handleContentInput(event) {
  if (event.target.matches("[data-athlete-filter]")) {
    handleAthleteFilter(event.target);
    return;
  }
  if (event.target.matches("[data-coach-home-search]")) {
    coachHomePicker.query = event.target.value;
    const list = els.content.querySelector(".coach-home-picker-list");
    if (list) list.innerHTML = coachHomePickerListHtml();
    return;
  }
  // The create-form's name input has no value= binding to state, so a full
  // re-render (e.g. opening the athlete picker) would otherwise wipe it -
  // mirror every keystroke into state, same idea as createAthleteId.
  const createNameInput = event.target.closest(".builder-create-form input[name='name']");
  if (createNameInput) {
    state.builder.createName = createNameInput.value;
    return;
  }

  // Re-arm the SAME per-item debounced autosave (see scheduleBuilderItemAutosave)
  // on every keystroke, not only on blur ("change", handled below in
  // handleContentChange) - see that function's comment for why blur-only
  // debouncing still let a mid-typing rebuild wipe out characters.
  const updateItemForm = event.target.closest('[data-builder-form="update-item"][data-builder-autosave]');
  if (updateItemForm && event.target.matches("input, textarea")) {
    scheduleBuilderItemAutosave(updateItemForm);
    return;
  }

  const orgFilter = event.target.closest("[data-org-select-filter]");
  if (orgFilter) {
    handleOrganizationFilterInput(orgFilter);
    return;
  }

  const presetNameInput = event.target.closest("[data-builder-preset-name-input]");
  if (presetNameInput) {
    applyBuilderNodePresetMatch(presetNameInput);
    filterBuilderPresetPicker(presetNameInput);
    return;
  }

  const exerciseFilterSearch = event.target.closest("[data-exercise-filter-search]");
  if (exerciseFilterSearch) {
    syncExerciseFilterSearch(exerciseFilterSearch);
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
  // Training Load Frontend 3A: metric picker search (item 8) — filtering
  // is synchronous over already-loaded definitions (no network round trip
  // per keystroke), so this re-renders immediately; focus/cursor position
  // is restored right after, same "never lose focus after a rerender"
  // convention item 11 requires everywhere else in this feature.
  const metricPickerSearch = event.target.closest("[data-tl-calendar-metric-search]");
  if (metricPickerSearch) {
    state.trainingLoad.calendar.metricPicker.search = metricPickerSearch.value;
    const selectionStart = metricPickerSearch.selectionStart;
    const selectionEnd = metricPickerSearch.selectionEnd;
    renderTrainingLoad();
    const restored = els.content.querySelector("[data-tl-calendar-metric-search]");
    if (restored) {
      restored.focus();
      restored.setSelectionRange(selectionStart, selectionEnd);
    }
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
  // Library settings: the cover picture follows the link while it is typed,
  // the open-ended access note follows the access length (program-preview.js).
  const metadataInput = event.target.closest("[data-template-metadata-form] input[name='coverImageUrl'], [data-template-metadata-form] input[name='accessDurationDays']");
  if (metadataInput) {
    if (metadataInput.name === "coverImageUrl") scheduleProgramCoverPreview(metadataInput);
    else syncTemplateMetadataForm(metadataInput.form, metadataInput);
    return;
  }
  if (handleExerciseEditorInput(state, event)) return;

  const wellnessSlider = event.target.closest("[data-action='tests-slider-input']");
  if (wellnessSlider) {
    handleTestsSliderInput(wellnessSlider);
    return;
  }
  const testsAthleteSearch = event.target.closest("[data-action='tests-schedule-athlete-search']");
  if (testsAthleteSearch) {
    handleTestsScheduleAthleteSearchInput(testsAthleteSearch);
    return;
  }

  // Training load's RPE slider/duration/note inputs and the coach filter's
  // athlete-search box all carry their own data-action directly on the
  // input element itself (same convention as the WELLNESS slider above) -
  // handleTrainingLoadAction reads the live value straight off it.
  // The shared icon picker and Settings -> Icons narrow their grids in place.
  if (handleIconPickerInput(event.target)) return;
  if (handleIconGalleryInput(event.target)) return;
  // Data configuration -> Variables: the form's values and the list filter.
  if (handleVariablesInput(event.target, { render: renderActiveTrainingLoadSurface })) return;
  // Data configuration -> Source fields: the confirmation form's values.
  if (handleSourceFieldsInput(event.target)) return;

  const trainingLoadInput = event.target.closest("[data-action^='training-load-']");
  if (trainingLoadInput && trainingLoadInput.matches("input, textarea")) {
    // Dashboards UX H1: the dashboard picker's and the metric panel's
    // search boxes filter per keystroke over already-loaded lists - same
    // re-render + focus/cursor restore as the Activities metric picker
    // above, so typing is never interrupted.
    const analysisSearch = trainingLoadInput.dataset.tlAnalysisSearch;
    if (analysisSearch) {
      setTrainingLoadAnalysisSearch(analysisSearch, trainingLoadInput.value);
      const selectionStart = trainingLoadInput.selectionStart;
      const selectionEnd = trainingLoadInput.selectionEnd;
      renderTrainingLoad();
      const restored = els.content.querySelector(`[data-tl-analysis-search='${analysisSearch}']`);
      if (restored) {
        restored.focus();
        if (typeof restored.setSelectionRange === "function" && selectionStart !== null) restored.setSelectionRange(selectionStart, selectionEnd);
      }
      return;
    }
    // Dashboards UX H3: the widget editor's Title/Label go straight into the
    // staged draft per keystroke, without a re-render.
    if (trainingLoadInput.dataset.tlEditorField) {
      setTrainingLoadAnalysisEditorText(trainingLoadInput);
      return;
    }
    // Other Analysis text fields apply on change/blur. Re-rendering on every
    // keystroke would replace the input node and interrupt typing.
    if (trainingLoadInput.dataset.action.startsWith("training-load-analysis-")) return;
    void handleTrainingLoadAction(trainingLoadInput, { renderTrainingLoad: renderActiveTrainingLoadSurface, openWeeklyPlanForAthleteOnDate });
    return;
  }

  const input = event.target.closest("[data-builder-exercise-search]");
  if (!input) return;
  state.builder.exerciseQuery = input.value;
  debounceBuilderSearch();
}

async function handleContentChange(event) {
  // Exercise media (FE-2): the editor's hidden file input chose a file.
  if (handleExerciseEditorChange(state, exerciseEditorHandlers, event)) return;
  if (await handleTestsContentChange(event)) return;
  const trainingLoadControl = event.target.closest("[data-action^='training-load-']");
  if (trainingLoadControl && trainingLoadControl.matches("select, input")) {
    void handleTrainingLoadAction(trainingLoadControl, { renderTrainingLoad: renderActiveTrainingLoadSurface, openWeeklyPlanForAthleteOnDate });
    return;
  }
  // Mirror the create-form's color-palette hidden input into state, same
  // reasoning as createNameInput above - fires for both a swatch pick and a
  // custom-color pick, since both end up setting this hidden input's value
  // and dispatching change on it (see taxonomy-actions.js / pastelCustom below).
  const createColorInput = event.target.closest(".builder-create-form input[name='color']");
  if (createColorInput) {
    state.builder.createColor = createColorInput.value;
    return;
  }

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

  // Manage account -> Application blocks: Grant block waits for a chosen block.
  const grantSelect = event.target.closest('[data-manage-account-add="block"] select');
  if (grantSelect) { syncGrantBlockButton(grantSelect); return; }

  const athleteAccessInput = event.target.closest("[data-athlete-access-key]");
  if (athleteAccessInput) {
    syncOrganizationAccessGroupMaster(athleteAccessInput);
    return;
  }

  const builderFilter = event.target.closest("[data-builder-exercise-filter]");
  if (builderFilter) {
    state.builder.exerciseFilters[builderFilter.dataset.builderExerciseFilter] =
      builderFilter.type === "checkbox" ? builderFilter.checked : builderFilter.value;
    renderBuilderFiltersChange();
    debounceBuilderSearch();
    return;
  }

  const templateFilter = event.target.closest("[data-template-filter]");
  if (templateFilter) {
    if (templateFilter.dataset.templateFilter === "scope") {
      state.templateScope = templateFilter.value || "my_programs";
      if (state.templateScope !== "my_programs") state.templateFilters.lifecycle = "all";
    }
    else if (templateFilter.dataset.templateFilter === "freeOnly") state.templateFilters.pricing = templateFilter.checked ? "free" : "all";
    else state.templateFilters[templateFilter.dataset.templateFilter] = templateFilter.value;
    state.selectedTemplateId = null;
    state.templatePreview = emptyTemplatePreview();
    renderTemplateLibraryResults();
    return;
  }

  // Library settings: Pricing, shelf, status, license, access length and the
  // cover link update their dependent parts in place (program-preview.js).
  const metadataForm = event.target.closest("[data-template-metadata-form]");
  if (metadataForm && syncTemplateMetadataForm(metadataForm, event.target)) return;

  const pastelCustom = event.target.closest("[data-pastel-custom-color]");
  if (pastelCustom) {
    const palette = pastelCustom.closest("[data-pastel-target]");
    const hidden = palette?.querySelector('input[type="hidden"]');
    if (hidden) {
      hidden.value = pastelCustom.value;
      hidden.dispatchEvent(new Event("change", { bubbles: true }));
    }
    palette?.querySelectorAll(".pastel-swatch").forEach((swatch) => swatch.classList.remove("is-selected"));
    const customSwatch = pastelCustom.closest(".pastel-swatch-custom");
    if (customSwatch) {
      customSwatch.classList.add("is-selected");
      customSwatch.style.background = pastelCustom.value;
    }
    const currentSwatch = palette?.querySelector(".pastel-current-swatch");
    if (currentSwatch) {
      currentSwatch.style.background = pastelCustom.value;
      currentSwatch.classList.remove("is-empty");
    }
    palette?.classList.remove("is-open");
    return;
  }

  const quickAddTime = event.target.closest("[data-builder-quick-add-time]");
  if (quickAddTime) {
    state.builder.sessionQuickAdd.time = quickAddTime.value;
    return;
  }

  const form = event.target.closest("[data-builder-autosave]");
  // Session AM/PM and training-phase are <select> elements sharing this
  // SAME autosave form with the name/time <input>s (see
  // renderSessionEditPhaseSelects in builder-structure.js) - excluding
  // "select" here meant a real, live-confirmed bug: changing AM to PM (or
  // the training phase) fired a genuine `change` event that this guard
  // then silently dropped, so the PATCH was never sent.
  if (!form || !event.target.matches("input, textarea, select")) return;
  // update-item forms (Sets/Reps/Load/Instruction) are the one autosave form
  // with several sibling fields a coach tabs through quickly (Sets -> Reps ->
  // Load). Each field's own blur fires this "change" handler independently -
  // saving immediately on every single one meant a fast Tab-Tab-Tab could
  // have an earlier field's save+DOM-rebuild (renderBuilderSectionItems,
  // builder-view.js) land WHILE the coach is already typing into the next
  // field, resetting it back to its last-saved (not yet including what was
  // just typed) value mid-keystroke - reported live as "kao da izbacuje pa
  // unese upis, kasni". Debouncing per item coalesces a whole Sets/Reps/Load
  // pass into one save+rebuild after the coach actually pauses, and since
  // FormData is only read once the debounced call finally fires, it always
  // captures whatever is currently in the DOM - never stale.
  if (form.dataset.builderForm === "update-item") {
    scheduleBuilderItemAutosave(form);
    return;
  }
  try {
    await submitBuilderFormAction(form, { loadBuilderExercises, ensureBuilderExercises: ensureBuilderExercisesQuietly, renderBuilder, renderBuilderSectionItems, renderBuilderAddFeedback });
  } catch (error) {
    renderBuilderError(error);
  }
}

async function handleTestsContentChange(event) {
  const testsScheduleField = event.target.closest("[data-action='tests-schedule-form-field']");
  if (!testsScheduleField) return false;
  handleTestsScheduleFormField(testsScheduleField);
  renderTests();
  return true;
}
const builderAutosaveTimers = new Map();
const BUILDER_ITEM_AUTOSAVE_DEBOUNCE_MS = 500;

// Shared by both the "change" (blur) and "input" (every keystroke) paths
// below for an update-item form - keyed per item, so typing anywhere across
// Sets/Reps/Load/Instruction keeps pushing the save+rebuild further out.
// Blur-only debouncing (the original fix) still lost text in a very
// realistic pattern: blur Sets, pause a beat deciding what to type, THEN
// start typing Reps - if that pause exceeded 500ms, Sets' own debounced
// save could fire and rebuild the DOM (renderBuilderSectionItems) WHILE the
// coach was mid-keystroke on Reps, wiping the in-progress (not yet blurred,
// so not yet reflected in any saved FormData) characters - reported live as
// letters constantly vanishing while typing. Re-arming this same timer on
// every "input" event too, not only "change", means the save (and the
// rebuild it triggers) only ever fires 500ms after the coach's TRUE last
// keystroke anywhere in the item's own form, never mid-typing.
//
// That alone still isn't enough on a real network: the debounce only
// delays WHEN the save is DISPATCHED, not how long the round trip to the
// server takes once it's underway. On localhost the PATCH + response is
// near-instant, so there's essentially no gap - but against a real deploy
// (Render's response time, not zero) a coach can easily type MORE
// characters during the second or so between "the save fired" and "the
// response came back and renderBuilderSectionItems() rebuilt the DOM from
// it". That rebuild reads state.builder.draft, which only reflects the
// FormData snapshot taken when THIS save was dispatched - so it silently
// overwrote the coach's newer, not-yet-saved keystrokes with the older
// value, restoring focus/cursor position (renderBuilderSectionItems
// already does that carefully) but not the newer text itself. A per-item
// generation counter closes this: every keystroke bumps it, and a save's
// own response only gets applied to the screen if no NEWER keystroke
// happened while it was in flight - a stale response still updates
// state.builder.draft in the background (harmless; the next, newer save
// - already scheduled by that later keystroke - reads the DOM fresh and
// will supersede it shortly) but never touches what's on screen.
const builderItemAutosaveGeneration = new Map();
const builderItemAutosaveTasks = new Map();
const builderItemAutosaveInFlight = new Set();
function scheduleBuilderItemAutosave(form) {
  const key = form.dataset.itemId || form;
  rememberBuilderItemEdit(key, Object.fromEntries(new FormData(form)));
  const generation = (builderItemAutosaveGeneration.get(key) || 0) + 1;
  builderItemAutosaveGeneration.set(key, generation);
  clearTimeout(builderAutosaveTimers.get(key));
  const save = () => {
    builderAutosaveTimers.delete(key);
    builderItemAutosaveTasks.delete(key);
    const isStale = () => builderItemAutosaveGeneration.get(key) !== generation;
    const request = submitBuilderFormAction(form, {
      loadBuilderExercises,
      renderBuilder: () => { if (!isStale()) renderBuilder(); },
      // Returning true when stale mirrors renderBuilderSectionItems()'s own
      // "handled" signal (submitBuilderForm only falls through to
      // handlers.renderBuilder() when this returns falsy) - a stale
      // response is fully handled by doing nothing to the screen.
      renderBuilderSectionItems: () => (isStale() ? true : renderBuilderSectionItems()),
      renderBuilderAddFeedback,
    });
    builderItemAutosaveInFlight.add(request);
    request.then(() => builderItemAutosaveInFlight.delete(request), () => {
      builderItemAutosaveInFlight.delete(request);
      if (!isStale()) builderItemAutosaveTasks.set(key, save);
    });
    request.catch(renderBuilderError);
    return request;
  };
  builderItemAutosaveTasks.set(key, save);
  builderAutosaveTimers.set(key, setTimeout(save, BUILDER_ITEM_AUTOSAVE_DEBOUNCE_MS));
}

async function flushBuilderAutosaves() {
  while (builderItemAutosaveTasks.size || builderItemAutosaveInFlight.size) {
    const requests = [...builderItemAutosaveInFlight];
    for (const [key, save] of [...builderItemAutosaveTasks]) {
      clearTimeout(builderAutosaveTimers.get(key));
      requests.push(save());
    }
    await Promise.all(requests);
  }
}

async function cancelBuilderAutosaves() {
  for (const key of builderItemAutosaveGeneration.keys()) {
    clearTimeout(builderAutosaveTimers.get(key));
    builderItemAutosaveGeneration.set(key, builderItemAutosaveGeneration.get(key) + 1);
  }
  builderAutosaveTimers.clear();
  builderItemAutosaveTasks.clear();
  await Promise.allSettled([...builderItemAutosaveInFlight]);
  clearBuilderItemEdits();
}

async function cancelBuilderItemAutosave(key) {
  clearTimeout(builderAutosaveTimers.get(key));
  builderAutosaveTimers.delete(key);
  builderItemAutosaveTasks.delete(key);
  builderItemAutosaveGeneration.set(key, (builderItemAutosaveGeneration.get(key) || 0) + 1);
  await Promise.allSettled([...builderItemAutosaveInFlight]);
}

// A failed library load says so in place, with Try again
// (loadBuilderExercises), so the caller has nothing more to do with it.
function ensureBuilderExercisesQuietly() {
  void ensureBuilderExercises()?.catch(() => {});
}

let builderSearchTimer = null;
function debounceBuilderSearch() {
  clearTimeout(builderSearchTimer);
  // loadBuilderExercises() now patches only the results list and never touches the
  // search input itself, so there is nothing to restore focus/selection for here
  // anymore -- doing so anyway would fight the user's own cursor position with a
  // stale (pre-fetch) offset, which is what used to make it look like typed letters
  // landed mid-word.
  builderSearchTimer = setTimeout(() => loadBuilderExercises(), 250);
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
    // Explicit even though the reload below tears it down anyway - the
    // athlete Back-button guard must never be nominally active post-logout.
    window.removeEventListener("popstate", handleBrowserBack);
    // A deliberate navigation: the Imports reload/close guard does not ask.
    state.deliberateNavigation = true;
    state.currentUser = null;
    // Defensive, not load-bearing: window.location.replace("/") below
    // already reloads the page (a fresh module evaluation resets
    // view-cache.js's in-memory store on its own), so no cached
    // Coaches/Organization/Program Library/Exercise Library/Builder-drafts
    // data could survive into the next session regardless. Cleared
    // explicitly anyway so that invariant is self-evident here, not just an
    // accident of the reload, in case that ever changes. Same reasoning for
    // resetMessagesState() - a typed-but-not-yet-cleared search must never
    // be attributable to whichever account logs in next.
    clearAllViewCache();
    // The unconfirmed GPEXE name loads (a request key per team, memory only)
    // belong to this sign-in alone.
    clearPendingIdentityLoads();
    resetMessagesState();
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

function toggleMobileNav() {
  state.mobileNavOpen = !state.mobileNavOpen;
  renderMobileNavState();
}

function closeMobileNav() {
  if (!state.mobileNavOpen) return;
  state.mobileNavOpen = false;
  renderMobileNavState();
}

function collapseRailAfterNav() {
  if (state.railExpanded && !window.matchMedia("(min-width: 900px)").matches) {
    state.railExpanded = false;
    renderRailState();
  }
  closeMobileNav();
}

function openWeeklyCalendarFromRail() {
  if (!confirmLeaveTrainingLoad("weekly")) return;
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

  // An R2 picture whose short-lived address failed asks for a new one once
  // (media-playback.js); only after that do its fallbacks apply.
  if (retryExpiredMediaImage(image)) return;

  const fallbacks = parseImageFallbacks(image.dataset.fallbacks);
  const next = fallbacks.shift();
  if (next) {
    image.dataset.fallbacks = JSON.stringify(fallbacks);
    image.src = next;
    return;
  }

  if (image.classList.contains("builder-batch-photo")) {
    image.remove();
    return;
  }

  if (image.classList.contains("program-metadata-cover-image") && showProgramCoverPreviewError(image)) return;

  // An exercise picture (exercise-view-modes.js renderExerciseThumb) whose
  // image and video covers all failed: show the exercise's initials.
  if (replaceExerciseThumbWithInitials(image)) return;

  if (image.classList.contains("avatar")) {
    const fallback = document.createElement("span");
    fallback.className = "avatar-fallback";
    fallback.textContent = image.alt || "?";
    image.replaceWith(fallback);
    return;
  }

  // hotfix/mobile-messages-test-regression: message-avatar-photo's alt is
  // deliberately empty (decorative - the participant's name always sits
  // right next to it), so unlike the generic .avatar branch above, the
  // fallback text comes from data-initials, not image.alt.
  if (image.classList.contains("message-avatar-photo")) {
    const fallback = document.createElement("span");
    fallback.className = "message-avatar";
    fallback.textContent = image.dataset.initials || "?";
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

// hotfix/athlete-home-mobile-layout: the athlete shell has no separate Home
// nav button (removed from the sidebar/drawer) - the OptiMove logo is the
// only way back to Home, from any athlete tab. Must work identically no
// matter which athlete view is currently on screen.
function goHome() {
  state.navStack = [];
  if (isAthleteMode()) {
    if (state.activeTab !== "athlete-home") pushAppHistory();
    state.activeTab = "athlete-home";
    state.selectedProgramId = null;
    state.selectedTemplateId = null;
    state.weekSelectorOpen = false;
    state.openWeekCalendarOnLoad = false;
    collapseRailAfterNav();
    renderTabs();
    renderLibraryNav();
    void loadActiveTab();
    return;
  }
  renderCurrentNode();
}

// Dashboards UX H4: the question only - see confirmLeaveTrainingLoad.
const askLeaveTrainingLoad = () => confirmLeaveTrainingLoad(null, { discard: false });

async function handleGlobalClick(event) {
  const tab = event.target.closest("[data-tab]");
  if (tab) {
    const nextTab = tab.dataset.tab;
    if (!confirmLeaveTrainingLoad(nextTab)) return;
    if (state.activeTab !== nextTab) pushAppHistory();
    state.activeTab = nextTab;
    state.selectedProgramId = null;
    state.selectedTemplateId = null;
    state.navStack = [];
    // ui/athlete-program-navigation-icons: clicking the Weekly plans tab
    // must only switch views, never auto-open the calendar/month picker -
    // that stays reachable only through the Weekly header's own date/period
    // button (data-action="week-toggle", handleWeeklyAction) and the
    // sidebar's #calendarToggle, both unaffected by this reset.
    if (state.activeTab === "weekly") state.openWeekCalendarOnLoad = false;
    renderTabs();
    renderLibraryNav();
    loadActiveTab();
    return;
  }

  const action = event.target.closest("[data-action]");
  if (!action) {
    closeNotificationsIfOutside(event.target);
    closeMessagesIfOutside(event.target);
    closeWorkspaceSwitcherIfOutside(event.target);
    return;
  }
  if (await handleWorkspaceAction(action, { onWorkspaceChanged, confirmLeave: askLeaveTrainingLoad })) {
    return;
  }
  if (await handleNotificationAction(action, { openProgramRequests, openTestAssignment, openTestsToday, openTestsResults, openTrainingLoadAssignment, openTrainingLoadResults, openWeeklyPlanFromNotification: openWeeklyPlanOnDate, openSpecificProgramFromNotification, confirmLeave: askLeaveTrainingLoad, discardLeave: discardTrainingLoadLeaveDrafts })) {
    renderMessages();
    return;
  }
  if (await handleMessageAction(action)) {
    renderNotifications();
    return;
  }
  if (action.dataset.action === "close-media") closeMedia();
  if (action.dataset.action === "home") goHome();
  if (action.dataset.action === "brand-home") {
    closeMobileNav();
    if (document.body.classList.contains("athlete-mode")) {
      goHome();
    } else if (state.activeTab !== "coach-home") {
      if (!confirmLeaveTrainingLoad("coach-home")) return;
      pushAppHistory();
      state.activeTab = "coach-home";
      state.selectedProgramId = null;
      state.selectedTemplateId = null;
      state.navStack = [];
      collapseRailAfterNav();
      renderTabs();
      renderLibraryNav();
      await loadActiveTab();
    }
  }
  if (action.dataset.action === "home-add-athlete") {
    if (state.activeTab !== "organization") pushAppHistory();
    state.activeTab = "organization";
    state.organization.section = "athletes";
    state.organization.addFormOpen = true;
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
    await loadActiveTab();
  }
  if (action.dataset.action === "exit-confirm-stay") {
    closeAthleteExitConfirm();
    return;
  }
  if (action.dataset.action === "exit-confirm-exit") {
    confirmAthleteExit();
    return;
  }
  if (action.dataset.action === "sidebar-submenu-toggle") {
    const key = action.dataset.submenuKey || "";
    if (key) {
      const submenuEl = document.querySelector(`[data-sidebar-submenu="${key}"]`);
      const currentlyOpen = submenuEl?.classList.contains("is-open");
      state.sidebarSubmenuOpen[key] = !currentlyOpen;
      renderLibraryNav();
      if (!currentlyOpen && document.body.classList.contains("mobile-nav-open")) {
        submenuEl?.scrollIntoView({ block: "nearest", behavior: "smooth" });
      }
    }
  }
  closeNotificationsIfOutside(event.target);
  closeMessagesIfOutside(event.target);
  closeWorkspaceSwitcherIfOutside(event.target);
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
  if (target.closest(".calendar-grid, .week-selector, .week-calendar-picker, .program-day-grid, .exercise-list, .tests-calendar")) return false;
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

// hotfix/athlete-home-mobile-layout: for the athlete shell specifically, a
// Back press with nothing internal left to close must never hand control
// straight to the browser's native confirm() - it shows the styled
// Exit OptiMove? modal instead (Stay/Exit), matching this app's own visual
// language rather than an OS-level dialog. The coach shell's existing
// window.confirm() flow below is completely untouched.
// handleAppBack's answer when Back would have left the current screen but
// the coach chose to stay (Dashboards UX H2: an unsaved Dashboards layout).
const BACK_STAYED = "stayed";

function handleBrowserBack() {
  if (state.allowBrowserExit) return;
  if (state.appHistoryDepth > 0) {
    state.appHistoryDepth -= 1;
    if (handleAppBack() === BACK_STAYED) {
      // The browser has already stepped back one entry - put it back, so the
      // address bar and the next Back press behave as if nothing happened.
      window.history.pushState({ optimove: true }, "", window.location.href);
      state.appHistoryDepth += 1;
    }
    return;
  }
  if (handleAppBack()) {
    window.history.pushState({ optimoveGuard: true }, "", window.location.href);
    return;
  }
  if (isAthleteMode()) {
    // Re-arm the guard state immediately - the browser has already moved
    // back one entry by the time this popstate handler runs, so this
    // restores the address bar to where it was BEFORE showing the modal.
    // Exit (confirmAthleteExit) is the only path that's allowed to
    // actually move past this guard again.
    window.history.pushState({ optimoveGuard: true }, "", window.location.href);
    openAthleteExitConfirm();
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

  // feature/mobile-messages-fullscreen: menu -> Hide-confirm -> thread-to-
  // list -> close-Messages, in that exact priority order - see
  // handleMessagesBack()'s own comment in messages.js for why this lives
  // there (shared with the Escape handler below) and why only the last
  // two steps are gated to mobile.
  if (handleMessagesBack()) return true;

  if (state.athleteExitConfirmOpen) {
    closeAthleteExitConfirm();
    return true;
  }

  if (state.mobileNavOpen) {
    closeMobileNav();
    return true;
  }

  if (els.content.querySelector(".exercise-detail")) {
    returnToNodeParent();
    return true;
  }

  // Drilled into a node (domain/category/section) from inside the Specific
  // Program overlay: step back ONE level and stay inside the overlay - this
  // must run before the overlay-close check below, otherwise Back from a
  // drilled-in node used to skip straight past the section/exercise list
  // and close the whole overlay instead of just stepping up one level
  // (reported live as exercises "disappearing" - the overlay closed under
  // the user rather than showing the level above).
  if (state.navStack.length) {
    state.navStack.pop();
    renderCurrentNode();
    return true;
  }

  // A Specific Program open as an internal overlay must close on Back
  // before the browser is ever allowed to leave the app/tab - there is no
  // "unsaved changes" state inside this read-only detail view today, so
  // closing here is always safe (see closeSpecificProgramOverlay's own
  // comment for what "close" actually touches - never els.toolbar). Only
  // reached once navStack is empty (see above) - i.e. the user is already
  // at the overlay's own root day/block list.
  if (closeSpecificProgramOverlay()) return true;

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

  // The athlete shell's own root/landing tab is athlete-home (no separate
  // Home nav item exists - see goHome()); the coach shell's is unchanged.
  const rootTab = isAthleteMode() ? "athlete-home" : "weekly";
  if (state.activeTab !== rootTab) {
    if (!confirmLeaveTrainingLoad(rootTab)) return BACK_STAYED;
    state.activeTab = rootTab;
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

// hotfix/athlete-home-mobile-layout: the athlete-only "confirm before
// leaving the app" flow, reusing the exact same allowBrowserExit/
// window.history.back() mechanism the coach shell's native confirm()
// already relies on above - Exit here is not a new exit path, just a
// styled trigger for the same one.
function openAthleteExitConfirm() {
  if (!els.exitConfirmModal) return;
  state.athleteExitConfirmOpen = true;
  renderAthleteExitConfirmModal();
}

function closeAthleteExitConfirm() {
  if (!state.athleteExitConfirmOpen) return;
  state.athleteExitConfirmOpen = false;
  renderAthleteExitConfirmModal();
}

// The only function that is ever allowed to set allowBrowserExit for the
// athlete shell - a single real exit, never re-showing this same modal for
// the resulting popstate (handleBrowserBack's very first line returns
// immediately once allowBrowserExit is true).
function confirmAthleteExit() {
  state.athleteExitConfirmOpen = false;
  renderAthleteExitConfirmModal();
  state.allowBrowserExit = true;
  window.history.back();
}

function renderAthleteExitConfirmModal() {
  if (!els.exitConfirmModal) return;
  els.exitConfirmModal.hidden = !state.athleteExitConfirmOpen;
}

async function loadAthletes() {
  document.body.classList.remove("login-mode");
  setStatus("Loading");
  try {
    const data = await api("/api/admin/athletes");
    state.athletes = data.adminRows || [];
    // organization-actions.js reuses this same function as its post-mutation
    // athlete-roster reload (create/archive/restore athlete, coach/team/club
    // relationship archive/restore - see handleOrganizationAction's
    // loadAthletes call sites) - Home's "today" overview lists exactly this
    // roster (GET /api/athletes/today, filtered the same way), so every one
    // of those mutations must invalidate it too, not just the initial
    // session bootstrap call this function also serves as.
    invalidateCoachHomeCache();
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
  if (isAthleteMode() && state.activeTab === "coach-home") state.activeTab = "athlete-home";
  renderTabs();
  renderLibraryNav();
  if (state.activeTab === "athlete-settings") return renderAthleteSettings();
  if (state.activeTab === "coach-account") return renderCoachAccount();
  if (state.activeTab === "athlete-library") return renderAthleteLibrary();
  // Switching between Settings sub-tabs (Overview/Users/Clubs/Teams/Athletes/
  // Tags & Presets/Join links) keeps state.activeTab === "organization" the
  // whole time - every one of those clicks routes through here. Reuse
  // whatever's already cached instead of re-fetching the full
  // /api/organization payload on every single sub-tab click; a genuine first
  // entry into Settings this session (state.organization.data still null)
  // still fetches, since renderOrganizationPanel falls back to `refresh ||
  // !state.organization.data`. Explicit refreshes (mutations, workspace
  // switch - see onWorkspaceChanged) call renderOrganizationPanel()/
  // refreshOrganizationData() directly and are untouched by this.
  if (state.activeTab === "organization") {
    // Coming back to Settings is the other way into Data sources (the first
    // is its sub-tab button): read the chosen team again. This belongs on
    // the entry event, never in renderOrganizationPanel itself - that one is
    // also the Data sources repaint, so a reset there would loop.
    if (state.organization.section === "dataSources") enterDataSourcesSection();
    if (state.organization.section === "sourceConnections") enterSourceConnectionsSection();
    if (state.organization.section === "storage") enterStorageAdminSection();
    if (state.organization.section === "icons") enterIconGallery();
    return renderOrganizationPanel({ refresh: false });
  }
  if (state.activeTab === "coach-home") return loadCoachHome();
  if (state.activeTab === "athlete-home") return loadAthleteHome();
  if (state.activeTab === "weekly") return loadWeekly();
  if (state.activeTab === "programs") return loadPrograms();
  if (state.activeTab === "templates") return loadTemplates();
  if (state.activeTab === "coaches") return loadCoaches();
  if (state.activeTab === "builder") return loadBuilder();
  if (state.activeTab === "tests") return loadTests({ setLoading, renderTests });
  if (state.activeTab === "training-load") return loadTrainingLoad();
  return loadExercises({ renderExercises, setLoading });
}

async function loadCoaches({ forceRefresh = false } = {}) {
  els.context.textContent = "Coach directory";
  els.title.textContent = "Coaches";
  els.toolbar.innerHTML = "";
  return loadCoachesAction({ setLoading, renderCoaches, forceRefresh });
}

async function loadCoachHome({ forceRefresh = false } = {}) {
  coachHomePicker = { mode: "", query: "" };
  state.navStack = [];
  els.context.textContent = "Overview";
  els.title.textContent = "Home";
  els.toolbar.innerHTML = "";
  // The calendar's dots, the chosen day and the exercise and program strips
  // load beside the roster, each drawing its own card when it arrives.
  if (state.currentUser?.activeWorkspace?.type !== "platform") void loadCoachHomeExtras({ onChange: refreshCoachHomeSection, forceRefresh });
  return loadCoachHomeData({ setLoading, renderCoachHome, forceRefresh });
}

function renderCoachHome({ rows, error }) {
  coachHomeRows = rows || [];
  // A redraw (the athlete list opening, a background refresh) keeps every
  // strip where the coach left it and the focus where it was.
  const view = captureCoachHomeView(els.content.querySelector(".coach-home"));
  els.content.innerHTML = renderCoachHomeHtml({ rows: coachHomeRows, error, user: state.currentUser, picker: coachHomePicker, home: state.coachHome });
  const home = els.content.querySelector(".coach-home");
  restoreCoachHomeView(home, view);
  bindCoachHomeCarousels(home, { onNearEnd: loadMoreCoachHomeOnNearEnd });
  const dialog = els.content.querySelector(".coach-home-picker");
  if (dialog) {
    dialog.showModal();
    dialog.addEventListener("cancel", (event) => { event.preventDefault(); closeCoachHomePicker(); });
    dialog.addEventListener("click", (event) => {
      if (event.target !== dialog) return;
      const rect = dialog.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) closeCoachHomePicker();
    });
    dialog.querySelector("input")?.focus();
  }
}

// One Home card drawn again once its data changed (coach-home-actions.js
// renderCoachHomeSection), never while another screen is open.
function refreshCoachHomeSection(section, appended) {
  if (state.activeTab !== "coach-home") return;
  renderCoachHomeSection(els.content, section, { rows: coachHomeRows, appended, onNearEnd: loadMoreCoachHomeOnNearEnd });
}

// After a failed page only its Try again loads it again, never a scroll.
function loadMoreCoachHomeOnNearEnd(track) {
  if (track === "exercises" && !state.coachHome.exercises.moreError) void loadMoreCoachHomeExercises({ onChange: refreshCoachHomeSection });
}

// The open athlete list's rows for the search field (coach-home.js).
function coachHomePickerListHtml() {
  return renderCoachHomeAthleteRows(coachHomePickerRows(coachHomeRows, coachHomePicker, state.coachHome), coachHomePicker);
}

function closeCoachHomePicker() {
  const mode = coachHomePicker.mode;
  els.content.querySelector(".coach-home-picker")?.close();
  coachHomePicker = { mode: "", query: "" };
  els.content.querySelector(`[data-action="coach-home-picker-open"][data-mode="${mode}"]`)?.focus();
}

async function loadAthleteHome({ forceRefresh = false } = {}) {
  state.navStack = [];
  els.context.textContent = "Home";
  els.title.textContent = "Home";
  els.toolbar.innerHTML = "";
  // Training load's own Session feedback card is deliberately NOT part of
  // the cached GET /api/athlete-home payload (see training-load-data.js's
  // own header comment - rated/not-rated status changes on nearly every
  // visit, most of all right after a submit) - fetched as its own,
  // uncached, parallel call instead.
  return Promise.all([
    loadAthleteHomeData({ setLoading, renderAthleteHome, forceRefresh }),
    loadTrainingLoadAthleteToday().then(renderAthleteHomeFromCache),
  ]);
}

// state.lastAthleteHomeData is the only way a training-load athlete action
// (rate a session, dismiss the saved confirmation) can redraw the WHOLE
// Home surface (header/wellness/today/week-strip/quick actions, not just
// its own card) without re-fetching GET /api/athlete-home itself.
function renderAthleteHome({ data, error }) {
  if (data) state.lastAthleteHomeData = data;
  els.content.innerHTML = renderAthleteHomeHtml({ data, error });
}

function renderAthleteHomeFromCache() {
  if (state.activeTab !== "athlete-home") return;
  els.content.innerHTML = renderAthleteHomeHtml({ data: state.lastAthleteHomeData, error: "" });
}

// Coach "Training load" tab (Schedule / Data & Analysis) - own weekly fetch,
// same request-generation-token guard as Tests' own weekly nav (see
// training-load-data.js's loadTrainingLoadWeekly).
// Correction: menu-cache-policy.js declares this tab "always-refresh" (the
// same reasoning as Tests' own entry - rated/not-rated status changes on
// nearly every visit) - every entry into this tab must issue a real fetch,
// never skip it just because SOME data already happens to be sitting in
// state from an earlier visit this session. `forceRefresh` used to gate an
// otherwise-skipped fetch; it's kept as a parameter only so callers that
// want to be explicit about why they're here still can, but it no longer
// changes behavior - loadTrainingLoadWeekly always runs.
async function loadTrainingLoad() {
  state.navStack = [];
  els.context.textContent = "Training load";
  els.title.textContent = "Training load";
  els.toolbar.innerHTML = "";
  // perf: renders the tab shell (Schedule / Data & Analysis nav + whatever
  // this section's own nav.data/loading already says) BEFORE awaiting
  // anything below - previously this whole function awaited the fetch
  // first, so the content area (including the nav strip itself) stayed
  // whatever it was before for the full round trip. loadTrainingLoadWeekly
  // now also paints again on its own (instantly from cache, or once
  // "loading" is set) via the onPainted callback passed below, so this
  // first call just guarantees the nav/section shell itself is never
  // waiting on network at all.
  renderTrainingLoad();
  // (v9) Same "workspace switch must immediately load the new
  // workspace's own value, never carry over the old one" rule as every
  // other workspace-scoped Training Load fetch - this function runs both
  // on a fresh tab entry AND right after a workspace switch (see
  // onWorkspaceChanged above), so gating on the currently-active section
  // here covers both triggers with one check.
  // "today" is the Calendar tab (item 3) — its own canonical-activity
  // read model, opening on today's date on first entry exactly like the
  // old Today tab did (loadTrainingLoadCalendarWeek seeds weekStart/
  // selectedDate to today on its own first call, same convention as
  // loadTrainingLoadWeekly).
  await Promise.all([
    loadTrainingLoadSectionData(state.trainingLoad.section, renderTrainingLoad),
    state.trainingLoad.section === "schedule" ? loadPlannedRpeSetting() : Promise.resolve(),
  ]);
  renderTrainingLoad();
}

function renderTrainingLoad() {
  els.content.innerHTML = renderTrainingLoadCoachHtml();
  if (state.trainingLoad.section === "analysis") {
    bindTrainingLoadAnalysisLayoutInteractions(els.content, renderActiveTrainingLoadSurface);
  }
}

// Every training-load-* action can fire from either surface it appears on
// (the athlete's own Home card/RPE form, or the coach's Training load tab)
// - picks the right re-render for whichever is actually on screen, same
// convention as renderActiveTestsSurface below.
function renderActiveTrainingLoadSurface() {
  if (state.activeTab === "athlete-home") return renderAthleteHomeFromCache();
  if (state.activeTab === "training-load") return renderTrainingLoad();
}

// Schedule tab click-through ("klik otvara postojeći Weekly plan/session,
// ne pravi poseban RPE schedule") - reuses the EXACT same navigation
// coach-home-open-athlete already does (select the athlete, land on a
// specific date in the real Weekly plan Calendar), never a new view.
async function openWeeklyPlanForAthleteOnDate(athleteId, date) {
  state.selectedAthleteId = athleteId;
  state.athletesExpanded = false;
  await openWeeklyPlanOnDate(date);
}

// Mirrors weekly-actions.js's "week-day-select" branch exactly (same
// selectedWeekIndex/viewedWeekStart/selectedWeekDay/pendingScrollDate/
// weekCalendarMonth assignment), applied once loadWeekly() has resolved -
// from Athlete Home's own "Open today's training" button and week-strip day
// clicks, both of which need to land on a SPECIFIC date rather than
// whatever week Calendar would otherwise default to.
async function openWeeklyPlanOnDate(date) {
  if (state.activeTab !== "weekly") pushAppHistory();
  state.selectedProgramId = null;
  state.selectedTemplateId = null;
  state.navStack = [];
  state.activeTab = "weekly";
  state.openWeekCalendarOnLoad = false;
  collapseRailAfterNav();
  renderTabs();
  renderLibraryNav();
  await loadWeekly();
  const weeks = state.lastWeeklyData?.weeks || [];
  const weekIndex = weekIndexForDate(weeks, date);
  state.selectedWeekIndex = weekIndex >= 0 ? weekIndex : 0;
  state.viewedWeekStart = weekMondayIso(date);
  state.selectedWeekDay = date;
  state.pendingScrollDate = date;
  state.weekSelectorOpen = false;
  state.weekCalendarMonth = monthStartIso(date);
  state.navStack = [];
  renderWeeklyRoot(state.lastWeeklyData);
}

async function loadWeekly(options = {}) {
  return loadWeeklyData(
    { setLoading, renderEmpty, renderError, renderAthleteHeader, renderWeeklyRoot },
    options,
  );
}

async function loadPrograms(options = {}) {
  return loadProgramsData(
    { renderEmpty, setLoading, renderError, renderAthleteHeader, renderProgramToolbar, renderProgramRoot },
    options,
  );
}

async function loadTemplates(options = {}) {
  // Program Library's own list (/api/templates, see program-library-data.js
  // for its own caching) never depends on Organization data - the only
  // thing here that reads it is the sidebar's "Requests" badge count (see
  // updateProgramLibraryNavLabels/renderLibraryNav), which is allowed to be
  // a beat behind. If Organization data is already cached (fresh or stale -
  // renderOrganizationPanel/refreshOrganizationData own its own freshness),
  // this never fires at all. If nothing is cached yet this session, refresh
  // it in the background - never awaited here - so a slow /api/organization
  // can never delay the template list itself.
  if (state.activeTab === "templates" && state.currentUser?.role !== "athlete" && !state.organization.data) {
    void refreshOrganizationData({ silent: true }).then(() => {
      if (state.activeTab === "templates") renderLibraryNav();
    });
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

// Specific Program just published/assigned - opens the athlete's own
// Specific Programs view with that exact plan selected, resolved by id
// (mirrors the click handling wireProgramToolbar/wireAthleteProgramsPanel
// already use when a program card/chip is clicked directly).
async function openSpecificProgramFromNotification(planId) {
  if (state.activeTab !== "programs") pushAppHistory();
  state.activeTab = "programs";
  state.selectedProgramId = planId;
  state.selectedTemplateId = null;
  state.navStack = [];
  collapseRailAfterNav();
  renderTabs();
  renderLibraryNav();
  await loadPrograms();
  const programs = state.lastProgramBundle?.programs || [];
  openSpecificProgramOverlay();
  renderProgramToolbar(programs);
  renderProgramRoot(programs.find((program) => program.id === state.selectedProgramId));
}

// WELLNESS invitation/reminder click (athlete side) - switches to Tests and
// opens the athlete's own assignment form directly, same as tapping it from
// Today would. openTestAssignmentForm (tests-actions.js's own openAssignment)
// already 404s safely if this assignment somehow isn't this athlete's own -
// see GET /api/tests/assignments/:id's own athlete_id check.
async function openTestAssignment(assignmentId) {
  state.activeTab = "tests";
  state.navStack = [];
  renderTabs();
  renderLibraryNav();
  await openTestAssignmentForm(assignmentId, renderTests);
}

// Coach live digest click - switches to Tests -> Today. loadTests()/
// loadTestsSection() (tests-data.js) already branch internally on
// isAthleteMode(), so this same function also correctly opens the
// ATHLETE's own Today list when called from an athlete session (Home's
// "multiple WELLNESS assignments waiting" card, item 5) - no separate
// athlete-only variant needed.
async function openTestsToday() {
  state.activeTab = "tests";
  state.tests.section = "today";
  state.tests.scheduleDetail = null;
  state.tests.form = null;
  state.navStack = [];
  renderTabs();
  renderLibraryNav();
  await loadTests({ setLoading, renderTests });
}

// Final coach digest click - switches to Tests -> Results, filtered to the
// schedule this occurrence belongs to (the same scheduleId filter the
// Results tab's own UI already supports).
async function openTestsResults(scheduleId) {
  state.activeTab = "tests";
  state.tests.section = "results";
  state.tests.resultsScheduleId = scheduleId || "";
  state.tests.scheduleDetail = null;
  state.tests.form = null;
  state.navStack = [];
  renderTabs();
  renderLibraryNav();
  await loadTests({ setLoading, renderTests });
}

// training_load external invitation/reminder/manual-reminder click
// (athlete side) - switches to the athlete's own Home and opens the RPE
// form for this exact assignment directly, same as tapping the Home card
// would. openExternalAssignmentFromNotification (training-load-actions.js)
// re-fetches Today (and, if not found there, the athlete's own weekly
// overlay) before opening the form, since a notification click can happen
// before Home's own data has ever been loaded this session.
async function openTrainingLoadAssignment(assignmentId) {
  state.activeTab = "athlete-home";
  state.navStack = [];
  await loadAthleteHome();
  await openExternalAssignmentFromNotification(assignmentId);
  renderTabs();
  renderLibraryNav();
  renderActiveTrainingLoadSurface();
}

// Final digest click (coach side) - switches to Training load -> Results,
// on the week containing the occurrence's own scheduled date (from the
// notification's own metadata.scheduledDate - see
// trainingLoadNotificationWorker.js's own runFinalDigestPhase).
async function openTrainingLoadResults(scheduledDate) {
  state.activeTab = "training-load";
  setTrainingLoadSection("results");
  state.navStack = [];
  if (scheduledDate) {
    const nav = state.trainingLoad.weekly.results;
    nav.weekStart = weekMondayIso(scheduledDate);
    nav.selectedDate = scheduledDate;
    // Phase B: this is a real entry point into Athletes' own week, same as
    // any of its Prev/Next/Today controls - must keep the Data & Analysis
    // shared week in sync too, or switching to Activities right after
    // opening a notification would show a stale, unrelated week.
    syncDataAnalysisSharedWeek(nav.weekStart, "results");
  }
  renderTabs();
  renderLibraryNav();
  await loadTrainingLoadWeekly("results");
  renderTrainingLoad();
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
  // 3B3 UX slice: clicking anywhere in the Analysis From/To field (not just
  // the tiny native calendar-icon glyph) opens the date picker. The label
  // wraps the input, so a click on the "From"/"To" text also lands here via
  // the browser's own label -> control click forwarding (target becomes the
  // input itself either way). Returns immediately - the click itself never
  // changed the field's value, so it must not fall through into the
  // period-from/period-to query-refresh branch further down (shared with
  // handleContentChange, which is what actually fires once the picker's own
  // native "change" event carries a real new date) - letting it fall
  // through fired a needless /query POST on every open, and the render it
  // triggered replaced this very <input> mid-open, closing the picker
  // that had just been shown.
  if (type === "training-load-analysis-period-from" || type === "training-load-analysis-period-to") {
    action.showPicker?.();
    return;
  }
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
  if (type === "confirm-email-change") {
    await submitConfirmEmailChangeAction(action);
    return;
  }
  if (type === "email-change-resend" || type === "email-change-cancel") {
    await submitEmailChangeAction(type, action);
    return;
  }
  if (type === "coach-home-picker-open") {
    const mode = ["load", "day"].includes(action.dataset.mode) ? action.dataset.mode : "plan";
    coachHomePicker = { mode, date: mode === "day" ? action.dataset.date || "" : "", query: "" };
    renderCoachHome({ rows: coachHomeRows, error: "" });
    return;
  }
  if (type === "coach-home-picker-close") {
    closeCoachHomePicker();
    return;
  }
  // Home's error state (renderErrorStateHtml, coach-home.js): the same
  // loader the tab entry uses, forced past the cache - a failed first load
  // is never cached, a stale good entry must not be re-shown as the answer.
  if (type === "coach-home-retry") {
    await loadCoachHome({ forceRefresh: true });
    return;
  }
  if (type === "coach-home-open-athlete") {
    const row = coachHomeRows.find((entry) => entry.athleteId === action.dataset.athleteId);
    if (!row) return;
    if (action.dataset.mode === "load") {
      if (!row.athleteUuid) return;
      closeCoachHomePicker();
      pushAppHistory();
      collapseRailAfterNav();
      state.trainingLoad.filter.athleteIds = [row.athleteUuid];
      state.trainingLoad.filter.clubIds = [];
      state.trainingLoad.filter.teamIds = [];
      state.selectedAthleteId = row.athleteId;
      els.context.textContent = "Training Load";
      els.title.textContent = row.athlete;
      els.toolbar.innerHTML = "";
      renderAthleteList();
      await openTrainingLoadResults();
      await handleTrainingLoadAction({ dataset: { action: "training-load-results-open-athlete", athleteId: row.athleteUuid } }, { renderTrainingLoad, openWeeklyPlanForAthleteOnDate });
      return;
    }
    closeCoachHomePicker();
    pushAppHistory();
    state.selectedAthleteId = action.dataset.athleteId;
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
    if (action.dataset.mode === "day") await openWeeklyPlanOnDate(/^\d{4}-\d{2}-\d{2}$/.test(action.dataset.date || "") ? action.dataset.date : localDateIso());
    else await loadWeekly();
    return;
  }
  // Home's library cards: the title opens the library itself, the menu's
  // way; an exercise or a program opens in it.
  if (type === "coach-home-open-library") {
    await openLibraryTab(action.dataset.library === "programs" ? { libraryTab: "templates", templateScope: "my_programs" } : { libraryTab: "exercises" });
    return;
  }
  if (type === "coach-home-open-exercise") {
    const exercise = state.coachHome.exercises.items.find((entry) => String(entry.id) === action.dataset.exerciseId);
    if (!exercise || !(await openLibraryTab({ libraryTab: "exercises" })) || state.activeTab !== "exercises") return;
    // In the library's own list (with its order around it) when it is there,
    // else on its own - the library may be filtered or not yet paged that far.
    const itemId = (state.exerciseDetail.ids || []).find((id) => String(getItemById(id)?.id) === String(exercise.id)) || registerItem(exercise);
    pushAppHistory();
    await renderExerciseDetail(getItemById(itemId), itemId);
    return;
  }
  if (type === "coach-home-open-program") {
    const template = state.coachHome.programs.items.find((entry) => String(entry.plan_id) === action.dataset.templateId);
    if (!template || !(await openLibraryTab({ libraryTab: "templates", templateScope: "my_programs" })) || state.activeTab !== "templates") return;
    await openTemplatePreviewFromCoachProgram(template, () => renderTemplateLibrary(state.lastTemplates));
    return;
  }
  if (handleCoachHomeAction(action, { root: els.content, onChange: refreshCoachHomeSection })) return;
  if (type === "athlete-home-open-today" || type === "athlete-home-open-day") {
    await openWeeklyPlanOnDate(action.dataset.date || localDateIso());
    return;
  }
  if (type === "athlete-home-open-wellness") {
    const count = Number(action.dataset.count || 0);
    // A single open assignment deep-links straight to it (the exact same
    // flow a WELLNESS notification click already uses); more than one
    // routes to the athlete's own Tests -> Today list instead of guessing
    // which one to open.
    if (count === 1 && action.dataset.assignmentId) await openTestAssignment(action.dataset.assignmentId);
    else await openTestsToday();
    return;
  }
  if (type === "specific-program-close") {
    closeSpecificProgramOverlay();
    return;
  }
  if (type === "athlete-home-quick-tab") {
    const targetTab = action.dataset.targetTab || "weekly";
    const nextTab = targetTab === "calendar" ? "weekly" : targetTab;
    if (state.activeTab !== nextTab) pushAppHistory();
    state.selectedProgramId = null;
    state.selectedTemplateId = null;
    state.navStack = [];
    state.weekSelectorOpen = false;
    // hotfix/athlete-mobile-navigation: no longer targetTab === "calendar" -
    // see athlete-mobile-navigation.test.mjs for why.
    state.openWeekCalendarOnLoad = false;
    state.activeTab = nextTab;
    collapseRailAfterNav();
    renderTabs();
    renderLibraryNav();
    await loadActiveTab();
    return;
  }
  if (type === "weekly-create-plan") {
    if (isAthleteMode() || state.currentUser?.role === "athlete") return;
    const athleteId = state.selectedAthleteId;
    const weekStart = state.viewedWeekStart || weekMondayIso(localDateIso());
    state.activeTab = "builder";
    state.navStack = [];
    renderTabs();
    renderLibraryNav();
    setLoading("Creating weekly plan...");
    try {
      const created = await api("/api/builder/plans", {
        method: "POST",
        body: JSON.stringify({
          planType: "weekly",
          athleteIds: athleteId ? [athleteId] : [],
          weekStart,
        }),
      });
      state.builder = emptyBuilderState({ planType: "weekly", entryType: "weekly", weekStart, draft: created });
      await loadBuilder();
    } catch (error) {
      state.builder = emptyBuilderState({ planType: "weekly", entryType: "weekly", weekStart });
      renderBuilder();
      renderBuilderError(error);
    }
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
    state.exerciseDetail.currentId = null;
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
  if (type === "open-exercise" && state.activeTab === "exercises") {
    const item = getItemById(action.dataset.itemId);
    if (!item?.id) return;
    try { await api(`/api/exercises/${encodeURIComponent(item.id)}`); }
    catch { await refreshExerciseLibraryAccess(); return; }
  }
  if (handleExerciseDetailAction(action, {
    getItemById,
    moveExerciseDetail,
    pushAppHistory,
    renderCurrentNode,
    renderExerciseDetail,
  })) return;
  if (await handleExerciseLibraryAction(action, { renderExercises, setLoading })) return;
  if (type === "exercise-blocks-open") {
    const { openExerciseBlocks } = await import("./exercise-blocks.js");
    await openExerciseBlocks({ renderExercises, setLoading });
    return;
  }
  if (type === "exercise-collections-open") {
    // After a save the Blocks view it was opened from is read again.
    await openExerciseCollections(async () => {
      invalidateExercisesCache();
      if (state.activeTab === "exercises") await reloadExerciseLibrarySurface({ renderExercises, setLoading });
    }, action.dataset.collectionId || "");
    return;
  }
  if (type === "exercise-classification") {
    await openExerciseClassification(action.dataset.exerciseId, state.exerciseSearch.options, async () => {
      state.exerciseSearch.options = {};
      await exerciseEditorHandlers.refreshAfterSave();
    }, { canManageBlocks: state.exerciseSearch.canManageCollections === true });
    return;
  }
  if (type === "exercise-edit-open" || type === "exercise-copy-open") {
    void openExerciseEditor(state, exerciseEditorHandlers, action.dataset.exerciseId || "", { copy: type === "exercise-copy-open" });
    return;
  }
  if (type === "exercise-add-open") {
    void openExerciseEditor(state, exerciseEditorHandlers, "");
    return;
  }
  if (await handleExerciseEditorAction(state, exerciseEditorHandlers, action)) return;
  if (type === "coach-message") {
    const coachUserId = action.dataset.coachUserId || "";
    if (!coachUserId || action.disabled) return;
    action.disabled = true;
    try {
      const result = await api("/api/messages/direct", { method: "POST", body: JSON.stringify({ coachUserId }) });
      await openMessageConversation(result.conversationId);
    } catch (error) {
      state.coaches = { ...state.coaches, error: error.message || "Could not open conversation." };
      renderCoachContext();
    } finally {
      action.disabled = false;
    }
    return;
  }
  if (handleCoachProfileAction(action, { renderCoachContext, renderCurrentNode })) return;
  if (handleTemplateLibraryAction(action, { loadTemplates, renderCoachContext, renderTemplateLibrary })) return;
  if (await handleDataSourcesAction(action, { render: renderDataSourcesSurface })) return;
  if (await handleSourceConnectionsAction(action, { render: renderDataSourcesSurface, openDataSources: openDataSourcesFromSourceConnections })) return;
  if (await handleStorageAdminAction(action, { render: renderDataSourcesSurface })) return;
  if (await handleOrganizationAction(action, {
    loadAthletes,
    refreshOrganizationData,
    renderAfterOrganizationAccessChange,
    renderOrganizationPanel,
  })) return;
  if (await handleTaxonomyAction(action, { renderOrganizationPanel })) return;
  if (await handleIconGalleryAction(action)) return;
  if (handleWeeklyAction(action, { moveWeek, renderWeeklyRoot })) return;
  if (await handleTestsAction(action, { renderTests: renderActiveTestsSurface })) return;
  if (await handleVariablesAction(action, { render: renderActiveTrainingLoadSurface })) return;
  if (await handleSourceFieldsAction(action, { render: renderActiveTrainingLoadSurface })) return;
  if (await handleTrainingLoadAction(action, { renderTrainingLoad: renderActiveTrainingLoadSurface, openWeeklyPlanForAthleteOnDate })) return;
  handleMediaAction(action);
}

// Both the normal in-app Tests tab and the public /tests/check-in/:token
// page (see check-in-actions.js) render WELLNESS form markup into the same
// #content element through the same delegated click/input/submit listeners
// - this picks the right re-render for whichever one is actually on screen,
// so tests-actions.js's shared WELLNESS handlers never need to know which
// context they were called from.
function renderActiveTestsSurface() {
  if (state.checkIn.token) return renderCheckInContent();
  return renderTests();
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
  if (state.activeTab === "coach-account") return renderCoachAccount();
  if (state.activeTab === "athlete-library") return renderAthleteLibrary();
  if (state.activeTab === "tests") return renderTests();
}

function moveWeek(delta) {
  const weeks = state.lastWeeklyData?.weeks || [];
  const currentStart = state.viewedWeekStart || weeks[Math.max(0, Math.min(weeks.length - 1, state.selectedWeekIndex))]?.weekStart || weekMondayIso(localDateIso());
  state.viewedWeekStart = addDaysIso(currentStart, delta * 7);
  state.navStack = [];
  renderWeeklyRoot(state.lastWeeklyData);
}

function renderTabs() {
  const isLibraryTab = ["organization", "templates", "exercises", "builder", "coaches"].includes(state.activeTab);
  const tabs = document.querySelectorAll(".tab");
  const tabsContainer = tabs[0]?.closest(".tabs");
  if (tabsContainer) tabsContainer.hidden = isLibraryTab;
  tabs.forEach((tab) => tab.classList.toggle("is-active", tab.dataset.tab === state.activeTab));
  // Every navigation path away from the Programs tab (every tab/library-tab/
  // athlete-tab click handler, roughly a dozen call sites) already calls
  // renderTabs() right after resetting state.selectedProgramId - this is
  // the one choke point all of them share, so it's the safe place to also
  // force-close a still-open Specific Program overlay rather than editing
  // every one of those call sites (and risking missing one, which would
  // leave document.body's scroll-lock class stuck on forever). Only a
  // state/class reset - never renderProgramRoot(), since loadActiveTab()
  // is about to replace els.content with the new tab's own content anyway.
  if (state.activeTab !== "programs" && state.specificProgramOverlayOpen) {
    state.specificProgramOverlayOpen = false;
    document.body.classList.remove("specific-program-open");
  }
}

function renderAthleteListState() {
  els.athleteList.classList.toggle("is-expanded", state.athletesExpanded);
  els.athletesToggle?.setAttribute("aria-expanded", String(state.athletesExpanded));
  document.body.classList.toggle("athletes-drawer-open", state.athletesExpanded);
}

const ORGANIZATION_CACHE_NAMESPACE = "organization";

// The /api/organization payload differs per account and per active
// workspace only - never per Settings sub-tab (Overview/Users/Clubs/Teams/
// Athletes/Tags & Presets/Join links all read the exact same payload, just
// render different slices of it - see renderOrganizationPanelHtml). That's
// the whole reason Settings sub-tab switches can safely reuse this cache
// entry instead of refetching.
function organizationContextKey() {
  return buildContextKey(currentUserWorkspaceContextParts());
}

// Settings -> Data sources and Source connections repaint through the
// Settings panel they live in - only while Settings is the active tab: a
// Connect or Test can take many seconds, and its late answer must never paint
// the Settings panel over another screen (the slice keeps the outcome; the
// tab's re-entry shows it).
function renderDataSourcesSurface() {
  if (state.activeTab !== "organization") return;
  void renderOrganizationPanel({ refresh: false });
}

// From Source connections to the approved pair: the existing Data sources
// tab (platform admin only), where the GPEXE Team ID of a team is set.
function openDataSourcesFromSourceConnections() {
  state.organization.section = "dataSources";
  enterDataSourcesSection();
  void renderOrganizationPanel({ refresh: false });
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

  const paintOrganizationPanel = async () => {
    if (state.organization.section === "presets" && !state.taxonomy.loaded) {
      await loadTaxonomyData();
    }
    // A team is chosen but its data is not loaded yet (the tab was opened
    // again after a workspace or Settings reload): read it once. Every write
    // on the screen reloads the team itself, so this never repeats.
    const dataSources = state.dataSources;
    if (state.organization.section === "dataSources" && dataSources.teamId && !dataSources.status && !dataSources.loading && !dataSources.error) {
      void loadDataSources(renderDataSourcesSurface);
    }
    // Source connections (F3c3): the same one-shot read of the club on
    // screen - also after a workspace switch left a previous club loaded;
    // without a chosen club (platform workspace) nothing is sent.
    if (state.organization.section === "sourceConnections" && sourceConnectionsNeedLoad()) {
      void loadSourceConnections(renderDataSourcesSurface);
    }
    // Storage (PR 5): the same one-shot read of the defaults and the accounts.
    if (state.organization.section === "storage" && storageAdminContext(state.organization.data) && storageAdminNeedsLoad()) {
      void loadStorageAdmin(renderDataSourcesSurface);
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
  };

  await loadCachedView({
    namespace: ORGANIZATION_CACHE_NAMESPACE,
    contextKey: organizationContextKey(),
    forceRefresh: refresh,
    fetcher: () => api("/api/organization"),
    showLoading: () => setLoading("Loading organization..."),
    applyData: (data) => {
      state.organization.data = data;
      state.organization.error = "";
      return paintOrganizationPanel();
    },
    applyError: (error) => {
      state.organization.error = error.message || "Could not load organization.";
      state.organization.data = null;
      return paintOrganizationPanel();
    },
    getCurrentContextKey: organizationContextKey,
  });
}

// A switch between two non-athlete workspaces (e.g. club A -> club B) never
// needs a full page reload - just a re-fetch of whatever workspace-scoped
// data is currently on screen. Coaches, Organization, Program Library, and
// Exercise Library are all workspace-scoped (their view-cache context key
// includes currentUserWorkspaceContextParts - see access.js), so the new
// workspace's context key is already different from the old one on its
// own; this is never at risk of showing the old workspace's cached data
// even for an instant. forceRefresh:true is still passed explicitly so a
// workspace this account happened to already visit earlier in the session
// is re-verified against the server rather than trusted purely from cache.
async function onWorkspaceChanged() {
  resetExercisesForWorkspaceChange();
  state.organizationUserSelection = { active: false, ids: new Map(), note: "" };
  clearAthleteFilters();
  const generation = ++workspaceRosterGeneration;
  const contextKey = buildContextKey(currentUserWorkspaceContextParts());
  coachHomeRows = [];
  coachHomePicker = { mode: "", query: "" };
  resetCoachHomeForWorkspaceChange();
  state.athletes = [];
  state.selectedAthleteId = null;
  renderAthleteList();
  if (state.activeTab === "weekly" || state.activeTab === "programs") state.activeTab = "coach-home";
  // Correction: a workspace switch changes WHICH athletes' data Training
  // load's coach scope resolves to (see backend/src/routes/trainingLoad.js's
  // coachWorkspaceScopeSql) - the OLD workspace's filter selection, org-
  // picker roster, and cached weekly payload must never silently carry
  // over into the new one, even for a tab that isn't currently open (so a
  // later re-entry into it never renders a stale cross-workspace flash
  // before its own fresh fetch lands).
  resetTrainingLoadForWorkspaceChange();
  renderTabs();
  renderLibraryNav();
  if (["organization", "coach-home", "coaches", "templates", "exercises", "tests", "training-load"].includes(state.activeTab)) setLoading("Loading workspace...");
  try {
    const roster = await api("/api/admin/athletes");
    if (generation !== workspaceRosterGeneration || contextKey !== buildContextKey(currentUserWorkspaceContextParts())) return;
    state.athletes = roster.adminRows || [];
    renderAthleteList();
  } catch (error) {
    if (generation !== workspaceRosterGeneration || contextKey !== buildContextKey(currentUserWorkspaceContextParts())) return;
    renderError(error);
    return;
  }
  // Source connections (F3c3): the new workspace may be another club; the
  // loaded list is dropped (unless a write is in flight) and read again.
  if (state.organization.section === "sourceConnections") enterSourceConnectionsSection();
  if (state.activeTab === "organization") return renderOrganizationPanel();
  if (state.activeTab === "coach-home") return loadCoachHome({ forceRefresh: true });
  if (state.activeTab === "coaches") return loadCoaches({ forceRefresh: true });
  if (state.activeTab === "templates") return loadTemplates({ forceRefresh: true });
  if (state.activeTab === "exercises") return loadExercises({ renderExercises, setLoading }, { forceRefresh: true });
  if (state.activeTab === "tests") return loadTests({ setLoading, renderTests });
  if (state.activeTab === "training-load") return loadTrainingLoad();
}

// The shared post-mutation refresh every organization-actions.js handler
// already calls by name (grant/revoke roles, login-status, archive/restore,
// invite/join-link actions, club/team/athlete/user CRUD - see
// handleOrganizationAction's many `refreshOrganizationData?.()` call sites).
// Left with the exact same name/signature/behavior (always a real forced
// fetch, updates state.organization.data/error, `silent` swallows vs.
// rethrows) so none of those call sites need to change - the only addition
// is that the fresh result is also written into the cache, so the very next
// navigation into Settings (or Program Library's accessRequests badge) sees
// it immediately instead of triggering yet another fetch.
async function refreshOrganizationData({ silent = false } = {}) {
  const contextKey = organizationContextKey();
  try {
    const data = await dedupeRequest(ORGANIZATION_CACHE_NAMESPACE, contextKey, () => api("/api/organization"));
    setCacheData(ORGANIZATION_CACHE_NAMESPACE, contextKey, data);
    // The cache write above is always correct (it's keyed by the context this
    // request was actually issued for), but this function also writes
    // directly into the live render state below - unlike renderOrganizationPanel,
    // which goes through loadCachedView's own race guard. The caller that
    // fires this in the background without awaiting it (loadTemplates()'s
    // `void refreshOrganizationData({ silent: true })`) means a workspace or
    // account switch can complete before this resolves; without this check a
    // late response for the OLD context would silently overwrite
    // state.organization.data with another workspace's data.
    if (organizationContextKey() !== contextKey) return;
    state.organization.data = data;
    state.organization.error = "";
  } catch (error) {
    setCacheError(ORGANIZATION_CACHE_NAMESPACE, contextKey, error);
    if (organizationContextKey() !== contextKey) return;
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
  const filteredAthletes = state.athletes.filter((athlete) => athleteMatches(athlete, search));
  const athletes = filteredAthletes;

  els.athleteList.innerHTML = renderAthleteListHtml(athletes, state.selectedAthleteId);

  renderAthleteListState();

  els.athleteList.querySelectorAll(".athlete-button").forEach((button) => {
    button.addEventListener("click", () => {
      if (!confirmLeaveTrainingLoad("weekly")) return;
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

// hotfix/athlete-mobile-navigation: labeled "Account" (not "Settings")
// throughout the athlete shell - an athlete doesn't configure anything the
// way a coach does on the coach shell's own, separate Settings/organization
// panel (renderOrganizationPanel, untouched), they only ever edit their own
// personal data/login/password here. state.activeTab's internal value
// ("athlete-settings") and every data-athlete-tab/data-target-tab wired to
// it are deliberately left unrenamed - this is a user-facing label change
// only, not a route/id rename.
async function renderAthleteSettings() {
  const athlete = state.athletes.find((entry) => entry.athlete_id === state.selectedAthleteId);
  // hotfix/athlete-mobile-navigation: no longer renderAthleteHeader({}) -
  // that hero+Weekly/Specific-tabs toolbar exists to switch between those
  // two views, which doesn't apply once already on Account, and duplicated
  // the athlete's name/photo the compact sticky identity row below already
  // shows (renderAthleteSettingsIdentityHtml in athlete-view.js).
  els.toolbar.innerHTML = "";
  els.context.textContent = "Athlete account";
  els.title.textContent = "Account";
  els.content.innerHTML = renderAthleteSettingsHtml(athlete, state.currentUser, null, null);
  const [emailChangeStatus, profile] = await Promise.all([
    api("/api/auth/account/email-change/status").catch(() => null),
    api("/api/athlete-profile").catch(() => ({ error: true })),
  ]);
  // Guard against a slow fetch resolving after the user has already
  // navigated off Settings (or switched workspace) - see the same pattern
  // at every other state.activeTab === "..." check in this file.
  if (state.activeTab !== "athlete-settings") return;
  els.content.innerHTML = renderAthleteSettingsHtml(athlete, state.currentUser, emailChangeStatus, profile);
}

// Coach-mode counterpart of renderAthleteSettings() above - same two-pass
// (render immediately, then patch in emailChangeStatus once it loads)
// pattern, just without the athlete-only personal-data/photo fetch since a
// coach has no athlete profile row of their own.
async function renderCoachAccount() {
  els.toolbar.innerHTML = "";
  els.context.textContent = "Account";
  els.title.textContent = "Account";
  els.content.innerHTML = renderCoachAccountHtml(state.currentUser, null);
  const emailChangeStatus = await api("/api/auth/account/email-change/status").catch(() => null);
  if (state.activeTab !== "coach-account") return;
  els.content.innerHTML = renderCoachAccountHtml(state.currentUser, emailChangeStatus);
}

// security/verified-email-change: the email-change endpoints return short
// machine codes (see backend/src/routes/auth.js), not display text, since
// the same codes are reused by the platform-admin-initiated endpoints in
// organization.js. Map the ones a self-service athlete can actually trigger
// to plain language here; anything unrecognized (eg. "Unauthorized" from an
// expired session) falls back to the raw message, which is already
// human-readable for every other error this app surfaces.
const EMAIL_CHANGE_ERROR_MESSAGES = {
  INVALID_CURRENT_PASSWORD: "Current password is incorrect.",
  INVALID_EMAIL: "Enter a valid email address.",
  EMAIL_UNCHANGED: "That's already your current login email.",
  EMAIL_ALREADY_IN_USE: "That email is already in use by another account.",
  EMAIL_SEND_FAILED: "Could not send the verification email. Please try again.",
  RESEND_TOO_SOON: "Please wait a bit before requesting another link.",
  NO_PENDING_EMAIL_CHANGE: "There is no pending email change to update.",
};

function emailChangeErrorMessage(error) {
  return EMAIL_CHANGE_ERROR_MESSAGES[error?.message] || error?.message || "Something went wrong.";
}

// The email-change-request/resend/cancel forms are shared verbatim between
// the athlete Account page and the coach Account page (both render through
// renderAccountEmailPasswordSectionsHtml, athlete-view.js) - re-render
// whichever one is actually on screen after a successful call, instead of
// hardcoding the athlete-only renderAthleteSettings().
async function refreshAccountSettingsView() {
  if (state.activeTab === "coach-account") return renderCoachAccount();
  return renderAthleteSettings();
}

async function submitEmailChangeAction(type, action) {
  if (action.disabled) return;
  const container = action.closest(".account-email-pending");
  const error = container?.querySelector("[data-role='email-change-pending-error']");
  if (error) error.textContent = "";
  action.disabled = true;
  try {
    const endpoint = type === "email-change-resend" ? "/api/auth/account/email-change/resend" : "/api/auth/account/email-change/cancel";
    await api(endpoint, { method: "POST" });
    await refreshAccountSettingsView();
  } catch (submitError) {
    if (error) error.textContent = emailChangeErrorMessage(submitError);
    action.disabled = false;
  }
}

async function renderAthleteLibrary() {
  renderAthleteHeader({});
  state.templateScope = state.templateScope === "workspace" || state.templateScope === "all" ? "my_programs" : state.templateScope;
  await loadTemplates();
}

function buildBlankWeek(weekStart) {
  const days = [];
  for (let offset = 0; offset < 7; offset += 1) {
    days.push({ date: addDaysIso(weekStart, offset), slots: {}, dayNote: "" });
  }
  return { weekStart, weekEnd: addDaysIso(weekStart, 6), days, planId: null };
}

function renderWeeklyRoot(data) {
  renderLibraryNav();
  const weeks = data?.weeks || [];
  const fallbackStart = weeks[Math.max(0, Math.min(weeks.length - 1, state.selectedWeekIndex))]?.weekStart || weekMondayIso(localDateIso());
  const viewedStart = state.viewedWeekStart || fallbackStart;
  const matchedIndex = weeks.findIndex((week) => week.weekStart === viewedStart);
  if (matchedIndex >= 0) state.selectedWeekIndex = matchedIndex;
  state.viewedWeekStart = viewedStart;
  const activeWeek = matchedIndex >= 0 ? weeks[matchedIndex] : buildBlankWeek(viewedStart);
  const weekSelectorMarkup = state.weekSelectorOpen ? renderWeekCalendarPicker(weeks, activeWeek) : "";

  els.content.innerHTML = renderWeeklyRootHtml({
    activeWeek,
    copyPlanModal: renderCopyPlanModal(state),
    makeNode,
    renderPlanMoreMenu,
    weekSelectorMarkup,
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
  els.toolbar.querySelector(".athlete-programs-panel")?.remove();

  // feature/athlete-programs-profile: athlete mode gets visual template
  // cards; the coach side of this same tab (managing a specific athlete's
  // programs) keeps the original chip toolbar below, completely
  // unchanged - this only branches the athlete's OWN view.
  if (isAthleteMode()) {
    if (!programs.length) return;
    els.toolbar.insertAdjacentHTML("beforeend", renderAthleteProgramsPanelHtml(programs, state.selectedProgramId, state.athleteProgramsSearchQuery));
    wireAthleteProgramsPanel(programs);
    return;
  }

  els.toolbar.insertAdjacentHTML("beforeend", renderProgramToolbarHtml(programs, state.selectedProgramId, renderPlanMoreMenu));
  els.toolbar.querySelectorAll(".program-toolbar .chip").forEach((button) => {
    button.addEventListener("click", () => {
      state.selectedProgramId = button.dataset.programId;
      state.navStack = [];
      openSpecificProgramOverlay();
      renderProgramToolbar(programs);
      renderProgramRoot(programs.find((program) => program.id === state.selectedProgramId));
    });
  });
}

function wireAthleteProgramsPanel(programs) {
  const panel = els.toolbar.querySelector(".athlete-programs-panel");
  if (!panel) return;
  const railContainer = panel.querySelector(".athlete-program-cards-rail-container");

  function renderRail() {
    if (!railContainer) return;
    railContainer.innerHTML = renderAthleteProgramCardsRailHtml(programs, state.selectedProgramId, state.athleteProgramsSearchQuery);
    railContainer.querySelectorAll("[data-action='athlete-program-open']").forEach((button) => {
      button.addEventListener("click", () => {
        state.selectedProgramId = button.dataset.programId;
        state.navStack = [];
        openSpecificProgramOverlay();
        renderProgramToolbar(programs);
        renderProgramRoot(programs.find((program) => program.id === state.selectedProgramId));
      });
    });
  }

  // The search input is rendered once by renderAthleteProgramsPanelHtml and
  // deliberately never replaced here - only railContainer's innerHTML is
  // touched on each keystroke, so the input never loses keyboard focus
  // mid-search. No API call is made for any of this; it filters the
  // already-loaded `programs` array in memory.
  const searchInput = panel.querySelector("[data-action='athlete-programs-search']");
  if (searchInput) {
    searchInput.addEventListener("input", () => {
      state.athleteProgramsSearchQuery = searchInput.value;
      renderRail();
    });
  }

  // hotfix/athlete-mobile-navigation: renderRail() is where the card-open
  // click listeners actually get attached, but until now it was only ever
  // invoked from the search input's own "input" handler above - never once
  // on initial mount. The cards from renderAthleteProgramsPanelHtml() (the
  // caller's insertAdjacentHTML, before this function ever runs) were
  // already in the DOM with correct markup, just with no click listener at
  // all, so every tap silently did nothing. That's invisible for athletes
  // with >ATHLETE_PROGRAMS_SEARCH_THRESHOLD programs (the search box exists
  // and typing into it happens to wire the buttons as a side effect) but
  // permanently broken for the common case of 3 or fewer programs, where no
  // search box is rendered and renderRail() would otherwise never run.
  renderRail();
}
function renderProgramRoot(program) {
  if (!program) return renderEmpty("This athlete has no specific programs.");
  // The overlay only ever opens from an explicit click (see the chip/card
  // click handlers below) - a program can be "selected" (highlighted in
  // the still-visible list, targeted by the more-menu) without its overlay
  // being open, e.g. right after Back/Escape closed it, or on a fresh tab
  // entry. Every other call site here (background refreshes, renderCopyPlanSource,
  // exitBuilderToPlanContext) just re-supplies whichever program is
  // currently selected/refreshed - none of them should force the overlay
  // open on their own.
  if (!state.specificProgramOverlayOpen) {
    els.content.innerHTML = `<div class="empty-state">Select a program to view its details.</div>`;
    return;
  }
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

function openSpecificProgramOverlay() {
  state.specificProgramOverlayOpen = true;
  document.body.classList.add("specific-program-open");
}

// Closes the Specific Program overlay without touching els.toolbar (the
// still-visible chip toolbar or athlete card rail) at all - whatever
// filter/search/scroll state was there survives simply because nothing
// here ever re-renders it. Returns false (no-op) when nothing was open, so
// callers in the Back/Escape cascades can tell whether they handled
// anything. selectedProgramId is deliberately left untouched (same
// contract the old athlete-program-back scroll-restore already had) - it
// still highlights the last-opened program and targets the more-menu.
function closeSpecificProgramOverlay() {
  if (!state.specificProgramOverlayOpen) return false;
  state.specificProgramOverlayOpen = false;
  document.body.classList.remove("specific-program-open");
  const programs = state.lastProgramBundle?.programs || [];
  renderProgramRoot(programs.find((program) => program.id === state.selectedProgramId) || null);
  return true;
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
  const detailHtml = renderNodeDetailHtml({
    crumbs,
    next,
    node,
    renderNodeButton,
    siblingState,
    terminalHtml: next.length ? "" : renderTerminalNode(node),
  });

  // Drilling into a domain/category/section from inside the Specific
  // Program overlay must stay inside the overlay's own chrome (backdrop,
  // header, scrollable .program-preview-body) - plainly swapping els.content
  // for the bare node-detail markup (the old behavior, still correct for
  // Weekly/Templates which are full-page, not modal) dropped the overlay
  // wrapper entirely while body.specific-program-open kept page scroll
  // locked, making anything below the fold unreachable. See
  // renderProgramNodeOverlayHtml's own comment in program-view.js.
  const program = state.specificProgramOverlayOpen
    ? (state.lastProgramBundle?.programs || []).find((entry) => entry.id === state.selectedProgramId)
    : null;
  if (program) {
    els.content.innerHTML = renderProgramNodeOverlayHtml({ nodeDetailHtml: detailHtml, program, renderPlanMoreMenu });
    return;
  }
  els.content.innerHTML = detailHtml;
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

  const keptScroll = capturePreviewScroll(document);
  const keptDraft = captureMetadataFormDraft(document);

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

  restoreMetadataFormDraft(keptDraft, document);
  restorePreviewScroll(keptScroll, document);
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
  const filters = state.templateScope === "my_programs"
    ? state.templateFilters
    : { ...state.templateFilters, lifecycle: "all" };
  const filtered = applyTemplateClientFilters(templates, filters);
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
// perf/main-navigation-cache Builder decision: a draft's structural/content
// edits (add/move/delete node/session/item/exercise, rename, dose changes -
// see builder-actions.js's queuedBuilderApi/setBuilderDraft) already
// autosave to the server on every single action; there is no separate
// "unsaved draft" state to protect on the happy path. The real risk this
// function used to carry was re-entering this tab (e.g. after a quick trip
// to Coaches) unconditionally re-GETting and OVERWRITING state.builder.draft
// - besides being a wasted request every time, that GET can race an
// in-flight autosave PATCH (whichever resolves last wins, silently
// reverting a just-made edit), and it wipes the whole view (scroll
// position, open exercise search, expanded sections) for no reason. Rather
// than folding the draft itself into the generic view-cache (its local copy
// IS the freshest known-good state between edits, so there's nothing useful
// a TTL-based cache would add), this simply stops re-fetching it on mere
// re-entry: an already-open draft is just re-rendered from what's already
// in memory. A real refetch stays available, unchanged, via the existing
// explicit refreshBuilderDraft() (see builder-data.js), still called by the
// small number of actions that already call it deliberately.
async function loadBuilder() {
  state.navStack = [];
  els.context.textContent = "Program builder";
  els.title.textContent = "Build a program";
  els.toolbar.innerHTML = "";
  void loadBuilderNodePresets().catch(() => {});
  if (!state.builder.draft) {
    renderBuilder();
    void loadBuilderDrafts().catch(renderBuilderError);
    return;
  }
  renderBuilder();
  await loadBuilderExercises();
}

function renderCopyPlanSource() {
  if (state.activeTab === "weekly") return renderWeeklyRoot(state.lastWeeklyData);
  if (state.activeTab === "programs") return renderProgramRoot((state.lastProgramBundle?.programs || []).find((program) => program.id === state.selectedProgramId));
  // "Assign to athlete" (see builder-view.js) opens this same copy modal
  // from INSIDE the open Builder - re-rendering the Builder itself (not the
  // Templates list) is the only way the modal actually appears on that path.
  if (state.activeTab === "builder") return renderBuilder();
  return loadTemplates();
}

async function handleBuilderAction(action) {
  if (state.builder.leaving || state.builder.batchSwitchPending || state.builder.openingDraftId) return;
  const leaving = ["builder-submit-plan", "builder-cancel", "builder-discard-current-draft"].includes(action.dataset.action);
  if (leaving) {
    state.builder.leaving = true;
    document.querySelector(".builder-workspace")?.setAttribute("inert", "");
  }
  try {
    if (await handleBuilderPlanAction(action, { renderBuilder, renderBuilderBatchSwitchProgress, renderBuilderDraftOpenProgress, flushBuilderAutosaves, renderCopyPlanSource, renderTabs, renderLibraryNav, loadBuilderExercises, loadBuilderDrafts })) return;
    if (await handleBuilderWorkspaceAction(action, { renderBuilder, renderBuilderExerciseViewChange, renderBuilderFiltersChange, renderBuilderSectionItems, renderBuilderError, loadBuilderExercises, ensureBuilderExercises: ensureBuilderExercisesQuietly })) return;
    if (await handleBuilderDraftAction(action, { renderBuilder, renderBuilderDiscardProgress, renderBuilderError, renderTabs, renderLibraryNav, loadWeekly, loadPrograms, loadTemplates, refreshBuilderDraft, flushBuilderAutosaves, cancelBuilderAutosaves })) return;
    if (await handleBuilderItemAction(action, { renderBuilder, renderBuilderSectionItems, renderBuilderAddFeedback, renderBuilderError, refreshBuilderDraft, cancelBuilderItemAutosave })) return;
  } finally {
    if (leaving) {
      state.builder.leaving = false;
      document.querySelector(".builder-workspace")?.removeAttribute("inert");
    }
  }
}

function renderBuilderError(error) {
  const message = error?.message || "Could not save this change.";
  els.content.insertAdjacentHTML("afterbegin", `<p class="builder-error builder-page-error" role="alert">${escapeHtml(message)}</p>`);
}

function renderExercises(exercises) {
  state.lastExerciseResults = exercises;
  els.context.textContent = "Exercise library";
  els.title.textContent = "Exercise Library";
  const itemIds = registerItems(exercises);
  state.exerciseDetail = { ids: itemIds, currentId: null };
  els.content.innerHTML = renderExerciseLibraryHtml({
    exercises,
    itemIds,
    markedExerciseIds: state.markedExerciseIds,
    search: state.exerciseSearch,
    selection: state.exerciseSelection,
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

async function renderExerciseDetail(item, itemId = state.exerciseDetail.currentId) {
  if (itemId) state.exerciseDetail.currentId = itemId;
  const exerciseId = item.exercise_id || item.id;
  if (exerciseId) {
    try {
      const detail = await api(`/api/exercises/${encodeURIComponent(exerciseId)}?archived=true`);
      item = { ...item, id: exerciseId, can_edit: detail.canEdit, can_copy: detail.canCopy,
        image_url: item.owner_scope ? detail.effectiveImageUrl || "" : item.image_url || detail.effectiveImageUrl || "",
        video_url: item.owner_scope ? detail.effectiveVideoUrl || "" : item.video_url || detail.effectiveVideoUrl || "",
        // The media descriptor (R2, FE-1): the detail's, else the item's own.
        media: detail.media && typeof detail.media === "object" ? detail.media : item.media || null };
    } catch {
      if (item.owner_scope) return;
      item = { ...item, can_edit: false, can_copy: false };
    }
  }
  if (state.exerciseDetail.currentId !== itemId) return;
  const ids = state.exerciseDetail.ids || [];
  const markup = renderExerciseDetailHtml({ item, itemId: state.exerciseDetail.currentId, ids, getItemById });
  els.content.querySelector(".exercise-detail-overlay")?.remove();
  els.content.insertAdjacentHTML("beforeend", markup);
  setExerciseOverlayBackgroundInert(true);
}

function renderExerciseEditorOverlay() {
  els.content.querySelector(".exercise-editor-overlay")?.remove();
  if (!state.exerciseEditor.open) return;
  els.content.insertAdjacentHTML("beforeend", renderExerciseEditorHtml(state.exerciseEditor, state.exerciseSearch.options));
}

async function refreshExerciseLibraryAccess() {
  document.querySelector(".exercise-classification-overlay")?.remove();
  invalidateExercisesCache();
  state.exerciseSearch.options = {};
  if (state.activeTab !== "exercises" && state.activeTab !== "builder") return;
  const editor = state.exerciseEditor;
  let keepEditor = editor.open && editor.isNew;
  if (editor.open && editor.exerciseId) {
    try { await api(`/api/exercises/${encodeURIComponent(editor.exerciseId)}`); keepEditor = true; }
    catch { keepEditor = false; }
  }
  state.exerciseEditor.open = false;
  state.tagEditor.open = false;
  for (const [id, item] of itemRegistry) if (item.owner_scope) itemRegistry.delete(id);
  state.exerciseDetail = { ids: [], currentId: null };
  if (state.activeTab === "exercises") {
    state.navStack = [];
    await reloadExerciseLibrarySurface({ renderExercises, setLoading });
  } else if (state.activeTab === "builder") {
    document.querySelector(".exercise-detail-overlay")?.remove();
    document.querySelector(".exercise-editor-overlay:not(.exercise-collections-overlay)")?.remove();
    await loadBuilderExercises();
  }
  if (keepEditor && state.exerciseEditor === editor) {
    editor.open = true;
    renderExerciseEditorOverlay();
  }
}

const exerciseEditorHandlers = {
  rerender: renderExerciseEditorOverlay,
  refreshAfterSave: async () => {
    // A new/edited exercise can appear in (or change within) any previously
    // cached search/filter combination, not just whatever's on screen right
    // now - clearing the whole namespace here is simpler and safer than
    // trying to guess which of many cached filter combinations are affected.
    invalidateExercisesCache();
    if (state.activeTab === "exercises") await loadExercises({ renderExercises, setLoading });
    else if (state.activeTab === "builder" && state.builder.selectedNodeId) await loadBuilderExercises();
  },
};

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

// hotfix/athlete-home-mobile-layout: els.connectionIndicator only exists on
// the athlete shell (athlete.html) - null on the coach shell, so this is a
// no-op there. Reflects the real EventSource connection state reported by
// realtime.js's onConnectionChange callback - never shown unless a real
// disconnect was actually observed.
function renderConnectionIndicator() {
  if (!els.connectionIndicator) return;
  els.connectionIndicator.hidden = !state.realtimeOffline;
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
