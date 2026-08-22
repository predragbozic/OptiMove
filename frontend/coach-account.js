import { renderAccountEmailPasswordSectionsHtml } from "./athlete-view.js";
import { escapeHtml } from "./utils.js";

// Mirrors the athlete rail's own Account entry, but for the coach's OWN
// personal account (login email, password) - distinct from Settings >
// Users/Clubs/Teams/Athletes/Tags, which is organization-wide
// administration, not personal account settings. Reuses the email-change/
// password-change panels as-is (athlete-view.js) - only the athlete-only
// personal-data/photo section is skipped, since that's specific to the
// athlete profile record a coach doesn't have.
export function renderCoachAccountHtml(currentUser, emailChangeStatus) {
  return `
    <section class="content-section athlete-simple-view">
      <section class="panel athlete-settings-card">
        <div>
          <p class="eyebrow">Account</p>
          <h3>${escapeHtml(currentUser?.name || "Your account")}</h3>
          <p class="muted">Manage the login email and password for your own coach account.</p>
        </div>
      </section>
      ${renderAccountEmailPasswordSectionsHtml(currentUser, emailChangeStatus)}
    </section>
  `;
}
