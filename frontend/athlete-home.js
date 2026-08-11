import { renderImage } from "./media.js";
import { escapeAttr, escapeHtml, formatDate, formatWeekday, programInitials } from "./utils.js";

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
  const programs = data.programs || { rows: [], total: 0 };
  return `
    <section class="content-section athlete-home">
      ${renderAthleteHomeHeader(athlete, today)}
      ${renderTodayCard(today)}
      ${renderWeekStrip(week)}
      ${renderProgramsSection(programs)}
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

function renderProgramsSection(programs) {
  const rows = programs.rows || [];
  if (!rows.length) {
    return `
      <section class="athlete-home-programs">
        <p class="eyebrow">Active specific programs</p>
        <div class="empty-state">No specific programs are assigned yet.</div>
      </section>
    `;
  }
  return `
    <section class="athlete-home-programs">
      <div class="organization-list-head">
        <p class="eyebrow">Active specific programs</p>
        ${programs.total > rows.length ? `<button class="plain-button compact-button" type="button" data-action="athlete-home-view-programs">View all programs</button>` : ""}
      </div>
      <div class="athlete-home-program-cards">
        ${rows.map(renderProgramCard).join("")}
      </div>
    </section>
  `;
}

function renderProgramCard(program) {
  return `
    <article class="athlete-home-program-card">
      ${program.imageUrl ? renderImage(program.imageUrl, "athlete-home-program-image") : `<span class="athlete-home-program-fallback">${escapeHtml(programInitials(program.name || "Program"))}</span>`}
      <div class="athlete-home-program-body">
        <strong>${escapeHtml(program.name || "Program")}</strong>
        <button class="plain-button compact-button" type="button" data-action="athlete-home-open-program" data-program-id="${escapeAttr(program.id)}">Open program</button>
      </div>
    </article>
  `;
}

function renderQuickActions() {
  const actions = [
    ["calendar", "Weekly plan"],
    ["programs", "Specific programs"],
    ["athlete-library", "Program Library"],
    ["athlete-settings", "Settings"],
  ];
  return `
    <section class="athlete-home-quick-actions">
      <p class="eyebrow">Quick actions</p>
      <div class="athlete-home-quick-actions-row">
        ${actions.map(([tab, label]) => `<button class="plain-button compact-button" type="button" data-action="athlete-home-quick-tab" data-target-tab="${escapeAttr(tab)}">${escapeHtml(label)}</button>`).join("")}
      </div>
    </section>
  `;
}
