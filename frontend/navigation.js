import { hasOrganizationAccess, isAthleteMode } from "./access.js";
import { ATHLETE_TEMPLATE_SCOPES, TEMPLATE_SCOPES, state } from "./state.js";
import { escapeAttr, escapeHtml } from "./utils.js";

export function templateScopeMeta(scope = state.templateScope, user = state.currentUser) {
  const access = String(user?.accessScope || "").toLowerCase();
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

export function renderLibraryNav(renderAccessNav) {
  renderAccessNav();
  if (state.activeTab === "organization" && !hasOrganizationAccess()) state.activeTab = "weekly";
  if (isAthleteMode() && state.activeTab === "builder") state.activeTab = "weekly";
  document.querySelectorAll("[data-library-tab]").forEach((button) => {
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
  document.querySelectorAll("[data-athlete-tab]").forEach((button) => {
    const tab = button.dataset.athleteTab || "";
    const isCalendar = tab === "calendar" && state.activeTab === "weekly" && state.weekSelectorOpen;
    const isWeeklyPlan = tab === "weekly" && state.activeTab === "weekly" && !state.weekSelectorOpen;
    const isDirectTab = tab !== "weekly" && tab !== "calendar" && tab === state.activeTab;
    button.classList.toggle("is-active", isWeeklyPlan || isCalendar || isDirectTab);
  });
  document.querySelector("#athletesToggle")?.classList.toggle("is-active", state.athletesExpanded);
  document.querySelector("#calendarToggle")?.classList.toggle("is-active", state.activeTab === "weekly" && state.weekSelectorOpen);
}

export function updateProgramLibraryNavLabels() {
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

export function renderSettingsNavHtml(section = state.organization.section || "overview") {
  const items = [
    ["overview", "Overview"],
    ["clubs", "Clubs"],
    ["teams", "Teams"],
    ["athletes", "Athletes"],
    ["users", "Users"],
  ];
  return `
    <nav class="settings-tabs" aria-label="Settings sections">
      ${items.map(([value, label]) => `<button class="settings-tab ${section === value ? "is-active" : ""}" type="button" data-action="organization-section" data-section="${escapeAttr(value)}">${escapeHtml(label)}</button>`).join("")}
    </nav>
  `;
}
