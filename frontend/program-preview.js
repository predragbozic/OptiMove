import { renderImage } from "./media.js";
import { inferProgramCategory, programPriceLabel, ratingLabel, templateAccessStatusLabel, templateCategoryLabel } from "./program-library.js";
import { clean, escapeAttr, escapeHtml, programInitials, renderOption } from "./utils.js";

export function renderTemplatePreviewModalHtml(data) {
  const {
    currentUserRole,
    detail,
    groups,
    isMicrocycle,
    preview,
    programTagEditor,
    renderNodeButton,
    renderPlanMoreMenu,
    renderProgramDayCard,
    selected,
    templateOptions,
  } = data;
  if (!preview?.open) return "";
  const selectedMeta = selected ? [templateCategoryLabel(selected), programPriceLabel(selected)].filter(Boolean).join(" - ") : "Program template";
  const creatorName = clean(selected?.creator_name);
  const creatorProfileId = clean(selected?.creator_profile_id);
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
            ${preview.loading ? `<span class="item-badge">Loading</span>` : ""}
            ${selected ? `<span class="item-badge">${escapeHtml(ratingLabel(selected))}</span>` : ""}
            ${selected && currentUserRole !== "athlete" && selected.can_assign_to_athlete !== false ? `<button class="plain-button compact-button" type="button" data-action="template-assign" data-template-id="${escapeAttr(selected.plan_id)}">Assign</button>` : ""}
            ${selected ? `<button class="plain-button compact-button" type="button" data-action="template-settings-toggle">${preview.settingsOpen ? "Hide settings" : "Library settings"}</button>` : ""}
            ${selected ? renderPlanMoreMenu(selected.plan_id, "template") : ""}
            <button class="plain-button icon-button" type="button" data-action="template-close" aria-label="Close"><span class="button-icon">x</span></button>
          </div>
        </div>
        ${selected && preview.settingsOpen ? renderTemplateMetadataForm(selected, templateOptions, programTagEditor) : ""}
        ${selected && !preview.loading && !preview.error ? renderTemplateReviewPanel(selected, preview, currentUserRole) : ""}
        <div class="program-preview-body">
          ${preview.loading ? `<div class="empty-state">Loading program...</div>` : preview.error ? `<div class="empty-state">${escapeHtml(preview.error)}</div>` : isMicrocycle
            ? `<div class="node-grid">${groups.map(renderNodeButton).join("")}</div>`
            : `<div class="program-day-grid">${groups.map(renderProgramDayCard).join("")}</div>`}
        </div>
      </section>
    </div>
  `;
}

function renderTemplateReviewPanel(template, review, currentUserRole) {
  const reviews = review.reviews || [];
  const accessStatus = clean(template.user_access_status).toLowerCase();
  const isRequested = review.requestSent || accessStatus === "requested";
  const isUsed = review.usedMarked || accessStatus === "used" || accessStatus === "completed";
  const isApproved = accessStatus === "accessed";
  const hasActiveAccess = isApproved || isUsed;
  const requiresApproval = currentUserRole === "athlete" && template.requires_approval === true && !hasActiveAccess;
  const statusLabel = templateAccessStatusLabel(template);
  const primaryLabel = review.submittingUse
    ? "Saving..."
    : isRequested
      ? "Request sent"
      : isApproved
        ? "Mark as used"
        : isUsed
        ? "Access active"
        : requiresApproval
          ? "Request access"
          : "Get access";
  const helperText = isRequested
    ? "Your request is waiting for coach approval."
    : isApproved
      ? "Access is approved. Mark it as used when you start working with this program."
      : requiresApproval
        ? "Your coach must approve this program before it becomes active."
        : "Reviews are enabled after access is active and the program has been used.";
  return `
    <section class="program-review-panel">
      <div class="program-review-summary">
        <div>
          <span class="eyebrow">Verified program review</span>
          <p class="muted">${escapeHtml(helperText)}${statusLabel ? ` <strong>${escapeHtml(statusLabel)}</strong>` : ""}</p>
        </div>
        <div class="program-review-actions">
          <button class="plain-button compact-button" type="button" data-action="template-use" data-template-id="${escapeAttr(template.plan_id)}" ${review.submittingUse || isRequested || isUsed ? "disabled" : ""}>${primaryLabel}</button>
          ${isUsed ? `<button class="plain-button compact-button" type="button" data-action="template-review-toggle">${review.reviewOpen ? "Hide review" : "Leave review"}</button>` : `<button class="plain-button compact-button" type="button" disabled>Review after use</button>`}
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

function renderTemplateMetadataForm(template, templateOptions, programTagEditor) {
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
        ${(templateOptions?.categories || []).map((category) => `<option value="${escapeAttr(category)}"></option>`).join("")}
      </datalist>
      ${renderProgramInlineTags(template, templateOptions, programTagEditor)}
      <div class="program-metadata-actions">
        <p class="builder-error" aria-live="polite"></p>
        <button class="plain-button compact-button" type="submit">Save library settings</button>
      </div>
    </form>
  `;
}

function renderProgramInlineTags(template, templateOptions, programTagEditor) {
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
      ${programTagEditor?.error && String(programTagEditor.planId) === String(template.plan_id) ? `<p class="builder-error">${escapeHtml(programTagEditor.error)}</p>` : ""}
      <div class="program-inline-tag-form">
        <label class="search-field">
          <span>Add tag</span>
          <input data-program-tag-input="${escapeAttr(template.plan_id)}" list="${escapeAttr(datalistId)}" placeholder="Type tag name">
          <datalist id="${escapeAttr(datalistId)}">
            ${(templateOptions?.tags || []).map((tag) => `<option value="${escapeAttr(tag)}"></option>`).join("")}
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
