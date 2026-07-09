import { renderImage } from "./media.js";
import { clean, escapeAttr, escapeHtml, programInitials } from "./utils.js";

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

export function ratingLabel(entity) {
  const count = Number(entity?.review_count || 0);
  if (!count) return "No reviews yet";
  const average = Number(entity?.average_rating || 0);
  return `${average.toFixed(average % 1 ? 1 : 0)} / 5 (${count})`;
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

export function renderProgramLibraryCard(template, duplicateNames, selectedTemplateId) {
  const category = templateCategoryLabel(template);
  const creator = clean(template.creator_name);
  const creatorProfileId = clean(template.creator_profile_id);
  const isSelected = String(template.plan_id) === String(selectedTemplateId);
  const price = programPriceLabel(template);
  return `
    <article class="program-library-card ${isSelected ? "is-selected" : ""}">
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
          <span class="item-badge">${escapeHtml(ratingLabel(template))}</span>
          ${(template.tags || []).length ? `<span class="item-badge">${escapeHtml(template.tags[0].name)}${template.tags.length > 1 ? ` +${template.tags.length - 1}` : ""}</span>` : ""}
          <span class="text-action">Preview</span>
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
