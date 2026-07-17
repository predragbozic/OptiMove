import { renderImage } from "./media.js";
import { hasTemplateAccessStatus, templateAccessActionLabel, templateAccessBadge } from "./program-access-ui.js";
import { clean, escapeAttr, escapeHtml, programInitials, renderOption } from "./utils.js";

const PROGRAM_CATEGORY_DEFAULTS = ["General", "Rehabilitation", "Strength & power", "Speed & conditioning", "Movement prep", "Corrective & preventive", "Fitness & health", "Education"];
const PROGRAM_LIFECYCLE_OPTIONS = [
  ["draft", "Draft"],
  ["published_private", "Published private"],
  ["assigned", "Assigned"],
  ["team_shared", "Team shared"],
  ["club_shared", "Club shared"],
  ["archived", "Archived"],
];

export function duplicateTemplateNames(templates) {
  const counts = new Map();
  templates.forEach((template) => {
    const name = clean(template.plan_name);
    if (!name) return;
    counts.set(name, (counts.get(name) || 0) + 1);
  });
  return new Set([...counts].filter(([, count]) => count > 1).map(([name]) => name));
}

export function templateSecondaryLabel() {
  return "";
}

export function templateCategoryLabel(template) {
  return clean(template.library_category) || inferProgramCategory(template) || "General";
}

export function inferProgramCategory(template) {
  const text = `${template.plan_name || ""} ${template.source_external_id || ""}`.toLowerCase();
  if (/(rehab|rechab|rtp|return|injury|pain|calf|groin|neck)/.test(text)) return "Rehabilitation";
  if (/(strength|strenght|power|gym|core|legs|arms)/.test(text)) return "Strength & power";
  if (/(speed|sprint|acceleration|deceleration|running)/.test(text)) return "Speed & conditioning";
  if (/(mobility|stability|activation|warm)/.test(text)) return "Movement prep";
  return "";
}

export function programPriceLabel(template) {
  const accessModel = template.access_model || (template.is_free === false ? "one_time_forever" : "free_forever");
  const durationDays = Number(template.access_duration_days || 0);
  if (template.is_free === false) {
    const price = template.price_cents ? `${Math.round(template.price_cents / 100)} EUR` : "Paid";
    if (accessModel === "subscription") return `${price} / ${template.subscription_period || "month"}`;
    if (durationDays) return `${price} - ${durationDays} days`;
    return price;
  }
  if (accessModel === "trial") return durationDays ? `Free trial - ${durationDays} days` : "Free trial";
  if (accessModel === "time_limited") return durationDays ? `Free - ${durationDays} days` : "Time-limited";
  if (accessModel === "assigned") return "Assigned";
  return "Free";
}

export function programLifecycle(template) {
  const status = clean(template.status).toLowerCase();
  const scope = clean(template.library_scope).toLowerCase();
  const visibility = clean(template.visibility).toLowerCase();
  const assignedCount = Number(template.assigned_count || 0);
  const userAccessStatus = clean(template.user_access_status).toLowerCase();
  if (status === "archived" || template.is_active === false) return { code: "archived", label: "Archived" };
  if (status === "draft" || scope === "workspace") return { code: "draft", label: "Draft" };
  if (assignedCount > 0 || ["accessed", "used", "completed"].includes(userAccessStatus)) return { code: "assigned", label: "Assigned" };
  if (visibility === "team") return { code: "team_shared", label: "Team shared" };
  if (visibility === "club") return { code: "club_shared", label: "Club shared" };
  if (visibility === "private") return { code: "published_private", label: "Published private" };
  return { code: "published_private", label: "Published private" };
}

export function ratingLabel(entity) {
  const count = Number(entity?.review_count || 0);
  if (!count) return "No reviews yet";
  const average = Number(entity?.average_rating || 0);
  return `${average.toFixed(average % 1 ? 1 : 0)} / 5 (${count})`;
}

export function applyTemplateAccessScope(templates, scope, user) {
  const accessScope = clean(user?.accessScope).toLowerCase();
  if (accessScope !== "athlete" || scope !== "all") return templates;
  return templates.filter(hasTemplateAccessStatus);
}

export function programInfoModel(program) {
  const tags = (program.tags || []).map((tag) => clean(tag.name)).filter(Boolean);
  return {
    title: program.plan_name || "Program",
    group: templateCategoryLabel(program),
    creator: clean(program.creator_name),
    description: clean(program.description || program.program_note || program.short_note || program.note),
    price: programPriceLabel(program),
    tags,
  };
}

