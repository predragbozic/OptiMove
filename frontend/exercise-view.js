import { renderImage, renderMediaThumb } from "./media.js";
import { clean, escapeAttr, escapeHtml, initialsFor } from "./utils.js";

export function renderExerciseListHtml(items, itemIds, layout) {
  const exerciseIds = itemIds.filter(Boolean);
  return `
    ${exerciseIds.length ? `
      <div class="exercise-layout-toolbar" aria-label="Exercise layout">
        <span class="muted">Layout</span>
        <button class="chip layout-chip ${layout === "horizontal" ? "is-active" : ""}" data-action="exercise-layout" data-layout="horizontal">
          <span class="layout-icon layout-icon-horizontal"></span><span>Horizontal</span>
        </button>
        <button class="chip layout-chip ${layout === "vertical" ? "is-active" : ""}" data-action="exercise-layout" data-layout="vertical">
          <span class="layout-icon layout-icon-vertical"></span><span>Vertical</span>
        </button>
      </div>
    ` : ""}
    <div class="exercise-list is-${layout} ${items.length === 1 ? "is-single" : ""}">
      ${items.map((item, index) => renderExerciseItemHtml(item, itemIds[index], layout)).join("")}
    </div>
  `;
}

export function renderExerciseItemHtml(item, itemId, layout) {
  const color = item.section_color || item.category_color || item.domain_color || "#1f6f68";
  const image = item.image || item.image_url || "";
  const video = item.video || item.video_url || "";
  const doseRows = exerciseDoseRows(item);
  const hasMedia = Boolean(image || video);
  if (!isExerciseItem(item)) return renderOrganizationItemHtml(item, color);
  if (layout === "vertical") {
    return `
      <article class="plan-item exercise-item exercise-item-vertical ${hasMedia ? "" : "no-media"}" style="border-left-color:${escapeAttr(color)}">
        <div class="exercise-item-top">
          <div class="exercise-media-stack">
            <button class="exercise-open exercise-title-open" data-action="open-exercise" data-item-id="${escapeAttr(itemId)}">
              <span class="item-title">${escapeHtml(item.title || "Untitled")}</span>
            </button>
            ${hasMedia ? `
              <button class="exercise-media" data-action="open-media" data-title="${escapeAttr(item.title || "Exercise media")}" data-image="${escapeAttr(image)}" data-video="${escapeAttr(video)}">
                ${image ? renderMediaThumb(image, "") : `<span class="media-fallback">Video</span>`}
              </button>
            ` : ""}
          </div>
          <button class="exercise-open plan-exercise-open exercise-item-summary" data-action="open-exercise" data-item-id="${escapeAttr(itemId)}">
            ${doseRows.length ? renderDoseMiniHtml(doseRows) : ""}
            ${item.description ? `<span class="item-description">${escapeHtml(item.description)}</span>` : ""}
          </button>
        </div>
      </article>
    `;
  }
  return `
    <article class="plan-item exercise-item ${hasMedia ? "" : "no-media"}" style="border-left-color:${escapeAttr(color)}">
      ${hasMedia ? `
        <button class="exercise-media" data-action="open-media" data-title="${escapeAttr(item.title || "Exercise media")}" data-image="${escapeAttr(image)}" data-video="${escapeAttr(video)}">
          ${image ? renderMediaThumb(image, "") : `<span class="media-fallback">Video</span>`}
        </button>
      ` : ""}
      <button class="exercise-open plan-exercise-open" data-action="open-exercise" data-item-id="${escapeAttr(itemId)}">
        <span class="item-head">
          <span class="item-title">${escapeHtml(item.title || "Untitled")}</span>
        </span>
        ${doseRows.length ? renderDoseMiniHtml(doseRows) : ""}
        ${item.description ? `<span class="item-description">${escapeHtml(item.description)}</span>` : ""}
      </button>
    </article>
  `;
}

export function renderOrganizationSummaryHtml(node) {
  const meta = (node.items || []).find(Boolean) || {};
  const icon = node.icon || meta[`${node.type}_icon_url`] || meta.category_icon_url || meta.section_icon_url || meta.domain_icon_url || "";
  const color = node.color || meta[`${node.type}_color`] || meta.category_color || meta.section_color || meta.domain_color || "#1f6f68";
  const note = node.note || meta.description || meta[`${node.type}_note`] || meta[`${node.type}_short_note`] || "";
  const doseRows = exerciseDoseRows(meta);
  return `
    <article class="organization-summary" style="--node-color:${escapeAttr(color)}">
      <div class="node-card-head">
        ${icon ? `${renderImage(icon, "node-icon")}<span class="node-dot node-dot-fallback"></span>` : `<span class="node-dot"></span>`}
        <div>
          <h4>${escapeHtml(node.label)}</h4>
          ${note ? `<p>${escapeHtml(note)}</p>` : ""}
        </div>
      </div>
      ${doseRows.length ? renderDoseMiniHtml(doseRows) : ""}
    </article>
  `;
}

