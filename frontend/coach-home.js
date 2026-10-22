import { renderImage } from "./media.js";
import { athleteMatches, sortAthletes } from "./athlete-list-tools.js";
import { renderExerciseThumb } from "./exercise-view-modes.js";
import { ICON_ADD_ATHLETE } from "./organization-view.js";
import { emptyCoachHomeState } from "./state.js";
import { escapeAttr, escapeHtml, localDateIso, monthLabel, monthWeeksIso, programInitials } from "./utils.js";

// Every Home card carries the icon of its item in the main menu
// (index.html), path for path: Training plan the menu's Calendar (which
// opens the same weekly plan), Training load, Exercise Library and Program
// Library their own.
export const COACH_HOME_MENU_ICONS = {
  calendar: `<rect x="4" y="5" width="16" height="15" rx="2"></rect><path d="M8 3v4"></path><path d="M16 3v4"></path><path d="M4 10h16"></path><path d="M8 14h.01"></path><path d="M12 14h.01"></path><path d="M16 14h.01"></path><path d="M8 17h.01"></path><path d="M12 17h.01"></path><path d="M16 17h.01"></path>`,
  load: `<circle cx="4" cy="12" r="1.3" fill="currentColor" stroke="none"></circle><circle cx="9" cy="7" r="1.3" fill="currentColor" stroke="none"></circle><circle cx="14" cy="10" r="1.3" fill="currentColor" stroke="none"></circle><circle cx="19" cy="6" r="1.3" fill="currentColor" stroke="none"></circle><path d="M4 12l5-5 5 3 5-4"></path><path d="M4 21v-6"></path><path d="M9 21v-9"></path><path d="M14 21v-7"></path><path d="M19 21v-11"></path>`,
  exercises: `<path d="M6 7v10"></path><path d="M18 7v10"></path><path d="M3 9v6"></path><path d="M21 9v6"></path><path d="M6 12h12"></path>`,
  programs: `<path d="M2.5 8.5l9.5-6 9.5 6"></path><path d="M3.5 9h17"></path><path d="M5.8 9.6v8.4"></path><path d="M18.2 9.6v8.4"></path><path d="M9 10c1.2-.7 2-.7 3 0 1-.7 1.8-.7 3 0v7.4c-1.2-.7-2-.7-3 0-1-.7-1.8-.7-3 0z"></path><path d="M3 20h18"></path>`,
};

// One chevron for every Home row that opens something else - the admin's
// workspace rows and the library card titles share it, so "this opens
// another screen" reads the same everywhere, with or without hover.
const ICON_CHEVRON_RIGHT = `<svg class="coach-home-workspace-arrow" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 5l7 7-7 7"></path></svg>`;
const ICON_PREVIOUS = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5l-7 7 7 7"></path></svg>`;
const ICON_NEXT = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 5l7 7-7 7"></path></svg>`;
const ICON_SEARCH = `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.5"></circle><path d="M20 20l-4.2-4.2"></path></svg>`;

// On a computer the day card lists this many of the day's athletes; the
// rest are one "Show all" away, in the same searchable list the Search
// buttons open. On a phone every one of them is in the day's strip.
export const COACH_HOME_DAY_LIST_LIMIT = 6;

const WORKSPACE_ICONS = {
  private_coach: `<circle cx="12" cy="7" r="3"></circle><path d="M5 21v-3a7 7 0 0 1 14 0v3"></path>`,
  club: `<path d="M12 3l8 3v6c0 4-4 7-8 9-4-2-8-5-8-9V6l8-3z"></path><circle cx="12" cy="11" r="3"></circle>`,
  team: `<circle cx="9" cy="7" r="3"></circle><path d="M3 21v-3a6 6 0 0 1 12 0v3M16 4a3 3 0 0 1 0 6M21 21v-3a6 6 0 0 0-4-5.7"></path>`,
  athlete: `<circle cx="12" cy="7" r="3"></circle><path d="M5 21v-3a7 7 0 0 1 14 0v3"></path>`,
};

