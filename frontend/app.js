const API_BASE = "";

const state = {
  athletes: [],
  selectedAthleteId: null,
  athletesExpanded: false,
  activeTab: "weekly",
  selectedProgramId: null,
  selectedTemplateId: null,
  selectedWeekIndex: 0,
  weekSelectorOpen: false,
  pendingScrollDate: "",
  lastWeeklyData: null,
  lastProgramBundle: null,
  lastTemplates: [],
  lastExerciseResults: [],
  navStack: [],
  exerciseDetail: { ids: [], currentId: null },
  exerciseLayout: "horizontal",
  touch: { startX: 0, startY: 0, startTime: 0 },
  appHistoryDepth: 0,
};

const els = {
  status: document.querySelector("#apiStatus"),
  title: document.querySelector("#screenTitle"),
  context: document.querySelector("#contextLabel"),
  athleteList: document.querySelector("#athleteList"),
  athleteSearch: document.querySelector("#athleteSearch"),
  athletesToggle: document.querySelector("#athletesToggle"),
  tabs: document.querySelectorAll(".tab"),
  libraryTabs: document.querySelectorAll("[data-library-tab]"),
  toolbar: document.querySelector("#viewToolbar"),
  content: document.querySelector("#content"),
  mediaModal: document.querySelector("#mediaModal"),
  mediaTitle: document.querySelector("#mediaTitle"),
  mediaBody: document.querySelector("#mediaBody"),
};

init();

async function init() {
  bindEvents();
  await loadAthletes();
}

function bindEvents() {
  els.athleteSearch.addEventListener("input", renderAthleteList);
  els.athletesToggle.addEventListener("click", toggleAthletesList);
  els.tabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      state.activeTab = tab.dataset.tab;
      state.selectedProgramId = null;
      state.selectedTemplateId = null;
      state.navStack = [];
      renderTabs();
      renderLibraryNav();
      loadActiveTab();
    });
  });
  els.libraryTabs.forEach((button) => {
    button.addEventListener("click", () => {
      state.activeTab = button.dataset.libraryTab;
      state.selectedProgramId = null;
      state.navStack = [];
      renderTabs();
      renderLibraryNav();
      loadActiveTab();
    });
  });

  els.content.addEventListener("click", handleContentClick);
  els.content.addEventListener("touchstart", handleSwipeStart, { passive: true });
  els.content.addEventListener("touchend", handleSwipeEnd, { passive: true });
  document.addEventListener("click", handleGlobalClick);
  document.addEventListener("error", handleImageError, true);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeMedia();
  });
  window.addEventListener("popstate", handleBrowserBack);
}

function toggleAthletesList() {
  state.athletesExpanded = !state.athletesExpanded;
  renderAthleteList();
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
    state.activeTab = tab.dataset.tab;
    state.selectedProgramId = null;
    state.selectedTemplateId = null;
    state.navStack = [];
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
  const velocity = Math.abs(deltaX) / elapsed;
  if (Math.abs(deltaX) < 86 || velocity < 0.28 || Math.abs(deltaX) < Math.abs(deltaY) * 1.8) return;
  handleHorizontalSwipe(deltaX < 0 ? 1 : -1);
}

function isSwipeContext(target) {
  if (!els.mediaModal?.hidden) return false;
  if (target.closest(".calendar-grid, .week-selector, .program-day-grid, .exercise-list")) return false;
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
  window.history.pushState({ optimove: true }, "", window.location.href);
  state.appHistoryDepth += 1;
}

function handleBrowserBack() {
  if (state.appHistoryDepth > 0) state.appHistoryDepth -= 1;
  handleAppBack();
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

  return false;
}

async function loadAthletes() {
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
  if (state.activeTab === "weekly") return loadWeekly();
  if (state.activeTab === "programs") return loadPrograms();
  if (state.activeTab === "templates") return loadTemplates();
  return loadExercises();
}

