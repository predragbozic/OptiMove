import { renderImage } from "./media.js";
import { escapeAttr, escapeHtml, initialsFor } from "./utils.js";

function avatarMarkup(athlete) {
  const initials = initialsFor(athlete.athlete);
  if (!athlete.athlete_image_url) return `<span class="avatar-fallback">${escapeHtml(initials)}</span>`;
  return renderImage(athlete.athlete_image_url, "avatar", initials);
}

export function renderAthleteListHtml(athletes, selectedAthleteId) {
  return athletes.map((athlete) => `
    <button class="athlete-button ${athlete.athlete_id === selectedAthleteId ? "is-active" : ""}" data-athlete-id="${escapeAttr(athlete.athlete_id)}">
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
}

export function renderAthleteHeaderToolbarHtml(athlete, { isAthleteMode }) {
  const imageMarkup = athlete.athlete_image_url
    ? renderImage(athlete.athlete_image_url, "athlete-hero-image", initialsFor(athlete.athlete))
    : `<div class="athlete-hero-fallback">${escapeHtml(initialsFor(athlete.athlete))}</div>`;
  const athleteDetailsMarkup = isAthleteMode ? `
    <div class="athlete-hero-copy">
      <p class="eyebrow">My program</p>
      <h3>${escapeHtml(athlete.athlete)}</h3>
    </div>
  ` : "";

  return `
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
}

export function renderAthleteSettingsHtml(athlete) {
  return `
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
