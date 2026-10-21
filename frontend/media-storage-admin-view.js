// Settings -> Storage (R2 media, PR 5): what a platform administrator sees.
//
// An administrative screen in plain language: the defaults for every account
// first, then every storage account that exists, in two groups (user
// accounts, club accounts - the owner's decision 6), each with its use, its
// limit and one inline form to change or remove that limit. Every change
// needs a reason and travels with the revision it was read at. Nothing here
// promises freed space or an upload that the rest of the system cannot do
// yet. Carbon informs the structure (one card per thing, status first, the
// destructive step named); it is a design reference only.
import { bytesToGigabytes, bytesToMegabytes, ownerLabel, REASON_MAX_LENGTH, storageAdminContext, usageSentence } from "./media-storage-admin-data.js";
import { renderDriveImportCardHtml } from "./drive-import-view.js";
import { state } from "./state.js";
import { escapeAttr, escapeHtml, formatBytes } from "./utils.js";

const fmtWhen = (value) => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleString("en-GB", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
};

function renderNotice(text) {
  return text ? `<p class="storage-admin-notice" role="status">${escapeHtml(text)}</p>` : "";
}

function renderReasonField(name = "reason") {
  return `<label class="search-field storage-admin-reason"><span>Reason (required, kept in the history)</span><textarea class="builder-text-input" name="${escapeAttr(name)}" rows="2" maxlength="${REASON_MAX_LENGTH}" required placeholder="Why this changes"></textarea></label>`;
}

// The inline form that sets or removes one account's limit. `scope` says
// which state slice drew it (the tab or the Manage account section).
export function renderLimitFormHtml(usage, edit, { scope }) {
  const remove = edit.mode === "remove";
  return `
    <form class="storage-admin-form" data-storage-admin-form="limit" data-scope="${escapeAttr(scope)}" data-account-id="${escapeAttr(usage.storageAccountId)}" data-mode="${remove ? "remove" : "set"}">
      <input type="hidden" name="expectedRevision" value="${escapeAttr(String(usage.revision))}">
      ${remove
        ? `<p>Remove the individual limit of ${escapeHtml(formatBytes(usage.limitBytes))}. The default limit applies to this account again.</p>`
        : `<label class="search-field"><span>Limit for this account (GB; 0 means no new uploads)</span><input class="builder-text-input" name="limitGb" type="text" inputmode="decimal" value="${escapeAttr(edit.draft?.limitGb ?? bytesToGigabytes(usage.limitBytes))}" required></label>`}
      ${renderReasonField()}
      ${edit.error ? `<p class="builder-error" role="alert">${escapeHtml(edit.error)}</p>` : ""}
      <div class="storage-admin-actions">
        <button class="plain-button compact-button ${remove ? "danger-button" : ""}" type="submit" ${edit.busy ? "disabled" : ""}>${edit.busy ? "Saving..." : remove ? "Remove individual limit" : "Save limit"}</button>
        <button class="text-action" type="button" data-action="storage-admin-limit-cancel" data-scope="${escapeAttr(scope)}" ${edit.busy ? "disabled" : ""}>Cancel</button>
      </div>
    </form>
  `;
}

function renderUsageBadges(usage) {
  return `
    <span class="item-badge">${usage.limitSource === "override" ? "Individual limit" : "Default limit"}</span>
    ${usage.overLimit ? `<span class="item-badge storage-admin-over">Over limit</span>` : ""}
    ${Number(usage.limitBytes) === 0 ? `<span class="item-badge">No new uploads</span>` : ""}
  `;
}