function renderMenuIcon(name) {
  return `<svg class="coach-home-panel-icon" viewBox="0 0 24 24" aria-hidden="true">${COACH_HOME_MENU_ICONS[name]}</svg>`;
}

function renderWorkspaceButton(entry) {
  const kind = entry.type === "club" ? "Club" : entry.type === "team" ? "Team" : entry.type === "athlete" ? "Athlete" : "Private";
  return `<button class="coach-home-workspace" type="button" data-action="workspace-select" data-workspace-type="${escapeAttr(entry.type)}" data-workspace-scope-id="${escapeAttr(entry.scopeId || "")}">
    <svg class="coach-home-workspace-icon" viewBox="0 0 24 24" aria-hidden="true">${WORKSPACE_ICONS[entry.type] || WORKSPACE_ICONS.private_coach}</svg>
    <span class="coach-home-workspace-label"><strong>${escapeHtml(coachHomeWorkspaceLabel(entry))}</strong><small>${kind}</small></span>
    ${ICON_CHEVRON_RIGHT}
  </button>`;
}

function renderWorkspaceList(workspaces) {
  const clubIds = new Set(workspaces.filter((entry) => entry.type === "club").map((entry) => entry.scopeId));
  const roots = workspaces.filter((entry) => entry.type !== "team" || !entry.clubId || !clubIds.has(entry.clubId));
  return roots.map((entry) => {
    const teams = entry.type === "club" ? workspaces.filter((team) => team.type === "team" && team.clubId === entry.scopeId) : [];
    return `<li>${renderWorkspaceButton(entry)}${teams.length ? `<ul class="coach-home-workspace-teams" aria-label="${escapeAttr(coachHomeWorkspaceLabel(entry))} teams">${teams.map((team) => `<li>${renderWorkspaceButton(team)}</li>`).join("")}</ul>` : ""}</li>`;
  }).join("");
}

export function coachHomeWorkspaceLabel(workspace) {
  if (workspace?.type === "private_coach") return "Private coaching";
  if (workspace?.type === "platform") return "Platform administration";
  return workspace?.label || "Home";
}

