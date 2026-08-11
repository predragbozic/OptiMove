import { renderImage } from "./media.js";
import { ICON_ADD_ATHLETE } from "./organization-view.js";
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
      ${!isAthleteMode ? `<button class="plain-button icon-button athlete-toolbar-add-button" type="button" data-action="home-add-athlete" aria-label="Add athlete" title="Add athlete">${ICON_ADD_ATHLETE}</button>` : ""}
    </div>
  `;
}

// security/verified-email-change: the old combined "Login and password"
// form let a typo'd or someone-else's email become the account's login
// identity on nothing more than the CURRENT password - proof of owning the
// old account, not proof of controlling the new address. Login email and
// password are now two separate forms/flows: changing the login email
// always requires confirming a link sent to the NEW address before
// anything changes (see data-account-form="email-change-request" below and
// POST /api/auth/account/email-change/request), and changing the password
// (data-account-form="password-change") can never touch the email, even via
// a hand-crafted request - see PUT /api/auth/me/credentials's own
// enforcement in backend/src/routes/auth.js.
//
// emailChangeStatus is either null (no pending request - render the
// request form) or { newEmail, expiresAt, requestSource } from
// GET /api/auth/account/email-change/status - the caller
// (renderAthleteSettings in app.js) fetches this after the initial render
// and re-renders with it, mirroring how every other async-status panel in
// this app is patched in.
// feature/athlete-programs-profile: profile is null while GET
// /api/athlete-profile is still loading, { error: true } if it failed, or
// { firstName, lastName, imageUrl } once loaded - the exact same
// null -> loaded two-pass pattern renderAthleteSettings() already uses for
// emailChangeStatus below. Only these 3 fields are ever shown/editable
// here - see backend/src/routes/athleteProfile.js's own header comment for
// exactly which real athletes.* columns were audited and excluded (no
// birth_date/phone/gender/address - confirmed zero consumers anywhere in
// the app today).
export function renderAthleteSettingsHtml(athlete, currentUser, emailChangeStatus, profile) {
  return `
    <section class="content-section athlete-simple-view">
      <section class="panel athlete-settings-card">
        <div>
          <p class="eyebrow">Profile</p>
          <h3>${escapeHtml(athlete?.athlete || "Athlete profile")}</h3>
          <p class="muted">Your coach controls program assignment and club/team membership - only your own basic profile fields below are yours to edit.</p>
        </div>
        <div class="athlete-setting-list">
          <article class="athlete-personal-data">
            <strong>Personal data</strong>
            ${renderPersonalDataFormHtml(profile)}
          </article>
          <article>
            <strong>Notifications</strong>
            <span>Future reminders for programs, wellness, and testing.</span>
          </article>
        </div>
      </section>
      <section class="panel athlete-settings-card">
        <div>
          <p class="eyebrow">Account</p>
          <h3>Login email</h3>
          <p class="muted">The email you use to sign in. Changing it requires confirming the new address before it takes effect.</p>
        </div>
        <p class="account-current-email"><span>Current login email</span> <strong>${escapeHtml(currentUser?.email || "")}</strong></p>
        ${renderEmailChangeStatusHtml(emailChangeStatus)}
      </section>
      <section class="panel athlete-settings-card">
        <div>
          <p class="eyebrow">Account</p>
          <h3>Change password</h3>
          <p class="muted">Change the password you use to sign in. This never changes your login email.</p>
        </div>
        <form class="organization-form" data-account-form="password-change">
          <label class="search-field"><span>Current password</span><input name="currentPassword" type="password" required placeholder="Confirm with your current password" autocomplete="current-password"></label>
          <label class="search-field"><span>New password</span><input name="newPassword" type="password" required minlength="8" placeholder="At least 8 characters" autocomplete="new-password"></label>
          <label class="search-field"><span>Confirm new password</span><input name="confirmNewPassword" type="password" required minlength="8" autocomplete="new-password"></label>
          <p class="builder-error" aria-live="polite"></p>
          <p class="builder-success" aria-live="polite"></p>
          <button class="plain-button" type="submit">Change password</button>
        </form>
      </section>
    </section>
  `;
}

function renderPersonalDataFormHtml(profile) {
  if (!profile) {
    return `<span class="muted">Loading your profile...</span>`;
  }
  if (profile.error) {
    return `<span class="muted">Could not load your profile. Try reopening Settings.</span>`;
  }
  const initials = initialsFor([profile.firstName, profile.lastName].filter(Boolean).join(" ") || "Athlete");
  const preview = profile.imageUrl
    ? renderImage(profile.imageUrl, "avatar athlete-personal-data-preview", initials)
    : `<span class="avatar-fallback athlete-personal-data-preview">${escapeHtml(initials)}</span>`;
  return `
    <form class="organization-form athlete-personal-data-form" data-account-form="personal-data">
      <div class="athlete-personal-data-preview-row">${preview}</div>
      <label class="search-field"><span>First name</span><input name="firstName" required maxlength="100" value="${escapeAttr(profile.firstName)}" autocomplete="given-name"></label>
      <label class="search-field"><span>Last name</span><input name="lastName" maxlength="100" value="${escapeAttr(profile.lastName)}" autocomplete="family-name"></label>
      <label class="search-field"><span>Date of birth</span><input name="birthDate" type="date" max="${escapeAttr(todayIsoUtc())}" value="${escapeAttr(profile.birthDate)}"></label>
      <label class="search-field"><span>Phone</span><input name="phone" type="tel" maxlength="50" value="${escapeAttr(profile.phone)}" autocomplete="tel"></label>
      <label class="search-field"><span>Country</span><input name="country" maxlength="100" value="${escapeAttr(profile.country)}" autocomplete="country-name"></label>
      <label class="search-field"><span>City</span><input name="city" maxlength="100" value="${escapeAttr(profile.city)}" autocomplete="address-level2"></label>
      <label class="search-field">
        <span>Profile photo URL</span>
        <input name="imageUrl" type="url" maxlength="2000" placeholder="https://..." value="${escapeAttr(profile.imageUrl)}">
      </label>
      <p class="muted athlete-personal-data-photo-hint">Paste a link to an image - there's no photo upload yet.</p>
      <p class="builder-error" aria-live="polite"></p>
      <p class="builder-success" aria-live="polite"></p>
      <button class="plain-button" type="submit">Save personal data</button>
    </form>
  `;
}

function todayIsoUtc() {
  return new Date().toISOString().slice(0, 10);
}

function renderEmailChangeStatusHtml(status) {
  if (status?.pending) {
    return `
      <div class="account-email-pending" role="status">
        <p class="builder-success">Your login email has not changed yet. Confirm the link sent to <strong>${escapeHtml(status.newEmail || "")}</strong> to finish - it expires ${escapeHtml(formatExpiryLabel(status.expiresAt))}.</p>
        <div class="account-email-pending-actions">
          <button class="text-action" type="button" data-action="email-change-resend">Resend</button>
          <button class="text-action danger-action" type="button" data-action="email-change-cancel">Cancel request</button>
        </div>
        <p class="builder-error" aria-live="polite" data-role="email-change-pending-error"></p>
      </div>
    `;
  }
  return `
    <form class="organization-form" data-account-form="email-change-request">
      <label class="search-field"><span>New login email</span><input name="newEmail" type="email" required autocomplete="off"></label>
      <label class="search-field"><span>Current password</span><input name="currentPassword" type="password" required placeholder="Confirm with your current password" autocomplete="current-password"></label>
      <p class="builder-error" aria-live="polite"></p>
      <p class="builder-success" aria-live="polite"></p>
      <button class="plain-button" type="submit">Send verification link</button>
    </form>
  `;
}

function formatExpiryLabel(expiresAt) {
  if (!expiresAt) return "soon";
  try {
    return new Date(expiresAt).toLocaleString(undefined, { hour: "numeric", minute: "2-digit", month: "short", day: "numeric" });
  } catch {
    return "soon";
  }
}
