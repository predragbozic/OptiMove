import { canManageCoachProfile } from "./access.js";
import { renderImage } from "./media.js";
import { programPriceLabel, ratingLabel } from "./program-library.js";
import { escapeAttr, escapeHtml, programInitials, renderOption } from "./utils.js";

export function renderCoachesHtml(data) {
  const {
    coaches,
    currentUser,
    programInfo,
    renderProgramInfoModal,
    renderTemplatePreviewModal,
  } = data;
  const rows = coaches.rows || [];
  const ownProfile = rows.find((profile) => String(profile.user_id) === String(currentUser?.id));
  const canEditProfile = canManageCoachProfile(currentUser);
  return `
    <section class="content-section coach-directory">
      <section class="coach-directory-head">
        <div>
          <p class="eyebrow">Expert directory</p>
          <h3>Coach profiles</h3>
          <p class="muted">Profiles can connect programs, specialties, and future marketplace requests.</p>
        </div>
        ${canEditProfile ? `<button class="plain-button compact-button" type="button" data-action="coach-edit-toggle">${ownProfile ? "Edit my profile" : "Create my profile"}</button>` : ""}
      </section>
      ${coaches.error ? `<p class="builder-error">${escapeHtml(coaches.error)}</p>` : ""}
      ${canEditProfile && coaches.editOpen ? renderCoachProfileForm(ownProfile, currentUser) : ""}
      <section class="coach-card-grid">
        ${rows.length ? rows.map(renderCoachCard).join("") : `<div class="empty-state">No visible coach profiles yet.</div>`}
      </section>
    </section>
    ${renderCoachDetailModalHtml(coaches, currentUser)}
    ${renderProgramInfoModal(programInfo)}
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

function renderCoachProfileForm(profile, currentUser) {
  const tags = (profile?.tags || []).map((tag) => tag.name || tag).join(", ");
  return `
    <form class="panel coach-profile-form" data-coach-profile-form>
      <div>
        <p class="eyebrow">My coach profile</p>
        <h4>${escapeHtml(profile?.name || currentUser?.name || "Coach profile")}</h4>
      </div>
      <div class="program-metadata-grid">
        <label class="search-field"><span>Headline</span><input name="headline" value="${escapeAttr(profile?.headline || "")}" placeholder="e.g. Strength and return-to-play coach"></label>
        <label class="search-field"><span>Specialties</span><input name="specialties" value="${escapeAttr(profile?.specialties || "")}" placeholder="Speed, strength, rehab"></label>
        <label class="search-field"><span>Photo URL</span><input name="photoUrl" value="${escapeAttr(profile?.photo_url || "")}" placeholder="https://..."></label>
        <label class="search-field"><span>Cover image URL</span><input name="coverImageUrl" value="${escapeAttr(profile?.cover_image_url || "")}" placeholder="https://..."></label>
        <label class="search-field"><span>Intro video URL</span><input name="videoUrl" value="${escapeAttr(profile?.video_url || "")}" placeholder="https://youtube.com/..."></label>
        <label class="search-field"><span>Contact email</span><input name="contactEmail" value="${escapeAttr(profile?.contact_email || currentUser?.email || "")}"></label>
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

export function renderCoachDetailModalHtml(coaches, currentUser) {
  const detail = coaches.detail;
  const profile = detail?.profile || coaches.rows.find((row) => String(row.id) === String(coaches.selected));
  if (!coaches.selected) return "";
  if (!profile) {
    const title = coaches.error ? "Coach profile unavailable" : "Loading coach profile";
    const message = coaches.error || "Loading coach profile...";
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
        ${profile.cover_image_url ? `<div class="coach-profile-cover">${renderImage(profile.cover_image_url, "coach-profile-cover-image")}</div>` : ""}
        <div class="program-preview-head coach-profile-head">
          <div class="coach-profile-title">
            ${profile.photo_url ? renderImage(profile.photo_url, "coach-profile-photo") : `<span class="coach-card-initials">${escapeHtml(programInitials(profile.name || "Coach"))}</span>`}
            <div>
              <p class="eyebrow">${escapeHtml(profile.visibility || "profile")}</p>
              <h3>${escapeHtml(profile.name || "Coach")}</h3>
              ${profile.headline ? `<p class="muted">${escapeHtml(profile.headline)}</p>` : ""}
            </div>
          </div>
          <div class="builder-source-actions">
            ${profile.video_url ? `<button class="plain-button compact-button" type="button" data-action="open-media" data-title="${escapeAttr(profile.name || "Coach")} - Intro" data-image="${escapeAttr(profile.photo_url || "")}" data-video="${escapeAttr(profile.video_url)}">Watch intro</button>` : ""}
            ${programs.length ? `<button class="plain-button compact-button" type="button" data-action="coach-programs-focus">View programs</button>` : ""}
            ${profile.contact_enabled ? `<button class="plain-button compact-button" type="button" data-action="coach-contact-toggle">${coaches.contactOpen ? "Close contact" : "Contact coach"}</button>` : ""}
            <button class="plain-button icon-button" type="button" data-action="coach-close" aria-label="Close"><span class="button-icon">x</span></button>
          </div>
        </div>
        <div class="coach-profile-body">
          <section class="coach-profile-summary">
            <p class="coach-profile-bio">${escapeHtml(profile.bio || "No profile description yet.")}</p>
            ${profile.specialties ? `<p class="coach-profile-specialties"><strong>Specialties:</strong> ${escapeHtml(profile.specialties)}</p>` : ""}
            <p class="rating-line">${escapeHtml(ratingLabel(profile))}</p>
            <div class="coach-tag-row">${(profile.tags || []).map((tag) => `<span>${escapeHtml(tag.name || tag)}</span>`).join("")}</div>
            ${profile.club_names ? `<p class="muted">${escapeHtml(profile.club_names)}</p>` : ""}
          </section>
          ${coaches.contactOpen ? renderCoachContactForm(profile, currentUser) : ""}
          <section data-coach-programs>
            <div class="program-library-shelf-head"><h4>Published programs</h4><span>${programs.length} ${programs.length === 1 ? "program" : "programs"}</span></div>
            <div class="program-library-row">
              ${detail ? programs.length ? programs.map(renderCoachProgramCard).join("") : `<div class="empty-state">No visible programs from this coach yet.</div>` : `<div class="empty-state">Loading programs...</div>`}
            </div>
          </section>
        </div>
      </section>
    </div>
  `;
}

function renderCoachContactForm(profile, currentUser) {
  return `
    <form class="panel coach-contact-form" data-coach-contact-form data-profile-id="${escapeAttr(profile.id)}">
      <label class="search-field"><span>Your name</span><input name="name" value="${escapeAttr(currentUser?.name || "")}"></label>
      <label class="search-field"><span>Your email</span><input name="email" value="${escapeAttr(currentUser?.email || "")}"></label>
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
