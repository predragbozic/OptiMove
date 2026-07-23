import { renderImage } from "./media.js";
import { templateAccessActionLabel, templateAccessHelperText, templateAccessStatusCode, templateAccessStatusLabel } from "./program-access-ui.js";
import { inferProgramCategory, programPriceLabel, ratingLabel, templateCategoryLabel } from "./program-library.js";
import { clean, escapeAttr, escapeHtml, programInitials, renderOption } from "./utils.js";

export function renderTemplatePreviewModalHtml(data) {
  const {
    currentUserRole,
    detail,
    groups,
    isMicrocycle,
    preview,
    athletes,
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
            ${selected && currentUserRole !== "athlete" ? `<button class="plain-button compact-button" type="button" data-action="template-settings-toggle">${preview.settingsOpen ? "Hide settings" : "Library settings"}</button>` : ""}
            ${selected && currentUserRole !== "athlete" ? renderPlanMoreMenu(selected.plan_id, "template") : ""}
            <button class="plain-button icon-button" type="button" data-action="template-close" aria-label="Close"><span class="button-icon">x</span></button>
          </div>
        </div>
        ${selected && preview.settingsOpen ? renderTemplateMetadataForm(selected, templateOptions, programTagEditor, currentUserRole) : ""}
        ${selected && preview.assignOpen && currentUserRole !== "athlete" ? renderTemplateAssignmentPanel(selected, preview, athletes || []) : ""}
        ${selected && !preview.loading ? renderTemplateReviewPanel(selected, preview, currentUserRole) : ""}
        <div class="program-preview-body">
          ${preview.loading ? `<div class="empty-state">Loading program...</div>` : preview.error ? `<div class="empty-state">${escapeHtml(preview.error)}</div>` : isMicrocycle
            ? `<div class="node-grid">${groups.map(renderNodeButton).join("")}</div>`
            : `<div class="program-day-grid">${groups.map(renderProgramDayCard).join("")}</div>`}
        </div>
      </section>
    </div>
  `;
}

function renderTemplateAssignmentPanel(template, preview, athletes) {
  const selectedIds = new Set((preview.assignedAthleteIds || []).map(String));
  const visibleAthletes = athletes || [];
  const visibleAthleteIds = visibleAthletes.map(assignmentAthleteId).filter(Boolean);
  const allVisibleSelected = visibleAthleteIds.length > 0 && visibleAthleteIds.every((athleteId) => selectedIds.has(String(athleteId)));
  return `
    <section class="program-review-panel program-assignment-panel">
      <div class="program-review-summary">
        <div>
          <span class="eyebrow">Assign program access</span>
          <p class="muted">Grant this library program to selected athletes without creating an editable copy.</p>
        </div>
        <div class="program-review-actions">
          <button class="checkbox-toggle-all ${allVisibleSelected ? "is-checked" : ""}" type="button" data-action="template-assign-toggle-all" aria-label="${allVisibleSelected ? "Uncheck all athletes" : "Check all athletes"}" ${preview.assigning || !visibleAthleteIds.length ? "disabled" : ""}>
            <span aria-hidden="true">${allVisibleSelected ? "&#10003;" : ""}</span>
          </button>
          <button class="plain-button compact-button" type="button" data-action="template-assign-submit" data-template-id="${escapeAttr(template.plan_id)}" ${preview.assigning || !selectedIds.size ? "disabled" : ""}>${preview.assigning ? "Assigning..." : "Grant access"}</button>
        </div>
      </div>
      ${preview.assignMessage ? `<p class="builder-success">${escapeHtml(preview.assignMessage)}</p>` : ""}
      ${preview.assignError ? `<p class="builder-error">${escapeHtml(preview.assignError)}</p>` : ""}
      ${visibleAthletes.length ? `
        <div class="program-assignment-list">
          ${visibleAthletes.map((athlete) => renderTemplateAssignmentAthlete(athlete, selectedIds)).join("")}
        </div>
      ` : `<p class="muted">No athletes available for assignment.</p>`}
    </section>
  `;
}

function assignmentAthleteId(athlete) {
  return String(athlete?.athlete_uuid || athlete?.id || athlete?.athlete_id || "");
}

function renderTemplateAssignmentAthlete(athlete, selectedIds) {
  const athleteId = assignmentAthleteId(athlete);
  const selected = selectedIds.has(String(athleteId));
  const image = athlete.athlete_image_url || athlete.image_url || "";
  const name = athlete.athlete || athlete.name || athlete.athlete_name || "Athlete";
  const code = athlete.athlete_id || athlete.source_external_id || "";
  return `
    <button class="program-assignment-athlete ${selected ? "is-selected" : ""}" type="button" data-action="template-assign-toggle-athlete" data-athlete-id="${escapeAttr(athleteId)}">
      <span class="program-assignment-check" aria-hidden="true">${selected ? "&#10003;" : ""}</span>
      ${image ? renderImage(image, "program-assignment-athlete-image") : `<span class="program-assignment-athlete-fallback">${escapeHtml(programInitials(name))}</span>`}
      <span><strong>${escapeHtml(name)}</strong>${code ? `<small>ID ${escapeHtml(code)}</small>` : ""}</span>
    </button>
  `;
}

function renderTemplateReviewPanel(template, review, currentUserRole) {
  if (currentUserRole !== "athlete") return renderTemplateAccessRequestPanel(review);
  const reviews = review.reviews || [];
  const accessStatus = templateAccessStatusCode(template);
  const isRequested = review.requestSent || accessStatus === "requested";
  const isUsed = review.usedMarked || accessStatus === "used" || accessStatus === "completed";
  const isApproved = accessStatus === "accessed";
  const statusLabel = templateAccessStatusLabel(template);
  const primaryLabel = review.submittingUse ? "Saving..." : templateAccessActionLabel(template, { accessScope: "athlete" });
  const helperText = templateAccessHelperText(template, review);
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

function renderTemplateAccessRequestPanel(review) {
  const requests = review.accessRequests || [];
  const pendingRequests = requests.filter((request) => templateAccessStatusCode(request) === "requested");
  const activeRequests = requests.filter((request) => ["accessed", "used", "completed"].includes(templateAccessStatusCode(request)));
  const pendingIds = pendingRequests.map((request) => request.id).filter(Boolean).join(",");
  return `
    <section class="program-review-panel program-access-request-panel">
      <div class="program-review-summary">
        <div>
          <span class="eyebrow">Program access</span>
          <p class="muted">${requests.length ? "Review requested, approved, and rejected access for this program." : "No athlete access activity for this program."}</p>
        </div>
        <div class="program-review-actions">
          <span class="item-badge">${escapeHtml(`${pendingRequests.length} pending`)}</span>
          <span class="item-badge">${escapeHtml(`${activeRequests.length} active`)}</span>
          ${pendingRequests.length ? `
            <button class="plain-button compact-button" type="button" data-action="template-access-bulk" data-access-action="approve" data-access-ids="${escapeAttr(pendingIds)}" ${review.submittingAccessBulk ? "disabled" : ""}>Approve all</button>
            <button class="plain-button compact-button danger-button" type="button" data-action="template-access-bulk" data-access-action="reject" data-access-ids="${escapeAttr(pendingIds)}" ${review.submittingAccessBulk ? "disabled" : ""}>Reject all</button>
          ` : ""}
          <button class="plain-button compact-button" type="button" data-action="template-reviews-toggle">${review.reviewsOpen ? "Hide reviews" : `Reviews (${(review.reviews || []).length})`}</button>
        </div>
      </div>
      ${review.reviewMessage ? `<p class="builder-success">${escapeHtml(review.reviewMessage)}</p>` : ""}
      ${review.accessRequestError ? `<p class="builder-error">${escapeHtml(review.accessRequestError)}</p>` : ""}
      ${requests.length ? `
        <div class="program-access-request-list">
          ${requests.map((request) => renderTemplateAccessRequestRow(request, review.submittingAccessId)).join("")}
        </div>
      ` : ""}
      ${review.reviewsOpen ? renderTemplateReviewList(review.reviews || []) : ""}
    </section>
  `;
}

function renderTemplateAccessRequestRow(request, submittingAccessId) {
  const date = request.created_at ? new Date(request.created_at).toLocaleDateString("en-GB") : "";
  const isSubmitting = String(submittingAccessId || "") === String(request.id);
  const statusCode = templateAccessStatusCode(request);
  const isPending = statusCode === "requested";
  const isActive = ["accessed", "used", "completed"].includes(statusCode);
  return `
    <article class="program-access-request-row">
      <div>
        <strong>${escapeHtml(request.athlete_name || "Athlete")}</strong>
        <small>${escapeHtml([request.athlete_code ? `ID ${request.athlete_code}` : "", date].filter(Boolean).join(" - "))}</small>
      </div>
      <div class="program-review-actions">
        <span class="item-badge">${escapeHtml(templateAccessStatusLabel(request))}</span>
        ${isPending ? `
          <button class="plain-button compact-button" type="button" data-action="template-access-approve" data-access-id="${escapeAttr(request.id)}" ${isSubmitting ? "disabled" : ""}>${isSubmitting ? "Saving..." : "Approve"}</button>
          <button class="plain-button compact-button danger-button" type="button" data-action="template-access-reject" data-access-id="${escapeAttr(request.id)}" ${isSubmitting ? "disabled" : ""}>Reject</button>
        ` : ""}
        ${isActive ? `<button class="plain-button compact-button danger-button" type="button" data-action="template-access-revoke" data-access-id="${escapeAttr(request.id)}" ${isSubmitting ? "disabled" : ""}>Remove access</button>` : ""}
      </div>
    </article>
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

function renderTemplateMetadataForm(template, templateOptions, programTagEditor, currentUserRole) {
  const price = template.price_cents ? Number(template.price_cents) / 100 : "";
  const isFree = template.is_free !== false;
  const programGroup = template.library_category || inferProgramCategory(template) || "General";
  const accessModel = template.access_model || (isFree ? "free_forever" : "one_time_forever");
  const programStatus = programStatusForForm(template.status);
  const currentLibraryScope = clean(template.library_scope || "my").toLowerCase();
  const allowedLibraryScopes = templateLibraryScopesForRole(currentUserRole);
  const canEditCurrentScope = allowedLibraryScopes.some((scope) => scope.value === currentLibraryScope);
  const selectedLibraryScope = canEditCurrentScope ? currentLibraryScope : "my";
  const blockedShelfNotice = canEditCurrentScope ? "" : `
    <p class="muted small">This program is currently in ${escapeHtml(labelForLibraryScope(currentLibraryScope))}. Save it to My Programs or ask an admin to edit that shelf.</p>
  `;
  const derivedOwner = ownerLabelForLibraryScope(template.library_scope || "my");
  const derivedAudience = visibilityLabelForLibraryScope(template.library_scope || "my");
  return `
    <form class="program-metadata-form" data-template-metadata-form data-plan-id="${escapeAttr(template.plan_id)}">
      <div class="program-metadata-grid">
        <label class="search-field"><span>Library shelf</span><select name="libraryScope">
          ${allowedLibraryScopes.map((scope) => renderOption(scope.value, scope.label, selectedLibraryScope)).join("")}
        </select></label>
        <label class="search-field"><span>Program status</span><select name="programStatus">
          ${renderOption("draft", "Draft", programStatus)}
          ${renderOption("active", "Published", programStatus)}
          ${renderOption("archived", "Archived", programStatus)}
        </select></label>
        <label class="search-field"><span>Program group</span><input name="libraryCategory" list="program-settings-group-options" value="${escapeAttr(programGroup)}" placeholder="e.g. Rehabilitation"></label>
        <label class="search-field"><span>Cover image URL</span><input name="coverImageUrl" type="url" value="${escapeAttr(template.cover_image_url || "")}" placeholder="https://..."></label>
        <label class="search-field"><span>Audience</span><input value="${escapeAttr(derivedAudience)}" readonly></label>
        <label class="search-field"><span>Owner scope</span><input value="${escapeAttr(derivedOwner)}" readonly></label>
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
      <label class="search-field"><span>Description</span><textarea name="description" rows="3" placeholder="What is this program about? Shown to coaches and athletes in the program information popup.">${escapeHtml(template.description || "")}</textarea></label>
      ${blockedShelfNotice}
      ${renderProgramInlineTags(template, templateOptions, programTagEditor)}
      <div class="program-metadata-actions">
        <p class="builder-error" aria-live="polite"></p>
        <button class="plain-button compact-button" type="submit">Save library settings</button>
      </div>
    </form>
  `;
}

function templateLibraryScopesForRole(role) {
  const normalizedRole = clean(role).toLowerCase();
  const base = [
    ["workspace", "Draft / working material"],
    ["my", "My Programs"],
  ];
  const canUseTeam = ["team_coach", "team_trainer", "team_admin", "club_admin", "platform_admin", "admin"].includes(normalizedRole);
  const canUseClub = ["club_admin", "platform_admin", "admin"].includes(normalizedRole);
  const canUsePlatform = ["platform_admin", "admin"].includes(normalizedRole);
  if (canUseTeam) base.push(["team", "Team programs"]);
  if (canUseClub) base.push(["club", "Club programs"]);
  if (canUsePlatform) {
    base.push(["optimove", "OptiMove"]);
    base.push(["marketplace", "Marketplace"]);
  }
  return base.map(([value, label]) => ({ value, label }));
}

function ownerLabelForLibraryScope(scope) {
  const normalized = clean(scope).toLowerCase();
  if (normalized === "team") return "Team";
  if (normalized === "club") return "Club";
  if (normalized === "optimove") return "OptiMove";
  if (normalized === "marketplace") return "Marketplace";
  return "Coach";
}

function visibilityLabelForLibraryScope(scope) {
  const normalized = clean(scope).toLowerCase();
  if (normalized === "team") return "Team visible";
  if (normalized === "club") return "Club visible";
  if (normalized === "optimove" || normalized === "marketplace") return "Platform visible";
  return "Private";
}

function labelForLibraryScope(scope) {
  return {
    workspace: "Draft / working material",
    my: "My Programs",
    team: "Team programs",
    club: "Club programs",
    optimove: "OptiMove",
    marketplace: "Marketplace",
  }[scope] || scope;
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

function programStatusForForm(status) {
  const normalized = clean(status).toLowerCase();
  if (normalized === "published" || normalized === "active") return "active";
  if (normalized === "archived") return "archived";
  return "draft";
}