function renderLimitActions(usage, { scope, pending }) {
  return `
    <div class="storage-admin-actions">
      <button class="plain-button compact-button" type="button" data-action="storage-admin-limit-edit" data-scope="${escapeAttr(scope)}" data-account-id="${escapeAttr(usage.storageAccountId)}" data-mode="set" ${pending ? "disabled" : ""}>Change limit...</button>
      ${usage.limitSource === "override" ? `<button class="text-action" type="button" data-action="storage-admin-limit-edit" data-scope="${escapeAttr(scope)}" data-account-id="${escapeAttr(usage.storageAccountId)}" data-mode="remove" ${pending ? "disabled" : ""}>Remove individual limit</button>` : ""}
    </div>
  `;
}

function renderHistory(storageAccountId) {
  const entry = state.storageAdmin.history[storageAccountId];
  if (!entry?.open) return "";
  if (entry.loading) return `<p class="muted" role="status">Reading the history...</p>`;
  if (entry.error) return `<p class="builder-error">${escapeHtml(entry.error)}</p>`;
  if (!entry.entries?.length) return `<p class="muted">No limit changes recorded for this account.</p>`;
  return `<ul class="storage-admin-history">${entry.entries.map((item) => `
    <li><span class="muted">${escapeHtml(fmtWhen(item.createdAt))}</span> · ${escapeHtml(ownerLabel({ type: "user", id: item.performedByUserId }))}: limit ${escapeHtml(item.oldValues?.limitBytes == null ? "default" : formatBytes(item.oldValues.limitBytes))} → ${escapeHtml(item.newValues?.limitBytes == null ? "default" : formatBytes(item.newValues.limitBytes))} — ${escapeHtml(item.reason || "")}</li>`).join("")}</ul>`;
}

function renderAccountRow(usage, data) {
  const admin = state.storageAdmin;
  const editing = admin.limitEdit?.scope === "panel" && admin.limitEdit.accountId === usage.storageAccountId;
  const history = admin.history[usage.storageAccountId];
  return `
    <article class="storage-admin-account" data-storage-account="${escapeAttr(usage.storageAccountId)}">
      <div class="storage-admin-account-head">
        <strong>${escapeHtml(ownerLabel(usage.owner, data))}</strong>
        ${renderUsageBadges(usage)}
      </div>
      <p class="storage-admin-usage">${escapeHtml(usageSentence(usage))}</p>
      ${editing ? renderLimitFormHtml(usage, admin.limitEdit, { scope: "panel" }) : renderLimitActions(usage, { scope: "panel", pending: admin.busy })}
      <button class="text-action" type="button" data-action="storage-admin-history" data-account-id="${escapeAttr(usage.storageAccountId)}">${history?.open ? "Hide history" : "History"}</button>
      ${renderHistory(usage.storageAccountId)}
      <details class="storage-admin-technical"><summary>Technical details</summary><code>storage account ${escapeHtml(usage.storageAccountId)} · owner ${escapeHtml(usage.owner?.type || "")} ${escapeHtml(String(usage.owner?.id || ""))} · revision ${escapeHtml(String(usage.revision))}</code></details>
    </article>
  `;
}