async function loadWeekly() {
  if (!state.selectedAthleteId) return renderEmpty("No athlete selected.");
  state.navStack = [];
  setLoading("Loading weekly plans...");
  const data = await api(`/api/athletes/${encodeURIComponent(state.selectedAthleteId)}/program-data?program=__weekly__`);
  state.lastWeeklyData = data;
  state.selectedWeekIndex = defaultWeekIndex(data.weeks || []);
  state.weekSelectorOpen = false;
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

async function loadTemplates() {
  state.navStack = [];
  setLoading("Loading templates...");
  const data = await api("/api/templates");
  state.lastTemplates = data.templates || [];
  if (!state.selectedTemplateId) state.selectedTemplateId = state.lastTemplates[0]?.plan_id || null;
  renderTemplateToolbar(state.lastTemplates);
  const selected = state.lastTemplates.find((template) => template.plan_id === state.selectedTemplateId);
  if (!selected) return renderEmpty("No template programs.");
  const detail = await api(`/api/plans/${selected.plan_id}/program`);
  renderTemplateList(state.lastTemplates, selected, detail);
}

async function loadExercises() {
  state.navStack = [];
  els.toolbar.innerHTML = `
    <label class="search-field">
      <span>Exercise search</span>
      <input id="exerciseSearch" type="search" placeholder="Name or code" value="V-sit">
    </label>
  `;
  const input = document.querySelector("#exerciseSearch");
  input.addEventListener("input", debounce(() => searchExercises(input.value), 250));
  await searchExercises(input.value);
}

async function searchExercises(term) {
  const query = term.trim();
  setLoading("Searching exercises...");
  const data = await api(`/api/exercises?search=${encodeURIComponent(query)}&limit=30`);
  renderExercises(data.exercises || []);
}

function handleContentClick(event) {
  const action = event.target.closest("[data-action]");
  if (!action) return;

  const type = action.dataset.action;
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
  if (type === "week-prev" || type === "week-next") {
    const delta = type === "week-prev" ? -1 : 1;
    moveWeek(delta);
    return;
  }
  if (type === "week-toggle") {
    state.weekSelectorOpen = !state.weekSelectorOpen;
    renderWeeklyRoot(state.lastWeeklyData);
    return;
  }
  if (type === "week-today") {
    const weeks = state.lastWeeklyData?.weeks || [];
    state.selectedWeekIndex = todayWeekIndex(weeks);
    state.pendingScrollDate = localDateIso();
    state.navStack = [];
    renderWeeklyRoot(state.lastWeeklyData);
    return;
  }
  if (type === "week-select") {
    state.selectedWeekIndex = Number(action.dataset.weekIndex) || 0;
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
  if (state.activeTab === "exercises") return renderExercises(state.lastExerciseResults);
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
  const isLibraryTab = state.activeTab === "templates" || state.activeTab === "exercises";
  const tabs = document.querySelectorAll(".tab");
  const tabsContainer = tabs[0]?.closest(".tabs");
  if (tabsContainer) tabsContainer.hidden = isLibraryTab;
  tabs.forEach((tab) => tab.classList.toggle("is-active", tab.dataset.tab === state.activeTab));
}

function renderLibraryNav() {
  els.libraryTabs.forEach((button) => {
    button.classList.toggle("is-active", button.dataset.libraryTab === state.activeTab);
  });
}

function renderAthleteListState() {
  els.athleteList.classList.toggle("is-expanded", state.athletesExpanded);
  els.athletesToggle.setAttribute("aria-expanded", String(state.athletesExpanded));
}

function renderAthleteList() {
  const search = els.athleteSearch.value.trim().toLowerCase();
  const filteredAthletes = state.athletes.filter((athlete) => {
    const haystack = `${athlete.athlete_id} ${athlete.athlete}`.toLowerCase();
    return haystack.includes(search);
  });
  const selectedAthlete = filteredAthletes.find((athlete) => athlete.athlete_id === state.selectedAthleteId);
  const athletes = state.athletesExpanded || search
    ? filteredAthletes
    : (selectedAthlete ? [selectedAthlete] : filteredAthletes.slice(0, 1));

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
      renderAthleteList();
      renderTabs();
      renderLibraryNav();
      loadActiveTab();
    });
  });
}

function renderAthleteHeader(data) {
  const athlete = state.athletes.find((entry) => entry.athlete_id === state.selectedAthleteId);
  els.context.textContent = athlete ? `Athlete ID ${athlete.athlete_id}` : "Coach dashboard";
  els.title.textContent = athlete?.athlete || "Athletes and programs";
  els.toolbar.innerHTML = "";

  if (!athlete) return;
  els.toolbar.innerHTML = `
    <div class="athlete-toolbar-row">
      <section class="athlete-hero">
        ${athlete.athlete_image_url
          ? renderImage(athlete.athlete_image_url, "athlete-hero-image", initialsFor(athlete.athlete))
          : `<div class="athlete-hero-fallback">${escapeHtml(initialsFor(athlete.athlete))}</div>`}
        <div>
          <p class="eyebrow">Selected athlete</p>
          <h3>${escapeHtml(athlete.athlete || "")}</h3>
          <p class="muted">ID ${escapeHtml(athlete.athlete_id || "")}</p>
        </div>
      </section>
      <nav class="tabs athlete-tabs" aria-label="Athlete views">
        <button class="tab" data-tab="weekly">Weekly plans</button>
        <button class="tab" data-tab="programs">Specific programs</button>
      </nav>
    </div>
  `;
  renderTabs();
}

