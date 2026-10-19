// Settings -> Storage (R2 media, PR 5): the clicks and the two inline forms.
// Every write goes through media-storage-admin-data.js, which reads the
// screen again after a refusal or a lost answer.
import {
  bytesToGigabytes, bytesToMegabytes, changeStorageLimit, gigabytesToBytes, loadManageAccountStorage, loadMoreStorageAccounts,
  loadStorageAdmin, loadStorageHistory, megabytesToBytes, saveStoragePolicy, storageAdminContext, validReason,
} from "./media-storage-admin-data.js";
import { state } from "./state.js";

const LIMIT_INVALID = "Enter the limit in gigabytes, as a number (for example 5 or 2.5); 0 means no new uploads.";
const REASON_INVALID = "A reason is required (1 to 1000 characters).";

// The state slice an inline limit form belongs to: the tab, or the Manage
// account section, with the usage row it edits.
function limitTarget(scope, accountId, render) {
  if (scope === "manage") {
    const manage = state.organizationUserManage;
    const storage = manage.storage;
    if (!manage.open || !storage?.usage || storage.usage.storageAccountId !== accountId) return null;
    return {
      target: storage,
      usage: storage.usage,
      apply: (usage) => { storage.usage = usage; },
      reread: (notice) => loadManageAccountStorage(manage.userId, render, notice),
    };
  }
  const admin = state.storageAdmin;
  const usage = admin.accounts.find((account) => account.storageAccountId === accountId);
  if (!usage) return null;
  return {
    target: admin,
    usage,
    apply: (fresh) => { admin.accounts = admin.accounts.map((account) => (account.storageAccountId === accountId ? fresh : account)); },
    reread: (notice) => loadStorageAdmin(render, notice),
  };
}

export async function handleStorageAdminAction(action, { render }) {
  const type = action.dataset.action;
  if (!type?.startsWith("storage-admin-")) return false;
  if (!storageAdminContext()) return true;
  const admin = state.storageAdmin;
  if (type === "storage-admin-reload") {
    await loadStorageAdmin(render);
    return true;
  }
  if (type === "storage-admin-load-more") {
    await loadMoreStorageAccounts(render);
    return true;
  }
  if (type === "storage-admin-policy-edit") {
    if (!admin.policy || admin.busy) return true;
    admin.policyEdit = { draft: { defaultLimitGb: bytesToGigabytes(admin.policy.defaultLimitBytes), maxVideoMb: bytesToMegabytes(admin.policy.maxVideoBytes), maxImageMb: bytesToMegabytes(admin.policy.maxImageBytes), maxParallelUploads: String(admin.policy.maxParallelUploads) }, error: "" };
    admin.notice = "";
    render();
    return true;
  }
  if (type === "storage-admin-policy-cancel") {
    if (admin.busy) return true;
    admin.policyEdit = null;
    render();
    return true;
  }
  if (type === "storage-admin-limit-edit") {
    const scope = action.dataset.scope === "manage" ? "manage" : "panel";
    const found = limitTarget(scope, action.dataset.accountId || "", render);
    if (!found || found.target.busy) return true;
    found.target.limitEdit = { scope, accountId: found.usage.storageAccountId, mode: action.dataset.mode === "remove" ? "remove" : "set", draft: { limitGb: bytesToGigabytes(found.usage.limitBytes) }, error: "", busy: false };
    found.target.notice = "";
    render();
    return true;
  }
  if (type === "storage-admin-limit-cancel") {
    const scope = action.dataset.scope === "manage" ? "manage" : "panel";
    const target = scope === "manage" ? state.organizationUserManage.storage : admin;
    if (!target || target.busy) return true;
    target.limitEdit = null;
    render();
    return true;
  }
  if (type === "storage-admin-history") {
    const id = action.dataset.accountId || "";
    const entry = admin.history[id];
    if (entry?.open) {
      entry.open = false;
      render();
      return true;
    }
    admin.history[id] = { open: true, loading: false, entries: entry?.entries || null, error: "" };
    if (!entry?.entries) await loadStorageHistory(id, render);
    else render();
    return true;
  }
  if (type === "storage-admin-manage-reload") {
    await loadManageAccountStorage(action.dataset.userId || "", render);
    return true;
  }
  return true;
}