export function renderProgramLibraryCard(template, duplicateNames, selectedTemplateId, currentUser) {
  const category = templateCategoryLabel(template);
  const creator = clean(template.creator_name);
  const creatorProfileId = clean(template.creator_profile_id);
  const isSelected = String(template.plan_id) === String(selectedTemplateId);
  const price = programPriceLabel(template);
  const lifecycle = programLifecycle(template);
  const actionLabel = templateAccessActionLabel(template, currentUser);
  const accessBadge = templateAccessBadge(template, currentUser);
  const hasPendingRequests = Number(template.pending_access_count || 0) > 0;
  return `
    <article class="program-library-card ${isSelected ? "is-selected" : ""} ${hasPendingRequests ? "has-pending-requests" : ""}">
      <button class="program-library-info-button" type="button" data-action="template-info" data-template-id="${escapeAttr(template.plan_id)}" aria-label="Program information">i</button>
      <button class="program-library-card-hit" type="button" data-action="template-open" data-template-id="${escapeAttr(template.plan_id)}">
        <span class="program-library-card-media">
          ${template.cover_image_url ? renderImage(template.cover_image_url, "program-library-cover") : `<span class="program-library-card-icon">${escapeHtml(programInitials(template.plan_name))}</span>`}
        </span>
        <span class="program-library-card-body">
          <span class="program-library-card-title">${escapeHtml(template.plan_name || "Untitled program")}</span>
          <span class="program-library-card-sub">${escapeHtml(category)}</span>
        </span>
        <span class="program-library-card-foot">
          <span class="item-badge">${escapeHtml(price)}</span>
          <span class="item-badge program-lifecycle-badge is-${escapeAttr(lifecycle.code)}">${escapeHtml(lifecycle.label)}</span>
          ${accessBadge ? `<span class="item-badge program-access-badge is-${escapeAttr(accessBadge.code)}">${escapeHtml(accessBadge.label)}</span>` : ""}
          <span class="item-badge">${escapeHtml(ratingLabel(template))}</span>
          ${(template.tags || []).length ? `<span class="item-badge">${escapeHtml(template.tags[0].name)}${template.tags.length > 1 ? ` +${template.tags.length - 1}` : ""}</span>` : ""}
          <span class="text-action">${escapeHtml(actionLabel)}</span>
        </span>
      </button>
      ${creator ? `
        <button class="program-library-creator" type="button" ${creatorProfileId ? `data-action="coach-open" data-profile-id="${escapeAttr(creatorProfileId)}"` : "disabled"}>
          ${template.creator_photo_url ? renderImage(template.creator_photo_url, "program-library-creator-photo") : `<span class="program-library-creator-initials">${escapeHtml(programInitials(creator))}</span>`}
          <span><small>Created by</small><strong>${escapeHtml(creator)}</strong></span>
        </button>
      ` : ""}
    </article>
  `;
}

export function renderTemplateLibraryResultsHtml(templates, selectedTemplateId, currentUser = null) {
  const duplicateNames = duplicateTemplateNames(templates);
  const shelves = groupTemplatesByCategory(templates);
  if (!templates.length) return `<div class="empty-state">No programs match these filters.</div>`;
  return shelves.map((shelf) => `
    <section class="program-library-shelf" aria-label="${escapeAttr(shelf.label)}">
      <div class="program-library-shelf-head">
        <h4>${escapeHtml(shelf.label)}</h4>
        <span>${shelf.templates.length} ${shelf.templates.length === 1 ? "program" : "programs"}</span>
      </div>
      <div class="program-library-row">
        ${shelf.templates.map((template) => renderProgramLibraryCard(template, duplicateNames, selectedTemplateId, currentUser)).join("")}
      </div>
    </section>
  `).join("");
}

export function groupTemplatesByCategory(templates) {
  const groups = new Map();
  templates.forEach((template) => {
    const category = templateCategoryLabel(template);
    if (!groups.has(category)) groups.set(category, []);
    groups.get(category).push(template);
  });
  return [...groups.entries()].map(([label, rows]) => ({ label, templates: rows }));
}

export function templateFilterOptionMatches(value, prefix) {
  const normalized = String(value || "").toLowerCase();
  return normalized.includes(prefix) || normalized.split(/[\s&/,-]+/).some((part) => part.startsWith(prefix));
}

export function templateCategoryOptions(templateOptions, templates) {
  const assigned = templateOptions?.categories || [];
  const inferred = (templates || []).map(templateCategoryLabel).filter(Boolean);
  return [...new Set([...PROGRAM_CATEGORY_DEFAULTS, ...assigned, ...inferred])].sort((a, b) => a.localeCompare(b));
}

