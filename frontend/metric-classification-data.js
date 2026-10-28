// Training Load -> Data configuration -> Variables -> Domains & categories
// (phase 12c; the contract is J6, docs/ai/phase12-domains-categories-contract.md,
// the API is PR #247): the domains and categories of canonical variables and
// their links, over /api/training-load/sources/metrics/classification. The
// screen never sends an owner, an actor or a basis: the server derives the
// owner from the active workspace and answers everyone else with the same 404.
// What a caller may do with a domain, category or link is the server's answer
// (`editable`, `actions`), never worked out here from a role.
import { api } from "./api.js";
import { LIMITS, TEXT_FORBIDDEN, WRITE_BOUND_MS, errorInfo, newRequestKey, outcomeUnknown } from "./metric-variables-data.js";

export { errorInfo, outcomeUnknown };

const BASE = "/api/training-load/sources/metrics/classification";
// The admin API's limits (J6 3.1): a name as M3-0's label, a description, a reason.
export const CLASS_LIMITS = Object.freeze({ name: LIMITS.label, description: LIMITS.description, reason: LIMITS.reason, key: LIMITS.key });
const KEY = /^[a-z][a-z0-9_]{0,62}$/;

// The modes of the one open form (it shares the Variables screen's form slot,
// so one write runs at a time and leaving asks first).
export const CLASSIFICATION_MODES = Object.freeze([
  "node-create", "node-rename", "node-archive", "node-restore", "category-place", "variable-link", "link-remove",
]);
export const isClassificationMode = (mode) => CLASSIFICATION_MODES.includes(mode);

export function emptyClassificationState() {
  return { tree: null, loaded: false, loading: false, error: null };
}

// ---------------------------------------------------------------------------
// Reads and writes
// ---------------------------------------------------------------------------
export const fetchClassification = () => api(BASE);
function write(path, body) {
  const signal = typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function" ? AbortSignal.timeout(WRITE_BOUND_MS) : undefined;
  return api(path, { method: "POST", body: JSON.stringify(body), ...(signal ? { signal } : {}) });
}
const PLURAL = { domain: "domains", category: "categories" };
export const createNode = (kind, body) => write(`${BASE}/${PLURAL[kind]}`, body);
export const changeNode = (kind, id, verb, body) => write(`${BASE}/${PLURAL[kind]}/${encodeURIComponent(id)}/${verb}`, body);
export const createLink = (body) => write(`${BASE}/links`, body);
export const removeLink = (id, body) => write(`${BASE}/links/${encodeURIComponent(id)}/remove`, body);

// ---------------------------------------------------------------------------
// The tree (C1): each domain with the categories placed under it, then the
// categories in no domain. A category sits under at most one domain (O3).
// ---------------------------------------------------------------------------
export function treeOf(classification) {
  const t = classification || {};
  const domains = t.domains || [];
  const categories = t.categories || [];
  const links = t.categoryDomains || [];
  const byId = new Map(categories.map((c) => [c.id, c]));
  const placed = new Map();
  for (const link of links) {
    if (byId.has(link.categoryId) && !placed.has(link.categoryId)) placed.set(link.categoryId, link);
  }
  return {
    domains: domains.map((domain) => ({
      domain,
      categories: links.filter((l) => l.domainId === domain.id && byId.has(l.categoryId) && placed.get(l.categoryId) === l)
        .map((link) => ({ category: byId.get(link.categoryId), link })),
    })),
    unplaced: categories.filter((c) => !placed.has(c.id)),
    // A placement whose domain is not in this read (the read is cut at 500).
    placedElsewhere: categories.filter((c) => placed.has(c.id) && !domains.some((d) => d.id === placed.get(c.id).domainId)),
    linkOf: (categoryId) => placed.get(categoryId) || null,
    truncated: t.truncated === true,
  };
}
export const findNode = (classification, kind, id) => (classification?.[PLURAL[kind]] || []).find((n) => n.id === id) || null;

