const API_BASE = "";

const EXERCISE_FILTERS = [
  { key: "purpose", label: "Purpose", optionsKey: "purposes" },
  { key: "quality", label: "Quality / modality", optionsKey: "qualities" },
  { key: "group", label: "Exercise group", optionsKey: "groups" },
  { key: "bodyPart", label: "Body part", optionsKey: "bodyParts" },
  { key: "movementPattern", label: "Movement pattern", optionsKey: "movementPatterns" },
  { key: "startingPosition", label: "Starting position", optionsKey: "startingPositions" },
  { key: "place", label: "Place", optionsKey: "places" },
  { key: "complexity", label: "Complexity", optionsKey: "complexities" },
  { key: "attractor", label: "Attractor", optionsKey: "attractors" },
  { key: "tag", label: "Tag", optionsKey: "tags" },
];

const emptyExerciseFilters = () => ({
  purpose: "",
  quality: "",
  group: "",
  bodyPart: "",
  movementPattern: "",
  startingPosition: "",
  place: "",
  complexity: "",
  attractor: "",
  tag: "",
  favorite: false,
  marked: false,
});

const emptyExerciseOptions = () => ({
  purposes: [],
  qualities: [],
  groups: [],
  bodyParts: [],
  movementPatterns: [],
  startingPositions: [],
  places: [],
  complexities: [],
  attractors: [],
  tags: [],
});

const emptyTemplateFilters = () => ({
  search: "",
  category: "",
  tag: "",
  creator: "",
  club: "",
  ownerType: "",
  visibility: "",
  pricing: "all",
});

const emptyTemplatePreview = (overrides = {}) => ({
  open: false,
  loading: false,
  detail: null,
  error: "",
  settingsOpen: false,
  reviewOpen: false,
  reviewMessage: "",
  reviewError: "",
  reviewsOpen: false,
  reviews: [],
  usedMarked: false,
  submittingUse: false,
  submittingReview: false,
  ...overrides,
});

const TEMPLATE_SCOPES = ["all", "workspace", "my", "club", "optimove", "marketplace"];
const ATHLETE_TEMPLATE_SCOPES = ["all", "my", "club", "optimove", "marketplace"];

const state = {
  currentUser: null,
  athletes: [],
  selectedAthleteId: null,
  athletesExpanded: false,
  railExpanded: false,
  activeTab: "weekly",
  templateScope: "my",
  selectedProgramId: null,
  selectedTemplateId: null,
  selectedWeekIndex: 0,
  selectedWeekDay: "",
  weekSelectorOpen: false,
  pendingScrollDate: "",
  lastWeeklyData: null,
  lastProgramBundle: null,
  lastTemplates: [],
  templateAllowedScopes: TEMPLATE_SCOPES,
  templatePreview: emptyTemplatePreview(),
  templateFilters: emptyTemplateFilters(),
  templateOptions: { categories: [], tags: [], creators: [], clubs: [] },
  lastExerciseResults: [],
  builder: { draft: null, planType: "program", weekStart: "", selectedSessionId: "", selectedNodeId: "", exerciseQuery: "", exerciseFilters: emptyExerciseFilters(), exercises: [], athletePickerOpen: false, sectionPickerOpen: false, createAthleteId: "", copyPlanId: "", copyPlanName: "", copyAthleteId: "", clipboard: null, showNote: false, addNodeOpen: false, sessionModalBlockId: "", structureModalOpen: false, infoOpen: "", customExerciseOpen: false },
  exerciseSearch: { term: "", limit: 30, hasMore: false, filters: emptyExerciseFilters(), options: emptyExerciseOptions() },
  markedExerciseIds: new Set(),
  markedExercises: new Map(),
  tagEditor: { open: false, exerciseId: "", exerciseName: "", tags: [], options: [], error: "" },
  programTagEditor: { open: false, planId: "", programName: "", tags: [], options: [], error: "" },
  organization: { data: null, error: "", selectedClubId: "", selectedTeamId: "", section: "overview", assignOpen: false },
  organizationEditor: { open: false, type: "", row: null },
  organizationInvite: { open: false, athleteId: "", inviteUrl: "", mailtoUrl: "", error: "" },
  coaches: { rows: [], selected: null, detail: null, editOpen: false, contactOpen: false, error: "" },
  navStack: [],
  exerciseDetail: { ids: [], currentId: null },
  exerciseLayout: "horizontal",
  touch: { startX: 0, startY: 0, startTime: 0 },
  appHistoryDepth: 0,
  backGuardReady: false,
  allowBrowserExit: false,
  weekCalendarMonth: "",
  openWeekCalendarOnLoad: false,
};

const els = {
  status: document.querySelector("#apiStatus"),
  title: document.querySelector("#screenTitle"),
  context: document.querySelector("#contextLabel"),
  athleteList: document.querySelector("#athleteList"),
  athleteSearch: document.querySelector("#athleteSearch"),
  athletesToggle: document.querySelector("#athletesToggle"),
  railToggle: document.querySelector("#railToggle"),
  calendarToggle: document.querySelector("#calendarToggle"),
  tabs: document.querySelectorAll(".tab"),
  libraryTabs: document.querySelectorAll("[data-library-tab]"),
  athleteTabs: document.querySelectorAll("[data-athlete-tab]"),
  toolbar: document.querySelector("#viewToolbar"),
  content: document.querySelector("#content"),
  mediaModal: document.querySelector("#mediaModal"),
  mediaTitle: document.querySelector("#mediaTitle"),
  mediaBody: document.querySelector("#mediaBody"),
  signOut: document.querySelector("#signOutButton"),
  userRole: document.querySelector("#userRole"),
};

init();

async function init() {
  bindEvents();
  state.railExpanded = window.matchMedia("(min-width: 900px)").matches;
  renderRailState();
  if (window.location.pathname === "/invite") {
    await renderInviteAccept();
    return;
  }
  await loadSession();
  if (!state.currentUser) {
    renderLogin();
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
    await submitInviteAccept(inviteForm);
    return;
  }

  const organizationForm = event.target.closest("[data-organization-form]");
  if (organizationForm) {
    event.preventDefault();
    await submitOrganizationForm(organizationForm);
    return;
  }

  const tagForm = event.target.closest("[data-exercise-tag-form]");
  if (tagForm) {
    event.preventDefault();
    await submitExerciseTagForm(tagForm);
    return;
  }

  const programTagForm = event.target.closest("[data-program-tag-form]");
  if (programTagForm) {
    event.preventDefault();
    await submitProgramTagForm(programTagForm);
    return;
  }

  const templateMetadataForm = event.target.closest("[data-template-metadata-form]");
  if (templateMetadataForm) {
    event.preventDefault();
    await submitTemplateMetadataForm(templateMetadataForm);
    return;
  }

  const templateReviewForm = event.target.closest("[data-template-review-form]");
  if (templateReviewForm) {
    event.preventDefault();
    await submitTemplateReviewForm(templateReviewForm);
    return;
  }

  const coachProfileForm = event.target.closest("[data-coach-profile-form]");
  if (coachProfileForm) {
    event.preventDefault();
    await submitCoachProfileForm(coachProfileForm);
    return;
  }

  const coachContactForm = event.target.closest("[data-coach-contact-form]");
  if (coachContactForm) {
    event.preventDefault();
    await submitCoachContactForm(coachContactForm);
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
    await submitBuilderForm(builderForm);
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
    filterOrganizationSelect(orgFilter);
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
    filterOrganizationSelect(orgFilter);
    return;
  }

  const organizationClubSelect = event.target.closest("[data-organization-club-select]");
  if (organizationClubSelect) {
    syncOrganizationTeamSelect(organizationClubSelect.closest("form"));
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
    await submitBuilderForm(form);
  } catch (error) {
    renderBuilderError(error);
  }
}

let builderSearchTimer = null;
function debounceBuilderSearch() {
  clearTimeout(builderSearchTimer);
  builderSearchTimer = setTimeout(loadBuilderExercises, 250);
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
  const values = templateFilterSuggestions(input.dataset.templateFilter);
  const matches = prefix ? values.filter((value) => templateFilterOptionMatches(value, prefix)) : values;
  list.innerHTML = `<option value="All"></option>${matches.map((value) => `<option value="${escapeAttr(value)}"></option>`).join("")}`;
}

function templateFilterSuggestions(filter) {
  if (filter === "category") return templateCategoryOptions();
  if (filter === "tag") return state.templateOptions.tags || [];
  if (filter === "creator") {
    return (state.templateOptions.creators || [])
      .map((row) => clean(`${row.name || ""}${row.email ? ` - ${row.email}` : ""}`))
      .filter(Boolean);
  }
  if (filter === "club") return (state.templateOptions.clubs || []).map((row) => row.name).filter(Boolean);
  return [];
}

function templateFilterOptionMatches(value, prefix) {
  const normalized = String(value || "").toLowerCase();
  return normalized.includes(prefix) || normalized.split(/[\s&/,-]+/).some((part) => part.startsWith(prefix));
}

function renderLogin() {
  document.body.classList.add("login-mode");
  setStatus("Sign in");
  els.context.textContent = "OptiMove";
  els.title.textContent = "Sign in";
  els.athleteList.innerHTML = "";
  els.athleteSearch.value = "";
  els.toolbar.innerHTML = "";
  renderUserControls();
  els.content.innerHTML = `
    <section class="login-panel">
      <form class="login-form" id="loginForm">
        <div>
          <p class="eyebrow">Account</p>
          <h3>Sign in to OptiMove</h3>
        </div>
        <label class="search-field">
          <span>Email</span>
          <input name="email" type="email" autocomplete="username" required>
        </label>
        <label class="search-field">
          <span>Password</span>
          <input name="password" type="password" autocomplete="current-password" required>
        </label>
        <p class="login-error" aria-live="polite"></p>
        <button class="plain-button" type="submit">Sign in</button>
      </form>
    </section>
  `;
}

async function renderInviteAccept() {
  document.body.classList.add("login-mode");
  setStatus("Invite");
  els.context.textContent = "OptiMove";
  els.title.textContent = "Activate account";
  els.athleteList.innerHTML = "";
  els.athleteSearch.value = "";
  els.toolbar.innerHTML = "";
  state.currentUser = null;
  renderUserControls();
  const token = new URLSearchParams(window.location.search).get("token") || "";
  if (!token) {
    els.content.innerHTML = `<section class="login-panel"><div class="login-form"><h3>Invite link is missing</h3><p class="muted">Ask your coach to send a new invite link.</p></div></section>`;
    return;
  }
  try {
    const data = await api(`/api/auth/invites/${encodeURIComponent(token)}`);
    const invite = data.invite || {};
    els.content.innerHTML = `
      <section class="login-panel">
        <form class="login-form invite-form" id="inviteAcceptForm" data-token="${escapeAttr(token)}">
          <div>
            <p class="eyebrow">Athlete access</p>
            <h3>Activate OptiMove account</h3>
            <p class="muted">${escapeHtml(invite.athlete_name || "Athlete")} ${invite.athlete_code ? `- ID ${escapeHtml(invite.athlete_code)}` : ""}</p>
          </div>
          <label class="search-field">
            <span>Email</span>
            <input value="${escapeAttr(invite.email || "")}" readonly>
          </label>
          <label class="search-field">
            <span>Password</span>
            <input name="password" type="password" autocomplete="new-password" required minlength="8" placeholder="At least 8 characters">
          </label>
          <label class="search-field">
            <span>Confirm password</span>
            <input name="confirmPassword" type="password" autocomplete="new-password" required minlength="8">
          </label>
          <p class="login-error" aria-live="polite"></p>
          <button class="plain-button" type="submit">Activate account</button>
        </form>
      </section>
    `;
  } catch (error) {
    els.content.innerHTML = `<section class="login-panel"><div class="login-form"><h3>Invite is not valid</h3><p class="login-error">${escapeHtml(error.message || "This invite has expired.")}</p></div></section>`;
  }
}