export function renderExerciseDetailHtml({ item, itemId, ids, getItemById }) {
  const currentIndex = ids.indexOf(itemId);
  const hasSequence = currentIndex >= 0 && ids.length > 1;
  const canGoPrevious = hasSequence && currentIndex > 0;
  const canGoNext = hasSequence;
  const title = clean(item.title || item.name || "Exercise");
  const image = item.image || item.image_url || "";
  const video = item.video || item.video_url || "";
  const hierarchy = [item.domain, item.category, item.section].filter(Boolean).join(" / ");
  const doseRows = [
    ...exerciseDoseRows(item),
    ["Place", item.place],
    ["Complexity", item.complexity],
  ].filter(([, value]) => clean(value));
  const noteRows = [
    ["Aim", item.aim],
    ["Description", item.description],
    ["Execution notes", item.execution_notes],
    ["Instruction", item.instruction],
  ].filter(([, value]) => clean(value));

  return `
    <div class="exercise-detail-overlay">
      <div class="exercise-detail-backdrop" data-action="exercise-back"></div>
      <section class="panel exercise-detail">
        ${hasSequence ? `<div class="exercise-sequence-indicator" aria-label="Exercise ${currentIndex + 1} of ${ids.length}">${ids.map((id) => `<i class="${id === itemId ? "is-active" : ""}"></i>`).join("")}</div>` : ""}
        <div class="drill-header">
          <div>
            <p class="eyebrow">Exercise</p>
            <h3>${escapeHtml(title)}</h3>
            ${hierarchy ? `<div class="breadcrumb">${escapeHtml(hierarchy)}</div>` : ""}
          </div>
        </div>

        <div class="exercise-detail-layout">
          <div class="exercise-detail-media">
            ${image || video
              ? `<button class="exercise-media detail-media" data-action="open-media" data-title="${escapeAttr(title)}" data-image="${escapeAttr(image)}" data-video="${escapeAttr(video)}">
                  ${image ? renderMediaThumb(image) : `<span class="media-fallback">Video</span>`}
                </button>`
              : `<div class="detail-media-empty">No image</div>`}
          </div>

          <div class="exercise-detail-main">
            ${doseRows.length ? `
              <div class="detail-grid">
                ${doseRows.map(([label, value]) => `
                  <div class="detail-cell">
                    <span>${escapeHtml(label)}</span>
                    <strong>${escapeHtml(value)}</strong>
                  </div>
                `).join("")}
              </div>
            ` : ""}

            ${noteRows.length ? `
              <div class="detail-notes">
                ${noteRows.map(([label, value]) => `
                  <section>
                    <p class="eyebrow">${escapeHtml(label)}</p>
                    <p>${escapeHtml(value)}</p>
                  </section>
                `).join("")}
              </div>
            ` : `<div class="empty">No additional exercise notes.</div>`}
          </div>

          ${hasSequence ? renderExerciseSiblingStripHtml(ids, itemId, getItemById) : ""}
        </div>

        <nav class="exercise-detail-footer">
          <button class="footer-nav-button" type="button" data-action="exercise-back"><span class="button-icon">&larr;</span><span>Back</span></button>
          ${hasSequence ? `<button class="footer-nav-button" type="button" data-action="exercise-prev" ${canGoPrevious ? "" : "disabled"}><span class="button-icon">&lsaquo;</span><span>Previous</span></button>` : ""}
          ${hasSequence ? `<span class="exercise-position">${currentIndex + 1} / ${ids.length}</span>` : ""}
          ${hasSequence ? `<button class="footer-nav-button" type="button" data-action="exercise-next" ${canGoNext ? "" : "disabled"}><span class="button-icon">&rsaquo;</span><span>Next</span></button>` : ""}
          <button class="footer-nav-button" type="button" data-action="home"><span class="button-icon">&#8962;</span><span>Home</span></button>
        </nav>
      </section>
    </div>
  `;
}

export function isExerciseItem(item) {
  const type = clean(item.item_type).toLowerCase();
  if (["category", "section", "domain"].includes(type)) return false;
  if (type === "exercise") return true;
  if (item.exercise_id || item.exercise_code) return true;
  if (item.image || item.image_url || item.video || item.video_url) return true;
  if (exerciseDoseRows(item).length) return true;
  return !type;
}

export function exerciseDoseRows(item) {
  return [
    ["Sets", item.sets],
    ["Reps", item.reps],
    ["Load", item.load],
  ].filter(([, value]) => clean(value));
}

export function renderDoseMiniHtml(rows) {
  return `
    <span class="dose-mini-grid">
      ${rows.map(([label, value]) => `
        <span class="dose-mini-cell">
          <span>${escapeHtml(label)}</span>
          <strong>${escapeHtml(value)}</strong>
        </span>
      `).join("")}
    </span>
  `;
}

function renderOrganizationItemHtml(item, color) {
  const title = item.title || item.category || item.section || item.domain || "Entry";
  return `
    <article class="plan-item exercise-item organization-item no-media" style="border-left-color:${escapeAttr(color)}">
      <div class="item-head">
        <span class="item-title">${escapeHtml(title)}</span>
      </div>
      ${item.description ? `<span class="item-description">${escapeHtml(item.description)}</span>` : ""}
    </article>
  `;
}

function renderExerciseSiblingStripHtml(ids, itemId, getItemById) {
  return `
    <div class="exercise-sibling-strip">
      <p class="eyebrow">Other exercises in this section</p>
      <div class="exercise-sibling-row">
        ${ids.map((id) => {
          const sibling = getItemById(id);
          if (!sibling) return "";
          const isActive = id === itemId;
          const siblingTitle = clean(sibling.title || sibling.name || "Exercise");
          const siblingImage = sibling.image || sibling.image_url || "";
          return `
            <button class="exercise-sibling-card ${isActive ? "is-active" : ""}" type="button" data-action="exercise-jump" data-item-id="${escapeAttr(id)}" ${isActive ? "disabled" : ""}>
              ${siblingImage ? renderImage(siblingImage, "exercise-sibling-image") : `<span class="exercise-sibling-fallback">${escapeHtml(initialsFor(siblingTitle))}</span>`}
              <span>${escapeHtml(siblingTitle)}</span>
            </button>
          `;
        }).join("")}
      </div>
    </div>
  `;
}