// The policy form and the limit forms (`[data-storage-admin-form]`).
// Returns true when the form was ours.
export async function submitStorageAdminForm(form, { render }) {
  const kind = form?.dataset?.storageAdminForm;
  if (!kind) return false;
  if (!storageAdminContext()) return true;
  const fields = Object.fromEntries(new FormData(form));
  const expectedRevision = Number(fields.expectedRevision);
  const reason = validReason(fields.reason);
  if (kind === "policy") {
    const admin = state.storageAdmin;
    if (!admin.policyEdit || admin.busy) return true;
    admin.policyEdit.draft = { defaultLimitGb: fields.defaultLimitGb ?? "", maxVideoMb: fields.maxVideoMb ?? "", maxImageMb: fields.maxImageMb ?? "", maxParallelUploads: fields.maxParallelUploads ?? "" };
    const defaultLimitBytes = gigabytesToBytes(fields.defaultLimitGb);
    const maxVideoBytes = megabytesToBytes(fields.maxVideoMb);
    const maxImageBytes = megabytesToBytes(fields.maxImageMb);
    const maxParallelUploads = Number(fields.maxParallelUploads);
    const problems = [];
    if (defaultLimitBytes === null) problems.push("The default limit must be a number of gigabytes (0 allowed).");
    if (maxVideoBytes === null || maxVideoBytes === "0") problems.push("The largest video file must be a number of megabytes above 0.");
    if (maxImageBytes === null || maxImageBytes === "0") problems.push("The largest picture file must be a number of megabytes above 0.");
    if (!Number.isInteger(maxParallelUploads) || maxParallelUploads < 1 || maxParallelUploads > 20) problems.push("Uploads at once must be a whole number from 1 to 20.");
    if (!reason) problems.push(REASON_INVALID);
    if (!Number.isInteger(expectedRevision) || expectedRevision < 1) problems.push("The revision is missing. Read again.");
    if (problems.length) {
      admin.policyEdit.error = problems.join(" ");
      render();
      return true;
    }
    // Only what changed travels, so an untouched value never overwrites another
    // administrator's. "Changed" is measured against what the form showed (the
    // stored value rounded for display), not the stored bytes: a prefilled
    // 209.72 MB left alone is not a change to 209715200 bytes.
    const shown = { defaultLimitBytes: gigabytesToBytes(bytesToGigabytes(admin.policy.defaultLimitBytes)), maxVideoBytes: megabytesToBytes(bytesToMegabytes(admin.policy.maxVideoBytes)), maxImageBytes: megabytesToBytes(bytesToMegabytes(admin.policy.maxImageBytes)) };
    const changes = {};
    if (defaultLimitBytes !== shown.defaultLimitBytes) changes.defaultLimitBytes = defaultLimitBytes;
    if (maxVideoBytes !== shown.maxVideoBytes) changes.maxVideoBytes = maxVideoBytes;
    if (maxImageBytes !== shown.maxImageBytes) changes.maxImageBytes = maxImageBytes;
    if (maxParallelUploads !== Number(admin.policy.maxParallelUploads)) changes.maxParallelUploads = maxParallelUploads;
    if (!Object.keys(changes).length) {
      admin.policyEdit.error = "Nothing changed.";
      render();
      return true;
    }
    await saveStoragePolicy({ changes, expectedRevision, reason }, render);
    return true;
  }
  if (kind === "limit") {
    const scope = form.dataset.scope === "manage" ? "manage" : "panel";
    const found = limitTarget(scope, form.dataset.accountId || "", render);
    if (!found || !found.target.limitEdit || found.target.busy) return true;
    const edit = found.target.limitEdit;
    const remove = form.dataset.mode === "remove";
    const limitBytes = remove ? null : gigabytesToBytes(fields.limitGb);
    edit.draft = { limitGb: fields.limitGb ?? "" };
    const problems = [];
    if (!remove && limitBytes === null) problems.push(LIMIT_INVALID);
    if (!reason) problems.push(REASON_INVALID);
    if (!Number.isInteger(expectedRevision) || expectedRevision < 1) problems.push("The revision is missing. Read again.");
    if (problems.length) {
      edit.error = problems.join(" ");
      render();
      return true;
    }
    await changeStorageLimit({ storageAccountId: found.usage.storageAccountId, limitBytes, expectedRevision, reason }, { target: found.target, apply: found.apply, reread: found.reread, render });
    return true;
  }
  return true;
}