function renderWeeklyRoot(data) {
  const weeks = data?.weeks || [];
  if (!weeks.length) return renderEmpty("This athlete has no weekly plans.");
  const activeWeek = weeks[Math.max(0, Math.min(weeks.length - 1, state.selectedWeekIndex))] || weeks[0];
  const todayIndex = todayWeekIndex(weeks);
  const weekRange = `${formatDate(activeWeek.weekStart)} - ${formatDate(activeWeek.weekEnd)}`;

  els.content.innerHTML = `
    <div class="content-section">
      <section class="week-nav-panel">
        <button class="plain-button" data-action="week-prev" ${state.selectedWeekIndex <= 0 ? "disabled" : ""}>Previous</button>
        <button class="week-title-button" data-action="week-toggle" aria-expanded="${state.weekSelectorOpen}">
          <span class="eyebrow">Weekly plans</span>
          <strong>${escapeHtml(weekRange)}</strong>
          <span>${weekTotal(activeWeek)} items · ${state.weekSelectorOpen ? "Hide weeks" : "Show weeks"}</span>
        </button>
        <button class="plain-button" data-action="week-today">Today</button>
        <button class="plain-button" data-action="week-next" ${state.selectedWeekIndex >= weeks.length - 1 ? "disabled" : ""}>Next</button>
      </section>
      ${state.weekSelectorOpen ? `
        <div class="week-selector">
          ${weeks.map((week, index) => `
            <button class="week-chip ${index === state.selectedWeekIndex ? "is-active" : ""}" data-action="week-select" data-week-index="${index}">
              ${formatDate(week.weekStart)}
            </button>
          `).join("")}
        </div>
      ` : ""}
      <section class="panel">
        <div class="calendar-grid">
          ${(activeWeek.days || []).map(renderDayEntry).join("")}
        </div>
      </section>
    </div>
  `;
  if (state.pendingScrollDate) {
    const date = state.pendingScrollDate;
    state.pendingScrollDate = "";
    requestAnimationFrame(() => scrollCalendarToDate(date));
  }
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
        <span class="item-badge">${data.rows?.length || 0} items</span>
      </div>
      ${isMicrocycle
        ? `<div class="node-grid">${groups.map(renderNodeButton).join("")}</div>`
        : `<div class="program-day-grid">${groups.map(renderProgramDayCard).join("")}</div>`}
    </section>
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
            <button class="plain-button" data-action="back">Back</button>
            <button class="plain-button" data-action="home">Home</button>
          </div>
          ${siblingState.hasSiblings ? `
            <div class="drill-sibling-actions">
              <button class="plain-button" data-action="node-prev" ${siblingState.canGoPrevious ? "" : "disabled"}>Previous</button>
              <span class="exercise-position">${siblingState.index + 1} / ${siblingState.total}</span>
              <button class="plain-button" data-action="node-next" ${siblingState.canGoNext ? "" : "disabled"}>Next</button>
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
  const labels = { B: "B - Before training", T: "T - Training", A: "A - After training", "": "Session" };
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
  els.context.textContent = "Program library";
  els.title.textContent = "Templates";
  els.toolbar.innerHTML = `
    <div class="chip-row template-toolbar">
      ${templates.map((template) => `
        <button class="chip ${template.plan_id === state.selectedTemplateId ? "is-active" : ""}" data-template-id="${escapeAttr(template.plan_id)}">
          ${escapeHtml(template.plan_name)}
        </button>
      `).join("")}
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
  els.context.textContent = "Program library";
  els.title.textContent = "Templates";
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
            <p class="muted">${escapeHtml(selected.source_external_id || "Program template")}</p>
          </div>
          <span class="item-badge">${detail.rows?.length || 0} items</span>
        </div>
        ${isMicrocycle
          ? `<div class="node-grid">${groups.map(renderNodeButton).join("")}</div>`
          : `<div class="program-day-grid">${groups.map(renderProgramDayCard).join("")}</div>`}
      </section>
    </section>
  `;
}

function renderExercises(exercises) {
  state.lastExerciseResults = exercises;
  els.context.textContent = "Library";
  els.title.textContent = "Exercises";
  if (!exercises.length) return renderEmpty("No exercises for this search.");
  const itemIds = registerItems(exercises);
  state.exerciseDetail = { ids: itemIds, currentId: null };
  els.content.innerHTML = `
    <div class="exercise-grid">
      ${exercises.map((exercise, index) => {
        const itemId = itemIds[index];
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
        </article>
      `;}).join("")}
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
        <button class="chip ${layout === "horizontal" ? "is-active" : ""}" data-action="exercise-layout" data-layout="horizontal">Horizontal</button>
        <button class="chip ${layout === "vertical" ? "is-active" : ""}" data-action="exercise-layout" data-layout="vertical">Vertical</button>
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

  els.content.innerHTML = `
    <section class="panel exercise-detail">
      <div class="drill-header">
        <div>
          <p class="eyebrow">Exercise</p>
          <h3>${escapeHtml(title)}</h3>
          ${hierarchy ? `<div class="breadcrumb">${escapeHtml(hierarchy)}</div>` : ""}
        </div>
        <div class="drill-actions">
          ${hasSequence ? `<button class="plain-button" data-action="exercise-prev" ${canGoPrevious ? "" : "disabled"}>Previous</button>` : ""}
          ${hasSequence ? `<span class="exercise-position">${currentIndex + 1} / ${ids.length}</span>` : ""}
          ${hasSequence ? `<button class="plain-button" data-action="exercise-next" ${canGoNext ? "" : "disabled"}>Next</button>` : ""}
          <button class="plain-button" data-action="exercise-back">Back</button>
          <button class="plain-button" data-action="home">Home</button>
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
          <div class="detail-badges">
            ${item.amPm ? `<span class="item-badge">${escapeHtml(item.amPm)}</span>` : ""}
            ${item.bta ? `<span class="item-badge">${escapeHtml(item.bta)}</span>` : ""}
          </div>

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
  `;
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
  bta: "B/T/A",
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
  if (state.navStack.length > 1) {
    state.navStack.pop();
    renderCurrentNode();
    return;
  }
  renderCurrentNode();
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

function defaultWeekIndex(weeks) {
  return todayWeekIndex(weeks);
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
    return renderVideoFrame(toDrivePreviewUrl(raw));
  }
  if (/\.(mp4|webm|mov)(\?|#|$)/i.test(raw)) {
    return `
      <video class="media-video" controls playsinline preload="metadata"${poster ? ` poster="${escapeAttr(poster)}"` : ""}>
        <source src="${escapeAttr(raw)}">
      </video>
    `;
  }
  return renderVideoFrame(toDrivePreviewUrl(raw));
}

function renderVideoFrame(src) {
  return `
    <iframe class="media-frame media-frame-video" src="${escapeAttr(src)}" allow="autoplay; encrypted-media; fullscreen" allowfullscreen></iframe>
    <button class="media-fullscreen-button" data-action="enter-fullscreen" type="button" aria-label="Full screen"></button>
  `;
}

function wireVideoFallback(videoUrl) {
  const video = els.mediaBody?.querySelector(".media-video");
  if (!video) return;
  let settled = false;
  const fallbackSrc = video.dataset.fallbackSrc || toDrivePreviewUrl(videoUrl);
  const showFallback = () => {
    if (settled || !fallbackSrc || !els.mediaBody || els.mediaModal.hidden) return;
    settled = true;
    els.mediaBody.innerHTML = `<iframe class="media-frame media-frame-video" src="${escapeAttr(fallbackSrc)}" allow="autoplay; encrypted-media; fullscreen" allowfullscreen></iframe>`;
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

function isMobileViewport() {
  return window.matchMedia?.("(max-width: 760px)").matches || window.innerWidth <= 760;
}

function closeMedia() {
  if (!els.mediaModal || !els.mediaBody) return;
  els.mediaModal.hidden = true;
  els.mediaModal.classList.remove("is-video");
  els.mediaBody.innerHTML = "";
}

function toDrivePreviewUrl(url) {
  const raw = String(url || "").trim();
  if (!raw) return "";
  const driveId = getDriveId(raw);
  if (driveId) return `https://drive.google.com/file/d/${driveId}/preview`;
  return raw;
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

async function api(path) {
  const response = await fetch(`${API_BASE}${path}`);
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
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
