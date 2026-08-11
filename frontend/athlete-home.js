import { renderImage } from "./media.js";
import { escapeAttr, escapeHtml, formatDate, formatWeekday, programInitials } from "./utils.js";

// hotfix/athlete-home-mobile-layout: the exact same icon paths as the
// athlete sidebar's own nav buttons (see data-athlete-tab="calendar" /
// "programs" / "athlete-library" / "athlete-settings" in athlete.html) -
// quick actions must look like larger versions of the real menu items they
// open, not a separate icon set.
// ui/athlete-program-navigation-icons: exported so the athlete toolbar's
// Weekly plans / Specific programs tabs (renderAthleteHeaderToolbarHtml in
// athlete-view.js) can reuse the exact same icon markup instead of a second
// copy of the same SVG paths - same convention as ICON_ADD_ATHLETE being
// exported from organization-view.js and reused in athlete-view.js.
export const ICON_CALENDAR = `<svg class="athlete-home-quick-action-icon" viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="5" width="16" height="15" rx="2"></rect><path d="M8 3v4"></path><path d="M16 3v4"></path><path d="M4 10h16"></path><path d="M8 14h.01"></path><path d="M12 14h.01"></path><path d="M16 14h.01"></path><path d="M8 17h.01"></path><path d="M12 17h.01"></path><path d="M16 17h.01"></path></svg>`;
export const ICON_SPECIFIC_PROGRAMS = `<svg class="athlete-home-quick-action-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 3.5h7l4 4v12a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1v-15a1 1 0 0 1 1-1Z"></path><path d="M14 3.5v4h4"></path><path d="M9 13h6"></path><path d="M9 16.5h6"></path></svg>`;
const ICON_PROGRAM_LIBRARY = `<svg class="athlete-home-quick-action-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M2.5 8.5l9.5-6 9.5 6"></path><path d="M3.5 9h17"></path><path d="M5.8 9.6v8.4"></path><path d="M18.2 9.6v8.4"></path><path d="M9 10c1.2-.7 2-.7 3 0 1-.7 1.8-.7 3 0v7.4c-1.2-.7-2-.7-3 0-1-.7-1.8-.7-3 0z"></path><path d="M3 20h18"></path></svg>`;
const ICON_SETTINGS = `<svg class="athlete-home-quick-action-icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 0 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2a2 2 0 0 1-4 0V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1A2 2 0 0 1 4.2 17l.1-.1A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.6-1H3a2 2 0 0 1 0-4h.2a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9l-.1-.1A2 2 0 0 1 7.2 4.2l.1.1A1.7 1.7 0 0 0 9.2 4a1.7 1.7 0 0 0 1-1.6V2a2 2 0 0 1 4 0v.2a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1A2 2 0 0 1 20 6.2l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1H21a2 2 0 0 1 0 4h-.2a1.7 1.7 0 0 0-1.4 1Z"></path></svg>`;

export function renderAthleteHomeHtml({ data, error }) {
  if (error) {
    return `
      <section class="content-section athlete-home">
        <p class="builder-error">${escapeHtml(error)}</p>
      </section>
    `;
  }
  if (!data) {
    return `<section class="content-section athlete-home"><div class="empty">Loading your home...</div></section>`;
  }
  const athlete = data.athlete || {};
  const today = data.today || {};
  const week = data.week || { days: [] };
  // hotfix/athlete-home-mobile-layout: Active specific programs was removed
  // from Home entirely - an athlete already reaches every assigned program
  // through the Specific programs quick action/tab, and a growing card list
  // here only lengthened the page and scaled badly. The backend response
  // still includes `programs` (other consumers may exist, and removing the
  // query would only be safe/obvious if nothing else read it - out of scope
  // for this UI-only change), it is just never rendered here.
  return `
    <section class="content-section athlete-home">
      ${renderAthleteHomeHeader(athlete, today)}
      ${renderTodayCard(today)}
      ${renderWeekStrip(week)}
      ${renderQuickActions()}
    </section>
  `;
}

