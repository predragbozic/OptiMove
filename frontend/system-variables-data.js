// Training Load -> Data configuration -> Variables -> From OptiMove (7i-B2,
// J15 section 8.2): a club's administrator uses, copies or hides one of
// OptiMove's ready-made (system) variables. This file holds the facts the
// screen reads from the server's answers (the `club` block of a system row and
// its `actions`), the three writes of 7i-B1 (copy, hide, show), their forms'
// requests and every sentence for their codes. It never works out a right
// from a role: what the caller may do is the server's `actions`, and the
// server decides again on every request.
import { api } from "./api.js";
import { LIMITS, WRITE_BOUND_MS, codeText, newRequestKey } from "./metric-variables-data.js";

const BASE = "/api/training-load/sources/metrics/variables";

export const SYSTEM_MODES = Object.freeze(["copy", "hide", "show"]);
export const isSystemMode = (mode) => SYSTEM_MODES.includes(mode);

function write(path, body) {
  const signal = typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function" ? AbortSignal.timeout(WRITE_BOUND_MS) : undefined;
  return api(path, { method: "POST", body: JSON.stringify(body), ...(signal ? { signal } : {}) });
}
export const copyVariable = (id, body) => write(`${BASE}/${encodeURIComponent(id)}/copy`, body);
export const hideVariable = (id, body) => write(`${BASE}/${encodeURIComponent(id)}/hide`, body);
export const showVariable = (id, body) => write(`${BASE}/${encodeURIComponent(id)}/show`, body);

// ---------------------------------------------------------------------------
// What the list and the detail say about a system variable in this club
// ---------------------------------------------------------------------------
// The server's `club` block on a system row: in a club's own workspace
// { hidden, usedByTeams, hasDataSource, copyId }; in a team workspace only
// { hidden }; nowhere else. A row without it is not shown any status.
export function clubFacts(item) {
  if (!item || item.ownerScope !== "system" || !item.club || typeof item.club !== "object") return null;
  const c = item.club;
  const admin = typeof c.usedByTeams === "boolean";
  return {
    hidden: c.hidden === true,
    admin,
    usedByTeams: admin && c.usedByTeams === true,
    hasDataSource: admin ? c.hasDataSource === true : null,
    copyId: admin && typeof c.copyId === "string" && c.copyId ? c.copyId : null,
  };
}
export const STATUS_LABEL = Object.freeze({
  hidden: "Hidden",
  hiddenByClub: "Hidden by the club",
  used: "Used by this club's teams",
  noSource: "No data source yet",
  notUsed: "Not used",
});
// One status chip per row: hidden first, then used, then no data source.
export function statusOf(facts) {
  if (!facts) return null;
  if (facts.hidden) return facts.admin ? "hidden" : "hiddenByClub";
  if (!facts.admin) return null;
  if (facts.usedByTeams) return "used";
  if (!facts.hasDataSource) return "noSource";
  return "notUsed";
}

// The list's "Available / Hidden by your club / All" select -> the server's
// `hidden` query (exclude | only | include).
export const HIDDEN_FILTERS = Object.freeze([
  { value: "exclude", label: "Available" },
  { value: "only", label: "Hidden by your club" },
  { value: "include", label: "All" },
]);
export const hiddenFilterValue = (value) => (HIDDEN_FILTERS.some((o) => o.value === value) ? value : "exclude");

// ---------------------------------------------------------------------------
// The forms (a copy, a hide, a show), kept in the Variables screen's own
// `form` slot so its leave guards, its write lock and its "Result not
// confirmed" block apply to them unchanged.
// ---------------------------------------------------------------------------
const KEY = /^[a-z][a-z0-9_]{0,62}$/;
const oneLine = (value) => String(value ?? "").replace(/\s+/g, " ").trim();

export function openSystemForm(mode, { variable }) {
  const current = variable?.currentVersion || null;
  return {
    mode,
    variableId: variable?.id || null,
    variableLabel: variable?.label || "",
    // The version the coach saw: the server refuses the copy when OptiMove
    // changed the variable meanwhile (source_version_changed).
    expectedSourceVersionId: current?.id || null,
    original: { label: variable?.label || "", key: variable?.key || "" },
    // The number of GPEXE field links the copy comes with: read once when the
    // card opens ({ state: "loading" | "ready" | "error", count }).
    links: { state: mode === "copy" ? "loading" : "ready", count: null },
    draft: { label: variable?.label || "", key: variable?.key || "" },
    dirty: false,
    requestKey: newRequestKey(),
    busy: false,
    unconfirmed: false,
    checkNote: "",
    errors: {},
    error: "",
  };
}