async function submitInviteAccept(form) {
  const error = form.querySelector(".login-error");
  const button = form.querySelector("button[type='submit']");
  const formData = new FormData(form);
  const password = String(formData.get("password") || "");
  const confirmPassword = String(formData.get("confirmPassword") || "");
  if (error) error.textContent = "";
  if (password !== confirmPassword) {
    if (error) error.textContent = "Passwords do not match.";
    return;
  }
  if (button) button.disabled = true;
  try {
    const data = await api(`/api/auth/invites/${encodeURIComponent(form.dataset.token || "")}/accept`, {
      method: "POST",
      body: JSON.stringify({ password }),
    });
    state.currentUser = data.user;
    window.location.replace(state.currentUser?.role === "athlete" ? "/athlete" : "/");
  } catch (submitError) {
    if (error) error.textContent = submitError.message || "Could not activate account.";
  } finally {
    if (button) button.disabled = false;
  }
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

function roleLabel(user = state.currentUser) {
  const role = String(user?.role || user?.role_hint || "").toLowerCase();
  const labels = {
    platform_admin: "Platform admin",
    general_admin: "Platform admin",
    admin: "Platform admin",
    club_admin: "Club admin",
    team_admin: "Team admin",
    team_coach: "Team coach",
    coach: "Coach",
    athlete: "Athlete",
  };
  return labels[role] || labels[user?.accessScope] || "User";
}

function accessScopeLabel(user = state.currentUser) {
  const scope = String(user?.accessScope || "").toLowerCase();
  return ({ platform: "All platform data", club: "Club workspace", team: "Team workspace", coach: "Private coach workspace", athlete: "Athlete view" })[scope] || "Workspace";
}

function hasOrganizationAccess(user = state.currentUser) {
  return Boolean(user) && String(user?.accessScope || "").toLowerCase() !== "athlete";
}

function canManageCoachProfile(user = state.currentUser) {
  if (!user || isAthleteMode()) return false;
  const role = String(user.role || user.role_hint || "").toLowerCase();
  return ["coach", "team_coach", "team_admin", "club_admin", "platform_admin", "general_admin", "admin"].includes(role)
    || ["coach", "team", "club", "platform"].includes(String(user.accessScope || "").toLowerCase());
}

function renderAccessNav() {
  const orgButton = document.querySelector('[data-library-tab="organization"]');
  const orgSubmenu = document.querySelector('[data-sidebar-submenu="settings"]');
  const builderButton = document.querySelector('[data-library-tab="builder"]');
  const visible = hasOrganizationAccess();
  if (orgButton) orgButton.hidden = !visible;
  if (orgSubmenu) orgSubmenu.hidden = !visible;
  if (builderButton) builderButton.hidden = isAthleteMode();
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

function renderRailState() {
  document.body.classList.toggle("rail-expanded", state.railExpanded);
  els.railToggle?.setAttribute("aria-expanded", String(state.railExpanded));
  els.railToggle?.setAttribute("aria-label", state.railExpanded ? "Collapse navigation" : "Expand navigation");
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
  return loadExercises();
}

async function loadCoaches() {
  state.navStack = [];
  els.context.textContent = "Coach directory";
  els.title.textContent = "Coaches";
  els.toolbar.innerHTML = "";
  setLoading("Loading coach profiles...");
  try {
    const data = await api("/api/coaches");
    state.coaches = { ...state.coaches, rows: data.coaches || [], error: "" };
    renderCoaches();
  } catch (error) {
    state.coaches = { ...state.coaches, error: error.message || "Could not load coach profiles." };
    renderCoaches();
  }
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
    if (state.templateScope !== requestedScope) return loadTemplates(options);
    state.lastTemplates = data.templates || [];
    if (!state.lastTemplates.some((template) => String(template.plan_id) === String(state.selectedTemplateId))) {
      state.selectedTemplateId = state.lastTemplates[0]?.plan_id || null;
    }
    if (!state.templateOptions.loaded) loadTemplateOptionsInBackground();
    renderTemplateLibrary(state.lastTemplates);
    restoreTemplateFilterFocus(options.restoreFocus);
  } catch (error) {
    setStatus("Error");
    renderError(error);
  }
}

async function loadTemplateOptionsInBackground() {
  try {
    const filterOptions = await api("/api/templates/options");
    state.templateOptions = { ...filterOptions, loaded: true };
    if (state.activeTab === "templates" || state.activeTab === "athlete-library") renderTemplateLibraryResults();
  } catch (error) {
    state.templateOptions = { ...state.templateOptions, loaded: true, error: error.message || "Could not load filters." };
  }
}

function templateSearchUrl() {
  const params = new URLSearchParams();
  params.set("scope", state.templateScope || "my");
  return `/api/templates?${params.toString()}`;
}

async function openCoachProfile(profileId) {
  if (!profileId) return;
  state.coaches = { ...state.coaches, selected: profileId, detail: null, editOpen: false, contactOpen: false, error: "" };
  renderCoachContext();
  try {
    const detail = await api(`/api/coaches/${encodeURIComponent(profileId)}`);
    state.coaches = { ...state.coaches, detail, error: "" };
  } catch (error) {
    state.coaches = { ...state.coaches, error: error.message || "Could not load coach profile." };
  }
  renderCoachContext();
}

function renderCoachContext() {
  if (state.activeTab === "coaches") return renderCoaches();
  if (state.activeTab === "templates" || state.activeTab === "athlete-library") return renderTemplateLibrary(state.lastTemplates);
  return renderCurrentNode();
}

function renderCoaches() {
  const rows = state.coaches.rows || [];
  const ownProfile = rows.find((profile) => String(profile.user_id) === String(state.currentUser?.id));
  const canEditProfile = canManageCoachProfile();
  els.content.innerHTML = `
    <section class="content-section coach-directory">
      <section class="coach-directory-head">
        <div>
          <p class="eyebrow">Expert directory</p>
          <h3>Coach profiles</h3>
          <p class="muted">Profiles can connect programs, specialties, and future marketplace requests.</p>
        </div>
        ${canEditProfile ? `<button class="plain-button compact-button" type="button" data-action="coach-edit-toggle">${ownProfile ? "Edit my profile" : "Create my profile"}</button>` : ""}
      </section>
      ${state.coaches.error ? `<p class="builder-error">${escapeHtml(state.coaches.error)}</p>` : ""}
      ${canEditProfile && state.coaches.editOpen ? renderCoachProfileForm(ownProfile) : ""}
      <section class="coach-card-grid">
        ${rows.length ? rows.map(renderCoachCard).join("") : `<div class="empty-state">No visible coach profiles yet.</div>`}
      </section>
    </section>
    ${renderCoachDetailModal()}
    ${renderTemplatePreviewModal()}
  `;
}

function renderCoachCard(profile) {
  const tags = (profile.tags || []).slice(0, 4);
  const image = profile.photo_url || profile.cover_image_url || "";
  return `
    <article class="coach-card">
      <button class="coach-card-hit" type="button" data-action="coach-open" data-profile-id="${escapeAttr(profile.id)}">
        <div class="coach-card-media">
          ${image ? renderImage(image, "coach-card-image") : `<span class="coach-card-initials">${escapeHtml(programInitials(profile.name || "Coach"))}</span>`}
        </div>
        <div class="coach-card-body">
          <p class="eyebrow">${escapeHtml(profile.visibility || "private")}</p>
          <h4>${escapeHtml(profile.name || "Coach")}</h4>
          <p class="muted">${escapeHtml(profile.headline || profile.specialties || "Coach profile")}</p>
          ${profile.club_names ? `<p class="coach-card-club">${escapeHtml(profile.club_names)}</p>` : ""}
          <div class="coach-tag-row">
            ${tags.map((tag) => `<span>${escapeHtml(tag.name || tag)}</span>`).join("")}
          </div>
          <div class="coach-card-meta">
            <span>${Number(profile.program_count || 0)} programs</span>
            <span>${escapeHtml(ratingLabel(profile))}</span>
          </div>
        </div>
      </button>
    </article>
  `;
}

function renderCoachProfileForm(profile) {
  const tags = (profile?.tags || []).map((tag) => tag.name || tag).join(", ");
  return `
    <form class="panel coach-profile-form" data-coach-profile-form>
      <div>
        <p class="eyebrow">My coach profile</p>
        <h4>${escapeHtml(profile?.name || state.currentUser?.name || "Coach profile")}</h4>
      </div>
      <div class="program-metadata-grid">
        <label class="search-field"><span>Headline</span><input name="headline" value="${escapeAttr(profile?.headline || "")}" placeholder="e.g. Strength and return-to-play coach"></label>
        <label class="search-field"><span>Specialties</span><input name="specialties" value="${escapeAttr(profile?.specialties || "")}" placeholder="Speed, strength, rehab"></label>
        <label class="search-field"><span>Photo URL</span><input name="photoUrl" value="${escapeAttr(profile?.photo_url || "")}" placeholder="https://..."></label>
        <label class="search-field"><span>Cover image URL</span><input name="coverImageUrl" value="${escapeAttr(profile?.cover_image_url || "")}" placeholder="https://..."></label>
        <label class="search-field"><span>Contact email</span><input name="contactEmail" value="${escapeAttr(profile?.contact_email || state.currentUser?.email || "")}"></label>
        <label class="search-field"><span>Visibility</span><select name="visibility">
          ${renderOption("private", "Private", profile?.visibility || "private")}
          ${renderOption("club", "Club only", profile?.visibility)}
          ${renderOption("public", "Platform visible", profile?.visibility)}
          ${renderOption("marketplace", "Marketplace visible", profile?.visibility)}
        </select></label>
        <label class="search-field"><span>Tags</span><input name="tags" value="${escapeAttr(tags)}" placeholder="RTP, football, hamstring"></label>
        <label class="program-paid-filter"><input name="contactEnabled" type="checkbox" ${profile?.contact_enabled === false ? "" : "checked"}><span>Allow contact requests</span></label>
      </div>
      <label class="search-field"><span>Short bio</span><textarea name="bio" rows="4" placeholder="Short professional introduction">${escapeHtml(profile?.bio || "")}</textarea></label>
      <p class="builder-error" aria-live="polite"></p>
      <div class="builder-source-actions">
        <button class="plain-button compact-button" type="submit">Save profile</button>
        <button class="plain-button compact-button" type="button" data-action="coach-edit-toggle">Cancel</button>
      </div>
    </form>
  `;
}

function renderCoachDetailModal() {
  const detail = state.coaches.detail;
  const profile = detail?.profile || state.coaches.rows.find((row) => String(row.id) === String(state.coaches.selected));
  if (!state.coaches.selected) return "";
  if (!profile) {
    const title = state.coaches.error ? "Coach profile unavailable" : "Loading coach profile";
    const message = state.coaches.error || "Loading coach profile...";
    return `
      <div class="program-preview-overlay">
        <button class="program-preview-backdrop" type="button" data-action="coach-close" aria-label="Close coach profile"></button>
        <section class="program-preview-modal coach-profile-modal" role="dialog" aria-modal="true" aria-label="${escapeAttr(title)}">
          <div class="program-preview-head coach-profile-head">
            <div>
              <p class="eyebrow">Coach profile</p>
              <h3>${escapeHtml(title)}</h3>
            </div>
            <button class="plain-button icon-button" type="button" data-action="coach-close" aria-label="Close"><span class="button-icon">x</span></button>
          </div>
          <div class="coach-profile-body">
            <div class="empty-state">${escapeHtml(message)}</div>
          </div>
        </section>
      </div>
    `;
  }
  const programs = detail?.programs || [];
  return `
    <div class="program-preview-overlay">
      <button class="program-preview-backdrop" type="button" data-action="coach-close" aria-label="Close coach profile"></button>
      <section class="program-preview-modal coach-profile-modal" role="dialog" aria-modal="true" aria-label="${escapeAttr(profile.name || "Coach profile")}">
        <div class="program-preview-head coach-profile-head">
          <div class="coach-profile-title">
            ${profile.photo_url ? renderImage(profile.photo_url, "coach-profile-photo") : `<span class="coach-card-initials">${escapeHtml(programInitials(profile.name || "Coach"))}</span>`}
            <div>
              <p class="eyebrow">${escapeHtml(profile.visibility || "profile")}</p>
              <h3>${escapeHtml(profile.name || "Coach")}</h3>
              <p class="muted">${escapeHtml(profile.headline || profile.specialties || "")}</p>
            </div>
          </div>
          <div class="builder-source-actions">
            ${programs.length ? `<button class="plain-button compact-button" type="button" data-action="coach-programs-focus">View programs</button>` : ""}
            ${profile.contact_enabled ? `<button class="plain-button compact-button" type="button" data-action="coach-contact-toggle">${state.coaches.contactOpen ? "Close contact" : "Contact coach"}</button>` : ""}
            <button class="plain-button icon-button" type="button" data-action="coach-close" aria-label="Close"><span class="button-icon">x</span></button>
          </div>
        </div>
        <div class="coach-profile-body">
          <section class="coach-profile-summary">
            <p>${escapeHtml(profile.bio || "No profile description yet.")}</p>
            <p class="rating-line">${escapeHtml(ratingLabel(profile))}</p>
            <div class="coach-tag-row">${(profile.tags || []).map((tag) => `<span>${escapeHtml(tag.name || tag)}</span>`).join("")}</div>
            ${profile.club_names ? `<p class="muted">${escapeHtml(profile.club_names)}</p>` : ""}
          </section>
          ${state.coaches.contactOpen ? renderCoachContactForm(profile) : ""}
          <section data-coach-programs>
            <div class="program-library-shelf-head"><h4>Published programs</h4><span>${programs.length} programs</span></div>
            <div class="program-library-row">
              ${detail ? programs.length ? programs.map(renderCoachProgramCard).join("") : `<div class="empty-state">No visible programs from this coach yet.</div>` : `<div class="empty-state">Loading programs...</div>`}
            </div>
          </section>
        </div>
      </section>
    </div>
  `;
}

function renderCoachContactForm(profile) {
  return `
    <form class="panel coach-contact-form" data-coach-contact-form data-profile-id="${escapeAttr(profile.id)}">
      <label class="search-field"><span>Your name</span><input name="name" value="${escapeAttr(state.currentUser?.name || "")}"></label>
      <label class="search-field"><span>Your email</span><input name="email" value="${escapeAttr(state.currentUser?.email || "")}"></label>
      <label class="search-field"><span>Message</span><textarea name="message" rows="3" required placeholder="Write what kind of program or support you need"></textarea></label>
      <p class="builder-error" aria-live="polite"></p>
      <button class="plain-button compact-button" type="submit">Send request</button>
    </form>
  `;
}

function renderCoachProgramCard(program) {
  const image = program.cover_image_url || "";
  const price = programPriceLabel(program);
  return `
    <article class="program-library-card">
      <button class="program-library-info-button" type="button" data-action="coach-program-info" data-template-id="${escapeAttr(program.plan_id)}" aria-label="Program information">i</button>
      <button class="program-library-card-hit" type="button" data-action="coach-program-open" data-template-id="${escapeAttr(program.plan_id)}">
        <span class="program-library-card-media">
          ${image ? renderImage(image, "program-library-cover") : `<span class="program-library-card-icon">${escapeHtml(programInitials(program.plan_name || "Program"))}</span>`}
        </span>
        <span class="program-library-card-body">
          <span class="program-library-card-title">${escapeHtml(program.plan_name || "Program")}</span>
          <span class="program-library-card-sub">${escapeHtml(program.library_category || "General")}</span>
        </span>
        <span class="program-library-card-foot">
          <span class="item-badge">${escapeHtml(price)}</span>
          <span class="item-badge">${escapeHtml(ratingLabel(program))}</span>
          <span class="text-action">Open</span>
        </span>
      </button>
    </article>
  `;
}

async function submitCoachProfileForm(form) {
  const error = form.querySelector(".builder-error");
  const button = form.querySelector("button[type='submit']");
  if (error) error.textContent = "";
  if (button) button.disabled = true;
  const formData = new FormData(form);
  try {
    await api("/api/coaches/me", {
      method: "PATCH",
      body: JSON.stringify({
        headline: formData.get("headline"),
        specialties: formData.get("specialties"),
        photoUrl: formData.get("photoUrl"),
        coverImageUrl: formData.get("coverImageUrl"),
        contactEmail: formData.get("contactEmail"),
        visibility: formData.get("visibility"),
        tags: formData.get("tags"),
        bio: formData.get("bio"),
        contactEnabled: formData.get("contactEnabled") === "on",
      }),
    });
    state.coaches.editOpen = false;
    await loadCoaches();
  } catch (submitError) {
    if (error) error.textContent = submitError.message || "Could not save profile.";
  } finally {
    if (button) button.disabled = false;
  }
}

async function submitCoachContactForm(form) {
  const profileId = form.dataset.profileId || "";
  const error = form.querySelector(".builder-error");
  const button = form.querySelector("button[type='submit']");
  if (error) error.textContent = "";
  if (button) button.disabled = true;
  const formData = new FormData(form);
  try {
    await api(`/api/coaches/${encodeURIComponent(profileId)}/contact`, {
      method: "POST",
      body: JSON.stringify({
        name: formData.get("name"),
        email: formData.get("email"),
        message: formData.get("message"),
      }),
    });
    state.coaches.contactOpen = false;
    state.coaches.error = "Contact request sent.";
    renderCoachContext();
  } catch (submitError) {
    if (error) error.textContent = submitError.message || "Could not send request.";
  } finally {
    if (button) button.disabled = false;
  }
}

async function loadExercises() {
  state.navStack = [];
  await loadExerciseFilterOptions();
  els.toolbar.innerHTML = `
    <label class="search-field exercise-search-field">
      <span>Exercise search</span>
      <input id="exerciseSearch" type="search" placeholder="Name or code" value="">
    </label>
    <div class="exercise-filter-strip">
      ${renderExerciseFilterControls(state.exerciseSearch.filters, state.exerciseSearch.options)}
    </div>
  `;
  const input = document.querySelector("#exerciseSearch");
  input.addEventListener("input", debounce(() => {
    state.exerciseSearch.limit = 30;
    searchExercises(input.value);
  }, 250));
  document.querySelectorAll("[data-exercise-filter]").forEach((control) => {
    control.addEventListener("change", () => {
      state.exerciseSearch.filters[control.dataset.exerciseFilter] =
        control.type === "checkbox" ? control.checked : control.value;
      state.exerciseSearch.limit = 30;
      searchExercises(input.value);
    });
  });
  await searchExercises(input.value);
}

async function searchExercises(term) {
  const query = term.trim();
  state.exerciseSearch.term = query;
  setLoading(query ? "Searching exercises..." : "Loading exercises...");
  const data = await api(exerciseSearchUrl(query, state.exerciseSearch.limit, state.exerciseSearch.filters));
  state.exerciseSearch.hasMore = Boolean(data.hasMore);
  renderExercises(applyClientExerciseFilters(data.exercises || [], state.exerciseSearch.filters));
}

async function loadExerciseFilterOptions() {
  if (EXERCISE_FILTERS.some((filter) => state.exerciseSearch.options[filter.optionsKey]?.length)) return;
  const data = await api("/api/exercises/options");
  state.exerciseSearch.options = { ...emptyExerciseOptions(), ...data };
}

function exerciseSearchUrl(query, limit, filters = {}) {
  const params = new URLSearchParams({ search: query || "", limit: String(limit || 30) });
  EXERCISE_FILTERS.forEach((filter) => {
    if (filters[filter.key]) params.set(filter.key, filters[filter.key]);
  });
  if (filters.favorite) params.set("favorite", "true");
  return `/api/exercises?${params.toString()}`;
}

function renderExerciseFilterControls(values, options, mode = "library") {
  const attr = mode.startsWith("builder") ? "data-builder-exercise-filter" : "data-exercise-filter";
  const includeToggles = mode !== "builder-selects";
  return `
    ${EXERCISE_FILTERS.map((filter) => renderExerciseFilterSelect(filter, values[filter.key], options[filter.optionsKey], attr)).join("")}
    ${includeToggles ? renderExerciseFilterToggle("favorite", "Favorites", values.favorite, attr) : ""}
    ${includeToggles ? renderExerciseFilterToggle("marked", "Marked", values.marked, attr) : ""}
  `;
}

function renderExerciseQuickFilters(values, attr) {
  return `
    <div class="exercise-quick-filters">
      ${renderExerciseFilterToggle("favorite", "Favorites", values.favorite, attr)}
      ${renderExerciseFilterToggle("marked", "Marked", values.marked, attr)}
    </div>
  `;
}

function renderExerciseFilterSelect(filter, value, options, attr) {
  if (!options?.length) return "";
  return `
    <label class="search-field exercise-filter-field">
      <span>${escapeHtml(filter.label)}</span>
      <select ${attr}="${escapeAttr(filter.key)}">
        <option value="">All</option>
        ${options.map((option) => `<option value="${escapeAttr(option)}" ${option === value ? "selected" : ""}>${escapeHtml(option)}</option>`).join("")}
      </select>
    </label>
  `;
}

function renderExerciseFilterToggle(key, label, checked, attr) {
  return `
    <label class="exercise-filter-toggle">
      <input type="checkbox" ${attr}="${escapeAttr(key)}" ${checked ? "checked" : ""}>
      <span>${escapeHtml(label)}</span>
    </label>
  `;
}

function activeExerciseFilterLabels(filters) {
  const labels = EXERCISE_FILTERS
    .filter((filter) => filters[filter.key])
    .map((filter) => `${filter.label}: ${filters[filter.key]}`);
  if (filters.favorite) labels.push("Favorites");
  if (filters.marked) labels.push("Marked");
  return labels;
}

function activeExerciseSelectFilterCount(filters) {
  return EXERCISE_FILTERS.filter((filter) => filters[filter.key]).length;
}

function applyClientExerciseFilters(exercises, filters) {
  if (!filters.marked) return exercises;
  const hasOtherFilters = EXERCISE_FILTERS.some((filter) => filters[filter.key]) || filters.favorite;
  if (!hasOtherFilters) return [...state.markedExercises.values()];
  return exercises.filter((exercise) => state.markedExerciseIds.has(exercise.id));
}

function findExerciseResultById(exerciseId) {
  return [...state.lastExerciseResults, ...state.builder.exercises].find((exercise) => String(exercise.id) === String(exerciseId)) || null;
}

async function toggleExerciseFavorite(exerciseId, isFavorite) {
  if (!exerciseId) return;
  await api(`/api/exercises/${encodeURIComponent(exerciseId)}/favorite`, {
    method: isFavorite ? "DELETE" : "POST",
  });
  if (state.activeTab === "builder" && state.builder.selectedNodeId) await loadBuilderExercises();
  else await searchExercises(state.exerciseSearch.term);
}

async function openExerciseTagEditor(exerciseId, exerciseName) {
  if (!exerciseId) return;
  const data = await api(`/api/exercises/${encodeURIComponent(exerciseId)}/tags`);
  state.tagEditor = {
    open: true,
    exerciseId,
    exerciseName,
    tags: data.tags || [],
    options: data.options || [],
    error: "",
  };
  rerenderCurrentExerciseSurface();
}

function closeExerciseTagEditor() {
  state.tagEditor = { open: false, exerciseId: "", exerciseName: "", tags: [], options: [], error: "" };
  rerenderCurrentExerciseSurface();
}

async function submitExerciseTagForm(form) {
  const formData = new FormData(form);
  const tagId = String(formData.get("tagId") || "").trim();
  const name = String(formData.get("name") || "").trim();
  if (!tagId && !name) {
    state.tagEditor.error = "Choose a tag or write a new one.";
    rerenderCurrentExerciseSurface();
    return;
  }
  try {
    await api(`/api/exercises/${encodeURIComponent(state.tagEditor.exerciseId)}/tags`, {
      method: "POST",
      body: JSON.stringify(tagId ? { tagId } : { name }),
    });
    await refreshExerciseTagEditor();
    state.exerciseSearch.options = emptyExerciseOptions();
    await loadExerciseFilterOptions();
    await refreshCurrentExerciseSearch();
  } catch (error) {
    state.tagEditor.error = error.message || "Could not add tag.";
    rerenderCurrentExerciseSurface();
  }
}

async function removeExerciseTag(exerciseId, tagId) {
  if (!exerciseId || !tagId) return;
  await api(`/api/exercises/${encodeURIComponent(exerciseId)}/tags/${encodeURIComponent(tagId)}`, { method: "DELETE" });
  await refreshExerciseTagEditor();
  state.exerciseSearch.options = emptyExerciseOptions();
  await loadExerciseFilterOptions();
  await refreshCurrentExerciseSearch();
}

async function refreshExerciseTagEditor() {
  if (!state.tagEditor.open || !state.tagEditor.exerciseId) return;
  const data = await api(`/api/exercises/${encodeURIComponent(state.tagEditor.exerciseId)}/tags`);
  state.tagEditor = { ...state.tagEditor, tags: data.tags || [], options: data.options || [], error: "" };
  updateExerciseTagsInCache(state.tagEditor.exerciseId, state.tagEditor.tags);
}

async function refreshCurrentExerciseSearch() {
  if (state.activeTab === "builder" && state.builder.selectedNodeId) await loadBuilderExercises();
  else await searchExercises(state.exerciseSearch.term);
}

function rerenderCurrentExerciseSurface() {
  if (state.activeTab === "builder" && state.builder.draft) renderBuilder();
  else renderExercises(state.lastExerciseResults);
}

function updateExerciseTagsInCache(exerciseId, tags) {
  const update = (exercise) => {
    if (String(exercise.id) === String(exerciseId)) exercise.tags = tags;
  };
  state.lastExerciseResults.forEach(update);
  state.builder.exercises.forEach(update);
  if (state.markedExercises.has(exerciseId)) {
    const exercise = state.markedExercises.get(exerciseId);
    state.markedExercises.set(exerciseId, { ...exercise, tags });
  }
}

async function openProgramTagEditor(planId, programName) {
  if (!planId) return;
  try {
    const data = await api(`/api/templates/${encodeURIComponent(planId)}/tags`);
    state.programTagEditor = {
      open: true,
      planId,
      programName,
      tags: data.tags || [],
      options: data.options || [],
      error: "",
    };
    renderTemplateLibrary(state.lastTemplates);
  } catch (error) {
    renderError(error);
  }
}

function closeProgramTagEditor() {
  state.programTagEditor = { open: false, planId: "", programName: "", tags: [], options: [], error: "" };
  renderTemplateLibrary(state.lastTemplates);
}

async function submitProgramTagForm(form) {
  const formData = new FormData(form);
  const planId = form.dataset.planId || state.programTagEditor.planId;
  try {
    await api(`/api/templates/${encodeURIComponent(planId)}/tags`, {
      method: "POST",
      body: JSON.stringify({
        tagId: formData.get("tagId"),
        name: formData.get("name"),
      }),
    });
    form.reset();
    await refreshProgramTags(planId);
  } catch (error) {
    state.programTagEditor = { ...state.programTagEditor, error: error.message || "Could not add tag.", planId };
    renderTemplateLibrary(state.lastTemplates);
  }
}

async function removeProgramTag(planId, tagId) {
  if (!planId || !tagId) return;
  await api(`/api/templates/${encodeURIComponent(planId)}/tags/${encodeURIComponent(tagId)}`, { method: "DELETE" });
  await refreshProgramTags(planId);
}

async function refreshProgramTagEditor() {
  await refreshProgramTags(state.programTagEditor.planId);
}

async function refreshProgramTags(planId) {
  const data = await api(`/api/templates/${encodeURIComponent(planId)}/tags`);
  if (state.programTagEditor.open && String(state.programTagEditor.planId) === String(planId)) {
    state.programTagEditor = { ...state.programTagEditor, tags: data.tags || [], options: data.options || [], error: "" };
  }
  updateProgramTagsInCache(planId, data.tags || []);
  const options = await api("/api/templates/options");
  state.templateOptions = { ...options, loaded: true };
  renderTemplateLibrary(state.lastTemplates);
}

async function addInlineProgramTag(planId) {
  const input = document.querySelector(`[data-program-tag-input="${CSS.escape(String(planId))}"]`);
  const name = clean(input?.value);
  if (!planId || !name) return;
  try {
    await api(`/api/templates/${encodeURIComponent(planId)}/tags`, {
      method: "POST",
      body: JSON.stringify({ name }),
    });
    if (input) input.value = "";
    await refreshProgramTags(planId);
  } catch (error) {
    state.programTagEditor = { ...state.programTagEditor, error: error.message || "Could not add tag.", planId };
    renderTemplateLibrary(state.lastTemplates);
  }
}

function updateProgramTagsInCache(planId, tags) {
  state.lastTemplates.forEach((template) => {
    if (String(template.plan_id) === String(planId)) template.tags = tags;
  });
}

function handleContentClick(event) {
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
    state.navStack = [];
    renderCurrentNode();
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
  if (type === "exercise-load-more") {
    state.exerciseSearch.limit += 30;
    searchExercises(state.exerciseSearch.term);
    return;
  }
  if (type === "exercise-toggle-favorite") {
    const exerciseId = action.dataset.exerciseId;
    const isFavorite = action.dataset.favorite === "true";
    void toggleExerciseFavorite(exerciseId, isFavorite);
    return;
  }
  if (type === "exercise-toggle-mark") {
    const exerciseId = action.dataset.exerciseId;
    if (!exerciseId) return;
    if (state.markedExerciseIds.has(exerciseId)) {
      state.markedExerciseIds.delete(exerciseId);
      state.markedExercises.delete(exerciseId);
    } else {
      state.markedExerciseIds.add(exerciseId);
      const exercise = findExerciseResultById(exerciseId);
      if (exercise) state.markedExercises.set(exerciseId, exercise);
    }
    if (state.activeTab === "builder" && state.builder.selectedNodeId) {
      if (state.builder.exerciseFilters.marked) void loadBuilderExercises();
      else renderBuilder();
    }
    else searchExercises(state.exerciseSearch.term);
    return;
  }
  if (type === "exercise-tags") {
    void openExerciseTagEditor(action.dataset.exerciseId, action.dataset.exerciseName || "Exercise");
    return;
  }
  if (type === "template-open") {
    void openTemplatePreview(action.dataset.templateId);
    return;
  }
  if (type === "coach-program-open") {
    const program = (state.coaches.detail?.programs || []).find((row) => String(row.plan_id) === String(action.dataset.templateId));
    if (program?.plan_id) {
      state.coaches = { ...state.coaches, selected: null, detail: null, contactOpen: false, error: "" };
      void openTemplatePreviewFromCoachProgram(program);
    }
    return;
  }
  if (type === "coach-program-info") {
    const program = (state.coaches.detail?.programs || []).find((row) => String(row.plan_id) === String(action.dataset.templateId));
    if (program) {
      alert(`${program.plan_name || "Program"}\n\n${program.description || program.program_note || program.library_category || "No additional information yet."}`);
    }
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
    void markTemplateUsed(action.dataset.templateId);
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
    closeProgramTagEditor();
    return;
  }
  if (type === "program-tag-add") {
    void addInlineProgramTag(action.dataset.planId);
    return;
  }
  if (type === "program-tag-remove") {
    void removeProgramTag(action.dataset.planId, action.dataset.tagId);
    return;
  }
  if (type === "exercise-tags-close") {
    closeExerciseTagEditor();
    return;
  }
  if (type === "exercise-tag-remove") {
    void removeExerciseTag(action.dataset.exerciseId, action.dataset.tagId);
    return;
  }
  if (type === "organization-edit") {
    const row = findOrganizationRow(action.dataset.orgType, action.dataset.orgId);
    if (!row) return;
    state.organizationEditor = { open: true, type: action.dataset.orgType, row };
    void renderOrganizationPanel();
    return;
  }
  if (type === "organization-select-club") {
    state.organization.selectedClubId = action.dataset.clubId || "";
    state.organization.selectedTeamId = "";
    state.organization.assignOpen = false;
    void renderOrganizationPanel({ refresh: false });
    return;
  }
  if (type === "organization-select-team") {
    state.organization.selectedTeamId = action.dataset.teamId || "";
    const team = findOrganizationRow("team", state.organization.selectedTeamId);
    if (team?.club_id) state.organization.selectedClubId = team.club_id;
    state.organization.assignOpen = false;
    void renderOrganizationPanel({ refresh: false });
    return;
  }
  if (type === "organization-clear-selection") {
    state.organization.selectedClubId = "";
    state.organization.selectedTeamId = "";
    state.organization.assignOpen = false;
    void renderOrganizationPanel({ refresh: false });
    return;
  }
  if (type === "organization-section") {
    state.organization.section = action.dataset.section || "overview";
    void renderOrganizationPanel({ refresh: false });
    return;
  }
  if (type === "organization-edit-close") {
    state.organizationEditor = { open: false, type: "", row: null };
    void renderOrganizationPanel();
    return;
  }
  if (type === "organization-toggle-assign-athlete") {
    state.organization.assignOpen = !state.organization.assignOpen;
    void renderOrganizationPanel({ refresh: false });
    return;
  }
  if (type === "organization-invite-athlete") {
    const row = findOrganizationRow("athlete", action.dataset.athleteId);
    if (!row) return;
    state.organizationInvite = { open: true, athleteId: row.id, inviteUrl: "", mailtoUrl: "", error: "" };
    state.organizationEditor = { open: false, type: "", row: null };
    void renderOrganizationPanel({ refresh: false });
    return;
  }
  if (type === "organization-invite-close") {
    state.organizationInvite = { open: false, athleteId: "", inviteUrl: "", mailtoUrl: "", error: "" };
    void renderOrganizationPanel({ refresh: false });
    return;
  }
  if (type === "organization-copy-invite") {
    const inviteUrl = state.organizationInvite.inviteUrl || "";
    if (inviteUrl) void navigator.clipboard?.writeText(inviteUrl);
    return;
  }
  if (type === "organization-delete") {
    void deleteOrganizationRow(action.dataset.orgType, action.dataset.orgId);
    return;
  }
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

function templateScopeMeta(scope = state.templateScope) {
  const access = String(state.currentUser?.accessScope || "").toLowerCase();
  const isAthlete = isAthleteMode() || access === "athlete";
  const isPlatform = access === "platform";
  const isClub = access === "club";
  const scopes = {
    all: {
      label: isAthlete ? "Allowed programs" : (isPlatform ? "All platform programs" : "All programs"),
      eyebrow: "Program library",
      note: isAthlete ? "Programs your coach or organization made available to you." : (isPlatform ? "All coach, club, OptiMove and marketplace programs visible to platform admins." : "All template programs available to your current account."),
    },
    my: {
      label: isAthlete ? "Coach library" : (isPlatform ? "Admin workspace" : "My templates"),
      eyebrow: isAthlete ? "Coach library" : (isPlatform ? "Private admin library" : "Private library"),
      note: isAthlete ? "Programs your coach allowed you to browse and use." : (isPlatform ? "Programs created inside your own platform admin workspace." : "Reusable programs and templates available in your current coach workspace."),
    },
    workspace: {
      label: "Working materials",
      eyebrow: "Private workspace",
      note: "Unfinished or reusable coach materials that only you can see and use while building programs.",
    },
    club: {
      label: isClub || isPlatform ? "Club library" : "Club",
      eyebrow: "Club library",
      note: isPlatform ? "Club-shared program libraries grouped by club ownership." : "Club-shared programs available to this workspace.",
    },
    optimove: {
      label: "OptiMove",
      eyebrow: "OptiMove library",
      note: "Curated OptiMove programs will be organized here as the platform library grows.",
    },
    marketplace: {
      label: "Marketplace",
      eyebrow: "Program marketplace",
      note: "Free and paid public programs will appear here after marketplace access is added.",
    },
  };
  return scopes[scope] || scopes.my;
}

function renderLibraryNav() {
  renderAccessNav();
  if (state.activeTab === "organization" && !hasOrganizationAccess()) state.activeTab = "weekly";
  if (isAthleteMode() && state.activeTab === "builder") state.activeTab = "weekly";
  els.libraryTabs.forEach((button) => {
    const tab = button.dataset.libraryTab;
    const scope = button.dataset.templateScope || "";
    const isHiddenScope = tab === "templates" && scope && button.classList.contains("sidebar-subnav-button") && !visibleTemplateScopes().includes(scope);
    button.hidden = isHiddenScope;
    const organizationSection = button.dataset.organizationSection || "";
    const isTemplateTab = tab === "templates" && state.activeTab === "templates";
    const isTemplateScope = isTemplateTab && scope && scope === state.templateScope;
    const isTemplateMain = isTemplateTab && button.classList.contains("sidebar-nav-button");
    const isOrganizationTab = tab === "organization" && state.activeTab === "organization";
    const isOrganizationScope = isOrganizationTab && organizationSection && organizationSection === (state.organization.section || "overview");
    const isOrganizationMain = isOrganizationTab && button.classList.contains("sidebar-nav-button");
    button.classList.toggle("is-active", isTemplateMain || isTemplateScope || isOrganizationMain || isOrganizationScope || (!scope && !organizationSection && tab === state.activeTab));
  });
  document.querySelectorAll("[data-sidebar-submenu]").forEach((submenu) => {
    const key = submenu.dataset.sidebarSubmenu;
    submenu.classList.toggle("is-open",
      (key === "program-library" && state.activeTab === "templates") ||
      (key === "settings" && state.activeTab === "organization"),
    );
  });
  updateProgramLibraryNavLabels();
  els.athleteTabs.forEach((button) => {
    const tab = button.dataset.athleteTab || "";
    const isCalendar = tab === "calendar" && state.activeTab === "weekly" && state.weekSelectorOpen;
    const isWeeklyPlan = tab === "weekly" && state.activeTab === "weekly" && !state.weekSelectorOpen;
    const isDirectTab = tab !== "weekly" && tab !== "calendar" && tab === state.activeTab;
    button.classList.toggle("is-active", isWeeklyPlan || isCalendar || isDirectTab);
  });
  els.athletesToggle?.classList.toggle("is-active", state.athletesExpanded);
  els.calendarToggle?.classList.toggle("is-active", state.activeTab === "weekly" && state.weekSelectorOpen);
}

function updateProgramLibraryNavLabels() {
  document.querySelectorAll(".sidebar-subnav-button[data-template-scope]").forEach((button) => {
    const label = templateScopeMeta(button.dataset.templateScope).label;
    if (label) button.textContent = label;
  });
}

function visibleTemplateScopes() {
  const allowed = new Set(state.templateAllowedScopes || TEMPLATE_SCOPES);
  const base = isAthleteMode() ? ATHLETE_TEMPLATE_SCOPES : TEMPLATE_SCOPES;
  return base.filter((scope) => allowed.has(scope));
}

function ensureTemplateScopeIsVisible() {
  const scopes = visibleTemplateScopes();
  if (scopes.length && !scopes.includes(state.templateScope)) state.templateScope = scopes[0];
}

function isAthleteMode() {
  return document.body.classList.contains("athlete-mode");
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
      ${renderSettingsNav()}
      ${renderOrganizationActions(data)}
      ${renderOrganizationBrowser(data)}
      ${state.organizationEditor.open ? renderOrganizationEditModal(data) : ""}
    </section>
  `;
}

function renderSettingsNav() {
  const items = [
    ["overview", "Overview"],
    ["clubs", "Clubs"],
    ["teams", "Teams"],
    ["athletes", "Athletes"],
    ["users", "Users"],
  ];
  return `
    <nav class="settings-tabs" aria-label="Settings sections">
      ${items.map(([value, label]) => `<button class="settings-tab ${state.organization.section === value ? "is-active" : ""}" type="button" data-action="organization-section" data-section="${escapeAttr(value)}">${escapeHtml(label)}</button>`).join("")}
    </nav>
  `;
}

function renderOrganizationActions(data) {
  const section = state.organization.section || "overview";
  const actions = {
    overview: "",
    clubs: data.canCreateClub ? renderOrganizationClubForm() : "",
    teams: data.canCreateTeam ? renderOrganizationTeamForm(data.clubs) : "",
    athletes: data.canCreateAthlete ? renderOrganizationAthleteForm(data.clubs, data.teams) : "",
    users: `${data.canCreateUser ? renderOrganizationUserForm() : ""}${renderOrganizationRoleForms(data)}`,
  }[section] || "";
  return actions ? `<section class="organization-actions">${actions}</section>` : "";
}

function renderOrganizationUserForm() {
  const roles = [
    ["athlete", "Athlete login"],
    ["coach", "Independent coach"],
    ["team_coach", "Team coach"],
    ["club_admin", "Club admin"],
    ["platform_admin", "Platform admin"],
  ];
  return `
    <form class="panel organization-form" data-organization-form="user">
      <div><p class="eyebrow">Access</p><h3>Add user account</h3></div>
      <label class="search-field"><span>Full name</span><input name="fullName" placeholder="Name"></label>
      <label class="search-field"><span>Email</span><input name="email" type="email" required placeholder="name@example.com"></label>
      <label class="search-field"><span>Password</span><input name="password" type="password" required placeholder="At least 8 characters"></label>
      <label class="search-field"><span>Role</span><select name="roleHint">${roles.map(([value, label]) => `<option value="${value}">${label}</option>`).join("")}</select></label>
      <p class="builder-error" aria-live="polite"></p>
      <button class="plain-button" type="submit">Add user</button>
    </form>
  `;
}

function normalizeOrganizationSelection(data) {
  const clubs = data.clubs || [];
  const teams = data.teams || [];
  const selectedClubExists = clubs.some((club) => String(club.id) === String(state.organization.selectedClubId));
  if (state.organization.selectedClubId && !selectedClubExists) state.organization.selectedClubId = "";
  const selectedTeam = teams.find((team) => String(team.id) === String(state.organization.selectedTeamId));
  if (state.organization.selectedTeamId && !selectedTeam) state.organization.selectedTeamId = "";
  if (selectedTeam?.club_id && !state.organization.selectedClubId) state.organization.selectedClubId = selectedTeam.club_id;
}

function renderOrganizationBrowserLegacy(data) {
  const clubs = data.clubs || [];
  const teams = data.teams || [];
  const athletes = data.athletes || [];
  const users = data.users || [];
  const section = state.organization.section || "overview";
  const selectedClub = clubs.find((club) => String(club.id) === String(state.organization.selectedClubId));
  const selectedTeam = teams.find((team) => String(team.id) === String(state.organization.selectedTeamId));
  const visibleTeams = state.organization.selectedClubId
    ? teams.filter((team) => String(team.club_id) === String(state.organization.selectedClubId))
    : teams;
  const visibleAthletes = state.organization.selectedTeamId
    ? athletes.filter((athlete) => String(athlete.team_id) === String(state.organization.selectedTeamId))
    : state.organization.selectedClubId
      ? athletes.filter((athlete) => String(athlete.club_id) === String(state.organization.selectedClubId) || visibleTeams.some((team) => String(team.id) === String(athlete.team_id)))
      : athletes;
  return `
    <section class="organization-browser">
      <div class="organization-browser-head">
        <div>
          <p class="eyebrow">Organization browser</p>
          <h3>${escapeHtml(selectedTeam?.name || selectedClub?.name || "All accessible organization")}</h3>
          <p class="muted">${escapeHtml(selectedTeam ? `${visibleAthletes.length} athletes in team` : selectedClub ? `${visibleTeams.length} teams · ${visibleAthletes.length} athletes` : `${clubs.length} clubs · ${teams.length} teams · ${athletes.length} athletes`)}</p>
        </div>
        ${state.organization.selectedClubId || state.organization.selectedTeamId ? `<button class="text-action" type="button" data-action="organization-clear-selection">Show all</button>` : ""}
      </div>
      <section class="organization-lists organization-lists-browser">
        ${section === "overview" || section === "users" ? renderOrganizationList("Users", users, "user") : ""}
        ${section === "overview" || section === "clubs" || section === "teams" ? renderOrganizationSelectableList("Clubs", clubs, "club", state.organization.selectedClubId) : ""}
        ${section === "overview" || section === "clubs" || section === "teams" ? renderOrganizationSelectableList(selectedClub ? `Teams · ${selectedClub.name}` : "Teams", visibleTeams, "team", state.organization.selectedTeamId) : ""}
        ${section === "overview" || section === "clubs" || section === "teams" || section === "athletes" ? renderOrganizationList(selectedTeam ? `Athletes · ${selectedTeam.name}` : selectedClub ? `Athletes · ${selectedClub.name}` : "Athletes", visibleAthletes, "athlete") : ""}
      </section>
      ${(section === "overview" || section === "teams" || section === "athletes") && selectedTeam ? renderAssignAthleteToTeamForm(selectedTeam, visibleAthletes, athletes) : ""}
    </section>
  `;
}

function renderOrganizationSelectableList(title, rows, type, selectedId) {
  return `
    <section class="panel organization-list-card">
      <div class="organization-list-head"><p class="eyebrow">${escapeHtml(title)}</p><strong>${rows.length}</strong></div>
      <div class="organization-list">
        ${rows.length ? rows.map((row) => renderOrganizationSelectableRow(row, type, selectedId)).join("") : `<p class="muted">No ${escapeHtml(title.toLowerCase())} yet.</p>`}
      </div>
    </section>
  `;
}

function renderOrganizationSelectableRow(row, type, selectedId) {
  const isSelected = String(row.id) === String(selectedId);
  return `
    <article class="organization-row ${isSelected ? "is-selected" : ""}">
      <button class="organization-row-main" type="button" data-action="organization-select-${escapeAttr(type)}" data-${escapeAttr(type)}-id="${escapeAttr(row.id)}">
        ${renderOrganizationRowContent(row, type)}
      </button>
      <span class="organization-row-actions"><button class="text-action" type="button" data-action="organization-edit" data-org-type="${escapeAttr(type)}" data-org-id="${escapeAttr(row.id)}">Edit</button><button class="text-action danger-action" type="button" data-action="organization-delete" data-org-type="${escapeAttr(type)}" data-org-id="${escapeAttr(row.id)}">Delete</button></span>
    </article>
  `;
}

function renderAssignAthleteToTeamFormLegacy(team, visibleAthletes, allAthletes) {
  const assignedIds = new Set(visibleAthletes.map((athlete) => String(athlete.id)));
  const options = allAthletes
    .filter((athlete) => !assignedIds.has(String(athlete.id)))
    .map((athlete) => ({ value: athlete.id, label: [athlete.name, athlete.athlete_id ? `ID ${athlete.athlete_id}` : "", athlete.club_name].filter(Boolean).join(" - ") }));
  return `
    <form class="panel organization-form organization-assign-panel" data-organization-form="assignTeamAthlete" data-team-id="${escapeAttr(team.id)}">
      <div><p class="eyebrow">Team athletes</p><h3>Add athlete to ${escapeHtml(team.name)}</h3><p class="muted">Assigning an athlete to this team also sets the athlete club to ${escapeHtml(team.club_name || "this team's club")}.</p></div>
      ${renderFilterableSelect({ name: "athleteId", label: "Athlete", options, required: true, placeholder: "Type athlete name or ID" })}
      <p class="builder-error" aria-live="polite"></p>
      <button class="plain-button" type="submit" ${options.length ? "" : "disabled"}>Assign athlete</button>
    </form>
  `;
}

function renderOrganizationBrowser(data) {
  const clubs = data.clubs || [];
  const teams = data.teams || [];
  const athletes = data.athletes || [];
  const users = data.users || [];
  const section = state.organization.section || "overview";
  const selectedClub = clubs.find((club) => String(club.id) === String(state.organization.selectedClubId));
  const selectedTeam = teams.find((team) => String(team.id) === String(state.organization.selectedTeamId));
  const visibleTeams = state.organization.selectedClubId
    ? teams.filter((team) => String(team.club_id) === String(state.organization.selectedClubId))
    : teams;
  const visibleAthletes = state.organization.selectedTeamId
    ? athletes.filter((athlete) => String(athlete.team_id) === String(state.organization.selectedTeamId))
    : state.organization.selectedClubId
      ? athletes.filter((athlete) => String(athlete.club_id) === String(state.organization.selectedClubId) || visibleTeams.some((team) => String(team.id) === String(athlete.team_id)))
      : athletes;
  return `
    <section class="organization-browser">
      <div class="organization-browser-head">
        <div>
          <p class="eyebrow">Organization browser</p>
          <h3>${escapeHtml(selectedTeam?.name || selectedClub?.name || "All accessible organization")}</h3>
          <p class="muted">${escapeHtml(selectedTeam ? `${visibleAthletes.length} athletes in team` : selectedClub ? `${visibleTeams.length} teams - ${visibleAthletes.length} athletes` : `${clubs.length} clubs - ${teams.length} teams - ${athletes.length} athletes`)}</p>
        </div>
        ${state.organization.selectedClubId || state.organization.selectedTeamId ? `<button class="text-action" type="button" data-action="organization-clear-selection">Show all</button>` : ""}
      </div>
      <section class="organization-lists organization-lists-browser">
        ${section === "overview" || section === "users" ? renderOrganizationList("Users", users, "user") : ""}
        ${section === "overview" || section === "clubs" || section === "teams" ? renderOrganizationSelectableList("Clubs", clubs, "club", state.organization.selectedClubId) : ""}
        ${section === "overview" || section === "clubs" || section === "teams" ? renderOrganizationSelectableList(selectedClub ? `Teams - ${selectedClub.name}` : "Teams", visibleTeams, "team", state.organization.selectedTeamId) : ""}
        ${section === "overview" || section === "clubs" || section === "teams" || section === "athletes" ? selectedTeam ? renderTeamAthleteTable(selectedTeam, visibleAthletes, athletes) : renderOrganizationList(selectedClub ? `Athletes - ${selectedClub.name}` : "Athletes", visibleAthletes, "athlete") : ""}
      </section>
      ${state.organizationInvite.open ? renderAthleteInviteModal(athletes) : ""}
    </section>
  `;
}

function renderAssignAthleteToTeamForm(team, visibleAthletes, allAthletes) {
  const assignedIds = new Set(visibleAthletes.map((athlete) => String(athlete.id)));
  const options = allAthletes
    .filter((athlete) => !assignedIds.has(String(athlete.id)) && !athlete.team_id)
    .map((athlete) => ({ value: athlete.id, label: [athlete.name, athlete.athlete_id ? `ID ${athlete.athlete_id}` : "", athlete.club_name || "No club"].filter(Boolean).join(" - ") }));
  return `
    <form class="organization-form organization-assign-panel" data-organization-form="assignTeamAthlete" data-team-id="${escapeAttr(team.id)}">
      <div><p class="eyebrow">Existing athletes</p><h3>Add athlete to ${escapeHtml(team.name)}</h3><p class="muted">Shows athletes without a team. Assigning also sets the club to ${escapeHtml(team.club_name || "this team's club")}.</p></div>
      ${renderFilterableSelect({ name: "athleteId", label: "Athlete", options, required: true, placeholder: "Type athlete name or ID" })}
      <p class="builder-error" aria-live="polite"></p>
      <button class="plain-button" type="submit" ${options.length ? "" : "disabled"}>Assign athlete</button>
    </form>
  `;
}

function renderTeamAthleteTable(team, teamAthletes, allAthletes) {
  return `
    <section class="panel organization-list-card organization-team-detail">
      <div class="organization-list-head organization-team-head">
        <div>
          <p class="eyebrow">Team roster</p>
          <h3>${escapeHtml(team.name)}</h3>
          <p class="muted">${escapeHtml(team.club_name || "No club")} - ${teamAthletes.length} athletes</p>
        </div>
        <button class="plain-button compact-button" type="button" data-action="organization-toggle-assign-athlete">${state.organization.assignOpen ? "Close add" : "Add athlete"}</button>
      </div>
      ${state.organization.assignOpen ? renderAssignAthleteToTeamForm(team, teamAthletes, allAthletes) : ""}
      <div class="organization-table" role="table" aria-label="${escapeAttr(team.name)} athletes">
        <div class="organization-table-row organization-table-head" role="row">
          <span>Athlete</span><span>ID</span><span>Login</span><span></span>
        </div>
        ${teamAthletes.length ? teamAthletes.map((athlete) => renderTeamAthleteRow(athlete)).join("") : `<p class="muted organization-empty-row">No athletes assigned to this team yet.</p>`}
      </div>
    </section>
  `;
}

function renderTeamAthleteRow(athlete) {
  const image = athlete.image_url || "";
  return `
    <div class="organization-table-row" role="row">
      <span class="organization-table-athlete">${image ? renderImage(image, "organization-avatar") : `<span class="organization-avatar">AT</span>`}<strong>${escapeHtml(athlete.name || "Athlete")}</strong></span>
      <span>${escapeHtml(athlete.athlete_id || athlete.source_external_id || "-")}</span>
      <span>${athlete.user_id ? "Enabled" : "No login"}</span>
      <span class="organization-row-actions">
        <button class="text-action" type="button" data-action="organization-invite-athlete" data-athlete-id="${escapeAttr(athlete.id)}">Invite</button>
        <button class="text-action" type="button" data-action="organization-edit" data-org-type="athlete" data-org-id="${escapeAttr(athlete.id)}">Edit</button>
      </span>
    </div>
  `;
}

function renderAthleteInviteModal(athletes) {
  const athlete = athletes.find((entry) => String(entry.id) === String(state.organizationInvite.athleteId));
  if (!athlete) return "";
  return `
    <div class="exercise-tag-overlay">
      <button class="exercise-tag-backdrop" type="button" data-action="organization-invite-close" aria-label="Close invite"></button>
      <section class="panel exercise-tag-modal organization-invite-modal" role="dialog" aria-modal="true" aria-label="Athlete invite">
        <div class="builder-modal-head">
          <div><p class="eyebrow">Athlete invite</p><h3>${escapeHtml(athlete.name || "Athlete")}</h3></div>
          <button class="plain-button icon-button" type="button" data-action="organization-invite-close" aria-label="Close"><span class="button-icon">x</span></button>
        </div>
        <form class="organization-form" data-organization-form="athleteInvite">
          <input type="hidden" name="athleteId" value="${escapeAttr(athlete.id)}">
          <label class="search-field"><span>Email</span><input name="email" type="email" required placeholder="athlete@example.com"></label>
          <p class="builder-error" aria-live="polite">${escapeHtml(state.organizationInvite.error || "")}</p>
          <button class="plain-button" type="submit">Create invite email</button>
        </form>
        ${state.organizationInvite.inviteUrl ? `
          <div class="invite-result">
            <p class="muted">Send this activation link to the athlete. They will open it and set their own password. It expires in 14 days.</p>
            <input readonly value="${escapeAttr(state.organizationInvite.inviteUrl)}">
            <div class="invite-actions">
              <button class="plain-button compact-button" type="button" data-action="organization-copy-invite">Copy link</button>
              <a class="plain-button compact-button" href="${escapeAttr(state.organizationInvite.mailtoUrl || "#")}">Open email draft</a>
            </div>
          </div>
        ` : ""}
      </section>
    </div>
  `;
}

function renderFilterableSelect({ name, label, options = [], value = "", required = false, placeholder = "Filter", includeEmpty = "", extraSelectAttrs = "" }) {
  const normalizedValue = String(value || "");
  const selected = options.find((option) => String(option.value) === normalizedValue);
  const visibleValue = normalizedValue ? selected?.label || includeEmpty || "" : "";
  const listId = `org-options-${name}-${Math.random().toString(36).slice(2)}`;
  return `
    <label class="search-field filterable-select-field">
      <span>${escapeHtml(label)}</span>
      <input
        data-org-select-filter
        data-target-select="${escapeAttr(name)}"
        type="search"
        list="${escapeAttr(listId)}"
        placeholder="${escapeAttr(placeholder)}"
        autocomplete="off"
        value="${escapeAttr(visibleValue)}"
        ${required ? "required" : ""}
      >
      <input type="hidden" name="${escapeAttr(name)}" value="${escapeAttr(normalizedValue)}" ${extraSelectAttrs}>
      <datalist id="${escapeAttr(listId)}">
        ${includeEmpty ? `<option value="${escapeAttr(includeEmpty)}" data-value=""></option>` : ""}
        ${options.map((option) => `<option value="${escapeAttr(option.label)}" data-value="${escapeAttr(option.value)}" data-club-id="${escapeAttr(option.clubId || "")}"></option>`).join("")}
      </datalist>
    </label>
  `;
}

function filterOrganizationSelect(input) {
  const field = input.closest(".filterable-select-field");
  const hiddenInput = field?.querySelector('input[type="hidden"]');
  const list = input.list;
  if (!hiddenInput || !list) return;
  const term = input.value.trim().toLowerCase();
  const form = input.closest("form");
  const selectedClubId = form?.querySelector("[data-organization-club-select]")?.value || "";
  let matchedValue = "";
  Array.from(list.options).forEach((option) => {
    const clubMatches = !option.dataset.clubId || !selectedClubId || option.dataset.clubId === selectedClubId;
    option.hidden = !clubMatches;
    option.disabled = !clubMatches;
    const label = String(option.value || "");
    if (clubMatches && term && label.toLowerCase() === term) matchedValue = option.dataset.value || "";
  });
  hiddenInput.value = matchedValue;
  if (hiddenInput.matches("[data-organization-club-select]")) syncOrganizationTeamSelect(form);
}

function validateFilterableSelects(form) {
  const invalid = Array.from(form.querySelectorAll(".filterable-select-field"))
    .map((field) => {
      const search = field.querySelector("[data-org-select-filter]");
      const hiddenInput = field.querySelector('input[type="hidden"]');
      if (!search || !hiddenInput || !search.required) return null;
      return hiddenInput.value ? null : search;
    })
    .filter(Boolean);
  invalid[0]?.setCustomValidity("Choose an item from the list.");
  if (invalid[0]) {
    invalid[0].reportValidity();
    invalid[0].setCustomValidity("");
    return false;
  }
  return true;
}

function syncOrganizationTeamSelect(form) {
  const clubInput = form?.querySelector("[data-organization-club-select]");
  const teamInput = form?.querySelector("[data-organization-team-select]");
  if (!clubInput || !teamInput) return;
  const selectedClubId = clubInput.value;
  const teamField = teamInput.closest(".filterable-select-field");
  const teamSearch = teamField?.querySelector("[data-org-select-filter]");
  const teamOption = Array.from(teamSearch?.list?.options || []).find((option) => option.dataset.value === teamInput.value);
  if (teamOption?.dataset.clubId && selectedClubId && teamOption.dataset.clubId !== selectedClubId) {
    teamInput.value = "";
    if (teamSearch) teamSearch.value = "";
  }
  if (teamSearch) filterOrganizationSelect(teamSearch);
}

function renderOrganizationClubForm() {
  return `
    <form class="panel organization-form" data-organization-form="club">
      <div><p class="eyebrow">Platform</p><h3>Add club</h3></div>
      <label class="search-field"><span>Club name</span><input name="name" required placeholder="e.g. FK Borac"></label>
      <label class="search-field"><span>Short name</span><input name="shortName" placeholder="e.g. Borac"></label>
      <label class="search-field"><span>Logo URL</span><input name="logoUrl" type="url" placeholder="https://..."></label>
      <div class="organization-form-row">
        <label class="search-field"><span>City</span><input name="city"></label>
        <label class="search-field"><span>Country</span><input name="country"></label>
      </div>
      <p class="builder-error" aria-live="polite"></p>
      <button class="plain-button" type="submit">Add club</button>
    </form>
  `;
}

function renderOrganizationTeamForm(clubs) {
  const clubOptions = clubs.map((club) => ({ value: club.id, label: club.name }));
  return `
    <form class="panel organization-form" data-organization-form="team">
      <div><p class="eyebrow">Club</p><h3>Add team</h3></div>
      ${renderFilterableSelect({ name: "clubId", label: "Club", options: clubOptions, required: true, placeholder: "Type club name" })}
      <label class="search-field"><span>Team name</span><input name="name" required placeholder="e.g. First team"></label>
      <label class="search-field"><span>Short name</span><input name="shortName" placeholder="e.g. U19"></label>
      <label class="search-field"><span>Logo URL</span><input name="logoUrl" type="url" placeholder="https://..."></label>
      <p class="builder-error" aria-live="polite"></p>
      <button class="plain-button" type="submit" ${clubs.length ? "" : "disabled"}>Add team</button>
    </form>
  `;
}

function renderOrganizationAthleteForm(clubs, teams) {
  const clubOptions = clubs.map((club) => ({ value: club.id, label: club.name }));
  const teamOptions = teams.map((team) => ({ value: team.id, label: `${team.name}${team.club_name ? ` - ${team.club_name}` : ""}`, clubId: team.club_id }));
  return `
    <form class="panel organization-form" data-organization-form="athlete">
      <div><p class="eyebrow">Athletes</p><h3>Add athlete</h3></div>
      <label class="search-field"><span>Athlete name</span><input name="fullName" required placeholder="First and last name"></label>
      <label class="search-field"><span>External ID</span><input name="athleteId" placeholder="Optional old ID"></label>
      <label class="search-field"><span>Image URL</span><input name="imageUrl" type="url" placeholder="https://..."></label>
      <div class="organization-form-row">
        ${renderFilterableSelect({ name: "clubId", label: "Club", options: clubOptions, placeholder: "Type club name", includeEmpty: "No club", extraSelectAttrs: "data-organization-club-select" })}
        ${renderFilterableSelect({ name: "teamId", label: "Team", options: teamOptions, placeholder: "Type team name", includeEmpty: "No team", extraSelectAttrs: "data-organization-team-select" })}
      </div>
      <p class="builder-error" aria-live="polite"></p>
      <button class="plain-button" type="submit">Add athlete</button>
    </form>
  `;
}

function renderOrganizationRoleForms(data) {
  const users = data.users || [];
  if (!users.length) return "";
  const userOptions = users.map((user) => ({ value: user.id, label: `${user.name || user.email}${user.email ? ` - ${user.email}` : ""}` }));
  const clubOptions = (data.clubs || []).map((club) => ({ value: club.id, label: club.name }));
  const teamOptions = (data.teams || []).map((team) => ({ value: team.id, label: `${team.name}${team.club_name ? ` - ${team.club_name}` : ""}`, clubId: team.club_id }));
  const athleteOptions = (data.athletes || []).map((athlete) => ({ value: athlete.id, label: `${athlete.name}${athlete.athlete_id ? ` - ID ${athlete.athlete_id}` : ""}` }));
  return `
    <form class="panel organization-form" data-organization-form="clubRole">
      <div><p class="eyebrow">Club access</p><h3>Assign club admin</h3></div>
      ${renderFilterableSelect({ name: "userId", label: "User", options: userOptions, required: true, placeholder: "Type user name or email" })}
      ${renderFilterableSelect({ name: "clubId", label: "Club", options: clubOptions, required: true, placeholder: "Type club name" })}
      <p class="builder-error" aria-live="polite"></p>
      <button class="plain-button" type="submit" ${(data.clubs || []).length ? "" : "disabled"}>Assign club</button>
    </form>
    <form class="panel organization-form" data-organization-form="teamRole">
      <div><p class="eyebrow">Team access</p><h3>Assign team coach</h3></div>
      ${renderFilterableSelect({ name: "userId", label: "User", options: userOptions, required: true, placeholder: "Type user name or email" })}
      ${renderFilterableSelect({ name: "teamId", label: "Team", options: teamOptions, required: true, placeholder: "Type team name" })}
      <p class="builder-error" aria-live="polite"></p>
      <button class="plain-button" type="submit" ${(data.teams || []).length ? "" : "disabled"}>Assign team</button>
    </form>
    <form class="panel organization-form" data-organization-form="athleteLogin">
      <div><p class="eyebrow">Athlete app</p><h3>Manual athlete login</h3><p class="muted">For normal onboarding, use Invite on the athlete row so the athlete sets their own password.</p></div>
      ${renderFilterableSelect({ name: "athleteId", label: "Athlete", options: athleteOptions, required: true, placeholder: "Type athlete name or ID" })}
      <label class="search-field"><span>Email</span><input name="email" type="email" required placeholder="athlete@example.com"></label>
      <label class="search-field"><span>Password</span><input name="password" type="password" required placeholder="At least 8 characters"></label>
      <p class="builder-error" aria-live="polite"></p>
      <button class="plain-button" type="submit" ${(data.athletes || []).length ? "" : "disabled"}>Create login</button>
    </form>
  `;
}

function renderOrganizationList(title, rows, type) {
  return `
    <section class="panel organization-list-card">
      <div class="organization-list-head"><p class="eyebrow">${escapeHtml(title)}</p><strong>${rows.length}</strong></div>
      <div class="organization-list">
        ${rows.length ? rows.map((row) => renderOrganizationRowV2(row, type)).join("") : `<p class="muted">No ${escapeHtml(title.toLowerCase())} yet.</p>`}
      </div>
    </section>
  `;
}

function renderOrganizationRow(row, type) {
  const title = row.name || row.full_name || row.display_name || row.athlete_id || "Untitled";
  const subtitle = type === "athlete"
    ? [row.athlete_id || row.source_external_id, row.team_name, row.club_name].filter(Boolean).join(" · ")
    : [row.short_name, row.club_name, row.city, row.country].filter(Boolean).join(" · ");
  const image = row.image_url || row.logo_url || "";
  return `
    <article class="organization-row">
      ${image ? renderImage(image, "organization-avatar") : `<span class="organization-avatar">${escapeHtml(type.slice(0, 2).toUpperCase())}</span>`}
      <span><strong>${escapeHtml(title)}</strong><small>${escapeHtml(subtitle || type)}</small></span>
    </article>
  `;
}

function renderOrganizationRowV2(row, type) {
  return `
    <article class="organization-row">
      ${renderOrganizationRowContent(row, type)}
      ${type === "user" ? "" : `<span class="organization-row-actions"><button class="text-action" type="button" data-action="organization-edit" data-org-type="${escapeAttr(type)}" data-org-id="${escapeAttr(row.id)}">Edit</button><button class="text-action danger-action" type="button" data-action="organization-delete" data-org-type="${escapeAttr(type)}" data-org-id="${escapeAttr(row.id)}">Delete</button></span>`}
    </article>
  `;
}

function renderOrganizationRowContent(row, type) {
  const title = row.name || row.full_name || row.display_name || row.athlete_id || "Untitled";
  const subtitle = type === "athlete"
    ? [row.athlete_id || row.source_external_id, row.team_name, row.club_name, row.user_id ? "login enabled" : ""].filter(Boolean).join(" - ")
    : type === "user"
      ? [row.email, row.role_hint].filter(Boolean).join(" - ")
      : [row.short_name, row.club_name, row.city, row.country].filter(Boolean).join(" - ");
  const image = row.image_url || row.logo_url || "";
  return `
    ${image ? renderImage(image, "organization-avatar") : `<span class="organization-avatar">${escapeHtml(type.slice(0, 2).toUpperCase())}</span>`}
    <span><strong>${escapeHtml(title)}</strong><small>${escapeHtml(subtitle || type)}</small></span>
  `;
}

function renderOrganizationEditModal(data) {
  const { type, row } = state.organizationEditor;
  if (!row) return "";
  const title = `Edit ${type}`;
  return `
    <div class="exercise-tag-overlay">
      <button class="exercise-tag-backdrop" type="button" data-action="organization-edit-close" aria-label="Close editor"></button>
      <section class="panel exercise-tag-modal organization-edit-modal" role="dialog" aria-modal="true" aria-label="${escapeAttr(title)}">
        <div class="builder-modal-head">
          <div><p class="eyebrow">Organization</p><h3>${escapeHtml(title)}</h3></div>
          <button class="plain-button icon-button" type="button" data-action="organization-edit-close" aria-label="Close"><span class="button-icon">x</span></button>
        </div>
        ${type === "club" ? renderOrganizationClubEditForm(row) : type === "team" ? renderOrganizationTeamEditForm(row, data.clubs || []) : `${renderOrganizationAthleteEditForm(row, data.clubs || [], data.teams || [])}${renderAthleteLibraryAccessForm(row)}`}
      </section>
    </div>
  `;
}

function renderOrganizationClubEditForm(row) {
  return `
    <form class="organization-form" data-organization-form="edit-club" data-organization-edit-id="${escapeAttr(row.id)}">
      <label class="search-field"><span>Club name</span><input name="name" required value="${escapeAttr(row.name || "")}"></label>
      <label class="search-field"><span>Short name</span><input name="shortName" value="${escapeAttr(row.short_name || "")}"></label>
      <label class="search-field"><span>Logo URL</span><input name="logoUrl" type="url" value="${escapeAttr(row.logo_url || "")}"></label>
      <div class="organization-form-row"><label class="search-field"><span>City</span><input name="city" value="${escapeAttr(row.city || "")}"></label><label class="search-field"><span>Country</span><input name="country" value="${escapeAttr(row.country || "")}"></label></div>
      <p class="builder-error" aria-live="polite"></p>
      <button class="plain-button" type="submit">Save changes</button>
    </form>
  `;
}

function renderOrganizationTeamEditForm(row, clubs) {
  const clubOptions = clubs.map((club) => ({ value: club.id, label: club.name }));
  return `
    <form class="organization-form" data-organization-form="edit-team" data-organization-edit-id="${escapeAttr(row.id)}">
      ${renderFilterableSelect({ name: "clubId", label: "Club", options: clubOptions, value: row.club_id, required: true, placeholder: "Type club name" })}
      <label class="search-field"><span>Team name</span><input name="name" required value="${escapeAttr(row.name || "")}"></label>
      <label class="search-field"><span>Short name</span><input name="shortName" value="${escapeAttr(row.short_name || "")}"></label>
      <label class="search-field"><span>Logo URL</span><input name="logoUrl" type="url" value="${escapeAttr(row.logo_url || "")}"></label>
      <p class="builder-error" aria-live="polite"></p>
      <button class="plain-button" type="submit">Save changes</button>
    </form>
  `;
}

function renderOrganizationAthleteEditForm(row, clubs, teams) {
  const clubOptions = clubs.map((club) => ({ value: club.id, label: club.name }));
  const teamOptions = teams.map((team) => ({ value: team.id, label: `${team.name}${team.club_name ? ` - ${team.club_name}` : ""}`, clubId: team.club_id }));
  return `
    <form class="organization-form" data-organization-form="edit-athlete" data-organization-edit-id="${escapeAttr(row.id)}">
      <label class="search-field"><span>Athlete name</span><input name="fullName" required value="${escapeAttr(row.name || "")}"></label>
      <label class="search-field"><span>External ID</span><input name="athleteId" value="${escapeAttr(row.athlete_id || row.source_external_id || "")}"></label>
      <label class="search-field"><span>Image URL</span><input name="imageUrl" type="url" value="${escapeAttr(row.image_url || "")}"></label>
      <div class="organization-form-row">
        ${renderFilterableSelect({ name: "clubId", label: "Club", options: clubOptions, value: row.club_id, placeholder: "Type club name", includeEmpty: "No club", extraSelectAttrs: "data-organization-club-select" })}
        ${renderFilterableSelect({ name: "teamId", label: "Team", options: teamOptions, value: row.team_id, placeholder: "Type team name", includeEmpty: "No team", extraSelectAttrs: "data-organization-team-select" })}
      </div>
      <p class="builder-error" aria-live="polite"></p>
      <button class="plain-button" type="submit">Save changes</button>
    </form>
  `;
}

function renderAthleteLibraryAccessForm(row) {
  return `
    <form class="organization-form athlete-access-form" data-organization-form="athleteLibraryAccess" data-athlete-id="${escapeAttr(row.id)}">
      <div>
        <p class="eyebrow">Athlete library access</p>
        <h3>Visible program libraries</h3>
        <p class="muted">Control what this athlete can browse from Program Library. Assigned weekly and specific programs stay visible as before.</p>
      </div>
      <div class="athlete-access-grid">
        ${renderAccessCheckbox("canViewCoachLibrary", "Coach library", row.can_view_coach_library !== false)}
        ${renderAccessCheckbox("canViewClubLibrary", "Club library", row.can_view_club_library === true)}
        ${renderAccessCheckbox("canViewOptimoveLibrary", "OptiMove", row.can_view_optimove_library === true)}
        ${renderAccessCheckbox("canViewMarketplace", "Marketplace", row.can_view_marketplace === true)}
        ${renderAccessCheckbox("freeOnly", "Free programs only", row.free_only !== false)}
        ${renderAccessCheckbox("requireApproval", "Require approval", row.require_approval !== false)}
      </div>
      <p class="builder-error" aria-live="polite"></p>
      <button class="plain-button compact-button" type="submit">Save library access</button>
    </form>
  `;
}

function renderAccessCheckbox(name, label, checked) {
  return `
    <label class="program-checkbox">
      <input type="checkbox" name="${escapeAttr(name)}" value="true" ${checked ? "checked" : ""}>
      <span>${escapeHtml(label)}</span>
    </label>
  `;
}

async function submitOrganizationForm(form) {
  if (!validateFilterableSelects(form)) return;
  const type = form.dataset.organizationForm;
  const button = form.querySelector("button[type='submit']");
  const error = form.querySelector(".builder-error");
  if (error) error.textContent = "";
  if (button) button.disabled = true;
  const formData = new FormData(form);
  const payload = Object.fromEntries(formData.entries());
  const editId = form.dataset.organizationEditId;
  const athleteId = form.dataset.athleteId;
  const teamId = form.dataset.teamId;
  const endpoint = {
    club: "/api/organization/clubs",
    team: "/api/organization/teams",
    athlete: "/api/organization/athletes",
    user: "/api/organization/users",
    clubRole: "/api/organization/club-roles",
    teamRole: "/api/organization/team-roles",
    athleteLogin: "/api/organization/athlete-logins",
    athleteInvite: "/api/organization/athlete-invites",
    assignTeamAthlete: `/api/organization/teams/${encodeURIComponent(teamId || "")}/athletes`,
    athleteLibraryAccess: `/api/organization/athletes/${encodeURIComponent(athleteId || "")}/library-access`,
    "edit-club": `/api/organization/clubs/${encodeURIComponent(editId)}`,
    "edit-team": `/api/organization/teams/${encodeURIComponent(editId)}`,
    "edit-athlete": `/api/organization/athletes/${encodeURIComponent(editId)}`,
  }[type];
  const method = type.startsWith("edit-") || type === "athleteLibraryAccess" ? "PUT" : "POST";
  if (type === "athleteLibraryAccess") {
    payload.canViewCoachLibrary = formData.has("canViewCoachLibrary");
    payload.canViewClubLibrary = formData.has("canViewClubLibrary");
    payload.canViewOptimoveLibrary = formData.has("canViewOptimoveLibrary");
    payload.canViewMarketplace = formData.has("canViewMarketplace");
    payload.freeOnly = formData.has("freeOnly");
    payload.requireApproval = formData.has("requireApproval");
  }
  try {
    const result = await api(endpoint, { method, body: JSON.stringify(payload) });
    if (type === "athleteInvite") {
      state.organizationInvite = {
        open: true,
        athleteId: payload.athleteId || state.organizationInvite.athleteId,
        inviteUrl: result.inviteUrl || "",
        mailtoUrl: result.mailtoUrl || "",
        error: "",
      };
      await renderOrganizationPanel({ refresh: false });
      return;
    }
    form.reset();
    state.organizationEditor = { open: false, type: "", row: null };
    await loadAthletes();
    if (state.activeTab === "organization") await renderOrganizationPanel();
  } catch (submitError) {
    if (error) error.textContent = submitError.message || "Could not save.";
  } finally {
    if (button) button.disabled = false;
  }
}

function findOrganizationRow(type, id) {
  const data = state.organization.data || {};
  const rows = type === "club" ? data.clubs : type === "team" ? data.teams : type === "athlete" ? data.athletes : [];
  return (rows || []).find((row) => String(row.id) === String(id)) || null;
}

async function deleteOrganizationRow(type, id) {
  const labels = { club: "club", team: "team", athlete: "athlete" };
  if (!id || !labels[type]) return;
  if (!window.confirm(`Delete this ${labels[type]}? Existing plans are preserved, but it will be hidden from active lists.`)) return;
  await api(`/api/organization/${type}s/${encodeURIComponent(id)}`, { method: "DELETE" });
  await loadAthletes();
  if (state.activeTab === "organization") await renderOrganizationPanel();
}

function renderAthleteList() {
  const search = els.athleteSearch.value.trim().toLowerCase();
  const filteredAthletes = state.athletes.filter((athlete) => {
    const haystack = `${athlete.athlete_id} ${athlete.athlete}`.toLowerCase();
    return haystack.includes(search);
  });
  const athletes = filteredAthletes;

  els.athleteList.innerHTML = athletes.map((athlete) => `
    <button class="athlete-button ${athlete.athlete_id === state.selectedAthleteId ? "is-active" : ""}" data-athlete-id="${escapeAttr(athlete.athlete_id)}">
      ${avatarMarkup(athlete)}
      <span>
        <span class="athlete-name">${escapeHtml(athlete.athlete)}</span>
        <span class="athlete-meta">ID ${escapeHtml(athlete.athlete_id)}</span>
        <span class="athlete-counts">
          <span>${athlete.weekly_plan_count || 0} weekly</span>
          <span>${athlete.program_count || 0} specific</span>
        </span>
      </span>
    </button>
  `).join("");

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
  const imageMarkup = athlete.athlete_image_url
    ? renderImage(athlete.athlete_image_url, "athlete-hero-image", initialsFor(athlete.athlete))
    : `<div class="athlete-hero-fallback">${escapeHtml(initialsFor(athlete.athlete))}</div>`;
  const athleteDetailsMarkup = isAthleteMode ? `
    <div class="athlete-hero-copy">
      <p class="eyebrow">My program</p>
      <h3>${escapeHtml(athlete.athlete)}</h3>
      <p class="muted">Athlete ID ${escapeHtml(athlete.athlete_id || "")}</p>
    </div>
  ` : "";

  els.toolbar.innerHTML = `
    <div class="athlete-toolbar-row">
      <section class="athlete-hero ${isAthleteMode ? "" : "athlete-hero-compact"}" aria-label="Selected athlete">
        ${imageMarkup}
        ${athleteDetailsMarkup}
      </section>
      <nav class="tabs athlete-tabs" aria-label="Athlete views">
        <button class="tab tab-with-icon" data-tab="weekly" data-open-calendar="true">
          <svg class="tab-icon" viewBox="0 0 24 24" aria-hidden="true">
            <rect x="4" y="5" width="16" height="15" rx="2"></rect>
            <path d="M8 3v4"></path>
            <path d="M16 3v4"></path>
            <path d="M4 10h16"></path>
          </svg>
          <span>Weekly plans</span>
        </button>
        <button class="tab" data-tab="programs">Specific programs</button>
      </nav>
    </div>
  `;
  renderTabs();
}

function renderAthleteSettings() {
  const athlete = state.athletes.find((entry) => entry.athlete_id === state.selectedAthleteId);
  renderAthleteHeader({});
  els.context.textContent = "Athlete settings";
  els.title.textContent = "Settings";
  els.content.innerHTML = `
    <section class="content-section athlete-simple-view">
      <section class="panel athlete-settings-card">
        <div>
          <p class="eyebrow">Profile</p>
          <h3>${escapeHtml(athlete?.athlete || "Athlete profile")}</h3>
          <p class="muted">Your coach controls program assignment. Profile editing and password change will live here.</p>
        </div>
        <div class="athlete-setting-list">
          <article>
            <strong>Account</strong>
            <span>Email and password management.</span>
          </article>
          <article>
            <strong>Personal data</strong>
            <span>Photo, contact details, and basic profile information.</span>
          </article>
          <article>
            <strong>Notifications</strong>
            <span>Future reminders for programs, wellness, and testing.</span>
          </article>
        </div>
      </section>
    </section>
  `;
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
    ${renderCopyPlanModal()}
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
          ${month.days.map((day) => renderWeekCalendarDay(day, activeWeek, selectedWeeklyDay(activeWeek))).join("")}
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
        subtitle: `${(microcycle.dayGroups || []).length} blocks`,
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
    ${renderCopyPlanModal()}
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
    <section class="panel">
      <div class="drill-header">
        <div>
          <p class="eyebrow">${escapeHtml(node.typeLabel || node.type)}</p>
          <h3>${escapeHtml(node.label)}</h3>
          <div class="breadcrumb">${crumbs.map(escapeHtml).join(" / ")}</div>
        </div>
        <div class="drill-actions">
          <div class="drill-main-actions">
            <button class="plain-button icon-button" data-action="back"><span class="button-icon">←</span><span>Back</span></button>
            <button class="plain-button icon-button" data-action="home"><span class="button-icon">⌂</span><span>Home</span></button>
          </div>
          ${siblingState.hasSiblings ? `
            <div class="drill-sibling-actions">
              <button class="plain-button icon-button" data-action="node-prev" ${siblingState.canGoPrevious ? "" : "disabled"}><span class="button-icon">‹</span><span>Previous</span></button>
              <span class="exercise-position">${siblingState.index + 1} / ${siblingState.total}</span>
              <button class="plain-button icon-button" data-action="node-next" ${siblingState.canGoNext ? "" : "disabled"}><span>Next</span><span class="button-icon">›</span></button>
            </div>
          ` : ""}
        </div>
      </div>
      ${node.note ? `<p class="node-note">${escapeHtml(node.note)}</p>` : ""}
      ${next.length
        ? `<div class="node-grid">${next.map(renderNodeButton).join("")}</div>`
        : renderTerminalNode(node)}
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

async function openTemplatePreview(planId) {
  const selected = state.lastTemplates.find((template) => String(template.plan_id) === String(planId));
  if (!selected) return;
  await openTemplatePreviewWithRenderer(selected, () => renderTemplateLibrary(state.lastTemplates));
}

async function openTemplatePreviewFromCoachProgram(program) {
  if (!program?.plan_id) return;
  if (!state.lastTemplates.some((template) => String(template.plan_id) === String(program.plan_id))) {
    state.lastTemplates = [...state.lastTemplates, normalizeCoachProgramAsTemplate(program)];
  }
  const selected = state.lastTemplates.find((template) => String(template.plan_id) === String(program.plan_id));
  await openTemplatePreviewWithRenderer(selected, renderCurrentNode);
}

async function openTemplatePreviewWithRenderer(selected, renderAfter) {
  state.selectedTemplateId = selected.plan_id;
  state.templatePreview = emptyTemplatePreview({ open: true, loading: true });
  renderAfter();
  try {
    const [detail, reviewsData] = await Promise.all([
      api(`/api/plans/${encodeURIComponent(selected.plan_id)}/program`),
      api(`/api/templates/${encodeURIComponent(selected.plan_id)}/reviews`),
    ]);
    state.templatePreview = emptyTemplatePreview({
      ...state.templatePreview,
      open: true,
      loading: false,
      detail,
      reviews: reviewsData.reviews || [],
      error: "",
    });
  } catch (error) {
    state.templatePreview = emptyTemplatePreview({ ...state.templatePreview, open: true, loading: false, detail: null, error: error.message || "Could not load program." });
  }
  renderAfter();
}

function normalizeCoachProgramAsTemplate(program) {
  return {
    ...program,
    plan_id: program.plan_id,
    plan_name: program.plan_name,
    library_category: program.library_category,
    cover_image_url: program.cover_image_url,
    is_free: program.is_free,
    price_cents: program.price_cents,
    average_rating: program.average_rating,
    review_count: program.review_count,
    library_scope: program.library_scope || "coach",
    tags: program.tags || [],
  };
}

function duplicateTemplateNames(templates) {
  const counts = new Map();
  templates.forEach((template) => {
    const name = clean(template.plan_name);
    if (!name) return;
    counts.set(name, (counts.get(name) || 0) + 1);
  });
  return new Set([...counts].filter(([, count]) => count > 1).map(([name]) => name));
}

function templateSecondaryLabel(template, duplicateNames) {
  return "";
}

function renderTemplateList(templates, selected, detail) {
  const scope = templateScopeMeta();
  els.context.textContent = "Program library";
  els.title.textContent = scope.label;
  const data = detail || {};
  const isMicrocycle = data.mode === "microcycle";
  const groups = isMicrocycle
    ? (data.microcycles || []).map((microcycle) => makeNode("microcycle", microcycle.name, flattenDayGroups(microcycle.dayGroups), {
        subtitle: `${(microcycle.dayGroups || []).length} blocks`,
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
    ${renderCopyPlanModal()}
  `;
}

function renderTemplateLibrary(templates) {
  const scope = templateScopeMeta();
  const visibleTemplates = applyTemplateClientFilters(templates);
  els.context.textContent = "Program library";
  els.title.textContent = scope.label;
  els.toolbar.innerHTML = "";

  els.content.innerHTML = `
    <section class="content-section program-library-page">
      <div class="program-library-head">
        <div>
          <p class="eyebrow">${escapeHtml(scope.eyebrow)}</p>
          <h3>${escapeHtml(scope.label)}</h3>
        </div>
        <p class="muted" data-template-count>${visibleTemplates.length} programs</p>
      </div>
      ${renderTemplateFilters()}
      <div class="program-library-shelves" data-template-results>
        ${renderTemplateLibraryResultsHtml(visibleTemplates)}
      </div>
    </section>
    ${renderTemplatePreviewModal()}
    ${renderCoachDetailModal()}
    ${renderCopyPlanModal()}
  `;
}

function renderTemplateLibraryResults() {
  const visibleTemplates = applyTemplateClientFilters(state.lastTemplates || []);
  const count = document.querySelector("[data-template-count]");
  if (count) count.textContent = `${visibleTemplates.length} programs`;
  document.querySelector(".program-preview-overlay")?.remove();
  const target = document.querySelector("[data-template-results]");
  if (target) target.innerHTML = renderTemplateLibraryResultsHtml(visibleTemplates);
}

function renderTemplateLibraryResultsHtml(templates) {
  const duplicateNames = duplicateTemplateNames(templates);
  const shelves = groupTemplatesByCategory(templates);
  if (!templates.length) return `<div class="empty-state">No programs match these filters.</div>`;
  return shelves.map((shelf) => `
    <section class="program-library-shelf" aria-label="${escapeAttr(shelf.label)}">
      <div class="program-library-shelf-head">
        <h4>${escapeHtml(shelf.label)}</h4>
        <span>${shelf.templates.length} programs</span>
      </div>
      <div class="program-library-row">
        ${shelf.templates.map((template) => renderProgramLibraryCard(template, duplicateNames)).join("")}
      </div>
    </section>
  `).join("");
}

function applyTemplateClientFilters(templates) {
  const search = clean(state.templateFilters.search).toLowerCase();
  const category = clean(state.templateFilters.category);
  const categoryNeedle = category.toLowerCase();
  const tag = clean(state.templateFilters.tag).toLowerCase();
  const creator = clean(state.templateFilters.creator).toLowerCase();
  const club = clean(state.templateFilters.club).toLowerCase();
  const ownerType = clean(state.templateFilters.ownerType).toLowerCase();
  const visibility = clean(state.templateFilters.visibility).toLowerCase();
  const pricing = clean(state.templateFilters.pricing).toLowerCase();
  return templates.filter((template) => {
    if (search) {
      const haystack = `${template.plan_name || ""} ${template.source_external_id || ""}`.toLowerCase();
      if (!haystack.includes(search)) return false;
    }
    if (categoryNeedle && categoryNeedle !== "all" && !templateFilterOptionMatches(templateCategoryLabel(template), categoryNeedle)) return false;
    if (tag && tag !== "all" && !(template.tags || []).some((row) => templateFilterOptionMatches(row.name, tag))) return false;
    if (creator && creator !== "all") {
      const creatorText = `${template.creator_name || ""} ${template.creator_email || ""}`.trim();
      if (!templateFilterOptionMatches(creatorText, creator)) return false;
    }
    if (club && club !== "all" && !templateFilterOptionMatches(template.creator_club_names, club)) return false;
    if (ownerType && ownerType !== "all" && clean(template.owner_type).toLowerCase() !== ownerType) return false;
    if (visibility && visibility !== "all" && clean(template.visibility).toLowerCase() !== visibility) return false;
    if (pricing === "free" && template.is_free === false) return false;
    if (pricing === "paid" && template.is_free !== false) return false;
    return true;
  });
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
  const categories = templateCategoryOptions();
  const categoryPrefix = clean(filters.category).toLowerCase();
  const visibleCategories = categoryPrefix ? categories.filter((category) => templateFilterOptionMatches(category, categoryPrefix)) : categories;
  const creatorOptions = templateFilterSuggestions("creator");
  const creatorPrefix = clean(filters.creator).toLowerCase();
  const visibleCreators = creatorPrefix ? creatorOptions.filter((creator) => templateFilterOptionMatches(creator, creatorPrefix)) : creatorOptions;
  const clubOptions = templateFilterSuggestions("club");
  const clubPrefix = clean(filters.club).toLowerCase();
  const visibleClubs = clubPrefix ? clubOptions.filter((club) => templateFilterOptionMatches(club, clubPrefix)) : clubOptions;
  return `
    <div class="program-scope-tabs" role="group" aria-label="Program library scope">
      ${scopes.map((scope) => renderTemplateScopeButton(scope, templateScopeMeta(scope).label)).join("")}
    </div>
    <section class="program-filter-panel" aria-label="Program filters">
      <label class="search-field program-filter-search">
        <span>Search programs</span>
        <input data-template-filter="search" type="search" value="${escapeAttr(filters.search || "")}" placeholder="Program name or code">
      </label>
      <label class="search-field">
        <span>Program group</span>
        <input data-template-filter="category" list="program-group-options" value="${escapeAttr(filters.category || "")}" placeholder="All">
        <datalist id="program-group-options">
          <option value="All"></option>
          ${visibleCategories.map((category) => `<option value="${escapeAttr(category)}"></option>`).join("")}
        </datalist>
      </label>
      <label class="search-field">
        <span>Tag</span>
        <input data-template-filter="tag" list="program-tag-filter-options" value="${escapeAttr(filters.tag || "")}" placeholder="${(options.tags || []).length ? "All" : "No assigned tags"}">
        <datalist id="program-tag-filter-options">
          <option value="All"></option>
          ${visibleTags.map((tag) => `<option value="${escapeAttr(tag)}"></option>`).join("")}
        </datalist>
      </label>
      ${showAdminFilters ? `
        <label class="search-field">
          <span>Coach</span>
          <input data-template-filter="creator" list="program-creator-filter-options" value="${escapeAttr(filters.creator || "")}" placeholder="${creatorOptions.length ? "All coaches" : "No coaches"}">
          <datalist id="program-creator-filter-options">
            <option value="All"></option>
            ${visibleCreators.map((creator) => `<option value="${escapeAttr(creator)}"></option>`).join("")}
          </datalist>
        </label>
        <label class="search-field">
          <span>Club</span>
          <input data-template-filter="club" list="program-club-filter-options" value="${escapeAttr(filters.club || "")}" placeholder="${clubOptions.length ? "All clubs" : "No clubs"}">
          <datalist id="program-club-filter-options">
            <option value="All"></option>
            ${visibleClubs.map((club) => `<option value="${escapeAttr(club)}"></option>`).join("")}
          </datalist>
        </label>
        <label class="search-field">
          <span>Owner</span>
          <select data-template-filter="ownerType">
            ${renderOption("all", "All owners", filters.ownerType || "all")}
            ${renderOption("coach", "Coach", filters.ownerType)}
            ${renderOption("club", "Club", filters.ownerType)}
            ${renderOption("optimove", "OptiMove", filters.ownerType)}
            ${renderOption("marketplace", "Marketplace", filters.ownerType)}
          </select>
        </label>
        <label class="search-field">
          <span>Access</span>
          <select data-template-filter="visibility">
            ${renderOption("all", "All access", filters.visibility || "all")}
            ${renderOption("private", "Private", filters.visibility)}
            ${renderOption("team", "Team shared", filters.visibility)}
            ${renderOption("club", "Club shared", filters.visibility)}
            ${renderOption("public", "Public", filters.visibility)}
          </select>
        </label>
      ` : ""}
      <label class="program-paid-filter">
        <input data-template-filter="freeOnly" type="checkbox" ${filters.pricing === "free" ? "checked" : ""}>
        <span>Free only</span>
      </label>
    </section>
  `;
}

function templateCategoryOptions() {
  const defaults = ["General", "Rehabilitation", "Strength & power", "Speed & conditioning", "Movement prep", "Corrective & preventive", "Fitness & health", "Education"];
  const assigned = state.templateOptions.categories || [];
  const inferred = (state.lastTemplates || []).map(templateCategoryLabel).filter(Boolean);
  return [...new Set([...defaults, ...assigned, ...inferred])].sort((a, b) => a.localeCompare(b));
}

function renderTemplateScopeButton(value, label) {
  return `<button class="program-scope-button ${state.templateScope === value ? "is-active" : ""}" type="button" data-action="template-scope" data-scope="${escapeAttr(value)}">${escapeHtml(label)}</button>`;
}

function groupTemplatesByCategory(templates) {
  const groups = new Map();
  templates.forEach((template) => {
    const category = templateCategoryLabel(template);
    if (!groups.has(category)) groups.set(category, []);
    groups.get(category).push(template);
  });
  return [...groups.entries()].map(([label, rows]) => ({ label, templates: rows }));
}

function templateCategoryLabel(template) {
  return clean(template.library_category) || inferProgramCategory(template) || "General";
}

function inferProgramCategory(template) {
  const text = `${template.plan_name || ""} ${template.source_external_id || ""}`.toLowerCase();
  if (/(rehab|rechab|rtp|return|injury|pain|calf|groin|neck)/.test(text)) return "Rehabilitation";
  if (/(strength|strenght|power|gym|core|legs|arms)/.test(text)) return "Strength & power";
  if (/(speed|sprint|acceleration|deceleration|running)/.test(text)) return "Speed & conditioning";
  if (/(mobility|stability|activation|warm)/.test(text)) return "Movement prep";
  return "";
}

function renderProgramLibraryCard(template, duplicateNames) {
  const category = templateCategoryLabel(template);
  const creator = clean(template.creator_name);
  const creatorProfileId = clean(template.creator_profile_id);
  const isSelected = String(template.plan_id) === String(state.selectedTemplateId);
  const price = programPriceLabel(template);
  return `
    <article class="program-library-card ${isSelected ? "is-selected" : ""}">
      <button class="program-library-card-hit" type="button" data-action="template-open" data-template-id="${escapeAttr(template.plan_id)}">
        <span class="program-library-card-media">
          ${template.cover_image_url ? renderImage(template.cover_image_url, "program-library-cover") : `<span class="program-library-card-icon">${escapeHtml(programInitials(template.plan_name))}</span>`}
        </span>
        <span class="program-library-card-body">
          <span class="program-library-card-title">${escapeHtml(template.plan_name || "Untitled program")}</span>
          <span class="program-library-card-sub">${escapeHtml(category)}</span>
        </span>
        <span class="program-library-card-foot">
          <span class="item-badge">${escapeHtml(price)}</span>
          <span class="item-badge">${escapeHtml(ratingLabel(template))}</span>
          ${(template.tags || []).length ? `<span class="item-badge">${escapeHtml(template.tags[0].name)}${template.tags.length > 1 ? ` +${template.tags.length - 1}` : ""}</span>` : ""}
          <span class="text-action">Preview</span>
        </span>
      </button>
      ${creator ? `
        <button class="program-library-creator" type="button" ${creatorProfileId ? `data-action="coach-open" data-profile-id="${escapeAttr(creatorProfileId)}"` : "disabled"}>
          ${template.creator_photo_url ? renderImage(template.creator_photo_url, "program-library-creator-photo") : `<span class="program-library-creator-initials">${escapeHtml(programInitials(creator))}</span>`}
          <span><small>Created by</small><strong>${escapeHtml(creator)}</strong></span>
        </button>
      ` : ""}
    </article>
  `;
}

function programPriceLabel(template) {
  const accessModel = template.access_model || (template.is_free === false ? "one_time_forever" : "free_forever");
  const durationDays = Number(template.access_duration_days || 0);
  if (template.is_free === false) {
    const price = template.price_cents ? `${Math.round(template.price_cents / 100)} EUR` : "Paid";
    if (accessModel === "subscription") return `${price} / ${template.subscription_period || "month"}`;
    if (durationDays) return `${price} - ${durationDays} days`;
    return price;
  }
  if (accessModel === "trial") return durationDays ? `Free trial - ${durationDays} days` : "Free trial";
  if (accessModel === "time_limited") return durationDays ? `Free - ${durationDays} days` : "Time-limited";
  if (accessModel === "assigned") return "Assigned";
  return "Free";
}

function ratingLabel(entity) {
  const count = Number(entity?.review_count || 0);
  if (!count) return "No reviews yet";
  const average = Number(entity?.average_rating || 0);
  return `${average.toFixed(average % 1 ? 1 : 0)} / 5 (${count})`;
}

async function submitTemplateMetadataForm(form) {
  const planId = form.dataset.planId || "";
  const error = form.querySelector(".builder-error");
  const button = form.querySelector("button[type='submit']");
  if (error) error.textContent = "";
  if (button) button.disabled = true;
  const formData = new FormData(form);
  try {
    await api(`/api/templates/${encodeURIComponent(planId)}/metadata`, {
      method: "PATCH",
      body: JSON.stringify({
        libraryScope: formData.get("libraryScope"),
        libraryCategory: formData.get("libraryCategory"),
        coverImageUrl: formData.get("coverImageUrl"),
        isFree: formData.get("isFree") === "true",
        priceCents: Math.round(Number(formData.get("price") || 0) * 100),
        availableUntil: formData.get("availableUntil"),
        ownerType: formData.get("ownerType"),
        visibility: formData.get("visibility"),
        accessModel: formData.get("accessModel"),
        accessDurationDays: formData.get("accessDurationDays"),
        subscriptionPeriod: formData.get("subscriptionPeriod"),
        canCopy: formData.get("canCopy") === "true",
        canEditCopy: formData.get("canEditCopy") === "true",
        canAssignToAthlete: formData.get("canAssignToAthlete") === "true",
        athleteCanViewDirectly: formData.get("athleteCanViewDirectly") === "true",
        requiresApproval: formData.get("requiresApproval") === "true",
      }),
    });
    state.templatePreview = emptyTemplatePreview();
    state.selectedTemplateId = null;
    await loadTemplates();
  } catch (submitError) {
    if (error) error.textContent = submitError.message || "Could not save library settings.";
  } finally {
    if (button) button.disabled = false;
  }
}

async function markTemplateUsed(planId) {
  if (!planId || state.templatePreview.submittingUse) return;
  state.templatePreview = {
    ...state.templatePreview,
    submittingUse: true,
    reviewError: "",
    reviewMessage: "",
  };
  renderTemplateLibrary(state.lastTemplates);
  try {
    await api(`/api/templates/${encodeURIComponent(planId)}/use`, {
      method: "POST",
      body: JSON.stringify({ note: "Marked as used from Program Library." }),
    });
    state.templatePreview = {
      ...state.templatePreview,
      submittingUse: false,
      usedMarked: true,
      reviewOpen: true,
      reviewMessage: "Access active. You can now leave a review after using this program.",
      reviewError: "",
    };
  } catch (error) {
    state.templatePreview = {
      ...state.templatePreview,
      submittingUse: false,
      reviewError: error.message || "Could not mark this program as used.",
      reviewMessage: "",
    };
  }
  renderTemplateLibrary(state.lastTemplates);
}

async function submitTemplateReviewForm(form) {
  const planId = form.dataset.planId || "";
  if (!planId || state.templatePreview.submittingReview) return;
  const formData = new FormData(form);
  const rating = Number(formData.get("rating") || 0);
  const comment = clean(formData.get("comment"));
  state.templatePreview = {
    ...state.templatePreview,
    submittingReview: true,
    reviewError: "",
    reviewMessage: "",
  };
  renderTemplateLibrary(state.lastTemplates);
  try {
    await api(`/api/templates/${encodeURIComponent(planId)}/reviews`, {
      method: "POST",
      body: JSON.stringify({ rating, comment }),
    });
    const reviewsData = await api(`/api/templates/${encodeURIComponent(planId)}/reviews`);
    state.templatePreview = {
      ...state.templatePreview,
      submittingReview: false,
      reviewOpen: false,
      reviewsOpen: true,
      reviews: reviewsData.reviews || [],
      usedMarked: true,
      reviewMessage: "Review saved.",
      reviewError: "",
    };
    await loadTemplates();
  } catch (error) {
    state.templatePreview = {
      ...state.templatePreview,
      submittingReview: false,
      reviewError: error.message || "Could not save review.",
      reviewMessage: "",
    };
    renderTemplateLibrary(state.lastTemplates);
  }
}

function programInitials(name = "") {
  const words = clean(name).split(/\s+/).filter(Boolean);
  if (!words.length) return "PL";
  return words.slice(0, 2).map((word) => word[0]).join("").toUpperCase();
}

function renderTemplatePreviewModal() {
  if (!state.templatePreview.open) return "";
  const selected = state.lastTemplates.find((template) => String(template.plan_id) === String(state.selectedTemplateId));
  const detail = state.templatePreview.detail || {};
  const selectedMeta = selected ? [templateCategoryLabel(selected), programPriceLabel(selected)].filter(Boolean).join(" · ") : "Program template";
  const creatorName = clean(selected?.creator_name);
  const creatorProfileId = clean(selected?.creator_profile_id);
  const isMicrocycle = detail.mode === "microcycle";
  const groups = state.templatePreview.loading || state.templatePreview.error
    ? []
    : isMicrocycle
      ? (detail.microcycles || []).map((microcycle) => makeNode("microcycle", microcycle.name, flattenDayGroups(microcycle.dayGroups), {
          subtitle: `${(microcycle.dayGroups || []).length} blocks`,
        }))
      : programDayGroupNodes(detail.dayGroups || []);

  return `
    <div class="program-preview-overlay">
      <button class="program-preview-backdrop" type="button" data-action="template-close" aria-label="Close program preview"></button>
      <section class="program-preview-modal" role="dialog" aria-modal="true" aria-label="${escapeAttr(selected?.plan_name || "Program preview")}">
        <div class="program-preview-head">
          <div>
            <p class="eyebrow">Program preview</p>
            <h3>${escapeHtml(selected?.plan_name || "Program")}</h3>
            <p class="muted">${escapeHtml(selectedMeta)}</p>
            ${creatorName ? `
              <button class="program-created-by" type="button" ${creatorProfileId ? `data-action="coach-open" data-profile-id="${escapeAttr(creatorProfileId)}"` : "disabled"}>
                ${selected.creator_photo_url ? renderImage(selected.creator_photo_url, "program-library-creator-photo") : `<span class="program-library-creator-initials">${escapeHtml(programInitials(creatorName))}</span>`}
                <span><small>Created by</small><strong>${escapeHtml(creatorName)}</strong>${selected.creator_headline ? `<em>${escapeHtml(selected.creator_headline)}</em>` : ""}</span>
              </button>
            ` : ""}
          </div>
          <div class="builder-source-actions">
            ${state.templatePreview.loading ? `<span class="item-badge">Loading</span>` : ""}
            ${selected ? `<span class="item-badge">${escapeHtml(ratingLabel(selected))}</span>` : ""}
            ${selected && state.currentUser?.role !== "athlete" && selected.can_assign_to_athlete !== false ? `<button class="plain-button compact-button" type="button" data-action="template-assign" data-template-id="${escapeAttr(selected.plan_id)}">Assign</button>` : ""}
            ${selected ? `<button class="plain-button compact-button" type="button" data-action="template-settings-toggle">${state.templatePreview.settingsOpen ? "Hide settings" : "Library settings"}</button>` : ""}
            ${selected ? renderPlanMoreMenu(selected.plan_id, "template") : ""}
            <button class="plain-button icon-button" type="button" data-action="template-close" aria-label="Close"><span class="button-icon">×</span></button>
          </div>
        </div>
        ${selected && state.templatePreview.settingsOpen ? renderTemplateMetadataForm(selected) : ""}
        ${selected && !state.templatePreview.loading && !state.templatePreview.error ? renderTemplateReviewPanel(selected) : ""}
        <div class="program-preview-body">
          ${state.templatePreview.loading ? `<div class="empty-state">Loading program...</div>` : state.templatePreview.error ? `<div class="empty-state">${escapeHtml(state.templatePreview.error)}</div>` : isMicrocycle
            ? `<div class="node-grid">${groups.map(renderNodeButton).join("")}</div>`
            : `<div class="program-day-grid">${groups.map(renderProgramDayCard).join("")}</div>`}
        </div>
      </section>
    </div>
  `;
}

function renderTemplateReviewPanel(template) {
  const review = state.templatePreview;
  const reviews = review.reviews || [];
  return `
    <section class="program-review-panel">
      <div class="program-review-summary">
        <div>
          <span class="eyebrow">Verified program review</span>
          <p class="muted">Reviews are enabled after access is active and the program has been used.</p>
        </div>
        <div class="program-review-actions">
          <button class="plain-button compact-button" type="button" data-action="template-use" data-template-id="${escapeAttr(template.plan_id)}" ${review.submittingUse ? "disabled" : ""}>${review.submittingUse ? "Saving..." : review.usedMarked ? "Access active" : "Get access"}</button>
          <button class="plain-button compact-button" type="button" data-action="template-review-toggle">${review.reviewOpen ? "Hide review" : "Leave review"}</button>
          <button class="plain-button compact-button" type="button" data-action="template-reviews-toggle">${review.reviewsOpen ? "Hide reviews" : `Reviews (${reviews.length})`}</button>
        </div>
      </div>
      ${review.reviewMessage ? `<p class="builder-success">${escapeHtml(review.reviewMessage)}</p>` : ""}
      ${review.reviewError ? `<p class="builder-error">${escapeHtml(review.reviewError)}</p>` : ""}
      ${review.reviewOpen ? `
        <form class="program-review-form" data-template-review-form data-plan-id="${escapeAttr(template.plan_id)}">
          <label class="search-field"><span>Rating</span><select name="rating" required>
            ${[5, 4, 3, 2, 1].map((rating) => `<option value="${rating}">${rating} / 5</option>`).join("")}
          </select></label>
          <label class="search-field program-review-comment"><span>Comment</span><textarea name="comment" rows="2" placeholder="Short note about how useful this program was"></textarea></label>
          <button class="plain-button compact-button" type="submit" ${review.submittingReview ? "disabled" : ""}>${review.submittingReview ? "Saving..." : "Save review"}</button>
        </form>
      ` : ""}
      ${review.reviewsOpen ? renderTemplateReviewList(reviews) : ""}
    </section>
  `;
}

function renderTemplateReviewList(reviews) {
  if (!reviews.length) return `<div class="program-review-list"><p class="muted">No written reviews yet.</p></div>`;
  return `
    <div class="program-review-list">
      ${reviews.map((item) => `
        <article class="program-review-item">
          <div>
            <strong>${escapeHtml(item.reviewer_name || "User")}</strong>
            <span>${escapeHtml(item.is_verified ? "Verified use" : "Review")}</span>
          </div>
          <b>${escapeHtml(String(item.rating || ""))}/5</b>
          ${item.comment ? `<p>${escapeHtml(item.comment)}</p>` : `<p class="muted">No comment.</p>`}
        </article>
      `).join("")}
    </div>
  `;
}

function renderTemplateMetadataForm(template) {
  const price = template.price_cents ? Number(template.price_cents) / 100 : "";
  const isFree = template.is_free !== false;
  const programGroup = template.library_category || inferProgramCategory(template) || "General";
  const accessModel = template.access_model || (isFree ? "free_forever" : "one_time_forever");
  return `
    <form class="program-metadata-form" data-template-metadata-form data-plan-id="${escapeAttr(template.plan_id)}">
      <div class="program-metadata-grid">
        <label class="search-field"><span>Library</span><select name="libraryScope">
          ${renderOption("workspace", "Working materials", template.library_scope)}
          ${renderOption("my", "My templates", template.library_scope || "my")}
          ${renderOption("club", "Club", template.library_scope)}
          ${renderOption("optimove", "OptiMove", template.library_scope)}
          ${renderOption("marketplace", "Marketplace", template.library_scope)}
        </select></label>
        <label class="search-field"><span>Program group</span><input name="libraryCategory" list="program-settings-group-options" value="${escapeAttr(programGroup)}" placeholder="e.g. Rehabilitation"></label>
        <label class="search-field"><span>Cover image URL</span><input name="coverImageUrl" type="url" value="${escapeAttr(template.cover_image_url || "")}" placeholder="https://..."></label>
        <label class="search-field"><span>Access</span><select name="visibility">
          ${renderOption("private", "Private", template.visibility || "private")}
          ${renderOption("team", "Team", template.visibility)}
          ${renderOption("club", "Club", template.visibility)}
          ${renderOption("public", "Public", template.visibility)}
        </select></label>
        <label class="search-field"><span>Owner</span><select name="ownerType">
          ${renderOption("coach", "Coach", template.owner_type || "coach")}
          ${renderOption("club", "Club", template.owner_type)}
          ${renderOption("optimove", "OptiMove", template.owner_type)}
          ${renderOption("marketplace", "Marketplace", template.owner_type)}
        </select></label>
        <label class="search-field"><span>Pricing</span><select name="isFree">
          ${renderOption("true", "Free", isFree ? "true" : "false")}
          ${renderOption("false", "Paid", isFree ? "true" : "false")}
        </select></label>
        <label class="search-field"><span>Price EUR</span><input name="price" type="number" min="0" step="0.01" value="${escapeAttr(price)}" placeholder="0" ${isFree ? "disabled" : ""}></label>
        <label class="search-field"><span>Available until</span><input name="availableUntil" type="date" value="${escapeAttr(template.available_until || "")}"></label>
        <label class="search-field"><span>License model</span><select name="accessModel">
          ${renderOption("free_forever", "Free forever", accessModel)}
          ${renderOption("one_time_forever", "One-time forever", accessModel)}
          ${renderOption("time_limited", "Time-limited", accessModel)}
          ${renderOption("subscription", "Subscription", accessModel)}
          ${renderOption("assigned", "Assigned only", accessModel)}
          ${renderOption("trial", "Trial", accessModel)}
        </select></label>
        <label class="search-field"><span>Duration days</span><input name="accessDurationDays" type="number" min="1" step="1" value="${escapeAttr(template.access_duration_days || "")}" placeholder="e.g. 30"></label>
        <label class="search-field"><span>Subscription</span><select name="subscriptionPeriod">
          ${renderOption("month", "Monthly", template.subscription_period || "month")}
          ${renderOption("year", "Yearly", template.subscription_period)}
        </select></label>
        ${renderBooleanSelect("canCopy", "Can copy", template.can_copy !== false)}
        ${renderBooleanSelect("canEditCopy", "Can edit copy", template.can_edit_copy !== false)}
        ${renderBooleanSelect("canAssignToAthlete", "Can assign", template.can_assign_to_athlete !== false)}
        ${renderBooleanSelect("athleteCanViewDirectly", "Athlete view", template.athlete_can_view_directly === true)}
        ${renderBooleanSelect("requiresApproval", "Needs approval", template.requires_approval === true)}
      </div>
      <datalist id="program-settings-group-options">
        ${(state.templateOptions.categories || []).map((category) => `<option value="${escapeAttr(category)}"></option>`).join("")}
      </datalist>
      ${renderProgramInlineTags(template)}
      <div class="program-metadata-actions">
        <p class="builder-error" aria-live="polite"></p>
        <button class="plain-button compact-button" type="submit">Save library settings</button>
      </div>
    </form>
  `;
}

function renderProgramInlineTags(template) {
  const tags = template.tags || [];
  const datalistId = `program-tag-options-${String(template.plan_id || "").replace(/[^a-zA-Z0-9_-]/g, "")}`;
  return `
    <section class="program-tags-panel" aria-label="Program tags">
      <div class="program-tags-head">
        <div>
          <span>Program tags</span>
          <small>Add labels for filtering. Use x to remove a label from this program.</small>
        </div>
        ${tags.length ? `<div class="program-tag-list">${tags.map((tag) => `<span class="exercise-tag-pill">${escapeHtml(tag.name)} <button type="button" data-action="program-tag-remove" data-plan-id="${escapeAttr(template.plan_id)}" data-tag-id="${escapeAttr(tag.id)}" aria-label="Remove ${escapeAttr(tag.name)}">x</button></span>`).join("")}</div>` : `<p class="muted">No program tags yet.</p>`}
      </div>
      ${state.programTagEditor.error && String(state.programTagEditor.planId) === String(template.plan_id) ? `<p class="builder-error">${escapeHtml(state.programTagEditor.error)}</p>` : ""}
      <div class="program-inline-tag-form">
        <label class="search-field">
          <span>Add tag</span>
          <input data-program-tag-input="${escapeAttr(template.plan_id)}" list="${escapeAttr(datalistId)}" placeholder="Type tag name">
          <datalist id="${escapeAttr(datalistId)}">
            ${(state.templateOptions.tags || []).map((tag) => `<option value="${escapeAttr(tag)}"></option>`).join("")}
          </datalist>
        </label>
        <button class="plain-button compact-button" type="button" data-action="program-tag-add" data-plan-id="${escapeAttr(template.plan_id)}">Add</button>
      </div>
    </section>
  `;
}

function renderBooleanSelect(name, label, selected) {
  const value = selected ? "true" : "false";
  return `
    <label class="search-field"><span>${escapeHtml(label)}</span><select name="${escapeAttr(name)}">
      ${renderOption("true", "Yes", value)}
      ${renderOption("false", "No", value)}
    </select></label>
  `;
}

function renderOption(value, label, selectedValue) {
  return `<option value="${escapeAttr(value)}" ${String(selectedValue || "") === String(value) ? "selected" : ""}>${escapeHtml(label)}</option>`;
}

function renderPlanMoreMenu(planId, objectType) {
  if (document.body.classList.contains("athlete-mode")) return "";
  const isTemplate = objectType === "template";
  const isWeekly = objectType === "weekly";
  const objectLabel = isTemplate ? "template" : isWeekly ? "weekly plan" : "program";
  const summaryClass = isTemplate ? "plain-button compact-button" : "plain-button icon-button";
  const summaryContent = isTemplate ? "Editing" : `<span class="button-icon">...</span>`;
  return `
    <details class="plan-more-menu">
      <summary class="${summaryClass}" aria-label="${objectLabel} actions" title="${objectLabel} actions">${summaryContent}</summary>
      <div class="plan-more-menu-popover">
        <button type="button" data-action="builder-edit-plan" data-plan-id="${escapeAttr(planId)}">Edit ${objectLabel}</button>
        <button type="button" data-action="builder-duplicate-plan" data-plan-id="${escapeAttr(planId)}" data-plan-type="${isWeekly ? "weekly" : "program"}">Edit copy</button>
        <button class="danger-action" type="button" data-action="builder-delete-source-plan" data-plan-id="${escapeAttr(planId)}" data-object-label="${objectLabel}">Delete ${objectLabel}</button>
      </div>
    </details>
  `;
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

async function loadBuilderExercises() {
  if (state.activeTab !== "builder") return;
  await loadExerciseFilterOptions();
  const query = state.builder.exerciseQuery.trim();
  const data = await api(exerciseSearchUrl(query, 18, state.builder.exerciseFilters));
  state.builder.exercises = applyClientExerciseFilters(data.exercises || [], state.builder.exerciseFilters);
  renderBuilder();
}

function renderBuilder() {
  const draft = state.builder.draft;
  els.context.textContent = "Program builder";
  els.title.textContent = draft ? draft.plan.name : "New program";
  els.toolbar.innerHTML = "";
  if (!draft) {
    const assignedAthlete = state.athletes.find((athlete) => String(athlete.athlete_id) === String(state.builder.createAthleteId));
    const isWeekly = state.builder.planType === "weekly";
    const weekStart = state.builder.weekStart || weekMondayIso(localDateIso());
    els.content.innerHTML = `
      <section class="content-section builder-start">
        <section class="panel builder-setup-card">
          <div class="section-heading">
            <div><p class="eyebrow">Program builder</p><h3>${isWeekly ? "Create weekly plan" : "Create program"}</h3><p class="muted">${isWeekly ? "Choose an athlete and the week to plan." : "Assign an athlete, or leave it reusable as a template."}</p></div>
          </div>
          <form class="builder-form builder-create-form" data-builder-form="create">
            <div class="builder-plan-type-control" role="group" aria-label="Plan type"><button class="${isWeekly ? "" : "is-active"}" type="button" data-action="builder-set-plan-type" data-plan-type="program">Program or template</button><button class="${isWeekly ? "is-active" : ""}" type="button" data-action="builder-set-plan-type" data-plan-type="weekly">Weekly plan</button></div>
            <div class="builder-details-row">
              <label class="search-field"><span>${isWeekly ? "Weekly plan name (optional)" : "Program name"}</span><input name="name" ${isWeekly ? "" : "required"} placeholder="${isWeekly ? "e.g. Match week" : "e.g. Preseason strength block"}"></label>
              <div class="builder-metadata-grid builder-setup-controls">
                <label class="search-field"><span>Color</span><input name="color" type="color" value="#287e77"></label>
                <label class="search-field"><span>Icon</span><select name="iconUrl">${builderIconOptions()}</select></label>
              </div>
            </div>
            <input type="hidden" name="planType" value="${isWeekly ? "weekly" : "program"}">
            <input type="hidden" name="athleteId" value="${escapeAttr(state.builder.createAthleteId)}">
            ${isWeekly ? `<label class="search-field builder-week-start"><span>Any date in the planned week</span><input name="weekStart" data-builder-week-start type="date" value="${escapeAttr(weekStart)}" required><small>The weekly plan will begin on Monday ${escapeHtml(formatDate(weekStart))}.</small></label>` : ""}
            <div class="builder-assignment-row"><span class="builder-field-label">Athlete</span><button class="builder-athlete-trigger" type="button" data-action="builder-open-athlete-picker">
              ${assignedAthlete?.athlete_image_url || assignedAthlete?.image_url ? renderImage(assignedAthlete.athlete_image_url || assignedAthlete.image_url, "builder-athlete-avatar") : `<span class="builder-athlete-trigger-icon">${assignedAthlete ? escapeHtml(initialsFor(assignedAthlete.athlete)) : "+"}</span>`}<span><strong>${escapeHtml(assignedAthlete?.athlete || (isWeekly ? "Choose athlete" : "Choose athlete or template"))}</strong>${assignedAthlete ? `<small>ID ${escapeHtml(assignedAthlete.athlete_id)}</small>` : ""}</span><span class="button-icon">></span>
            </button></div>
            ${state.builder.showNote ? `<label class="search-field"><span>Program note</span><textarea name="note" rows="2" placeholder="Optional coaching note"></textarea></label>` : `<button class="text-action builder-note-toggle" type="button" data-action="builder-toggle-note">Add note</button>`}
            <p class="builder-private-note">${isWeekly ? "Weekly plans are always assigned to the selected athlete." : "Private to your coach account until sharing and publishing are configured."}</p>
            <p class="builder-error" aria-live="polite"></p>
            <button class="plain-button builder-create-button" type="submit">${isWeekly ? "Create weekly plan" : "Create draft"}</button>
          </form>
        </section>
        ${state.builder.athletePickerOpen ? renderBuilderAthletePicker() : ""}
      </section>
    `;
    return;
  }

  const selectedSession = findBuilderSession(draft, state.builder.selectedSessionId);
  const selectedNode = findBuilderNode(draft, state.builder.selectedNodeId);
  const isWeekly = draft.plan.planType === "weekly";
  const isEditDraft = Boolean(draft.plan.isEditDraft);
  const closeLabel = isEditDraft ? "Cancel changes" : "Close editor";
  const saveLabel = isEditDraft ? "Apply changes" : "Save and finish";
  els.content.innerHTML = `
    <section class="content-section builder-workspace">
      <header class="builder-program-bar">
        <div><p class="eyebrow">${isEditDraft ? "Editing original" : isWeekly ? `Weekly plan · ${formatDate(draft.plan.weekStart)}` : (draft.plan.isTemplate ? "Reusable template" : "Athlete program")}</p><h3>${escapeHtml(draft.plan.name)}</h3><p class="muted">${escapeHtml(isEditDraft ? "Changes are saved only when applied." : draft.plan.athleteName || "Private coach template")}</p></div>
        <div class="builder-program-actions"><span class="item-badge">${isEditDraft ? "edit draft" : escapeHtml(draft.plan.status || "draft")}</span><button class="plain-button builder-cancel-button" type="button" data-action="builder-cancel" title="${isEditDraft ? "Discard this edit draft and keep the original unchanged." : "Close the editor. Autosaved changes remain."}">${closeLabel}</button>${draft.plan.status === "draft" ? `<button class="plain-button builder-finish-button" type="button" data-action="builder-submit-plan">${saveLabel}</button>` : `<span class="builder-finished-label">Saved</span>`}${isEditDraft ? "" : `<button class="text-action danger-action" type="button" data-action="builder-delete-plan">Delete</button>`}</div>
      </header>
      ${state.builder.clipboard?.type ? `<div class="builder-copy-hint"><span>Copied ${escapeHtml(state.builder.clipboard.type)}: <strong>${escapeHtml(state.builder.clipboard.name)}</strong>${state.builder.clipboard.itemCount ? ` (${state.builder.clipboard.itemCount} exercises)` : ""}</span><button class="text-action" type="button" data-action="builder-clear-clipboard">Clear</button></div>` : ""}
      ${isWeekly ? "" : `<section class="builder-block-creator">
        <div><p class="eyebrow">Program structure</p><strong>Add a day or block</strong></div>
        <button class="plain-button icon-button builder-info-button" type="button" data-action="builder-open-info" data-info="program" aria-label="Program structure example"><span class="button-icon">i</span></button>
        <form class="builder-inline-form builder-add-block" data-builder-form="add-block">
          <label class="search-field"><span>Block name</span><input name="name" placeholder="Day 1, MD-2, or Block 1"></label>
          <p class="builder-error" aria-live="polite"></p>
          <button class="plain-button" type="submit">Add block</button>
        </form>
      </section>`}
      <div class="builder-layout">
        <section class="panel builder-outline">
          <div class="section-heading"><div><p class="eyebrow">Day and session structure</p><h3>${isWeekly ? "Seven-day plan" : "Blocks and sessions"}</h3></div><button class="plain-button icon-button builder-info-button" type="button" data-action="builder-open-info" data-info="session" aria-label="Session structure example"><span class="button-icon">i</span></button></div>
          ${draft.blocks.length ? draft.blocks.map((block) => renderBuilderBlock(block, selectedSession?.id, selectedNode?.id, isWeekly)).join("") : `<div class="empty">Add the first day or block to start structuring the program.</div>`}
        </section>
      </div>
      ${state.builder.sessionModalBlockId ? renderBuilderSessionModal(state.builder.sessionModalBlockId) : ""}
      ${state.builder.structureModalOpen && selectedSession ? renderBuilderStructureModal(selectedSession, selectedNode) : ""}
      ${selectedNode?.type === "section" ? renderBuilderSectionOverlay(selectedNode) : ""}
      ${state.builder.infoOpen ? renderBuilderInfoModal(state.builder.infoOpen) : ""}
    </section>
  `;
}

function renderBuilderAthletePicker() {
  return `
    <div class="builder-athlete-overlay">
      <button class="builder-athlete-backdrop" type="button" data-action="builder-close-athlete-picker" aria-label="Close athlete picker"></button>
      <section class="panel builder-athlete-picker" role="dialog" aria-modal="true" aria-label="Assign athlete">
        <div class="builder-section-panel-head"><div><p class="eyebrow">Draft assignment</p><h3>Assign an athlete</h3><p class="muted">Choose an athlete or keep this draft reusable.</p></div><button class="plain-button icon-button" type="button" data-action="builder-close-athlete-picker" aria-label="Close athlete picker"><span class="button-icon">×</span></button></div>
        ${state.builder.planType === "weekly" ? "" : `<button class="builder-athlete-option ${state.builder.createAthleteId ? "" : "is-selected"}" type="button" data-action="builder-select-athlete" data-athlete-id="">
          <span class="builder-athlete-trigger-icon">+</span><span><strong>Reusable template</strong><small>Not assigned to an athlete</small></span>
        </button>`}
        <div class="builder-athlete-options">
          ${state.athletes.map((athlete) => `
            <button class="builder-athlete-option ${String(athlete.athlete_id) === String(state.builder.createAthleteId) ? "is-selected" : ""}" type="button" data-action="builder-select-athlete" data-athlete-id="${escapeAttr(athlete.athlete_id)}">
              ${athlete.athlete_image_url || athlete.image_url ? renderImage(athlete.athlete_image_url || athlete.image_url, "builder-athlete-avatar") : `<span class="builder-athlete-trigger-icon">${escapeHtml(initialsFor(athlete.athlete))}</span>`}
              <span><strong>${escapeHtml(athlete.athlete)}</strong><small>ID ${escapeHtml(athlete.athlete_id)}</small></span>
            </button>
          `).join("")}
        </div>
      </section>
    </div>
  `;
}

function renderCopyPlanModal() {
  if (!state.builder.copyPlanId) return "";
  const selectedAthlete = state.athletes.find((athlete) => String(athlete.athlete_id) === String(state.builder.copyAthleteId));
  const isWeeklyCopy = state.builder.copyPlanType === "weekly";
  return `
    <div class="builder-modal-overlay">
      <button class="builder-modal-backdrop" type="button" data-action="builder-close-copy-plan" aria-label="Close copy setup"></button>
      <section class="panel builder-compact-modal builder-copy-plan-modal" role="dialog" aria-modal="true" aria-label="Create editable copy">
        <div class="builder-modal-head"><div><p class="eyebrow">Editable copy</p><h3>${escapeHtml(state.builder.copyPlanName || "Program")}</h3><p class="muted">${isWeeklyCopy ? "Choose an athlete and the new week for this independent copy." : "Choose an athlete for a specific program, or keep the copy reusable as a template."}</p></div><button class="plain-button icon-button" type="button" data-action="builder-close-copy-plan" aria-label="Close"><span class="button-icon">x</span></button></div>
        ${isWeeklyCopy ? `<label class="search-field builder-copy-week"><span>Target week</span><input data-builder-copy-week-start type="date" value="${escapeAttr(state.builder.copyWeekStart || weekMondayIso(localDateIso()))}"><small>The copied week will begin on Monday.</small></label>` : `<button class="builder-athlete-option ${state.builder.copyAthleteId ? "" : "is-selected"}" type="button" data-action="builder-select-copy-athlete" data-athlete-id=""><span class="builder-athlete-trigger-icon">+</span><span><strong>Reusable template</strong><small>Keep this editable copy unassigned</small></span></button>`}
        <div class="builder-athlete-options">
          ${state.athletes.map((athlete) => `
            <button class="builder-athlete-option ${String(athlete.athlete_id) === String(state.builder.copyAthleteId) ? "is-selected" : ""}" type="button" data-action="builder-select-copy-athlete" data-athlete-id="${escapeAttr(athlete.athlete_id)}">
              ${athlete.athlete_image_url || athlete.image_url ? renderImage(athlete.athlete_image_url || athlete.image_url, "builder-athlete-avatar") : `<span class="builder-athlete-trigger-icon">${escapeHtml(initialsFor(athlete.athlete))}</span>`}
              <span><strong>${escapeHtml(athlete.athlete)}</strong><small>ID ${escapeHtml(athlete.athlete_id)}</small></span>
            </button>
          `).join("")}
        </div>
        <div class="builder-copy-plan-footer"><span class="muted">${selectedAthlete ? `${isWeeklyCopy ? "Weekly plan for" : "Specific program for"} ${escapeHtml(selectedAthlete.athlete)}` : isWeeklyCopy ? "Choose an athlete" : "Reusable template"}</span><button class="plain-button" type="button" data-action="builder-confirm-duplicate-plan" ${isWeeklyCopy && !selectedAthlete ? "disabled" : ""}>Create editable copy</button></div>
      </section>
    </div>
  `;
}

function renderCopyPlanSource() {
  if (state.activeTab === "weekly") return renderWeeklyRoot(state.lastWeeklyData);
  if (state.activeTab === "programs") return renderProgramRoot((state.lastProgramBundle?.programs || []).find((program) => program.id === state.selectedProgramId));
  return loadTemplates();
}

function builderIconOptions() {
  return [
    ["icon:target", "Target"],
    ["icon:bolt", "Bolt"],
    ["icon:dumbbell", "Strength"],
    ["icon:calendar", "Calendar"],
    ["icon:heart", "Recovery"],
  ].map(([value, label]) => `<option value="${value}">${builderIconGlyph(value)} ${label}</option>`).join("");
}

function builderIconGlyph(value) {
  return ({ "icon:target": "◎", "icon:bolt": "ϟ", "icon:dumbbell": "▰", "icon:calendar": "□", "icon:heart": "♥" })[value] || "•";
}

function renderBuilderSessionModal(blockId) {
  return `
    <div class="builder-modal-overlay">
      <button class="builder-modal-backdrop" type="button" data-action="builder-close-session-modal" aria-label="Close add session"></button>
      <section class="panel builder-compact-modal" role="dialog" aria-modal="true" aria-label="Add session">
        <div class="builder-modal-head"><div><p class="eyebrow">Day and session structure</p><h3>Add session</h3><p class="muted">Both fields are optional. Use them only when the day needs a time or training phase.</p></div><button class="plain-button icon-button" type="button" data-action="builder-close-session-modal" aria-label="Close"><span class="button-icon">x</span></button></div>
        <form class="builder-session-modal-form" data-builder-form="add-session" data-block-id="${escapeAttr(blockId)}">
          <label class="search-field"><span>Time of day</span><select name="amPm"><option value="">No AM/PM</option><option>AM</option><option>PM</option></select></label>
          <label class="search-field"><span>Training phase</span><select name="bta"><option value="">No phase</option><option value="B">Before training</option><option value="T">Training</option><option value="A">After training</option></select></label>
          <p class="builder-error" aria-live="polite"></p>
          <button class="plain-button" type="submit">Add session</button>
        </form>
      </section>
    </div>
  `;
}

function renderBuilderStructureModal(session, selectedNode) {
  return `
    <div class="builder-modal-overlay">
      <button class="builder-modal-backdrop" type="button" data-action="builder-close-structure-modal" aria-label="Close session parts"></button>
      <section class="panel builder-structure-modal" role="dialog" aria-modal="true" aria-label="Add session parts">
        <div class="builder-modal-head"><div><p class="eyebrow">${escapeHtml(sessionLabel(session))}</p><h3>Add session parts</h3><p class="muted">Build a path with Exercise domain, Exercise category, and Exercise section. An Exercise section can also be added directly.</p></div><button class="plain-button icon-button" type="button" data-action="builder-close-structure-modal" aria-label="Close"><span class="button-icon">x</span></button></div>
        ${renderBuilderStructureEditor(session, selectedNode)}
      </section>
    </div>
  `;
}

function renderBuilderInfoModal(kind) {
  const programInfo = kind === "program";
  return `
    <div class="builder-modal-overlay">
      <button class="builder-modal-backdrop" type="button" data-action="builder-close-info" aria-label="Close structure example"></button>
      <section class="panel builder-info-modal" role="dialog" aria-modal="true" aria-label="Program structure example">
        <div class="builder-modal-head"><div><p class="eyebrow">Structure guide</p><h3>${programInfo ? "Program and block example" : "Day and session example"}</h3></div><button class="plain-button icon-button" type="button" data-action="builder-close-info" aria-label="Close"><span class="button-icon">x</span></button></div>
        ${programInfo ? `
          <div class="builder-schema"><div class="schema-level schema-program">Program</div><div class="schema-line"></div><div class="schema-level schema-block">MD-4 day block</div><div class="schema-line"></div><div class="schema-split"><span>Before training session</span><span>After training session</span></div></div>
          <p class="muted">A program can have one or many blocks. A block can represent a calendar day, a microcycle day, or any named unit.</p>
        ` : `
          <div class="builder-schema-tree"><div class="schema-before"><strong>Before training session</strong><span>Exercise domain: Power and potentiation</span><span>Exercise category: Warm up or Power</span><span>Exercise section: Mobility, Stability, Activation</span><span>Exercises: selected movements</span></div><div class="schema-after"><strong>After training session</strong><span>Exercise category: Strength</span><span>Exercise section: Warm up for strength, Strength legs and core</span><span>Exercise category: Sauna or Compressive leggings</span></div></div>
          <p class="muted">Not every path needs all levels. You can add an Exercise section directly to a session, directly below an Exercise domain, or below an Exercise category. Only Exercise sections contain exercises.</p>
        `}
      </section>
    </div>
  `;
}

function renderBuilderBlock(block, selectedSessionId, selectedNodeId, isWeekly = false) {
  const defaultDayName = isWeekly ? weekDayName(block.date) : "";
  const blockTitle = isWeekly ? block.name || defaultDayName : block.name || `Block ${block.index}`;
  return `
    <article class="builder-block">
      <div class="builder-block-head"><div><strong>${escapeHtml(blockTitle)}</strong>${block.date ? `<span>${escapeHtml(formatDate(block.date))}</span>` : block.note ? `<span>${escapeHtml(block.note)}</span>` : ""}</div>${isWeekly ? "" : `<button class="text-action danger-action" type="button" data-action="builder-delete-block" data-block-id="${escapeAttr(block.id)}">Delete</button>`}</div>
      ${isWeekly ? `<form class="builder-day-label-form" data-builder-form="update-block" data-builder-autosave data-block-id="${escapeAttr(block.id)}"><label class="search-field"><span>Day label</span><input name="name" value="${escapeAttr(block.name || "")}" placeholder="e.g. MD-1, Match day"></label><small>Optional: leave empty to show ${escapeHtml(defaultDayName)}.</small></form>` : ""}
      <div class="builder-sessions">
        ${block.sessions.length ? block.sessions.map((session) => `
          <div class="builder-session-row"><button class="builder-session ${session.id === selectedSessionId ? "is-active" : ""}" data-action="builder-select-session" data-session-id="${escapeAttr(session.id)}">
            <span>${escapeHtml(sessionLabel(session))}</span><span>${session.nodes.reduce((total, node) => total + node.items.length, 0)} exercises</span>
          </button><div class="builder-session-actions">${renderNodePasteButton(session.id, "", "session")}<button class="text-action" type="button" data-action="builder-add-structure" data-session-id="${escapeAttr(session.id)}">Add session parts</button><button class="text-action danger-action" type="button" data-action="builder-delete-session" data-session-id="${escapeAttr(session.id)}">Delete</button></div></div>
          ${renderBuilderNodeTree(session, "", selectedNodeId)}
        `).join("") : `<p class="muted">No sessions yet.</p>`}
      </div>
      <button class="plain-button builder-add-session" type="button" data-action="builder-open-session-modal" data-block-id="${escapeAttr(block.id)}">Add session</button>
    </article>
  `;
}

function renderBuilderNodeTree(session, parentId, selectedNodeId) {
  const nodes = session.nodes.filter((node) => node.parentId === parentId);
  return nodes.map((node) => `
    <div class="builder-node builder-node-${escapeAttr(node.type)}">
      <div class="builder-node-row">
        <button class="builder-node-button ${node.id === selectedNodeId ? "is-active" : ""}" data-action="builder-select-node" data-node-id="${escapeAttr(node.id)}" data-session-id="${escapeAttr(session.id)}" style="${node.color ? `--builder-node-color:${escapeAttr(node.color)}` : ""}">
          <span class="builder-node-name"><span class="builder-node-icon">${builderIconGlyph(node.iconUrl)}</span>${escapeHtml(node.name)}</span><small>${builderNodeMarker(node.type)}${node.type === "section" ? builderExerciseCountDots(node.items.length) : ""}</small>
        </button>
        ${renderBuilderNodeMoveActions(node, true, session.id)}
      </div>
      ${renderNodePasteButton(session.id, node.id, node.type)}
      ${renderBuilderNodeTree(session, node.id, selectedNodeId)}
    </div>
  `).join("");
}

function renderBuilderStructureEditor(session, selectedNode) {
  if (selectedNode?.type === "section") {
    return `
      <div class="builder-selected-section">
        <div><p class="eyebrow">Selected section</p><strong>${escapeHtml(selectedNode.name)}</strong><p class="muted">Sections contain exercises and cannot contain another structural level.</p></div>
        <div class="builder-section-editor-actions">${renderBuilderNodeMoveActions(selectedNode)}<button class="plain-button" type="button" data-action="builder-copy-node" data-node-id="${escapeAttr(selectedNode.id)}">Copy section</button><button class="text-action danger-action" type="button" data-action="builder-delete-node" data-node-id="${escapeAttr(selectedNode.id)}">Delete section</button></div>
      </div>
      <button class="plain-button builder-open-section" type="button" data-action="builder-open-section-panel">Open section exercise editor</button>
    `;
  }
  return `
    <form class="builder-node-form" data-builder-form="add-node" data-session-id="${escapeAttr(session.id)}">
      <div class="builder-node-form-head"><strong>${selectedNode ? `Add below ${escapeHtml(selectedNode.name)}` : "Add first level"}</strong>${selectedNode ? `<span class="builder-node-form-actions">${renderBuilderNodeMoveActions(selectedNode)}<button class="text-action" type="button" data-action="builder-copy-node" data-node-id="${escapeAttr(selectedNode.id)}">Copy ${escapeHtml(selectedNode.type)}</button>${renderNodePasteButton(session.id, selectedNode.id, selectedNode.type)}<button class="text-action danger-action" type="button" data-action="builder-delete-node" data-node-id="${escapeAttr(selectedNode.id)}">Delete ${escapeHtml(selectedNode.type)}</button></span>` : ""}</div>
      <input type="hidden" name="parentId" value="${escapeAttr(selectedNode?.id || "")}">
      <select name="nodeType">${nodeTypeOptions(selectedNode?.type)}</select>
      <input name="name" placeholder="${selectedNode?.type === "domain" ? "Category or section name" : selectedNode?.type === "category" ? "Section name" : "Domain, category or section name"}" required>
      <input name="color" type="color" value="#287e77" aria-label="Node color">
      <select name="iconUrl" aria-label="Node icon">${builderIconOptions()}</select>
      <p class="builder-error" aria-live="polite"></p>
      <button class="plain-button" type="submit">Add</button>
    </form>
    ${selectedNode ? `
      <div class="empty">${selectedNode.type === "domain" ? "Add a category or section below this domain." : "Add a section below this category."}</div>
    ` : `<div class="empty">Create or select a domain, category or section before adding exercises.</div>`}
  `;
}

function renderNodePasteButton(sessionId, parentId, parentType) {
  const clipboard = state.builder.clipboard;
  if (!clipboard?.type || !canPasteNodeType(clipboard.type, parentType)) return "";
  return `<button class="text-action builder-paste-node" type="button" data-action="builder-paste-node" data-session-id="${escapeAttr(sessionId)}" data-parent-id="${escapeAttr(parentId)}">Paste ${escapeHtml(clipboard.type)}</button>`;
}

function renderBuilderNodeMoveActions(node, compact = false, sessionId = "") {
  const session = findBuilderSession(state.builder.draft, sessionId || state.builder.selectedSessionId);
  const siblings = (session?.nodes || [])
    .filter((candidate) => candidate.parentId === node.parentId)
    .sort((left, right) => left.order - right.order);
  const index = siblings.findIndex((candidate) => candidate.id === node.id);
  const buttonClass = compact ? "plain-button builder-node-move-icon" : "text-action";
  const upLabel = compact ? "&uarr;" : "Move up";
  const downLabel = compact ? "&darr;" : "Move down";
  return `<span class="builder-node-move-actions ${compact ? "is-compact" : ""}"><button class="${buttonClass}" type="button" data-action="builder-move-node" data-node-id="${escapeAttr(node.id)}" data-direction="up" aria-label="Move ${escapeAttr(node.type)} up" title="Move up" ${index <= 0 ? "disabled" : ""}>${upLabel}</button><button class="${buttonClass}" type="button" data-action="builder-move-node" data-node-id="${escapeAttr(node.id)}" data-direction="down" aria-label="Move ${escapeAttr(node.type)} down" title="Move down" ${index < 0 || index >= siblings.length - 1 ? "disabled" : ""}>${downLabel}</button></span>`;
}

function canPasteNodeType(nodeType, parentType) {
  if (parentType === "session") return nodeType === "domain" || nodeType === "category" || nodeType === "section";
  if (parentType === "domain") return nodeType === "category" || nodeType === "section";
  return parentType === "category" && nodeType === "section";
}

function renderBuilderSectionPanelLegacy(selectedNode) {
  const query = state.builder.exerciseQuery;
  return `
    <div class="builder-section-overlay">
      <button class="builder-section-backdrop" type="button" data-action="builder-close-section-panel" aria-label="Close section editor"></button>
      <section class="panel builder-section-panel" role="dialog" aria-modal="true" aria-label="Section exercise editor">
        <div class="builder-section-panel-head"><div><p class="eyebrow">Section exercise editor</p><h3>${escapeHtml(selectedNode.name)}</h3><p class="muted">Find and add exercises to this section.</p></div><button class="plain-button icon-button" type="button" data-action="builder-close-section-panel" aria-label="Close section editor"><span class="button-icon">×</span></button></div>
    <label class="search-field builder-exercise-search"><span>Search exercises</span><input data-builder-exercise-search type="search" value="${escapeAttr(query)}" placeholder="Name or code"></label>
    <form class="builder-dose-form" data-builder-form="add-exercise" data-node-id="${escapeAttr(selectedNode.id)}">
      <div class="builder-dose-inputs">
        <label><span>Sets</span><input name="sets" placeholder="3"></label>
        <label><span>Reps</span><input name="reps" placeholder="8"></label>
        <label><span>Load</span><input name="load" placeholder="40 kg"></label>
      </div>
      <input type="hidden" name="exerciseId" value="">
      <div class="builder-exercise-results">
        ${state.builder.exercises.map(renderBuilderExerciseResult).join("") || `<div class="empty">No matching exercises.</div>`}
      </div>
      <p class="builder-error" aria-live="polite"></p>
      <button class="plain-button" type="submit">Add selected exercise</button>
    </form>
    ${renderBuilderItems(selectedNode)}
      </section>
    </div>
  `;
}

function renderBuilderSectionOverlay(selectedNode) {
  return `
    <div class="builder-section-overlay">
      <button class="builder-section-backdrop" type="button" data-action="builder-finish-section" aria-label="Close Exercise section editor"></button>
      <section class="panel builder-section-modal" role="dialog" aria-modal="true" aria-label="Exercise section editor">
        ${renderBuilderSectionPanel(selectedNode)}
      </section>
    </div>
  `;
}

function renderBuilderSectionPanel(selectedNode) {
  const query = state.builder.exerciseQuery;
  const selectFilterCount = activeExerciseSelectFilterCount(state.builder.exerciseFilters);
  return `
    <div class="builder-section-panel" aria-label="Section exercise editor">
      <div class="builder-section-panel-head"><div><p class="eyebrow">Exercise section editor</p><h3>${escapeHtml(selectedNode.name)}</h3><p class="muted">Search the library and add exercises to this section.</p></div><div class="builder-section-editor-actions"><button class="plain-button" type="button" data-action="builder-copy-node" data-node-id="${escapeAttr(selectedNode.id)}">Copy section</button><button class="plain-button" type="button" data-action="builder-finish-section">Finish section</button><button class="text-action danger-action" type="button" data-action="builder-delete-node" data-node-id="${escapeAttr(selectedNode.id)}">Delete</button></div></div>
      <div class="builder-section-grid">
        <section class="builder-section-library">
          <div class="builder-panel-label">Exercise library</div>
          <label class="search-field builder-exercise-search"><span>Search exercises</span><input data-builder-exercise-search type="search" value="${escapeAttr(query)}" placeholder="Name or code"></label>
          ${renderExerciseQuickFilters(state.builder.exerciseFilters, "data-builder-exercise-filter")}
          <details class="builder-exercise-filters" ${selectFilterCount ? "open" : ""}>
            <summary>More filters${selectFilterCount ? ` (${selectFilterCount})` : ""}</summary>
            <div class="exercise-filter-strip builder-filter-strip">
              ${renderExerciseFilterControls(state.builder.exerciseFilters, state.exerciseSearch.options, "builder-selects")}
            </div>
          </details>
          <button class="text-action builder-custom-exercise-button" type="button" data-action="builder-open-custom-exercise">Add custom exercise</button>
          <div class="builder-dose-inputs builder-quick-dose">
            <label><span>Sets</span><input data-builder-new-dose name="sets" placeholder="3"></label>
            <label><span>Reps</span><input data-builder-new-dose name="reps" placeholder="8"></label>
            <label><span>Load</span><input data-builder-new-dose name="load" placeholder="40 kg"></label>
          </div>
          <div class="builder-exercise-results">
            ${state.builder.exercises.map(renderBuilderExerciseResult).join("") || `<div class="empty">No matching exercises.</div>`}
          </div>
        </section>
        <section class="builder-section-added">
          <div class="builder-panel-label">Added to section <span>${selectedNode.items.length}</span></div>
          ${renderBuilderItems(selectedNode) || `<div class="empty">Choose exercises from the library to build this section.</div>`}
        </section>
      </div>
      ${state.builder.customExerciseOpen ? renderCustomExerciseModal(selectedNode) : ""}
      ${state.tagEditor.open ? renderExerciseTagModal() : ""}
    </div>
  `;
}

function nodeTypeOptions(parentType = "") {
  const allowed = parentType === "domain" ? ["category", "section"] : parentType === "category" ? ["section"] : parentType === "section" ? [] : ["domain", "category", "section"];
  return allowed.map((type) => `<option value="${type}">${exerciseNodeLabel(type)}</option>`).join("") || `<option value="section">Exercise section</option>`;
}

function renderCustomExerciseModal(section) {
  return `
    <div class="builder-modal-overlay">
      <button class="builder-modal-backdrop" type="button" data-action="builder-close-custom-exercise" aria-label="Close custom exercise"></button>
      <section class="panel builder-compact-modal builder-custom-exercise-modal" role="dialog" aria-modal="true" aria-label="Add custom exercise">
        <div class="builder-modal-head"><div><p class="eyebrow">${escapeHtml(section.name)}</p><h3>Add custom exercise</h3><p class="muted">This creates a private exercise in your library and adds it to this Exercise section.</p></div><button class="plain-button icon-button" type="button" data-action="builder-close-custom-exercise" aria-label="Close"><span class="button-icon">x</span></button></div>
        <form class="builder-custom-exercise-form" data-builder-form="add-custom-exercise" data-node-id="${escapeAttr(section.id)}">
          <label class="search-field"><span>Exercise name</span><input name="name" required placeholder="e.g. Tempo running - custom"></label>
          <label class="search-field"><span>Instruction</span><textarea name="instruction" rows="3" placeholder="Coaching instruction"></textarea></label>
          <div class="builder-dose-inputs"><label><span>Sets</span><input name="sets" placeholder="3"></label><label><span>Reps</span><input name="reps" placeholder="8"></label><label><span>Load</span><input name="load" placeholder="Optional"></label></div>
          <label class="search-field"><span>Image URL</span><input name="imageUrl" type="url" placeholder="https://..."></label>
          <label class="search-field"><span>Video URL</span><input name="videoUrl" type="url" placeholder="https://..."></label>
          <p class="builder-upload-note">File upload will be added when Supabase Storage is connected.</p>
          <p class="builder-error" aria-live="polite"></p>
          <button class="plain-button" type="submit">Add custom exercise</button>
        </form>
      </section>
    </div>
  `;
}

function renderBuilderExerciseResult(exercise) {
  const image = exercise.image_url || "";
  const video = exercise.video_url || "";
  const title = exercise.name || "Exercise";
  const marked = state.markedExerciseIds.has(exercise.id);
  const tags = exercise.tags || [];
  return `
    <article class="builder-exercise-result">
      ${image || video
        ? `<button type="button" class="builder-exercise-preview" data-action="open-media" data-title="${escapeAttr(title)}" data-image="${escapeAttr(image)}" data-video="${escapeAttr(video)}" aria-label="Preview ${escapeAttr(title)}">${image ? renderImage(image, "builder-exercise-thumb") : `<span class="builder-exercise-thumb builder-exercise-thumb-fallback">Video</span>`}</button>`
        : `<span class="builder-exercise-preview builder-exercise-preview-empty"><span class="node-dot"></span></span>`}
      <span class="builder-exercise-result-text"><strong>${escapeHtml(title)}</strong><small>${video ? "Preview or add" : "Add to section"}</small><span class="builder-exercise-mini-actions"><button type="button" class="text-action" data-action="exercise-toggle-favorite" data-exercise-id="${escapeAttr(exercise.id)}" data-favorite="${exercise.is_favorite ? "true" : "false"}">${exercise.is_favorite ? "Fav" : "Favorite"}</button><button type="button" class="text-action" data-action="exercise-toggle-mark" data-exercise-id="${escapeAttr(exercise.id)}">${marked ? "Marked" : "Mark"}</button><button type="button" class="text-action" data-action="exercise-tags" data-exercise-id="${escapeAttr(exercise.id)}" data-exercise-name="${escapeAttr(title)}">Tags${tags.length ? ` (${tags.length})` : ""}</button></span></span>
      <button type="button" class="plain-button builder-exercise-add" data-action="builder-pick-exercise" data-exercise-id="${escapeAttr(exercise.id)}">Add</button>
    </article>
  `;
}

function exerciseNodeLabel(type) {
  return ({ domain: "Exercise domain", category: "Exercise category", section: "Exercise section" })[type] || type;
}

function builderNodeMarker(type) {
  const label = exerciseNodeLabel(type);
  return `<span class="builder-node-level builder-node-level-${escapeAttr(type)}" title="${escapeAttr(label)}" aria-label="${escapeAttr(label)}"><i class="builder-pyramid-top ${type === "section" ? "is-active" : ""}"></i><i class="builder-pyramid-middle ${type === "category" ? "is-active" : ""}"></i><i class="builder-pyramid-base ${type === "domain" ? "is-active" : ""}"></i></span>`;
}

function builderExerciseCountDots(count) {
  const total = Math.max(0, Number(count) || 0);
  return `<span class="builder-exercise-count" title="${total} exercise${total === 1 ? "" : "s"}" aria-label="${total} exercise${total === 1 ? "" : "s"}">${Array.from({ length: total }, () => "<i></i>").join("")}</span>`;
}

function renderBuilderItems(node) {
  if (!node.items.length) return "";
  return `<div class="builder-items">${node.items.map((item, index) => `
    <form class="builder-item" data-builder-form="update-item" data-builder-autosave data-item-id="${escapeAttr(item.id)}">
      <div class="builder-item-head">
        ${item.imageUrl || item.videoUrl ? `<button type="button" class="builder-added-exercise-media" data-action="open-media" data-title="${escapeAttr(item.title || "Exercise media")}" data-image="${escapeAttr(item.imageUrl || "")}" data-video="${escapeAttr(item.videoUrl || "")}">${item.imageUrl ? renderImage(item.imageUrl, "builder-added-exercise-image") : `<span class="builder-added-exercise-fallback">Video</span>`}</button>` : `<span class="builder-added-exercise-fallback">Exercise</span>`}
        <div><strong>${escapeHtml(item.title || "Exercise")}</strong><div class="builder-item-actions"><button class="text-action" type="button" data-action="builder-move-item" data-item-id="${escapeAttr(item.id)}" data-direction="up" ${index === 0 ? "disabled" : ""}>Move up</button><button class="text-action" type="button" data-action="builder-move-item" data-item-id="${escapeAttr(item.id)}" data-direction="down" ${index === node.items.length - 1 ? "disabled" : ""}>Move down</button><button class="text-action danger-action" type="button" data-action="builder-delete-item" data-item-id="${escapeAttr(item.id)}">Remove</button></div></div>
      </div>
      <div class="builder-dose-inputs builder-item-dose">
        <label><span>Sets</span><input name="sets" value="${escapeAttr(item.sets || "")}"></label>
        <label><span>Reps</span><input name="reps" value="${escapeAttr(item.reps || "")}"></label>
        <label><span>Load</span><input name="load" value="${escapeAttr(item.load || "")}"></label>
      </div>
      <label class="search-field"><span>Instruction</span><textarea name="description" rows="2">${escapeHtml(item.description || "")}</textarea></label>
      <small class="builder-autosave-hint">Changes save automatically.</small>
    </form>
  `).join("")}</div>`;
}

function findBuilderSession(draft, id) {
  return (draft?.blocks || []).flatMap((block) => block.sessions).find((session) => session.id === id) || null;
}

function findBuilderNode(draft, id) {
  return (draft?.blocks || []).flatMap((block) => block.sessions).flatMap((session) => session.nodes).find((node) => node.id === id) || null;
}

function sessionLabel(session) {
  return [session.amPm, { B: "Before training", T: "Training", A: "After training" }[session.bta] || ""].filter(Boolean).join(" · ") || "Session";
}

async function handleBuilderAction(action) {
  const type = action.dataset.action;
  if (type === "builder-edit-plan") {
    action.disabled = true;
    try {
      state.builder.draft = await api(`/api/builder/plans/${encodeURIComponent(action.dataset.planId || "")}/edit`, { method: "POST" });
      state.builder.selectedSessionId = "";
      state.builder.selectedNodeId = "";
      state.builder.exerciseQuery = "";
      state.activeTab = "builder";
      state.navStack = [];
      renderTabs();
      renderLibraryNav();
      await loadBuilderExercises();
    } catch (error) {
      action.disabled = false;
      throw error;
    }
    return;
  }
  if (type === "builder-duplicate-plan") {
    state.builder.copyPlanId = action.dataset.planId || "";
    state.builder.copyPlanName = action.closest(".section-heading")?.querySelector("h3")?.textContent || "Program";
    state.builder.copyAthleteId = "";
    state.builder.copyPlanType = action.dataset.planType === "weekly" ? "weekly" : "program";
    state.builder.copyWeekStart = state.builder.copyPlanType === "weekly" ? weekMondayIso(localDateIso()) : "";
    await renderCopyPlanSource();
    return;
  }
  if (type === "builder-close-copy-plan") {
    state.builder.copyPlanId = "";
    state.builder.copyPlanName = "";
    state.builder.copyAthleteId = "";
    state.builder.copyPlanType = "program";
    state.builder.copyWeekStart = "";
    await renderCopyPlanSource();
    return;
  }
  if (type === "builder-select-copy-athlete") {
    state.builder.copyAthleteId = action.dataset.athleteId || "";
    await renderCopyPlanSource();
    return;
  }
  if (type === "builder-confirm-duplicate-plan") {
    action.disabled = true;
    try {
      state.builder.draft = await api(`/api/builder/plans/${encodeURIComponent(state.builder.copyPlanId)}/duplicate`, { method: "POST", body: JSON.stringify({ athleteId: state.builder.copyAthleteId, weekStart: state.builder.copyWeekStart }) });
      state.builder.selectedSessionId = "";
      state.builder.selectedNodeId = "";
      state.builder.exerciseQuery = "";
      state.builder.copyPlanId = "";
      state.builder.copyPlanName = "";
      state.builder.copyAthleteId = "";
      state.builder.copyPlanType = "program";
      state.builder.copyWeekStart = "";
      state.activeTab = "builder";
      state.navStack = [];
      renderTabs();
      renderLibraryNav();
      await loadBuilderExercises();
    } catch (error) {
      action.disabled = false;
      throw error;
    }
    return;
  }
  if (type === "builder-set-plan-type") {
    state.builder.planType = action.dataset.planType === "weekly" ? "weekly" : "program";
    state.builder.weekStart ||= weekMondayIso(localDateIso());
    state.builder.athletePickerOpen = false;
    renderBuilder();
    return;
  }
  if (type === "builder-open-info") {
    state.builder.infoOpen = action.dataset.info || "session";
    renderBuilder();
    return;
  }
  if (type === "builder-close-info") {
    state.builder.infoOpen = "";
    renderBuilder();
    return;
  }
  if (type === "builder-open-session-modal") {
    state.builder.sessionModalBlockId = action.dataset.blockId || "";
    renderBuilder();
    return;
  }
  if (type === "builder-close-session-modal") {
    state.builder.sessionModalBlockId = "";
    renderBuilder();
    return;
  }
  if (type === "builder-close-structure-modal") {
    state.builder.structureModalOpen = false;
    renderBuilder();
    return;
  }
  if (type === "builder-open-custom-exercise") {
    state.builder.customExerciseOpen = true;
    renderBuilder();
    return;
  }
  if (type === "builder-close-custom-exercise") {
    state.builder.customExerciseOpen = false;
    renderBuilder();
    return;
  }
  if (type === "builder-copy-node") {
    const node = findBuilderNode(state.builder.draft, action.dataset.nodeId || state.builder.selectedNodeId);
    if (!node) return;
    state.builder.clipboard = { type: node.type, nodeId: node.id, name: node.name, itemCount: node.items.length };
    state.builder.selectedNodeId = "";
    state.builder.customExerciseOpen = false;
    state.builder.sectionPickerOpen = false;
    state.builder.structureModalOpen = false;
    renderBuilder();
    return;
  }
  if (type === "builder-clear-clipboard") {
    state.builder.clipboard = null;
    renderBuilder();
    return;
  }
  if (type === "builder-paste-node") {
    const clipboard = state.builder.clipboard;
    if (!clipboard) return;
    action.disabled = true;
    try {
      state.builder.draft = await api(`/api/builder/nodes/${encodeURIComponent(clipboard.nodeId)}/copy`, {
        method: "POST",
        body: JSON.stringify({ targetSessionId: action.dataset.sessionId, targetParentId: action.dataset.parentId || "" }),
      });
      state.builder.selectedSessionId = action.dataset.sessionId || "";
      state.builder.selectedNodeId = "";
      renderBuilder();
    } catch (error) {
      action.disabled = false;
      throw error;
    }
    return;
  }
  if (type === "builder-move-node") {
    action.disabled = true;
    try {
      state.builder.draft = await api(`/api/builder/nodes/${encodeURIComponent(action.dataset.nodeId || "")}/move`, {
        method: "POST",
        body: JSON.stringify({ direction: action.dataset.direction || "" }),
      });
      renderBuilder();
    } catch (error) {
      action.disabled = false;
      throw error;
    }
    return;
  }
  if (type === "builder-finish-section") {
    state.builder.selectedNodeId = "";
    state.builder.customExerciseOpen = false;
    renderBuilder();
    return;
  }
  if (type === "builder-toggle-note") {
    state.builder.showNote = !state.builder.showNote;
    renderBuilder();
    return;
  }
  if (type === "builder-open-athlete-picker") {
    state.builder.athletePickerOpen = true;
    renderBuilder();
    return;
  }
  if (type === "builder-close-athlete-picker") {
    state.builder.athletePickerOpen = false;
    renderBuilder();
    return;
  }
  if (type === "builder-select-athlete") {
    state.builder.createAthleteId = action.dataset.athleteId || "";
    state.builder.athletePickerOpen = false;
    renderBuilder();
    return;
  }
  if (type === "builder-open-section-panel") {
    state.builder.sectionPickerOpen = true;
    renderBuilder();
    return;
  }
  if (type === "builder-close-section-panel") {
    state.builder.sectionPickerOpen = false;
    renderBuilder();
    return;
  }
  if (type === "builder-add-structure") {
    state.builder.selectedSessionId = action.dataset.sessionId || "";
    state.builder.selectedNodeId = "";
    state.builder.addNodeOpen = true;
    state.builder.structureModalOpen = true;
    renderBuilder();
    return;
  }
  if (type === "builder-submit-plan") {
    const draft = state.builder.draft;
    if (!draft) return;
    action.disabled = true;
    try {
      state.builder.draft = await api(`/api/builder/plans/${encodeURIComponent(draft.plan.id)}/submit`, { method: "POST" });
      renderBuilder();
    } catch (error) {
      renderBuilderError(error);
    }
    return;
  }
  if (type === "builder-cancel") {
    const plan = state.builder.draft?.plan;
    if (plan?.isEditDraft) {
      if (!window.confirm("Discard these changes and keep the original unchanged?")) return;
      await api(`/api/builder/plans/${encodeURIComponent(plan.id)}`, { method: "DELETE" });
    }
    state.builder = { draft: null, planType: "program", weekStart: "", selectedSessionId: "", selectedNodeId: "", exerciseQuery: "", exerciseFilters: emptyExerciseFilters(), exercises: [], athletePickerOpen: false, sectionPickerOpen: false, createAthleteId: "", copyPlanId: "", copyPlanName: "", copyAthleteId: "", clipboard: null, showNote: false, addNodeOpen: false, sessionModalBlockId: "", structureModalOpen: false, infoOpen: "", customExerciseOpen: false };
    state.navStack = [];
    if (plan?.athleteId) state.selectedAthleteId = String(plan.athleteId);
    if (plan?.planType === "weekly") {
      state.activeTab = "weekly";
      state.weekSelectorOpen = false;
      renderTabs();
      renderLibraryNav();
      await loadWeekly();
      return;
    }
    if (plan?.isTemplate || !plan?.athleteId) {
      state.activeTab = "templates";
      renderTabs();
      renderLibraryNav();
      await loadTemplates();
      return;
    }
    state.activeTab = "programs";
    renderTabs();
    renderLibraryNav();
    await loadPrograms();
    return;
  }
  if (type === "builder-select-session") {
    state.builder.selectedSessionId = action.dataset.sessionId || "";
    state.builder.selectedNodeId = "";
    state.builder.sectionPickerOpen = false;
    state.builder.addNodeOpen = false;
    state.builder.structureModalOpen = false;
    renderBuilder();
    return;
  }
  if (type === "builder-select-node") {
    state.builder.selectedSessionId = action.dataset.sessionId || "";
    state.builder.selectedNodeId = action.dataset.nodeId || "";
    state.builder.sectionPickerOpen = findBuilderNode(state.builder.draft, state.builder.selectedNodeId)?.type === "section";
    state.builder.addNodeOpen = true;
    state.builder.structureModalOpen = !state.builder.sectionPickerOpen;
    renderBuilder();
    return;
  }
  if (type === "builder-pick-exercise") {
    const section = findBuilderNode(state.builder.draft, state.builder.selectedNodeId);
    const panel = action.closest(".builder-section-panel");
    if (!section || section.type !== "section") return;
    action.disabled = true;
    try {
      state.builder.draft = await api(`/api/builder/nodes/${encodeURIComponent(section.id)}/exercises`, {
        method: "POST",
        body: JSON.stringify({
          exerciseId: action.dataset.exerciseId || "",
          sets: panel?.querySelector("[name='sets']")?.value || "",
          reps: panel?.querySelector("[name='reps']")?.value || "",
          load: panel?.querySelector("[name='load']")?.value || "",
        }),
      });
      renderBuilder();
    } catch (error) {
      renderBuilderError(error);
    }
    return;
  }
  if (type === "builder-move-item") {
    const node = findBuilderNode(state.builder.draft, state.builder.selectedNodeId);
    const currentIndex = node?.items.findIndex((item) => item.id === action.dataset.itemId) ?? -1;
    const targetIndex = currentIndex + (action.dataset.direction === "up" ? -1 : 1);
    if (!node || currentIndex < 0 || targetIndex < 0 || targetIndex >= node.items.length) return;
    [node.items[currentIndex], node.items[targetIndex]] = [node.items[targetIndex], node.items[currentIndex]];
    renderBuilder();
    try {
      state.builder.draft = await api(`/api/builder/items/${encodeURIComponent(action.dataset.itemId)}/move`, {
        method: "POST",
        body: JSON.stringify({ direction: action.dataset.direction }),
      });
      renderBuilder();
    } catch (error) {
      await refreshBuilderDraft();
      throw error;
    }
    return;
  }
  if (type === "builder-delete-item") {
    if (!window.confirm("Remove this exercise from the program?")) return;
    await api(`/api/builder/items/${encodeURIComponent(action.dataset.itemId)}`, { method: "DELETE" });
    await refreshBuilderDraft();
    return;
  }
  if (type === "builder-delete-source-plan") {
    const planId = action.dataset.planId || "";
    const objectLabel = action.dataset.objectLabel || "program";
    if (!planId || !window.confirm(`Delete this ${objectLabel} and all of its contents? This cannot be undone.`)) return;
    action.disabled = true;
    await api(`/api/builder/plans/${encodeURIComponent(planId)}`, { method: "DELETE" });
    if (state.activeTab === "weekly") {
      state.weekSelectorOpen = false;
      await loadWeekly();
    } else if (state.activeTab === "programs") {
      state.selectedProgramId = null;
      await loadPrograms();
    } else {
      state.selectedTemplateId = null;
      await loadTemplates();
    }
    return;
  }
  const deleteTargets = {
    "builder-delete-plan": ["draft program", `/api/builder/plans/${encodeURIComponent(state.builder.draft?.plan.id || "")}`],
    "builder-delete-block": ["block and its contents", `/api/builder/blocks/${encodeURIComponent(action.dataset.blockId || "")}`],
    "builder-delete-session": ["session and its contents", `/api/builder/sessions/${encodeURIComponent(action.dataset.sessionId || "")}`],
    "builder-delete-node": ["selected node and its contents", `/api/builder/nodes/${encodeURIComponent(action.dataset.nodeId || "")}`],
  };
  if (deleteTargets[type]) {
    const [label, url] = deleteTargets[type];
    if (!window.confirm(`Delete this ${label}? This cannot be undone.`)) return;
    await api(url, { method: "DELETE" });
    if (type === "builder-delete-plan") {
      state.builder = { draft: null, planType: "program", weekStart: "", selectedSessionId: "", selectedNodeId: "", exerciseQuery: "", exerciseFilters: emptyExerciseFilters(), exercises: [], athletePickerOpen: false, sectionPickerOpen: false, createAthleteId: "", copyPlanId: "", copyPlanName: "", copyAthleteId: "", clipboard: null, showNote: false, addNodeOpen: false, sessionModalBlockId: "", structureModalOpen: false, infoOpen: "", customExerciseOpen: false };
    } else {
      state.builder.selectedNodeId = "";
      state.builder.selectedSessionId = "";
      await refreshBuilderDraft();
      return;
    }
    renderBuilder();
  }
}

async function submitBuilderForm(form) {
  const mode = form.dataset.builderForm;
  const data = Object.fromEntries(new FormData(form));
  const draft = state.builder.draft;
  if (mode === "create") {
    const created = await api("/api/builder/plans", { method: "POST", body: JSON.stringify(data) });
    state.builder.draft = created;
    state.builder.selectedSessionId = "";
    state.builder.selectedNodeId = "";
    state.builder.athletePickerOpen = false;
    state.builder.sectionPickerOpen = false;
    state.builder.createAthleteId = "";
    state.builder.planType = "program";
    state.builder.weekStart = "";
    state.builder.addNodeOpen = false;
    await loadBuilderExercises();
    return;
  }
  if (!draft) return;
  if (mode === "add-block") {
    state.builder.draft = await api(`/api/builder/plans/${encodeURIComponent(draft.plan.id)}/blocks`, { method: "POST", body: JSON.stringify(data) });
  }
  if (mode === "update-block") {
    state.builder.draft = await api(`/api/builder/blocks/${encodeURIComponent(form.dataset.blockId)}`, { method: "PATCH", body: JSON.stringify(data) });
  }
  if (mode === "add-session") {
    state.builder.draft = await api(`/api/builder/blocks/${encodeURIComponent(form.dataset.blockId)}/sessions`, { method: "POST", body: JSON.stringify(data) });
    const lastBlock = state.builder.draft.blocks.find((block) => block.id === form.dataset.blockId);
    state.builder.selectedSessionId = lastBlock?.sessions.at(-1)?.id || state.builder.selectedSessionId;
    state.builder.selectedNodeId = "";
    state.builder.sessionModalBlockId = "";
    state.builder.structureModalOpen = false;
  }
  if (mode === "add-node") {
    state.builder.draft = await api(`/api/builder/sessions/${encodeURIComponent(form.dataset.sessionId)}/nodes`, { method: "POST", body: JSON.stringify(data) });
    const session = findBuilderSession(state.builder.draft, form.dataset.sessionId);
    const added = session?.nodes.at(-1);
    state.builder.selectedSessionId = form.dataset.sessionId;
    state.builder.selectedNodeId = added?.id || "";
  }
  if (mode === "add-exercise") {
    if (!data.exerciseId) return;
    state.builder.draft = await api(`/api/builder/nodes/${encodeURIComponent(form.dataset.nodeId)}/exercises`, { method: "POST", body: JSON.stringify(data) });
  }
  if (mode === "add-custom-exercise") {
    state.builder.draft = await api(`/api/builder/nodes/${encodeURIComponent(form.dataset.nodeId)}/custom-exercise`, { method: "POST", body: JSON.stringify(data) });
    state.builder.customExerciseOpen = false;
  }
  if (mode === "update-item") {
    state.builder.draft = await api(`/api/builder/items/${encodeURIComponent(form.dataset.itemId)}`, { method: "PATCH", body: JSON.stringify(data) });
  }
  renderBuilder();
}

async function refreshBuilderDraft() {
  if (!state.builder.draft) return;
  state.builder.draft = await api(`/api/builder/plans/${encodeURIComponent(state.builder.draft.plan.id)}`);
  renderBuilder();
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
  els.content.innerHTML = `
    <div class="library-results-head">
      <span class="muted">${exercises.length} exercises shown</span>
      ${state.exerciseSearch.term ? `<span class="item-badge">${escapeHtml(state.exerciseSearch.term)}</span>` : ""}
      ${activeExerciseFilterLabels(state.exerciseSearch.filters).map((label) => `<span class="item-badge">${escapeHtml(label)}</span>`).join("")}
    </div>
    <div class="exercise-grid">
      ${exercises.map((exercise, index) => renderExerciseLibraryCard(exercise, itemIds[index])).join("")}
    </div>
    ${state.exerciseSearch.hasMore ? `
      <div class="load-more-row">
        <button class="plain-button" data-action="exercise-load-more">Load more</button>
      </div>
    ` : ""}
    ${state.tagEditor.open ? renderExerciseTagModal() : ""}
  `;
}

function renderExerciseLibraryCard(exercise, itemId) {
  const marked = state.markedExerciseIds.has(exercise.id);
  const tags = exercise.tags || [];
  return `
    <article class="exercise-card">
      ${exercise.image_url ? `
        <button class="exercise-media library-media" data-action="open-media" data-title="${escapeAttr(exercise.name || "Exercise media")}" data-image="${escapeAttr(exercise.image_url)}" data-video="${escapeAttr(exercise.video_url || "")}">
          ${renderMediaThumb(exercise.image_url)}
        </button>
      ` : ""}
      <button class="exercise-open" data-action="open-exercise" data-item-id="${escapeAttr(itemId)}">
        <span class="exercise-head">
          <span class="exercise-title">${escapeHtml(exercise.name || "")}</span>
        </span>
        <span class="muted">${escapeHtml(exercise.aim || "")}</span>
        <span class="item-description">${escapeHtml(exercise.execution_notes || exercise.instruction || "")}</span>
      </button>
      <div class="exercise-card-actions">
        <button class="text-action" type="button" data-action="exercise-toggle-favorite" data-exercise-id="${escapeAttr(exercise.id)}" data-favorite="${exercise.is_favorite ? "true" : "false"}">${exercise.is_favorite ? "Unfavorite" : "Favorite"}</button>
        <button class="text-action" type="button" data-action="exercise-toggle-mark" data-exercise-id="${escapeAttr(exercise.id)}">${marked ? "Unmark" : "Mark"}</button>
        <button class="text-action" type="button" data-action="exercise-tags" data-exercise-id="${escapeAttr(exercise.id)}" data-exercise-name="${escapeAttr(exercise.name || "Exercise")}">Tags${tags.length ? ` (${tags.length})` : ""}</button>
      </div>
      ${tags.length ? `<div class="exercise-tag-list">${tags.slice(0, 4).map((tag) => `<span>${escapeHtml(tag.name)}</span>`).join("")}${tags.length > 4 ? `<span>+${tags.length - 4}</span>` : ""}</div>` : ""}
    </article>
  `;
}

function renderExerciseTagModal() {
  const editor = state.tagEditor;
  const assigned = new Set((editor.tags || []).map((tag) => String(tag.id)));
  const available = (editor.options || []).filter((tag) => !assigned.has(String(tag.id)));
  return `
    <div class="exercise-tag-overlay">
      <button class="exercise-tag-backdrop" type="button" data-action="exercise-tags-close" aria-label="Close tags"></button>
      <section class="panel exercise-tag-modal" role="dialog" aria-modal="true" aria-label="Exercise tags">
        <div class="builder-modal-head">
          <div><p class="eyebrow">Exercise tags</p><h3>${escapeHtml(editor.exerciseName)}</h3><p class="muted">Use tags as your own reusable labels for filtering and building programs faster.</p></div>
          <button class="plain-button icon-button" type="button" data-action="exercise-tags-close" aria-label="Close"><span class="button-icon">x</span></button>
        </div>
        <div class="exercise-tag-current">
          ${(editor.tags || []).length
            ? editor.tags.map((tag) => `<span class="exercise-tag-pill">${escapeHtml(tag.name)} <button type="button" data-action="exercise-tag-remove" data-exercise-id="${escapeAttr(editor.exerciseId)}" data-tag-id="${escapeAttr(tag.id)}" aria-label="Remove ${escapeAttr(tag.name)}">x</button></span>`).join("")
            : `<p class="muted">No tags yet.</p>`}
        </div>
        <form class="exercise-tag-form" data-exercise-tag-form>
          <label class="search-field"><span>Add existing tag</span><select name="tagId"><option value="">Choose tag</option>${available.map((tag) => `<option value="${escapeAttr(tag.id)}">${escapeHtml(tag.name)}</option>`).join("")}</select></label>
          <label class="search-field"><span>Or create new tag</span><input name="name" placeholder="e.g. hotel gym, pre-match, knee friendly"></label>
          ${editor.error ? `<p class="builder-error">${escapeHtml(editor.error)}</p>` : ""}
          <button class="plain-button" type="submit">Add tag</button>
        </form>
      </section>
    </div>
  `;
}

function renderProgramTagModal() {
  const editor = state.programTagEditor;
  const assigned = new Set((editor.tags || []).map((tag) => String(tag.id)));
  const available = (editor.options || []).filter((tag) => !assigned.has(String(tag.id)));
  return `
    <div class="exercise-tag-overlay">
      <button class="exercise-tag-backdrop" type="button" data-action="program-tags-close" aria-label="Close tags"></button>
      <section class="panel exercise-tag-modal" role="dialog" aria-modal="true" aria-label="Program tags">
        <div class="builder-modal-head">
          <div><p class="eyebrow">Program tags</p><h3>${escapeHtml(editor.programName)}</h3><p class="muted">Use your own labels to find and reuse programs faster.</p></div>
          <button class="plain-button icon-button" type="button" data-action="program-tags-close" aria-label="Close"><span class="button-icon">x</span></button>
        </div>
        <div class="exercise-tag-current">
          ${(editor.tags || []).length
            ? editor.tags.map((tag) => `<span class="exercise-tag-pill">${escapeHtml(tag.name)} <button type="button" data-action="program-tag-remove" data-plan-id="${escapeAttr(editor.planId)}" data-tag-id="${escapeAttr(tag.id)}" aria-label="Remove ${escapeAttr(tag.name)}">x</button></span>`).join("")
            : `<p class="muted">No tags yet.</p>`}
        </div>
        <form class="exercise-tag-form" data-program-tag-form>
          <label class="search-field"><span>Add existing tag</span><select name="tagId"><option value="">Choose tag</option>${available.map((tag) => `<option value="${escapeAttr(tag.id)}">${escapeHtml(tag.name)}</option>`).join("")}</select></label>
          <label class="search-field"><span>Or create new tag</span><input name="name" placeholder="e.g. rehab, preseason, youth, premium"></label>
          ${editor.error ? `<p class="builder-error">${escapeHtml(editor.error)}</p>` : ""}
          <button class="plain-button" type="submit">Add tag</button>
        </form>
      </section>
    </div>
  `;
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
          <div class="drill-actions">
            <div class="drill-main-actions">
              <button class="plain-button icon-button" data-action="exercise-back"><span class="button-icon">←</span><span>Back</span></button>
              <button class="plain-button icon-button" data-action="home"><span class="button-icon">⌂</span><span>Home</span></button>
            </div>
            ${hasSequence ? `
              <div class="drill-sibling-actions">
                <button class="plain-button icon-button" data-action="exercise-prev" ${canGoPrevious ? "" : "disabled"}><span class="button-icon">‹</span><span>Previous</span></button>
                <span class="exercise-position">${currentIndex + 1} / ${ids.length}</span>
                <button class="plain-button icon-button" data-action="exercise-next" ${canGoNext ? "" : "disabled"}><span>Next</span><span class="button-icon">›</span></button>
              </div>
            ` : ""}
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
        </div>
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

function slotItems(slots, amPm) {
  const group = slots?.[amPm] || {};
  return ["B", "T", "A"].flatMap((bta) => (group[bta] || []).filter((item) => item.amPm === amPm));
}

function allSlotItems(slots) {
  const result = [];
  ["AM", "PM"].forEach((amPm) => {
    ["B", "T", "A"].forEach((bta) => {
      result.push(...(slots?.[amPm]?.[bta] || []));
    });
  });
  return result;
}

function groupItems(group) {
  return allSlotItems(group.slots || {});
}

function flattenDayGroups(dayGroups = []) {
  return dayGroups.flatMap((group) => groupItems(group));
}

function weekTotal(week) {
  return (week.days || []).reduce((sum, day) => sum + allSlotItems(day.slots).length, 0);
}

function weekContainsDate(week, date) {
  return (week.days || []).some((day) => day.date === date);
}

function weekIndexForDate(weeks, date) {
  if (!date) return -1;
  return weeks.findIndex((week) => weekContainsDate(week, date));
}

function buildWeeklyCalendarMonths(weeks) {
  const dayMap = weeklyCalendarDayMap(weeks);
  const months = weeklyCalendarMonthRange(weeks);
  return months.map((month) => buildWeeklyCalendarMonth(month, dayMap));
}

function weeklyCalendarDayMap(weeks) {
  const dayMap = new Map();
  weeks.forEach((week, weekIndex) => {
    (week.days || []).forEach((day) => {
      const itemCount = allSlotItems(day.slots).length;
      dayMap.set(day.date, {
        weekIndex,
        itemCount,
        hasItems: itemCount > 0,
      });
    });
  });
  return dayMap;
}

function weeklyCalendarMonthRange(weeks) {
  const dayMap = weeklyCalendarDayMap(weeks);
  const datesWithItems = [...dayMap.entries()]
    .filter(([, meta]) => meta.hasItems)
    .map(([date]) => date)
    .sort();
  if (!datesWithItems.length) return [];

  const firstMonth = monthStartIso(datesWithItems[0]);
  const lastMonth = monthStartIso(datesWithItems[datesWithItems.length - 1]);
  const months = [];
  let cursor = firstMonth;
  while (cursor <= lastMonth) {
    months.push(cursor);
    cursor = addMonthsIso(cursor, 1);
  }
  return months;
}

function clampMonth(month, firstMonth, lastMonth) {
  const value = monthStartIso(month || firstMonth);
  if (value < firstMonth) return firstMonth;
  if (value > lastMonth) return lastMonth;
  return value;
}

function buildWeeklyCalendarMonth(monthStart, dayMap) {
  const monthEnd = addDaysIso(addMonthsIso(monthStart, 1), -1);
  const gridStart = startOfWeekIso(monthStart);
  const gridEnd = endOfWeekIso(monthEnd);
  const days = [];
  let cursor = gridStart;
  while (cursor <= gridEnd) {
    const meta = dayMap.get(cursor) || {};
    days.push({
      date: cursor,
      dayNumber: Number(cursor.slice(8, 10)),
      isOutside: cursor.slice(0, 7) !== monthStart.slice(0, 7),
      itemCount: meta.itemCount || 0,
      hasItems: Boolean(meta.hasItems),
      weekIndex: meta.weekIndex,
    });
    cursor = addDaysIso(cursor, 1);
  }
  return {
    label: monthLabel(monthStart),
    days,
  };
}

function selectedWeeklyDay(week) {
  if (state.selectedWeekDay && weekContainsDate(week, state.selectedWeekDay)) return state.selectedWeekDay;
  const today = localDateIso();
  return weekContainsDate(week, today) ? today : week.weekStart;
}

function defaultWeekIndex(weeks) {
  if (!weeks.length) return 0;
  return weeks.length - 1;
}

function todayWeekIndex(weeks) {
  if (!weeks.length) return 0;
  const today = localDateIso();
  const exactIndex = weeks.findIndex((week) => (week.days || []).some((day) => day.date === today));
  if (exactIndex >= 0) return exactIndex;

  let closestIndex = 0;
  let closestDistance = Number.POSITIVE_INFINITY;
  weeks.forEach((week, index) => {
    const distance = Math.abs(dateValue(week.weekStart) - dateValue(today));
    if (distance < closestDistance) {
      closestDistance = distance;
      closestIndex = index;
    }
  });
  return closestIndex;
}

function localDateIso(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function weekMondayIso(value) {
  const date = new Date(`${String(value).slice(0, 10)}T12:00:00`);
  if (Number.isNaN(date.getTime())) return localDateIso();
  date.setDate(date.getDate() - ((date.getDay() + 6) % 7));
  return localDateIso(date);
}

function weekDayName(value) {
  const date = new Date(`${String(value || "").slice(0, 10)}T12:00:00`);
  if (Number.isNaN(date.getTime())) return "Day";
  return ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][date.getDay()];
}

function monthStartIso(value) {
  return `${String(value).slice(0, 7)}-01`;
}

function addMonthsIso(value, amount) {
  const date = new Date(`${value}T12:00:00`);
  date.setMonth(date.getMonth() + amount, 1);
  return localDateIso(date);
}

function addDaysIso(value, amount) {
  const date = new Date(`${value}T12:00:00`);
  date.setDate(date.getDate() + amount);
  return localDateIso(date);
}

function startOfWeekIso(value) {
  const date = new Date(`${value}T12:00:00`);
  const day = date.getDay() || 7;
  date.setDate(date.getDate() - day + 1);
  return localDateIso(date);
}

function endOfWeekIso(value) {
  return addDaysIso(startOfWeekIso(value), 6);
}

function monthLabel(value) {
  return new Intl.DateTimeFormat("en-GB", { month: "long", year: "numeric" }).format(new Date(`${value}T12:00:00`));
}

function dateValue(value) {
  if (!value) return 0;
  return new Date(`${value}T12:00:00`).getTime();
}

function countLabel(items) {
  const count = (items || []).length;
  return `${count} ${count === 1 ? "item" : "items"}`;
}

function orderedUnique(items, field) {
  const seen = new Set();
  const names = [];
  items.forEach((item) => {
    const name = clean(item[field]);
    if (!name || seen.has(name)) return;
    seen.add(name);
    names.push(name);
  });
  return names;
}

function groupBy(items, labelFn) {
  const map = new Map();
  items.forEach((item) => {
    const label = labelFn(item);
    if (!map.has(label)) map.set(label, []);
    map.get(label).push(item);
  });
  return Array.from(map, ([label, groupItemsValue]) => ({ label, items: groupItemsValue }));
}

function clean(value) {
  return String(value || "").trim();
}

function avatarMarkup(athlete) {
  const initials = initialsFor(athlete.athlete);
  if (!athlete.athlete_image_url) return `<span class="avatar-fallback">${escapeHtml(initials)}</span>`;
  return renderImage(athlete.athlete_image_url, "avatar", initials);
}

function initialsFor(name) {
  return String(name || "?")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase();
}

function openMedia(title, imageUrl, videoUrl) {
  if (!els.mediaModal || !els.mediaBody || !els.mediaTitle) return;
  const imagePreviewUrl = toDrivePreviewUrl(imageUrl);
  const hasImage = imageSources(imageUrl).length > 0;
  const cleanVideoUrl = String(videoUrl || "").trim();
  const videoEmbed = videoEmbedMarkup(cleanVideoUrl, imageUrl);
  els.mediaTitle.textContent = title || "Exercise media";
  els.mediaModal.classList.toggle("is-video", Boolean(videoEmbed));
  els.mediaBody.innerHTML = `
    ${videoEmbed
      ? videoEmbed
      : hasImage
        ? renderImage(imageUrl, "media-image-full", "", imagePreviewUrl)
        : imagePreviewUrl
          ? `<iframe class="media-frame" src="${escapeAttr(imagePreviewUrl)}" allowfullscreen></iframe>`
          : ""}
    ${!videoEmbed && !hasImage && !imagePreviewUrl ? `<div class="empty">No media available.</div>` : ""}
  `;
  els.mediaModal.hidden = false;
  wireVideoFallback(cleanVideoUrl);
  if (videoEmbed && isMobileViewport()) enterMediaFullscreen(true);
}

function videoEmbedMarkup(videoUrl, imageUrl = "") {
  const raw = String(videoUrl || "").trim();
  if (!raw) return "";
  const driveId = getDriveId(raw);
  const poster = toImageUrl(imageUrl);
  if (driveId) {
    return renderVideoFrame(toDrivePreviewUrl(raw, { autoplay: true }));
  }
  if (/\.(mp4|webm|mov)(\?|#|$)/i.test(raw)) {
    return `
      <video class="media-video" controls playsinline preload="metadata"${poster ? ` poster="${escapeAttr(poster)}"` : ""}>
        <source src="${escapeAttr(raw)}">
      </video>
    `;
  }
  return renderVideoFrame(toDrivePreviewUrl(raw, { autoplay: true }));
}

function renderVideoFrame(src) {
  return `
    <iframe class="media-frame media-frame-video" src="${escapeAttr(src)}" allow="autoplay; encrypted-media; fullscreen" allowfullscreen></iframe>
    <p class="media-fullscreen-note">Opening video in full screen</p>
    <button class="media-fullscreen-button" data-action="enter-fullscreen" type="button" aria-label="Full screen"></button>
  `;
}

function wireVideoFallback(videoUrl) {
  const video = els.mediaBody?.querySelector(".media-video");
  if (!video) return;
  let settled = false;
  const fallbackSrc = video.dataset.fallbackSrc || toDrivePreviewUrl(videoUrl);
  video.addEventListener("ended", closeMedia, { once: true });
  const showFallback = () => {
    if (settled || !fallbackSrc || !els.mediaBody || els.mediaModal.hidden) return;
    settled = true;
    els.mediaBody.innerHTML = renderVideoFrame(withAutoplayParam(fallbackSrc));
  };
  video.addEventListener("loadedmetadata", () => {
    settled = true;
  }, { once: true });
  video.addEventListener("error", showFallback, { once: true });
  setTimeout(showFallback, 2200);
}

function enterMediaFullscreen(silent = false) {
  const target = els.mediaBody?.querySelector(".media-frame-video, .media-video") || els.mediaModal?.querySelector(".media-dialog");
  const request = target?.requestFullscreen || target?.webkitRequestFullscreen || target?.msRequestFullscreen;
  if (!target || !request) return;
  try {
    const result = request.call(target);
    if (result?.catch && silent) result.catch(() => {});
  } catch (error) {
    if (!silent) console.warn(error);
  }
}

function handleFullscreenChange() {
  const fullscreenElement = document.fullscreenElement || document.webkitFullscreenElement;
  if (!fullscreenElement && els.mediaModal?.classList.contains("is-video") && !els.mediaModal.hidden) {
    closeMedia();
  }
}

function isMobileViewport() {
  return window.matchMedia?.("(max-width: 760px)").matches || window.innerWidth <= 760;
}

function closeMedia() {
  if (!els.mediaModal || !els.mediaBody) return;
  els.mediaModal.hidden = true;
  els.mediaModal.classList.remove("is-video");
  els.mediaBody.innerHTML = "";
}

function toDrivePreviewUrl(url, options = {}) {
  const raw = String(url || "").trim();
  if (!raw) return "";
  const driveId = getDriveId(raw);
  const previewUrl = driveId ? `https://drive.google.com/file/d/${driveId}/preview` : raw;
  return options.autoplay ? withAutoplayParam(previewUrl) : previewUrl;
}

function withAutoplayParam(url) {
  const raw = String(url || "").trim();
  if (!raw) return "";
  return raw.includes("?") ? `${raw}&autoplay=1` : `${raw}?autoplay=1`;
}

function toImageUrl(url) {
  return imageSources(url)[0] || "";
}

function renderImage(url, className, alt = "", previewUrl = "") {
  const sources = imageSources(url);
  if (!sources.length) return "";
  const fallbacks = sources.slice(1);
  return `<img class="${escapeAttr(className)}" src="${escapeAttr(sources[0])}" alt="${escapeAttr(alt)}"${fallbacks.length ? ` data-fallbacks="${escapeAttr(JSON.stringify(fallbacks))}"` : ""}${previewUrl ? ` data-preview-url="${escapeAttr(previewUrl)}"` : ""}>`;
}

function renderMediaThumb(url, fallbackLabel = "Image") {
  const previewUrl = toDrivePreviewUrl(url);
  return `${renderImage(url, "media-thumb", "", previewUrl)}${fallbackLabel ? `<span class="media-fallback">${escapeHtml(fallbackLabel)}</span>` : ""}`;
}

function imageSources(url) {
  const raw = String(url || "").trim();
  if (!raw) return [];
  const driveId = getDriveId(raw);
  if (!driveId) return [raw];
  return [
    `https://drive.google.com/thumbnail?id=${driveId}&sz=w1000`,
    `https://lh3.googleusercontent.com/d/${driveId}=w1000`,
    `https://drive.google.com/uc?export=view&id=${driveId}`,
  ];
}

function parseImageFallbacks(value) {
  try {
    const parsed = JSON.parse(value || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function getDriveId(url) {
  const raw = String(url || "").trim();
  if (!raw) return "";
  const fileMatch = raw.match(/drive\.google\.com\/file\/d\/([^/?]+)/);
  if (fileMatch) return fileMatch[1];
  const ucMatch = raw.match(/[?&]id=([^&]+)/);
  if (raw.includes("drive.google.com") && ucMatch) return ucMatch[1];
  const lhMatch = raw.match(/lh3\.googleusercontent\.com\/d\/([^/?]+)/);
  if (lhMatch) return lhMatch[1];
  return "";
}

async function api(path, options = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    credentials: "same-origin",
    headers: options.body ? { "Content-Type": "application/json", ...(options.headers || {}) } : options.headers,
    ...options,
  });
  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`;
    try {
      const errorData = await response.json();
      message = errorData.error || errorData.message || message;
    } catch {}
    throw new Error(message);
  }
  return response.json();
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

function formatDate(value) {
  if (!value) return "";
  const [year, month, day] = String(value).slice(0, 10).split("-");
  return day && month && year ? `${day}.${month}.${year}` : String(value);
}

function formatWeekday(value) {
  if (!value) return "";
  return new Intl.DateTimeFormat("en-GB", { weekday: "short" }).format(new Date(`${String(value).slice(0, 10)}T12:00:00`));
}

function formatDayMonth(value) {
  if (!value) return "";
  const [year, month, day] = String(value).slice(0, 10).split("-");
  return day && month && year ? `${day}.${month}` : String(value);
}

function debounce(fn, delay) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function escapeAttr(value) {
  return escapeHtml(value).replaceAll("`", "&#096;");
}