// The workspace's own active domains and categories: the containers a link of
// this workspace may use (O4: a link stays inside its owner).
export function ownActive(classification, kind, ctx) {
  return (classification?.[PLURAL[kind]] || []).filter((n) => n.state === "active" && n.ownerScope === ctx.owner);
}
// The domains a category may be placed under: its own owner's or the system's (O4).
export function placeableDomains(classification) {
  return (classification?.domains || []).filter((n) => n.state === "active");
}

// ---------------------------------------------------------------------------
// The forms
// ---------------------------------------------------------------------------
const NOUN = { domain: "domain", category: "category" };
export const nounOf = (kind) => NOUN[kind] || "item";

export function openClassificationForm(mode, params = {}) {
  const base = {
    mode,
    requestKey: newRequestKey(),
    busy: false,
    unconfirmed: false,
    checkNote: "",
    dirty: false,
    errors: {},
    error: "",
    // Where the screen goes after the form: the tree, or the variable it was opened from.
    returnTo: params.returnTo || "classification",
    variableId: params.variableId || null,
  };
  if (mode === "node-create") return { ...base, kind: params.kind, draft: { name: "", description: "", key: "" } };
  if (mode === "node-rename") {
    const node = params.node;
    const original = { name: node?.name || "", description: node?.description || "" };
    return { ...base, kind: params.kind, nodeId: node?.id || null, nodeName: node?.name || "", namesToken: node?.namesToken || null, truncated: node?.truncated === true, original, draft: { ...original } };
  }
  if (mode === "node-archive" || mode === "node-restore") {
    return { ...base, kind: params.kind, nodeId: params.node?.id || null, nodeName: params.node?.name || "", draft: { reason: "" } };
  }
  if (mode === "category-place") return { ...base, categoryId: params.category?.id || null, nodeName: params.category?.name || "", draft: { targetId: "" } };
  if (mode === "variable-link") return { ...base, linkKind: params.linkKind, variableLabel: params.variableLabel || "", draft: { targetId: "" } };
  if (mode === "link-remove") return { ...base, linkId: params.linkId, what: params.what || "", draft: { reason: "" } };
  return { ...base, draft: {} };
}

const oneLine = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
function textError(value, max, { required = false } = {}) {
  if (!value) return required ? "Required." : "";
  if ([...value].length > max) return `At most ${max} characters.`;
  if (TEXT_FORBIDDEN.test(value)) return "Contains a character that cannot be saved.";
  return "";
}

// The request of the form and its field errors; `body` is null while a field
// is wrong, or (a rename) when nothing changed (`unchanged`).
export function buildClassificationRequest(form) {
  const d = form.draft;
  const errors = {};
  if (form.mode === "node-create") {
    const name = oneLine(d.name);
    const description = oneLine(d.description);
    const key = String(d.key ?? "").trim();
    const set = (field, message) => { if (message) errors[field] = message; };
    set("name", textError(name, CLASS_LIMITS.name, { required: true }));
    set("description", textError(description, CLASS_LIMITS.description));
    if (key && !KEY.test(key)) errors.key = "Lower-case letters, digits and underscores, starting with a letter, at most 63.";
    if (Object.keys(errors).length) return { body: null, errors };
    return { errors, body: { requestKey: form.requestKey, name, ...(description ? { description } : {}), ...(key ? { key } : {}) } };
  }
  if (form.mode === "node-rename") {
    // Only a value the coach changed from what its field showed is checked and
    // sent: a saved one is kept exactly as it is (the server applies its text
    // rule to a changed value only).
    const changed = {};
    for (const [field, max, required] of [["name", CLASS_LIMITS.name, true], ["description", CLASS_LIMITS.description, false]]) {
      const value = oneLine(d[field]);
      if (value === oneLine(form.original[field])) continue;
      const message = textError(value, max, { required });
      if (message) errors[field] = message;
      else changed[field] = value || null;
    }
    if (Object.keys(errors).length) return { body: null, errors };
    if (!Object.keys(changed).length) return { body: null, errors, unchanged: true };
    return { errors, body: { requestKey: form.requestKey, namesToken: form.namesToken, ...changed } };
  }
  if (form.mode === "node-archive" || form.mode === "node-restore" || form.mode === "link-remove") {
    const reason = oneLine(d.reason);
    const message = textError(reason, CLASS_LIMITS.reason, { required: form.mode === "node-archive" });
    if (message) return { body: null, errors: { reason: message } };
    return { errors, body: { requestKey: form.requestKey, ...(reason ? { reason } : {}) } };
  }
  if (form.mode === "category-place" || form.mode === "variable-link") {
    if (!d.targetId) return { body: null, errors: { targetId: "Choose one." } };
    if (form.mode === "category-place") return { errors, body: { requestKey: form.requestKey, categoryId: form.categoryId, domainId: d.targetId } };
    return { errors, body: { requestKey: form.requestKey, variableId: form.variableId, [form.linkKind === "domain" ? "domainId" : "categoryId"]: d.targetId } };
  }
  return { body: null, errors };
}