function renderPolicyCard(admin) {
  const policy = admin.policy;
  const edit = admin.policyEdit;
  return `
    <section class="panel storage-admin-card" data-storage-admin-policy>
      <p class="eyebrow">Defaults for every account</p>
      ${edit ? `
        <form class="storage-admin-form" data-storage-admin-form="policy">
          <input type="hidden" name="expectedRevision" value="${escapeAttr(String(admin.revision))}">
          <div class="storage-admin-grid">
            <label class="search-field"><span>Default limit per account (GB; 0 means nothing until an individual limit is set)</span><input class="builder-text-input" name="defaultLimitGb" type="text" inputmode="decimal" value="${escapeAttr(edit.draft.defaultLimitGb)}" required></label>
            <label class="search-field"><span>Largest video file (MB)</span><input class="builder-text-input" name="maxVideoMb" type="text" inputmode="decimal" value="${escapeAttr(edit.draft.maxVideoMb)}" required></label>
            <label class="search-field"><span>Largest picture file (MB)</span><input class="builder-text-input" name="maxImageMb" type="text" inputmode="decimal" value="${escapeAttr(edit.draft.maxImageMb)}" required></label>
            <label class="search-field"><span>Uploads at once per account (1 to 20)</span><input class="builder-text-input" name="maxParallelUploads" type="number" min="1" max="20" step="1" value="${escapeAttr(edit.draft.maxParallelUploads)}" required></label>
          </div>
          ${renderReasonField()}
          ${edit.error ? `<p class="builder-error" role="alert">${escapeHtml(edit.error)}</p>` : ""}
          <div class="storage-admin-actions">
            <button class="plain-button compact-button" type="submit" ${admin.busy ? "disabled" : ""}>${admin.busy ? "Saving..." : "Save defaults"}</button>
            <button class="text-action" type="button" data-action="storage-admin-policy-cancel" ${admin.busy ? "disabled" : ""}>Cancel</button>
          </div>
        </form>
      ` : `
        <dl class="storage-admin-facts">
          <div><dt>Default limit per account</dt><dd>${escapeHtml(formatBytes(policy.defaultLimitBytes))}${Number(policy.defaultLimitBytes) === 0 ? ` <span class="muted">(nothing can be uploaded until an account gets an individual limit)</span>` : ""}</dd></div>
          <div><dt>Largest video file</dt><dd>${escapeHtml(formatBytes(policy.maxVideoBytes))}</dd></div>
          <div><dt>Largest picture file</dt><dd>${escapeHtml(formatBytes(policy.maxImageBytes))}</dd></div>
          <div><dt>Uploads at once per account</dt><dd>${escapeHtml(String(policy.maxParallelUploads))}</dd></div>
          <div><dt>Accepted files</dt><dd>${escapeHtml((policy.allowedMimeTypes || []).join(", "))}</dd></div>
        </dl>
        <div class="storage-admin-actions">
          <button class="plain-button compact-button" type="button" data-action="storage-admin-policy-edit" ${admin.busy ? "disabled" : ""}>Change defaults...</button>
        </div>
      `}
    </section>
  `;
}

export function renderStorageAdminPanelHtml(data = state.organization?.data) {
  const admin = state.storageAdmin;
  const intro = `
    <section class="panel storage-admin-card">
      <p class="eyebrow">Storage</p>
      <h3>Media storage for exercise videos and pictures</h3>
      <p class="muted">Files coaches upload to OptiMove's private storage count against a storage account: a coach's own account for private exercises, a club's account for club exercises, the uploading administrator's own account for application exercises. The limits here decide how much each account may hold. Removing a file from an exercise does not free its space by itself.</p>
    </section>
  `;
  if (!storageAdminContext(data)) return `${intro}<section class="panel storage-admin-card"><p class="muted">Storage is administered by a platform administrator in the platform workspace.</p></section>`;
  if (admin.loading && !admin.policy) return `${intro}<section class="panel storage-admin-card"><p class="muted" role="status">Reading storage...</p></section>`;
  if (admin.disabled) return `${intro}<section class="panel storage-admin-card"><p>Media storage is switched off in this environment (MEDIA_STORAGE_ENABLED). The limits can be read and set once it is on.</p></section>`;
  if (admin.unavailable) return `${intro}<section class="panel storage-admin-card"><p>This needs platform administrator access in the platform workspace. Reload the app before trying again.</p></section>`;
  if (admin.error || !admin.policy) {
    return `${intro}<section class="panel storage-admin-card"><p class="builder-error" role="alert">${escapeHtml(admin.error || "Storage could not be read.")}</p><div class="storage-admin-actions"><button class="plain-button compact-button" type="button" data-action="storage-admin-reload">Read again</button></div></section>`;
  }
  const platform = admin.accounts.filter((account) => account.owner?.type === "platform");
  const users = admin.accounts.filter((account) => account.owner?.type === "user");
  const clubs = admin.accounts.filter((account) => account.owner?.type === "club");
  const group = (title, rows, empty) => `
    <section class="panel storage-admin-card">
      <div class="organization-list-head"><p class="eyebrow">${escapeHtml(title)}</p><strong>${rows.length}</strong></div>
      ${rows.length ? `<div class="storage-admin-list">${rows.map((usage) => renderAccountRow(usage, data)).join("")}</div>` : `<p class="muted">${escapeHtml(empty)}</p>`}
    </section>
  `;
  return `
    ${intro}
    ${renderNotice(admin.notice)}
    ${renderPolicyCard(admin)}
    ${renderDriveImportCardHtml()}
    ${platform.length ? group("OptiMove system storage", platform, "") : ""}
    ${group("User storage accounts", users, "No user has a storage account yet. One appears when a coach's storage is first read or when you set a limit from Manage account.")}
    ${group("Club storage accounts", clubs, "No club has a storage account yet. One appears when a club exercise's storage is first read.")}
    ${admin.nextCursor ? `<div class="load-more-row"><button class="plain-button" type="button" data-action="storage-admin-load-more" ${admin.loadingMore ? "disabled" : ""}>${admin.loadingMore ? "Loading..." : "Load more accounts"}</button></div>` : ""}
    <section class="panel storage-admin-card"><div class="storage-admin-actions"><button class="text-action" type="button" data-action="storage-admin-reload">Read again</button></div></section>
  `;
}