export function templateFilterSuggestions(filter, templateOptions, templates) {
  if (filter === "category") return templateCategoryOptions(templateOptions, templates);
  if (filter === "tag") return templateOptions?.tags || [];
  if (filter === "creator") {
    return (templateOptions?.creators || [])
      .map((row) => clean(`${row.name || ""}${row.email ? ` - ${row.email}` : ""}`))
      .filter(Boolean);
  }
  if (filter === "club") return (templateOptions?.clubs || []).map((row) => row.name).filter(Boolean);
  return [];
}

export function applyTemplateClientFilters(templates, filters) {
  const search = clean(filters.search).toLowerCase();
  const category = clean(filters.category);
  const categoryNeedle = category.toLowerCase();
  const tag = clean(filters.tag).toLowerCase();
  const creator = clean(filters.creator).toLowerCase();
  const club = clean(filters.club).toLowerCase();
  const ownerType = clean(filters.ownerType).toLowerCase();
  const visibility = clean(filters.visibility).toLowerCase();
  const lifecycle = clean(filters.lifecycle).toLowerCase();
  const pricing = clean(filters.pricing).toLowerCase();
  return templates.filter((template) => {
    if (search) {
      const haystack = `${template.plan_name || ""} ${template.source_external_id || ""}`.toLowerCase();
      if (!haystack.includes(search)) return false;
    }
    if (categoryNeedle && categoryNeedle !== "all" && !templateFilterOptionMatches(templateCategoryLabel(template), categoryNeedle)) return false;
    if (tag && tag !== "all" && !(template.tags || []).some((row) => templateFilterOptionMatches(row.name, tag))) return false;
    if (creator && creator !== "all") {
      const creatorText = `${template.creator_name || ""} ${template.creator_email || ""}`.trim();
      if (!templateFilterOptionMatches(creatorText, creator)) return false;
    }
    if (club && club !== "all" && !templateFilterOptionMatches(template.creator_club_names, club)) return false;
    if (ownerType && ownerType !== "all" && clean(template.owner_type).toLowerCase() !== ownerType) return false;
    if (visibility && visibility !== "all" && clean(template.visibility).toLowerCase() !== visibility) return false;
    if (lifecycle && lifecycle !== "all" && programLifecycle(template).code !== lifecycle) return false;
    if (pricing === "free" && template.is_free === false) return false;
    if (pricing === "paid" && template.is_free !== false) return false;
    return true;
  });
}

export function renderTemplateFiltersHtml(data) {
  const {
    filters,
    options,
    showAdminFilters,
    scopes,
    activeScope,
    scopeLabel,
    activeSection = "programs",
    requestCount = 0,
    showRequests = false,
    visibleTags,
    visibleCategories,
    creatorOptions,
    visibleCreators,
    clubOptions,
    visibleClubs,
  } = data;
  return `
    ${renderProgramScopeTabsHtml({ scopes, activeScope, scopeLabel, activeSection, requestCount, showRequests })}
    <section class="program-filter-panel" aria-label="Program filters">
      <label class="search-field program-filter-search">
        <span>Search programs</span>
        <input data-template-filter="search" type="search" value="${escapeAttr(filters.search || "")}" placeholder="Program name or code">
      </label>
      <label class="search-field">
        <span>Program group</span>
        <input data-template-filter="category" list="program-group-options" value="${escapeAttr(filters.category || "")}" placeholder="All">
        <datalist id="program-group-options">
          <option value="All"></option>
          ${visibleCategories.map((category) => `<option value="${escapeAttr(category)}"></option>`).join("")}
        </datalist>
      </label>
      <label class="search-field">
        <span>Tag</span>
        <input data-template-filter="tag" list="program-tag-filter-options" value="${escapeAttr(filters.tag || "")}" placeholder="${(options.tags || []).length ? "All" : "No assigned tags"}">
        <datalist id="program-tag-filter-options">
          <option value="All"></option>
          ${visibleTags.map((tag) => `<option value="${escapeAttr(tag)}"></option>`).join("")}
        </datalist>
      </label>
      <label class="search-field">
        <span>Program status</span>
        <select data-template-filter="lifecycle">
          ${renderOption("all", "All statuses", filters.lifecycle || "all")}
          ${PROGRAM_LIFECYCLE_OPTIONS.map(([value, label]) => renderOption(value, label, filters.lifecycle)).join("")}
        </select>
      </label>
      ${showAdminFilters ? `
        <label class="search-field">
          <span>Coach</span>
          <input data-template-filter="creator" list="program-creator-filter-options" value="${escapeAttr(filters.creator || "")}" placeholder="${creatorOptions.length ? "All coaches" : "No coaches"}">
          <datalist id="program-creator-filter-options">
            <option value="All"></option>
            ${visibleCreators.map((creator) => `<option value="${escapeAttr(creator)}"></option>`).join("")}
          </datalist>
        </label>
        <label class="search-field">
          <span>Club</span>
          <input data-template-filter="club" list="program-club-filter-options" value="${escapeAttr(filters.club || "")}" placeholder="${clubOptions.length ? "All clubs" : "No clubs"}">
          <datalist id="program-club-filter-options">
            <option value="All"></option>
            ${visibleClubs.map((club) => `<option value="${escapeAttr(club)}"></option>`).join("")}
          </datalist>
        </label>
        <label class="search-field">
          <span>Owner</span>
          <select data-template-filter="ownerType">
            ${renderOption("all", "All owners", filters.ownerType || "all")}
            ${renderOption("coach", "Coach", filters.ownerType)}
            ${renderOption("club", "Club", filters.ownerType)}
            ${renderOption("optimove", "OptiMove", filters.ownerType)}
            ${renderOption("marketplace", "Marketplace", filters.ownerType)}
          </select>
        </label>
        <label class="search-field">
          <span>Access</span>
          <select data-template-filter="visibility">
            ${renderOption("all", "All access", filters.visibility || "all")}
            ${renderOption("private", "Private", filters.visibility)}
            ${renderOption("team", "Team shared", filters.visibility)}
            ${renderOption("club", "Club shared", filters.visibility)}
            ${renderOption("public", "Public", filters.visibility)}
          </select>
        </label>
      ` : ""}
      <label class="program-paid-filter">
        <input data-template-filter="freeOnly" type="checkbox" ${filters.pricing === "free" ? "checked" : ""}>
        <span>Free only</span>
      </label>
    </section>
  `;
}