// ---------------------------------------------------------------------------
// Answers
// ---------------------------------------------------------------------------
// Check result sends the same request again; only these answers settle what
// happened to the first one (they come from the body itself, or after the
// server's request record showed that nothing was saved under the key).
const SETTLED_ON_CHECK = new Set([
  "invalid_body", "key_required", "key_taken", "node_changed", "rename_unchanged", "node_not_active", "node_active",
  "node_archived", "variable_not_active", "link_outside_owner", "category_has_domain", "link_exists",
]);
export const checkSettles = (info) => SETTLED_ON_CHECK.has(info.code);
export function checkNoteText(info) {
  if (outcomeUnknown(info)) return "No answer again. The result is still not confirmed.";
  if (info.status === 401) return "The check could not be done: you are signed out. Sign in again in a new tab, then Check result here.";
  if (info.code === "request_key_reused") return "The check could not be done: a save under this request is already stored with other values. Close without checking and look at the list.";
  if (info.code === "notFound") return "The check could not be done: this workspace has no access to it now. The result is still not confirmed.";
  if (info.code === "try_again") return "The check could not be done: the server was busy. The result is still not confirmed; Check result again in a moment.";
  return "The check could not be done. The result is still not confirmed; Check result again in a moment.";
}

const CODE_TEXT = {
  notFound: "It is not available in this workspace, or it is no longer there. Nothing was saved.",
  key_required: "No key can be made from this name (a key uses only the letters a-z, digits and underscores). Enter a custom key under Technical details, starting with a letter.",
  key_taken: "Another one here already uses this key (an archived one counts too). Change the key under Technical details, or the name.",
  node_changed: "Someone changed it in the meantime, so your change was not saved. This is how it is now; make your change again if it is still needed.",
  rename_unchanged: "Nothing changed: these are the saved name and description.",
  node_not_active: "It is archived now, so it cannot be changed. Nothing was saved.",
  node_active: "It is active (perhaps restored in the meantime), so there is nothing to restore.",
  node_archived: "An archived domain or category cannot be linked. Nothing was saved.",
  variable_not_active: "This variable is archived, so it cannot be linked. Nothing was saved.",
  link_outside_owner: "This link would reach outside this workspace's own domains and categories. Nothing was saved.",
  category_has_domain: "This category is already in a domain (perhaps placed in the meantime). Remove it from that domain first. Nothing was saved.",
  link_exists: "This link already exists. Nothing was saved.",
  try_again: "The server was busy. Nothing was saved. Try again.",
  internal_error: "The server could not save it. Nothing was saved. Try again.",
  request_key_reused: "An earlier save of this form may already be stored. Cancel and check before saving again.",
};
const MODE_TEXT = {
  "node-archive": { node_not_active: "It is already archived." },
};
export function classificationCodeText(info, mode = "") {
  if (info.code === "invalid_body") return "Not saved: the server refused a value. Check the fields and save again.";
  return MODE_TEXT[mode]?.[info.code] || CODE_TEXT[info.code] || (info.status ? "Something went wrong. Nothing was saved." : "No answer from the server.");
}
// The refusals after which the form no longer fits what is saved: it is closed
// and the screen read again.
export const CLOSES_FORM = new Set([
  "notFound", "node_changed", "node_not_active", "node_active", "node_archived", "variable_not_active",
  "category_has_domain", "link_exists", "link_outside_owner",
]);