// The Storage section of the Manage account modal: this user's own storage
// account (created with zero use the first time it is read, so a limit can be
// set before the first upload), its use and its limit, with the same inline
// form as the tab. Club accounts are administered on the Storage tab.
export function renderManageAccountStorageSection(row, data) {
  if (!storageAdminContext(data)) return "";
  const storage = state.organizationUserManage.storage;
  if (!storage) return "";
  let body = "";
  if (storage.loading) body = `<p class="muted" role="status">Reading storage...</p>`;
  else if (storage.disabled) body = `<p class="muted">Media storage is switched off in this environment (MEDIA_STORAGE_ENABLED).</p>`;
  else if (storage.unavailable) body = `<p class="muted">Storage can't be administered from this workspace.</p>`;
  else if (storage.error) {
    body = `<p class="builder-error" role="alert">${escapeHtml(storage.error)}</p>
      <button class="plain-button compact-button" type="button" data-action="storage-admin-manage-reload" data-user-id="${escapeAttr(row.id)}" ${storage.busy ? "disabled" : ""}>Read again</button>`;
  } else if (storage.usage) {
    const usage = storage.usage;
    const editing = storage.limitEdit?.scope === "manage";
    body = `
      <div class="manage-account-row">${renderUsageBadges(usage)}</div>
      <p class="storage-admin-usage">${escapeHtml(usageSentence(usage))}</p>
      <p class="muted">Largest video ${escapeHtml(formatBytes(usage.maxVideoBytes))}, largest picture ${escapeHtml(formatBytes(usage.maxImageBytes))}, ${escapeHtml(String(usage.maxParallelUploads))} upload${Number(usage.maxParallelUploads) === 1 ? "" : "s"} at once (the defaults).</p>
      ${editing ? renderLimitFormHtml(usage, storage.limitEdit, { scope: "manage" }) : renderLimitActions(usage, { scope: "manage", pending: storage.busy })}
      <p class="muted">This is the account's personal storage. A club exercise counts against the club's own account, administered under Settings → Storage.</p>
      ${renderNotice(storage.notice)}
      <details class="storage-admin-technical"><summary>Technical details</summary><code>storage account ${escapeHtml(usage.storageAccountId)} · revision ${escapeHtml(String(usage.revision))}</code></details>`;
  }
  return `
    <section class="manage-account-section" data-manage-account-storage>
      <p class="eyebrow">Storage</p>
      ${body}
    </section>
  `;
}

export { bytesToGigabytes, bytesToMegabytes };