export function buildSystemRequest(form) {
  const errors = {};
  if (form.mode !== "copy") return { errors, body: { requestKey: form.requestKey } };
  const label = oneLine(form.draft.label);
  const key = String(form.draft.key ?? "").trim();
  if (!label) errors.label = "Enter a name.";
  else if ([...label].length > LIMITS.label) errors.label = `At most ${LIMITS.label} characters.`;
  if (!key) errors.key = "Enter a key.";
  else if (!KEY.test(key)) errors.key = "Lower-case letters, digits and underscores, starting with a letter, at most 63.";
  if (Object.keys(errors).length) return { body: null, errors };
  if (!form.expectedSourceVersionId) return { body: null, errors: { label: "Open the variable again and copy." } };
  // A name or a key the coach left as it is stays out of the request: the
  // server then takes OptiMove's own (J15 4.1).
  return {
    errors,
    body: {
      requestKey: form.requestKey,
      expectedSourceVersionId: form.expectedSourceVersionId,
      ...(label !== oneLine(form.original.label) ? { label } : {}),
      ...(key !== form.original.key ? { key } : {}),
    },
  };
}

export const SYSTEM_WRITES = Object.freeze({
  copy: (form) => copyVariable(form.variableId, form.sentBody),
  hide: (form) => hideVariable(form.variableId, form.sentBody),
  show: (form) => showVariable(form.variableId, form.sentBody),
});

// ---------------------------------------------------------------------------
// Sentences
// ---------------------------------------------------------------------------
// After a Check result only the answers the server gives once it has read its
// request record settle what happened to the first write: a refusal by the
// state or by the body. Busy, a server error and no access do not.
const SETTLED_ON_CHECK = new Set([
  "invalid_body", "label_required", "key_required", "key_taken", "source_not_active", "source_version_changed", "already_copied",
  "copy_source_unsupported", "copy_mapping_not_reproducible", "copy_too_large", "copy_source_not_system", "hide_not_system", "variable_in_use",
]);
export const systemCheckSettles = (info) => SETTLED_ON_CHECK.has(info.code);

const TEXT = {
  already_copied: "Your club already has a copy of this variable.",
  variable_in_use: "Teams of this club still use it. Switch it off for your teams first.",
  source_version_changed: "OptiMove changed this variable a moment ago. Open it again and copy.",
  source_not_active: "OptiMove has archived this variable, so it can't be copied.",
  copy_mapping_not_reproducible: "One of its GPEXE field links can't be copied now. Ask a platform administrator.",
  copy_source_unsupported: "This variable can't be copied into a club. Use it as it is instead.",
  copy_too_large: "It has too many links to copy at once. Ask a platform administrator.",
  copy_source_not_system: "This is not one of OptiMove's variables, so it can't be copied from there.",
  hide_not_system: "This is not one of OptiMove's variables, so it can't be hidden.",
  key_required: "No key can be made from this name. Enter one under Advanced.",
  key_taken: "Your club already has a variable with this key. Change the key under Advanced.",
  label_required: "Enter a name.",
};
export function systemCodeText(info, form) {
  if (info.code === "variable_hidden") return `This club hides ${form?.variableLabel || "this variable"}. Show it again first.`;
  return TEXT[info.code] || codeText(info);
}

// The notices after a settled write.
export function savedNotice(mode, data, label) {
  if (mode === "copy") {
    if (data?.readError) return "The copy was made, but it could not be read back. Find it under This club.";
    return `Copied. Next: open each draft link, submit it and activate it. Then move the teams that use OptiMove's ${label} with Move your teams to this copy; switch it on only for teams that do not use it yet.`;
  }
  if (data?.readError) return `The change was saved, but ${label} could not be read back. Open it again.`;
  return mode === "hide" ? `${label} is hidden from this club.` : `${label} is shown again.`;
}
