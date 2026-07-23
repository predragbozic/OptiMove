import { renderImage } from "./media.js";
import { escapeAttr, escapeHtml, programInitials } from "./utils.js";

export function renderCoachHomeHtml({ rows, error }) {
  const withTraining = (rows || []).filter((row) => row.hasTrainingToday);
  const withoutTraining = (rows || []).filter((row) => !row.hasTrainingToday);
  return `
    <section class="content-section coach-home">
      ${error ? `<p class="builder-error">${escapeHtml(error)}</p>` : ""}
      <section class="panel coach-home-summary">
        <p class="eyebrow">Today</p>
        <h3>${withTraining.length} of ${(rows || []).length} athletes training today</h3>
        <p class="muted">Based on scheduled weekly plan sessions for today's date.</p>
      </section>
      <section class="coach-home-list">
        <div class="organization-list-head"><p class="eyebrow">Training today</p><strong>${withTraining.length}</strong></div>
        <div class="coach-home-cards">
          ${withTraining.length ? withTraining.map(renderCoachHomeCard).join("") : `<p class="muted">No athletes have a session scheduled today.</p>`}
        </div>
      </section>
      ${withoutTraining.length ? `
        <section class="coach-home-list">
          <div class="organization-list-head"><p class="eyebrow">No session today</p><strong>${withoutTraining.length}</strong></div>
          <div class="coach-home-cards">
            ${withoutTraining.map(renderCoachHomeCard).join("")}
          </div>
        </section>
      ` : ""}
    </section>
  `;
}

function renderCoachHomeCard(row) {
  return `
    <button class="coach-home-card ${row.hasTrainingToday ? "has-training" : ""}" type="button" data-action="coach-home-open-athlete" data-athlete-id="${escapeAttr(row.athleteId)}">
      ${row.athleteImageUrl ? renderImage(row.athleteImageUrl, "coach-home-avatar") : `<span class="coach-home-avatar coach-home-avatar-fallback">${escapeHtml(programInitials(row.athlete || "Athlete"))}</span>`}
      <span class="coach-home-card-body">
        <strong>${escapeHtml(row.athlete || "Athlete")}</strong>
        <small>${row.hasTrainingToday ? `${row.sessionCount} ${row.sessionCount === 1 ? "session" : "sessions"} - ${row.itemCount} ${row.itemCount === 1 ? "exercise" : "exercises"}` : "No session today"}</small>
      </span>
    </button>
  `;
}