export function renderProgramScopeTabsHtml({ scopes = [], activeScope = "my", scopeLabel = (value) => value, activeSection = "programs", requestCount = 0, showRequests = false } = {}) {
  const buttons = [];
  scopes.forEach((scope) => {
    buttons.push(renderTemplateScopeButton(scope, scopeLabel(scope), activeScope, activeSection));
    if (showRequests && scope === "my_programs") buttons.push(renderProgramRequestsScopeButton(activeSection, requestCount));
  });
  if (showRequests && !scopes.includes("my_programs")) buttons.push(renderProgramRequestsScopeButton(activeSection, requestCount));
  return `
    <div class="program-scope-tabs" role="group" aria-label="Program library scope">
      ${buttons.join("")}
    </div>
  `;
}

function renderProgramRequestsScopeButton(activeSection, requestCount) {
  const count = Number(requestCount || 0);
  return `<button class="program-scope-button ${activeSection === "requests" ? "is-active" : ""}" type="button" data-action="program-library-section" data-program-library-section="requests">Requests${count ? ` (${count})` : ""}</button>`;
}

function renderTemplateScopeButton(value, label, activeScope, activeSection = "programs") {
  return `<button class="program-scope-button ${activeSection === "programs" && activeScope === value ? "is-active" : ""}" type="button" data-action="template-scope" data-scope="${escapeAttr(value)}">${escapeHtml(label)}</button>`;
}

export function renderProgramInfoModal(programInfo) {
  const program = programInfo?.program;
  if (!programInfo?.open || !program) return "";
  const info = programInfoModel(program);
  const meta = [info.group, info.price].filter(Boolean).join(" - ");
  return `
    <div class="program-preview-overlay program-info-overlay">
      <button class="program-preview-backdrop" type="button" data-action="program-info-close" aria-label="Close program information"></button>
      <section class="program-info-modal" role="dialog" aria-modal="true" aria-label="${escapeAttr(info.title)} information">
        <div class="program-info-head">
          <div>
            <p class="eyebrow">Program information</p>
            <h3>${escapeHtml(info.title)}</h3>
            ${meta ? `<p class="muted">${escapeHtml(meta)}</p>` : ""}
          </div>
          <button class="plain-button icon-button" type="button" data-action="program-info-close" aria-label="Close"><span class="button-icon">x</span></button>
        </div>
        <div class="program-info-body">
          <p>${escapeHtml(info.description || "No additional information yet.")}</p>
          <dl class="program-info-list">
            ${info.creator ? `<div><dt>Created by</dt><dd>${escapeHtml(info.creator)}</dd></div>` : ""}
            ${info.group ? `<div><dt>Program group</dt><dd>${escapeHtml(info.group)}</dd></div>` : ""}
            <div><dt>Access</dt><dd>${escapeHtml(info.price)}</dd></div>
            ${info.tags.length ? `<div><dt>Tags</dt><dd class="program-info-tags">${info.tags.map((tag) => `<span class="item-badge">${escapeHtml(tag)}</span>`).join("")}</dd></div>` : ""}
          </dl>
        </div>
      </section>
    </div>
  `;
}