// "Thu 22 Oct", with the year only when it is not this year's.
function shortDateLabel(iso, today) {
  const options = { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" };
  if (iso.slice(0, 4) !== today.slice(0, 4)) options.year = "numeric";
  return new Intl.DateTimeFormat("en-GB", options).format(new Date(`${iso}T12:00:00Z`));
}

function longDateLabel(iso) {
  return new Intl.DateTimeFormat("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${iso}T12:00:00Z`));
}

function sessionCountLabel(count) {
  return `${count} ${count === 1 ? "session" : "sessions"}`;
}

// An address renderImage cannot use draws nothing, so the initials stand in
// for it as for a missing picture. A strip draws every athlete at once, so
// its pictures load lazily.
function renderAthleteAvatar(row, className = "coach-home-avatar", { lazy = false } = {}) {
  return (row.athleteImageUrl && renderImage(row.athleteImageUrl, className, "", "", { lazy }))
    || `<span class="${className} coach-home-avatar-fallback" aria-hidden="true">${escapeHtml(programInitials(row.athlete || "Athlete"))}</span>`;
}

// The rows of the calendar's chosen day and whether they are ready: today is
// the roster read itself; another day is its own read (coach-home-data.js
// loadCoachHomeDay), loading until its answer for that very day arrives.
export function coachHomeDayView(rows, home, today = localDateIso()) {
  const date = home.calendar.selected || today;
  if (date === today) return { date, isToday: true, status: "ready", rows, error: "" };
  const day = home.day;
  if (day.date !== date || day.loading) return { date, isToday: false, status: "loading", rows: [], error: "" };
  if (day.error) return { date, isToday: false, status: "error", rows: [], error: day.error };
  return { date, isToday: false, status: "ready", rows: day.rows, error: "" };
}

// The picker's rows: the whole roster for Training plan / Training load, the
// chosen day's athletes with a session for the day list.
export function coachHomePickerRows(rows, picker = {}, home = emptyCoachHomeState(), today = localDateIso()) {
  if (picker.mode !== "day") return rows;
  const day = coachHomeDayView(rows, home, today);
  return day.date === picker.date ? day.rows : [];
}

function pickerTitle(picker, today) {
  if (picker.mode === "load") return "Training load";
  if (picker.mode === "day") return picker.date === today ? "Today" : shortDateLabel(picker.date, today);
  return "Training plan";
}

function renderPickerDialog(rows, picker, today) {
  return `<dialog class="coach-home-picker" aria-labelledby="coachHomePickerTitle">
        <header><h3 id="coachHomePickerTitle">${escapeHtml(pickerTitle(picker, today))}</h3><button class="plain-button icon-button" type="button" data-action="coach-home-picker-close" aria-label="Close athlete list" title="Close">&times;</button></header>
        <input type="search" data-coach-home-search placeholder="Search athletes" aria-label="Search athletes" value="${escapeAttr(picker.query || "")}">
        <div class="coach-home-picker-list">${renderCoachHomeAthleteRows(rows, picker, today)}</div>
      </dialog>`;
}

// A row of cards paged with the arrows (and, on a touch screen, a swipe).
// The arrows' enabled state follows the track's scroll position once it is
// on screen (coach-home-actions.js syncCoachHomeCarousel).
// `trackKey` names what the strip holds when it can hold something else under
// the same name (the day strip: its date), so a redraw keeps the scroll
// position only for the same contents.
function renderCarousel(track, label, itemsHtml, { previousLabel, nextLabel, trackKey = "" }) {
  return `<div class="coach-home-carousel" data-coach-home-carousel="${escapeAttr(track)}">
      <button class="plain-button coach-home-carousel-arrow" type="button" data-action="coach-home-scroll" data-track="${escapeAttr(track)}" data-direction="-1" aria-label="${escapeAttr(previousLabel)}" aria-disabled="true">${ICON_PREVIOUS}</button>
      <ul class="coach-home-track" role="list" data-coach-home-track="${escapeAttr(track)}"${trackKey ? ` data-coach-home-track-key="${escapeAttr(trackKey)}"` : ""} aria-label="${escapeAttr(label)}">${itemsHtml}</ul>
      <button class="plain-button coach-home-carousel-arrow" type="button" data-action="coach-home-scroll" data-track="${escapeAttr(track)}" data-direction="1" aria-label="${escapeAttr(nextLabel)}" aria-disabled="false">${ICON_NEXT}</button>
    </div>`;
}

function renderAthletePanel(mode, rows) {
  const plan = mode === "plan";
  const title = plan ? "Training plan" : "Training load";
  const titleId = plan ? "coachHomePlanTitle" : "coachHomeLoadTitle";
  const items = sortAthletes(rows).map((row) => `<li><button class="coach-home-strip-item coach-home-strip-athlete" type="button" data-action="coach-home-open-athlete" data-mode="${mode}" data-athlete-id="${escapeAttr(row.athleteId)}" data-athlete-uuid="${escapeAttr(row.athleteUuid || "")}" aria-label="${escapeAttr(`${row.athlete}, ${title}`)}">
        ${renderAthleteAvatar(row, "coach-home-avatar coach-home-strip-avatar", { lazy: true })}
        <span class="coach-home-strip-label">${escapeHtml(row.athlete)}</span>
      </button></li>`).join("");
  return `<section class="coach-home-panel coach-home-panel-${mode}" aria-labelledby="${titleId}">
      <header class="coach-home-panel-head">
        <h3 class="coach-home-panel-title" id="${titleId}">${renderMenuIcon(plan ? "calendar" : "load")}<span>${title}</span></h3>
        <button class="plain-button coach-home-search-button" type="button" aria-haspopup="dialog" data-action="coach-home-picker-open" data-mode="${mode}" aria-label="Search athletes for ${title}">${ICON_SEARCH}<span>Search</span></button>
      </header>
      ${renderCarousel(mode, `Athletes for ${title}`, items, { previousLabel: `Previous athletes for ${title}`, nextLabel: `Next athletes for ${title}` })}
    </section>`;
}

function renderCalendarHtml(home, today, selected) {
  const cursor = home.calendar.cursor || selected;
  const monthIso = cursor.slice(0, 7);
  const weeks = monthWeeksIso(monthIso);
  const cursorWeek = Math.max(0, weeks.findIndex((week) => week.includes(cursor)));
  const counts = home.days.counts || {};
  const expanded = home.calendar.expanded === true;
  const month = monthLabel(`${monthIso}-01`);
  const step = (unit, direction, label) => `<button class="plain-button coach-home-cal-step is-${unit}" type="button" data-action="coach-home-calendar-step" data-step="${unit}" data-direction="${direction}" aria-label="${label}">${direction < 0 ? ICON_PREVIOUS : ICON_NEXT}</button>`;
  const day = (iso) => {
    const count = Number(counts[iso] || 0);
    const classes = ["coach-home-cal-day"];
    if (iso.slice(0, 7) !== monthIso) classes.push("is-outside");
    if (iso === today) classes.push("is-today");
    if (iso === selected) classes.push("is-selected");
    if (count) classes.push("has-training");
    const label = `${longDateLabel(iso)}${iso === today ? ", today" : ""}${count ? `, ${count} ${count === 1 ? "athlete" : "athletes"} with a session` : ""}`;
    return `<button class="${classes.join(" ")}" type="button" data-action="coach-home-day-select" data-date="${escapeAttr(iso)}" aria-pressed="${iso === selected ? "true" : "false"}"${iso === today ? ' aria-current="date"' : ""} aria-label="${escapeAttr(label)}">${Number(iso.slice(8, 10))}</button>`;
  };
  return `<div class="coach-home-cal${expanded ? " is-expanded" : ""}">
        <div class="coach-home-cal-head">
          ${step("month", -1, "Previous month")}${step("week", -1, "Previous week")}
          <strong class="coach-home-cal-month">${escapeHtml(month)}</strong>
          ${step("week", 1, "Next week")}${step("month", 1, "Next month")}
        </div>
        <div class="coach-home-cal-weekdays" aria-hidden="true"><span>M</span><span>T</span><span>W</span><span>T</span><span>F</span><span>S</span><span>S</span></div>
        <div class="coach-home-cal-grid" role="group" aria-label="${escapeAttr(month)}">
          ${weeks.map((week, index) => `<div class="coach-home-cal-week"${index === cursorWeek ? " data-cursor-week" : ""}>${week.map(day).join("")}</div>`).join("")}
        </div>
        ${renderDaysErrorHtml(home, weeks)}
        <button class="plain-button coach-home-cal-toggle" type="button" data-action="coach-home-calendar-toggle" aria-expanded="${expanded ? "true" : "false"}">${expanded ? "Show week" : "Show month"}</button>
      </div>`;
}

// The month's dots could not be read: said, so an empty month never reads
// as "nothing planned". Every day can still be chosen.
function renderDaysErrorHtml(home, weeks) {
  if (!home.days.error || home.days.from !== weeks[0][0] || home.days.to !== weeks.at(-1)[6]) return "";
  return `<div class="coach-home-cal-note" role="alert">
          <p class="muted">Training days could not be shown.</p>
          <button class="plain-button coach-home-inline-button" type="button" data-action="coach-home-days-retry">Try again</button>
        </div>`;
}

function renderDayListHtml(day, today) {
  if (day.status === "loading") return `<p class="muted coach-home-day-note" role="status">Loading athletes...</p>`;
  if (day.status === "error") {
    return `<div class="coach-home-day-note" role="alert">
          <p>This day could not be loaded.</p>
          <p class="builder-error">${escapeHtml(day.error)}</p>
          <button class="plain-button coach-home-inline-button" type="button" data-action="coach-home-day-retry">Try again</button>
        </div>`;
  }
  const training = sortAthletes(day.rows.filter((row) => row.hasTrainingToday));
  if (!training.length) return `<p class="muted coach-home-day-note">${day.isToday ? "No athletes have a session scheduled today." : "No athletes have a session scheduled on this day."}</p>`;
  // One markup, two layouts (styles.css): a list beside the calendar on a
  // computer, the first COACH_HOME_DAY_LIST_LIMIT of them; on a phone a
  // strip under the calendar, every one of them, paged like the other
  // strips (owner, 2026-10-22).
  const items = training.map((row, index) => `<li${index >= COACH_HOME_DAY_LIST_LIMIT ? ' class="is-beyond-list"' : ""}><button class="coach-home-day-athlete" type="button" data-action="coach-home-open-athlete" data-mode="day" data-date="${escapeAttr(day.date)}" data-athlete-id="${escapeAttr(row.athleteId)}" data-athlete-uuid="${escapeAttr(row.athleteUuid || "")}">
            ${renderAthleteAvatar(row, "coach-home-avatar", { lazy: true })}
            <span class="coach-home-day-athlete-text"><strong>${escapeHtml(row.athlete)}</strong><small>${escapeHtml(sessionCountLabel(row.sessionCount))}</small></span>
          </button></li>`).join("");
  return `${renderCarousel("day", `Athletes with a session on ${shortDateLabel(day.date, today)}`, items, { previousLabel: `Previous athletes, ${shortDateLabel(day.date, today)}`, nextLabel: `Next athletes, ${shortDateLabel(day.date, today)}`, trackKey: day.date })}
        ${training.length > COACH_HOME_DAY_LIST_LIMIT ? `<button class="plain-button coach-home-inline-button coach-home-day-show-all" type="button" aria-haspopup="dialog" data-action="coach-home-picker-open" data-mode="day" data-date="${escapeAttr(day.date)}">Show all ${training.length} athletes</button>` : ""}`;
}

// The day card: the calendar and the chosen day's athletes. Today by
// default, as the old Today row was; any other day is one tap on the
// calendar, and "Today" brings it back.
export function renderCoachHomeDayHtml({ rows = [], home = emptyCoachHomeState(), today = localDateIso() } = {}) {
  const day = coachHomeDayView(rows, home, today);
  const training = day.rows.filter((row) => row.hasTrainingToday).length;
  const count = day.status === "ready"
    ? `${training} / ${day.rows.length} athletes ${day.isToday ? "training" : "with a session"}`
    : "";
  return `<section class="coach-home-panel coach-home-day" data-coach-home-section="day" aria-labelledby="coachHomeDayTitle">
      <header class="coach-home-panel-head">
        <div class="coach-home-day-heading">
          <h3 class="coach-home-panel-title" id="coachHomeDayTitle">${day.isToday ? `Today <span class="coach-home-day-date">${escapeHtml(shortDateLabel(day.date, today))}</span>` : escapeHtml(shortDateLabel(day.date, today))}</h3>
          ${count ? `<p class="coach-home-day-count">${count}</p>` : ""}
        </div>
        ${day.isToday && !home.calendar.cursor ? "" : `<button class="plain-button coach-home-inline-button" type="button" data-action="coach-home-day-today">Today</button>`}
      </header>
      <div class="coach-home-day-body">
        ${renderCalendarHtml(home, today, day.date)}
        <div class="coach-home-day-list">${renderDayListHtml(day, today)}</div>
      </div>
    </section>`;
}

function renderLibraryPanel({ section, title, titleId, icon, library, body }) {
  return `<section class="coach-home-panel coach-home-library" data-coach-home-section="${section}" aria-labelledby="${titleId}">
      <header class="coach-home-panel-head">
        <h3 class="coach-home-panel-title"><button class="coach-home-panel-link" type="button" data-action="coach-home-open-library" data-library="${library}" id="${titleId}">${renderMenuIcon(icon)}<span>${title}</span>${ICON_CHEVRON_RIGHT}</button></h3>
      </header>
      ${body}
    </section>`;
}

function renderLibraryStateHtml(part, { loadingText, errorText, emptyText, library }) {
  if (part.error && !part.items.length) {
    return `<div class="coach-home-library-note" role="alert">
        <p>${errorText}</p>
        <p class="builder-error">${escapeHtml(part.error)}</p>
        <button class="plain-button coach-home-inline-button" type="button" data-action="coach-home-library-retry" data-library="${library}">Try again</button>
      </div>`;
  }
  if (!part.loaded) return `<p class="muted coach-home-library-note" role="status">${loadingText}</p>`;
  if (!part.items.length) return `<p class="muted coach-home-library-note">${emptyText}</p>`;
  return "";
}

export function renderCoachHomeExerciseItemsHtml(items) {
  return items.map((exercise) => `<li><button class="coach-home-strip-item coach-home-strip-card" type="button" data-action="coach-home-open-exercise" data-exercise-id="${escapeAttr(exercise.id)}">
        <span class="coach-home-strip-media">${renderExerciseThumb(exercise, "coach-home-strip-thumb")}</span>
        <span class="coach-home-strip-label">${escapeHtml(exercise.name || "Exercise")}</span>
      </button></li>`).join("");
}

// The last item of the exercise strip while a further page loads, or after
// it failed: never an empty end with nothing to do.
export function renderCoachHomeExerciseMoreHtml(exercises) {
  if (exercises.loadingMore) return `<li class="coach-home-strip-more" data-coach-home-more><span class="muted" role="status">Loading more...</span></li>`;
  if (exercises.moreError) return `<li class="coach-home-strip-more" data-coach-home-more><div class="coach-home-library-note" role="alert"><p class="muted">More exercises could not be loaded.</p><button class="plain-button coach-home-inline-button" type="button" data-action="coach-home-exercises-more">Try again</button></div></li>`;
  return "";
}

export function renderCoachHomeExercisesHtml(exercises) {
  const note = renderLibraryStateHtml(exercises, {
    loadingText: "Loading exercises...",
    errorText: "Exercises could not be loaded.",
    emptyText: "No exercises in your library yet.",
    library: "exercises",
  });
  const body = note || renderCarousel("exercises", "Exercises", `${renderCoachHomeExerciseItemsHtml(exercises.items)}${renderCoachHomeExerciseMoreHtml(exercises)}`, { previousLabel: "Previous exercises", nextLabel: "Next exercises" });
  return renderLibraryPanel({ section: "exercises", title: "Exercise Library", titleId: "coachHomeExercisesTitle", icon: "exercises", library: "exercises", body });
}

export function renderCoachHomeProgramsHtml(programs) {
  const note = renderLibraryStateHtml(programs, {
    loadingText: "Loading programs...",
    errorText: "Programs could not be loaded.",
    emptyText: "No programs in My Programs yet.",
    library: "programs",
  });
  const items = programs.items.map((template) => `<li><button class="coach-home-strip-item coach-home-strip-card" type="button" data-action="coach-home-open-program" data-template-id="${escapeAttr(template.plan_id)}">
        <span class="coach-home-strip-media">${(template.cover_image_url && renderImage(template.cover_image_url, "coach-home-strip-thumb", "", "", { lazy: true })) || `<span class="coach-home-strip-thumb coach-home-strip-initials" aria-hidden="true">${escapeHtml(programInitials(template.plan_name))}</span>`}</span>
        <span class="coach-home-strip-label">${escapeHtml(template.plan_name || "Program")}</span>
      </button></li>`).join("");
  const body = note || renderCarousel("programs", "Programs", items, { previousLabel: "Previous programs", nextLabel: "Next programs" });
  return renderLibraryPanel({ section: "programs", title: "Program Library", titleId: "coachHomeProgramsTitle", icon: "programs", library: "programs", body });
}

// The roster loaded and holds no athlete: the one action that changes that
// (the same home-add-athlete the header's round button sends).
function renderEmptyStateHtml() {
  return `<div class="coach-home-state coach-home-state-empty">
        <p class="coach-home-state-title">No athletes in this workspace yet.</p>
        <p class="muted">Add your first athlete to plan training and track training load.</p>
        <button class="plain-button coach-home-state-button" type="button" data-action="home-add-athlete">${ICON_ADD_ATHLETE}<span>Add athlete</span></button>
      </div>`;
}

// GET /api/athletes/today failed: the message and one way back
// (coach-home-retry re-runs loadCoachHome with forceRefresh - app.js). Never
// the athlete cards or the day card: their "0 / 0" would read as a real,
// empty roster.
function renderErrorStateHtml(error) {
  return `<div class="coach-home-state coach-home-state-error">
        <div role="alert">
          <p class="coach-home-state-title">Your athletes could not be loaded.</p>
          <p class="builder-error">${escapeHtml(error)}</p>
        </div>
        <button class="plain-button coach-home-state-button" type="button" data-action="coach-home-retry">Try again</button>
      </div>`;
}

export function renderCoachHomeHtml({ rows = [], error = "", user, picker = {}, home = emptyCoachHomeState(), today = localDateIso() }) {
  const workspace = user?.activeWorkspace;
  const platform = workspace?.type === "platform";
  const workspaces = (user?.availableWorkspaces || []).filter((entry) => entry.type !== "platform");
  // The athlete cards need at least one athlete: with nobody to show, the
  // strips and the day card would be empty dead ends.
  const athleteCards = error
    ? renderErrorStateHtml(error)
    : rows.length
      ? `${renderAthletePanel("plan", rows)}${renderAthletePanel("load", rows)}${renderCoachHomeDayHtml({ rows, home, today })}`
      : renderEmptyStateHtml();
  const body = platform
    ? `${error ? `<p class="builder-error" role="alert">${escapeHtml(error)}</p>` : ""}${workspaces.length ? `<ul class="coach-home-workspaces">${renderWorkspaceList(workspaces)}</ul>` : `<p class="muted">No coaching workspaces available.</p>`}`
    : `<div class="coach-home-grid">${athleteCards}${renderCoachHomeExercisesHtml(home.exercises)}${renderCoachHomeProgramsHtml(home.programs)}</div>
    ${!error && rows.length && picker.mode ? renderPickerDialog(coachHomePickerRows(rows, picker, home, today), picker, today) : ""}`;
  return `<section class="content-section coach-home">
    <header class="coach-home-header"><h2>${escapeHtml(coachHomeWorkspaceLabel(workspace))}</h2>
      ${!platform ? `<button class="plain-button icon-button athlete-toolbar-add-button" type="button" data-action="home-add-athlete" aria-label="Add athlete" title="Add athlete">${ICON_ADD_ATHLETE}</button>` : ""}
    </header>
    ${body}
  </section>`;
}

function renderAthleteRowButton(row, picker, today) {
  const mode = picker.mode === "load" ? "load" : picker.mode === "day" ? "day" : "plan";
  const date = mode === "day" ? picker.date : "";
  // The day list's title already names the day.
  const detail = mode === "day"
    ? sessionCountLabel(row.sessionCount)
    : row.hasTrainingToday ? `${sessionCountLabel(row.sessionCount)} today` : "No session today";
  return `<button class="coach-home-athlete-row" type="button" data-action="coach-home-open-athlete" data-mode="${mode}"${date ? ` data-date="${escapeAttr(date)}"` : ""} data-athlete-id="${escapeAttr(row.athleteId)}" data-athlete-uuid="${escapeAttr(row.athleteUuid || "")}">
    ${renderAthleteAvatar(row)}
    <span><strong>${escapeHtml(row.athlete)}</strong><small>${escapeHtml(detail)}</small></span>
  </button>`;
}

export function renderCoachHomeAthleteRows(rows, picker = {}, today = localDateIso()) {
  const query = (picker.query || "").trim().toLocaleLowerCase();
  const scopedRows = picker.mode === "day" ? rows.filter((row) => row.hasTrainingToday) : rows;
  const matches = sortAthletes(scopedRows).filter((row) => athleteMatches(row, query));
  const none = picker.mode === "day"
    ? picker.date === today ? "No athletes have a session scheduled today." : "No athletes have a session scheduled on this day."
    : "No athletes in this workspace.";
  return matches.map((row) => renderAthleteRowButton(row, picker, today)).join("") || `<p class="muted">${scopedRows.length ? "No athletes match your search." : none}</p>`;
}