function renderAthleteHomeHeader(athlete, today) {
  const image = athlete.imageUrl || "";
  return `
    <header class="athlete-home-header">
      ${image ? renderImage(image, "athlete-home-avatar") : `<span class="athlete-home-avatar athlete-home-avatar-fallback">${escapeHtml(programInitials(athlete.name || "Athlete"))}</span>`}
      <div class="athlete-home-header-body">
        <p class="athlete-home-greeting">Welcome back</p>
        <h3>${escapeHtml(athlete.name || "Athlete")}</h3>
        <p class="muted">${escapeHtml(formatDate(today.date))}</p>
      </div>
    </header>
  `;
}

function renderTodayCard(today) {
  if (!today.hasTraining) {
    return `
      <section class="panel athlete-home-today">
        <p class="eyebrow">Today's training</p>
        <div class="empty-state">No training is assigned for today.</div>
      </section>
    `;
  }
  const parts = [];
  if (Number(today.sessionCount) > 0) parts.push(`${today.sessionCount} ${today.sessionCount === 1 ? "session" : "sessions"}`);
  if (Number(today.itemCount) > 0) parts.push(`${today.itemCount} ${today.itemCount === 1 ? "exercise" : "exercises"}`);
  return `
    <section class="panel athlete-home-today has-training">
      <p class="eyebrow">Today's training</p>
      <h3>${escapeHtml(today.planName || "Today's training")}</h3>
      ${parts.length ? `<p class="muted">${escapeHtml(parts.join(" - "))}</p>` : ""}
      <button class="plain-button compact-button athlete-home-today-button" type="button" data-action="athlete-home-open-today" data-date="${escapeAttr(today.date || "")}">Open today's training</button>
    </section>
  `;
}

function renderWeekStrip(week) {
  const days = week.days || [];
  return `
    <section class="athlete-home-week">
      <p class="eyebrow">This week</p>
      <div class="athlete-home-week-strip">
        ${days.map(renderWeekDay).join("")}
      </div>
    </section>
  `;
}

function renderWeekDay(day) {
  const classes = ["athlete-home-day"];
  if (day.isToday) classes.push("is-today");
  if (day.hasTraining) classes.push("has-training");
  const dayNumber = Number(String(day.date || "").slice(8, 10)) || "";
  return `
    <button class="${classes.join(" ")}" type="button" data-action="athlete-home-open-day" data-date="${escapeAttr(day.date)}" aria-label="${escapeAttr(formatDate(day.date))}${day.hasTraining ? ", training scheduled" : ""}">
      <span class="athlete-home-day-name">${escapeHtml(formatWeekday(day.date))}</span>
      <span class="athlete-home-day-number">${escapeHtml(String(dayNumber))}</span>
      ${day.hasTraining ? `<span class="athlete-home-day-dot" aria-hidden="true"></span>` : ""}
    </button>
  `;
}

// hotfix/athlete-home-mobile-layout: exactly the 4 required quick actions,
// in this exact order - Home is deliberately NOT one of them (the athlete
// is already on Home when looking at this list; a Home action here would
// be a no-op button). Each targets the same tab id the sidebar's own
// data-athlete-tab button for that view uses, so this reuses the existing
// data-athlete-tab click handling in app.js - no new API call, no
// duplicated navigation logic.
function renderQuickActions() {
  const actions = [
    ["calendar", "Weekly plan", ICON_CALENDAR],
    ["programs", "Specific programs", ICON_SPECIFIC_PROGRAMS],
    ["athlete-library", "Program Library", ICON_PROGRAM_LIBRARY],
    ["athlete-settings", "Settings", ICON_SETTINGS],
  ];
  return `
    <section class="athlete-home-quick-actions">
      <p class="eyebrow">Quick actions</p>
      <div class="athlete-home-quick-actions-grid">
        ${actions.map(([tab, label, icon]) => `
          <button class="athlete-home-quick-action" type="button" data-action="athlete-home-quick-tab" data-target-tab="${escapeAttr(tab)}">
            ${icon}
            <span class="athlete-home-quick-action-label">${escapeHtml(label)}</span>
          </button>
        `).join("")}
      </div>
    </section>
  `;
}
