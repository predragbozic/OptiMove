import { hasOrganizationAccess, isAthleteMode, isViewWorkspace } from "./access.js";
import { calendarSettingsContext } from "./calendar-settings-data.js";
import { sourceConnectionsAdminContext } from "./source-connections-data.js";
import { rolesContext } from "./roles-data.js";
import { coachSettingsSections, permissionTabAllowed, viewSettingsSections } from "./permission-nav.js";
import { viewHiddenMenuSelectors, viewWorkspaceTabs } from "./view-modules.js";
import { storageAdminContext } from "./media-storage-admin-data.js";
import { requestBottomNavSync } from "./bottom-nav.js";
import { els } from "./dom.js";
import { ATHLETE_TEMPLATE_SCOPES, TEMPLATE_SCOPES, state } from "./state.js";
import { escapeAttr, escapeHtml } from "./utils.js";

export function templateScopeMeta(scope = state.templateScope, user = state.currentUser) {
  const access = String(user?.accessScope || "").toLowerCase();
  const isAthlete = isAthleteMode() || access === "athlete";
  const isPlatform = access === "platform";
  const scopes = {
    my_programs: {
      // An athlete's place is "Programs" (menu, Home); this tab is what is shared with her (manager, item 6).
      label: isAthlete ? "Shared with you" : "My Programs",
      eyebrow: isAthlete ? "Allowed programs" : "Program workspace",
      note: isAthlete ? "Programs assigned to you and programs your coach or organization made available." : "Your drafts, coach programs, and shared team or club programs in one working library.",
    },
    all: {
      label: isAthlete ? "Allowed programs" : (isPlatform ? "All platform programs" : "All programs"),
      eyebrow: "Program library",
      note: isAthlete ? "Programs your coach or organization made available to you." : (isPlatform ? "All coach, club, OptiMove and marketplace programs visible to platform admins." : "All template programs available to your current account."),
    },
    my: {
      label: isAthlete ? "Coach library" : (isPlatform ? "Admin workspace" : "My Programs"),
      eyebrow: isAthlete ? "Coach library" : (isPlatform ? "Private admin library" : "Private library"),
      note: isAthlete ? "Programs your coach allowed you to browse and use." : (isPlatform ? "Programs created inside your own platform admin workspace." : "Reusable programs and templates available in your current coach workspace."),
    },
    workspace: {
      label: "Drafts",
      eyebrow: "Private workspace",
      note: "Unfinished or reusable coach materials that only you can see and use while building programs.",
    },
    club: {
      label: "Club programs",
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
  return scopes[scope] || scopes.my_programs;
}

// A view workspace (club_view / team_view, roles R4 contract 5.2) opens only what a module's own VIEW step adds; until
// then every module entry of the menu is hidden there (the phone's bottom bar reads the same menu). The tabs a view
// workspace may stay on are Home, Settings and Account.
export const VIEW_WORKSPACE_MENU_HIDDEN = Object.freeze([
  "#athletesToggle", "#calendarToggle", "#athleteSearch", "#athleteList",
  '[data-library-tab="coaches"]', '[data-library-tab="builder"]', '[data-sidebar-submenu="program-library"]',
  '[data-library-tab="exercises"]', '[data-library-tab="tests"]', '[data-library-tab="training-load"]',
]);
export const VIEW_WORKSPACE_TABS = Object.freeze(["coach-home", "organization", "coach-account"]);

// V-0: a place opens in a view workspace once one of its modules is open there and its word is held (view-modules.js);
// until a module's V step, the hidden set is the whole list above.
function applyViewWorkspaceMenu(view) {
  const hidden = new Set(view ? viewHiddenMenuSelectors() : []);
  for (const selector of VIEW_WORKSPACE_MENU_HIDDEN) {
    document.querySelectorAll(selector).forEach((el) => {
      // The athlete search is a label around its input: hide the label.
      const target = el.id === "athleteSearch" ? el.closest(".search-field") || el : el;
      if (hidden.has(selector)) {
        if (!target.hidden) target.dataset.viewHidden = "true";
        target.hidden = true;
      } else if (target.dataset.viewHidden) {
        delete target.dataset.viewHidden;
        target.hidden = false;
      }
    });
  }
}

export function renderAccessNav() {
  const orgButton = document.querySelector('[data-library-tab="organization"]');
  const orgSubmenu = document.querySelector('[data-sidebar-submenu="settings"]');
  const builderButton = document.querySelector('[data-library-tab="builder"]');
  const visible = hasOrganizationAccess();
  if (orgButton) orgButton.hidden = !visible;
  if (orgSubmenu) orgSubmenu.hidden = !visible;
  if (builderButton) builderButton.hidden = isAthleteMode();
  applyViewWorkspaceMenu(isViewWorkspace());
}

// A coach's Settings ("My team"): the active workspace is a team or the private coaching one. Only what a coach works with is
// offered; the server still decides every request (hiding a tab is not the protection).
export const COACH_SETTINGS_SECTIONS = ["athletes", "joinLinks", "presets", "icons"];
export function isCoachSettings() {
  return ["team", "private_coach"].includes(state.currentUser?.activeWorkspace?.type);
}

export function renderLibraryNav() {
  renderAccessNav();
  // A coach who loses Settings access lands on Home (K1b, D1: the weekly
  // plan without a picked athlete is only "No athlete selected."); the
  // athlete shell keeps its own weekly plan as the fallback.
  if (state.activeTab === "organization" && !hasOrganizationAccess()) state.activeTab = isAthleteMode() ? "weekly" : "coach-home";
  if (isViewWorkspace() && !viewWorkspaceTabs().includes(state.activeTab)) state.activeTab = "coach-home";
  if (isAthleteMode() && state.activeTab === "builder") state.activeTab = "weekly";
  document.querySelectorAll("[data-library-tab]").forEach((button) => {
    const tab = button.dataset.libraryTab;
    const scope = button.dataset.templateScope || "";
    const programLibrarySection = button.dataset.programLibrarySection || "";
    const isHiddenScope = tab === "templates" && scope && button.classList.contains("sidebar-subnav-button") && !visibleTemplateScopes().includes(scope);
    const organizationSection = button.dataset.organizationSection || "";
    const isHiddenOrganizationSection = tab === "organization" && button.classList.contains("sidebar-subnav-button") && (isCoachSettings() ? !coachSettingsSections().includes(organizationSection) : !permissionTabAllowed(organizationSection));
    button.hidden = isHiddenScope || isHiddenOrganizationSection;
    const isTemplateTab = tab === "templates" && state.activeTab === "templates";
    const isTemplateScope = isTemplateTab && scope && state.programLibrarySection !== "requests" && scope === state.templateScope;
    const isProgramLibrarySection = isTemplateTab && programLibrarySection && programLibrarySection === state.programLibrarySection;
    const isTemplateMain = isTemplateTab && button.classList.contains("sidebar-nav-button");
    const isOrganizationTab = tab === "organization" && state.activeTab === "organization";
    const isOrganizationScope = isOrganizationTab && organizationSection && organizationSection === (state.organization.section || "overview");
    const isOrganizationMain = isOrganizationTab && button.classList.contains("sidebar-nav-button");
    button.classList.toggle("is-active", isTemplateMain || isTemplateScope || isProgramLibrarySection || isOrganizationMain || isOrganizationScope || (!scope && !programLibrarySection && !organizationSection && tab === state.activeTab));
  });
  document.querySelectorAll("[data-sidebar-submenu]").forEach((submenu) => {
    const key = submenu.dataset.sidebarSubmenu;
    const autoOpen = (key === "program-library" && state.activeTab === "templates") ||
      (key === "settings" && state.activeTab === "organization");
    const manualOpen = state.sidebarSubmenuOpen[key];
    submenu.classList.toggle("is-open", manualOpen === undefined ? autoOpen : manualOpen);
  });
  updateProgramLibraryNavLabels();
  // After the loop above, which sets `hidden` on every menu button again.
  applyViewWorkspaceMenu(isViewWorkspace());
  document.querySelectorAll("[data-athlete-tab]").forEach((button) => {
    const tab = button.dataset.athleteTab || "";
    const isCalendar = tab === "calendar" && state.activeTab === "weekly";
    const isDirectTab = tab !== "calendar" && tab === state.activeTab;
    button.classList.toggle("is-active", isCalendar || isDirectTab);
    // "My training" is in the menu only once the server said she has a recorded session (owner, 2026-11-16).
    if (tab === "my-training") button.hidden = state.myTraining?.available !== true;
  });
  document.querySelector("#athletesToggle")?.classList.toggle("is-active", state.athletesExpanded);
  // The rail's Calendar is the central calendar (K1b, D1).
  document.querySelector("#calendarToggle")?.classList.toggle("is-active", state.activeTab === "central-calendar");
  // The phone's bottom bar shows the same sections and the same current one.
  requestBottomNavSync();
}

export function renderRailState() {
  document.body.classList.toggle("rail-expanded", state.railExpanded);
  els.railToggle?.setAttribute("aria-expanded", String(state.railExpanded));
  els.railToggle?.setAttribute("aria-label", state.railExpanded ? "Collapse navigation" : "Expand navigation");
}

export function renderMobileNavState() {
  document.body.classList.toggle("mobile-nav-open", state.mobileNavOpen);
  els.mobileNavToggle?.setAttribute("aria-expanded", String(state.mobileNavOpen));
  els.mobileNavToggle?.setAttribute("aria-label", state.mobileNavOpen ? "Close menu" : "Open menu");
}

export function updateProgramLibraryNavLabels() {
  const requestCount = (state.organization?.data?.accessRequests || []).filter((row) => row.status === "requested").length;
  document.querySelectorAll('.sidebar-subnav-button[data-program-library-section="requests"]').forEach((button) => {
    button.innerHTML = `Requests${requestCount ? ` <span class="sidebar-count">${escapeHtml(String(requestCount))}</span>` : ""}`;
  });
  document.querySelectorAll(".sidebar-subnav-button[data-template-scope]").forEach((button) => {
    const label = templateScopeMeta(button.dataset.templateScope).label;
    if (label) button.textContent = label;
  });
}

export function visibleTemplateScopes() {
  const allowed = new Set(state.templateAllowedScopes || TEMPLATE_SCOPES);
  const base = isAthleteMode() ? ATHLETE_TEMPLATE_SCOPES : TEMPLATE_SCOPES;
  return base.filter((scope) => allowed.has(scope));
}

export function ensureTemplateScopeIsVisible() {
  const scopes = visibleTemplateScopes();
  if (scopes.length && !scopes.includes(state.templateScope)) state.templateScope = scopes[0];
}

export function renderSettingsNavHtml(data = {}, section = state.organization.section || "overview") {
  if (isViewWorkspace()) {
    const labels = { overview: "Overview", clubs: "Clubs", teams: "Teams" };
    return `
    <nav class="settings-tabs om-tabs" aria-label="Settings sections">
      ${viewSettingsSections().map((value) => `<button class="settings-tab om-tab ${section === value ? "is-active" : ""}" type="button"${section === value ? ' aria-current="page"' : ""} data-action="organization-section" data-section="${escapeAttr(value)}">${escapeHtml(labels[value])}</button>`).join("")}
    </nav>
  `;
  }
  if (isCoachSettings()) {
    const labels = { athletes: "Athletes", joinLinks: "Join links", presets: "Tags & Presets", icons: "Icons" };
    return `
    <nav class="settings-tabs om-tabs" aria-label="Settings sections">
      ${coachSettingsSections().map((value) => `<button class="settings-tab om-tab ${section === value ? "is-active" : ""}" type="button"${section === value ? ' aria-current="page"' : ""} data-action="organization-section" data-section="${escapeAttr(value)}">${escapeHtml(labels[value])}</button>`).join("")}
    </nav>
  `;
  }
  const items = [
    ["overview", "Overview"],
    ["clubs", "Clubs"],
    ["teams", "Teams"],
    ["athletes", "Athletes"],
    ["users", "Users"],
    ["joinLinks", "Join links"],
    ["presets", "Tags & Presets"],
    // The built-in icons (PR-1): read only, for everyone who sees Settings.
    ["icons", "Icons"],
    // The club's calendar catalog (K2b-1c): an active club workspace and
    // that club's club_admin role. Every route behind it decides the same
    // again (T6) and answers everyone else 403 / the one 404.
    ...(calendarSettingsContext() ? [["calendar", "Calendar"]] : []),
    // Roles (R3): a platform admin, or the club's admin in that club's workspace, from today's /me facts. Every
    // route behind it decides again and answers everyone else the one 404.
    ...(rolesContext(data) ? [["roles", "Roles"]] : []),
    // Administering a data source is a platform-admin job (F3b). Hiding the
    // tab is not the protection - every route behind it checks the active
    // platform_admin role again on the server.
    ...(data.isPlatformAdmin ? [["dataSources", "Data sources"]] : []),
    // The club's source account (F3c3): a platform admin, or the owning
    // club's admin inside that club's workspace. Hiding the tab is not the
    // protection either - every route behind it resolves the same two bases
    // again and answers 404 to everyone else.
    ...(sourceConnectionsAdminContext() ? [["sourceConnections", "Source connections"]] : []),
    // Media storage limits (R2, PR 5): a platform administrator in the
    // platform workspace, like application blocks. Every route behind it
    // checks the active platform_admin role again.
    ...(storageAdminContext(data) ? [["storage", "Storage"]] : []),
    // App health (A2): the recorded errors, a platform administrator only; the route answers everyone else the unknown-route 404.
    ...(data.isPlatformAdmin ? [["appHealth", "App health"]] : []),
  ].filter(([value]) => permissionTabAllowed(value));
  return `
    <nav class="settings-tabs om-tabs" aria-label="Settings sections">
      ${items.map(([value, label]) => `<button class="settings-tab om-tab ${section === value ? "is-active" : ""}" type="button"${section === value ? ' aria-current="page"' : ""} data-action="organization-section" data-section="${escapeAttr(value)}">${escapeHtml(label)}</button>`).join("")}
    </nav>
  `;
}
