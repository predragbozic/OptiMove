// Settings > Clubs > a club's licence (roles R4-4, docs/ai/roles-r4-4-screens-contract.md 5.1): the data side over
// R4-3's ceiling routes, GET / POST /api/organization/roles/clubs/:clubId/ceiling. A platform admin reads and changes
// it; the server decides everything again (who may, which part may close) and answers everyone else the identical 404.
// Nothing here is the protection. One write at a time with its requestKey; a lost answer is checked by sending the same
// request again (Check result), never by a read.
import { api } from "./api.js";
import { CENTRAL_CALENDAR_WRITE_BOUND_MS, centralCalendarErrorInfo, centralCalendarOutcomeUnknown, newCentralCalendarRequestKey } from "./central-calendar-data.js";

export const LICENCE_BASE = "/api/organization/roles/clubs";
const ALWAYS_OPEN = new Set(["organization"]);

export function emptyClubLicence() {
  return { clubId: "", clubName: "", open: false, view: null, stale: false, loading: false, error: "", draftClosed: null, reason: "", command: null, notice: "", noticeTone: "ok" };
}

export const licence = emptyClubLicence();
// `generation`: the newest read wins. `epoch`: changes when the state is replaced (another club, a workspace switch),
// so an answer of a write sent before it never settles the state that replaced it.
let generation = 0;
let epoch = 0;

export function resetClubLicence() {
  Object.assign(licence, emptyClubLicence());
  generation += 1;
  epoch += 1;
}

const closedOf = (view) => (view?.modules || []).filter((m) => m.closed).map((m) => m.module).sort();

// The parts the draft would close, or null when nothing is drafted.
export function licenceDraftClosed() {
  return licence.draftClosed ?? closedOf(licence.view);
}

export function licenceChanges() {
  const now = closedOf(licence.view);
  const next = licenceDraftClosed();
  return { close: next.filter((m) => !now.includes(m)).sort(), open: now.filter((m) => !next.includes(m)).sort() };
}

export const licenceHasChanges = () => { const c = licenceChanges(); return c.close.length + c.open.length > 0; };
export const licenceWriteOpen = () => Boolean(licence.command?.busy || licence.command?.unconfirmed);

export function describeLicenceReadError(error) {
  const status = Number(error?.status) || 0;
  if (status === 401) return "Please sign in again to see the licence.";
  if (status === 404) return "This club is not available.";
  return "The licence could not be read. Try again.";
}

// Reads a club's licence. Another club replaces the state at once (never while a write of the first club is open:
// that write stays on screen under its own club); a newer read always wins over an older answer.
export async function loadClubLicence(clubId, render, clubName = "") {
  if (!clubId) return;
  if (licence.clubId !== clubId) {
    if (licenceWriteOpen()) return;
    Object.assign(licence, emptyClubLicence(), { clubId, clubName });
    epoch += 1;
  } else if (clubName) {
    licence.clubName = clubName;
  }
  const mine = ++generation;
  licence.loading = true;
  render?.();
  try {
    const view = await api(`${LICENCE_BASE}/${encodeURIComponent(clubId)}/ceiling`);
    if (mine !== generation || licence.clubId !== clubId) return;
    licence.view = view && Array.isArray(view.modules) ? view : { modules: [], history: [] };
    licence.error = "";
    licence.stale = false;
  } catch (error) {
    if (mine !== generation || licence.clubId !== clubId) return;
    licence.error = describeLicenceReadError(error);
  } finally {
    if (mine === generation && licence.clubId === clubId) licence.loading = false;
  }
  render?.();
}

// Whether the club on screen must be read: another club (whatever is loading for the old one, unless a write of the
// old one is open), or the same club not read yet or out of date after a write.
export function licenceNeedsLoad(clubId) {
  if (!clubId) return false;
  if (licence.clubId !== clubId) return !licenceWriteOpen();
  if (licence.loading || licence.command) return false;
  return licence.stale || (!licence.view && !licence.error);
}

export function toggleLicenceModule(module) {
  if (ALWAYS_OPEN.has(module) || licence.command) return;
  const next = new Set(licenceDraftClosed());
  if (next.has(module)) next.delete(module);
  else next.add(module);
  licence.draftClosed = [...next].sort();
  licence.notice = "";
}

export function setLicenceReason(text) {
  licence.reason = String(text ?? "");
}

export function cancelClubLicence() {
  if (licence.command) return;
  licence.draftClosed = null;
  licence.reason = "";
  licence.notice = "";
}

// The sentence of a refusal, for a platform admin (the only writer). A code it does not know reads as a plain sentence.
export function licenceRefusalText(info) {
  switch (info.code) {
    case "ceiling_unchanged": return "Nothing changed – the licence was already like this.";
    case "module_not_closable": return "Organization is always included.";
    case "notFound": return "This club is not available any more.";
    case "try_again": return "The server is busy. Nothing was written. Try again in a moment.";
    case "permissions_unavailable": return "Permissions could not be checked right now. Try again in a moment.";
    case "request_key_reused": return "This change was already sent with other content. Reload the licence and try again.";
    default: return info.status === 400 && info.message ? info.message : "Nothing was saved.";
  }
}

// Check result: only an answer given after the server read its request record, or one about the body itself, settles
// the first request. A 404 or a busy server comes before that record, so the first write stays not confirmed.
const SETTLING = new Set(["ceiling_unchanged", "module_not_closable", "request_key_reused"]);
export const licenceCheckSettles = (info) => info.status === 400 || SETTLING.has(info.code);

function send(body) {
  const signal = typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function" ? AbortSignal.timeout(CENTRAL_CALENDAR_WRITE_BOUND_MS) : undefined;
  return api(`${LICENCE_BASE}/${encodeURIComponent(licence.clubId)}/ceiling`, { method: "POST", body: JSON.stringify(body), ...(signal ? { signal } : {}) });
}

// What a saved request did, from the request itself: a replayed answer and an answer whose read-back failed carry no
// list of what changed (permissionRolesService.js runWrite / answerAfterCommit).
function savedText(body) {
  const label = (word) => (licence.view?.modules || []).find((m) => m.module === word)?.label || word;
  const parts = [];
  if (body.close.length) parts.push(`taken out: ${body.close.map(label).join(", ")}`);
  if (body.open.length) parts.push(`put back: ${body.open.map(label).join(", ")}`);
  return `Licence saved – ${parts.join("; ")}.`;
}

function settle(view, notice, tone = "ok") {
  // An answer without the licence (a failed read-back) leaves the view out of date: it is read again.
  if (view && Array.isArray(view.modules)) licence.view = view;
  else licence.stale = true;
  licence.command = null;
  licence.draftClosed = null;
  licence.reason = "";
  licence.notice = notice;
  licence.noticeTone = tone;
}

// Save: one request with every part to close and to open. `check`: send the same request again after a lost answer.
export async function saveClubLicence(render, { check = false } = {}) {
  if (licence.command?.busy) return;
  let body;
  if (check) {
    if (!licence.command?.unconfirmed) return;
    body = licence.command.body;
  } else {
    if (licence.command) return;
    const { close, open } = licenceChanges();
    const reason = licence.reason.trim();
    if (!close.length && !open.length) return;
    if (!reason) {
      licence.notice = "Write a reason. It is kept in the licence's history.";
      licence.noticeTone = "error";
      render?.();
      return;
    }
    body = { requestKey: newCentralCalendarRequestKey(), close, open, reason };
  }
  const clubId = licence.clubId;
  const mine = epoch;
  // Only an answer for the state that sent it settles it (not one replaced by another club or a workspace switch).
  const current = () => mine === epoch && licence.clubId === clubId;
  licence.command = { body, busy: true, unconfirmed: check };
  licence.notice = "";
  render?.();
  try {
    const answer = await send(body);
    if (!current()) return;
    settle(answer, savedText(body));
    if (licence.stale) void loadClubLicence(clubId, render);
  } catch (error) {
    if (!current()) return;
    const info = centralCalendarErrorInfo(error);
    if (check ? !licenceCheckSettles(info) : centralCalendarOutcomeUnknown(info)) {
      licence.command = { body, busy: false, unconfirmed: true };
      licence.notice = check ? "Still not confirmed. Try Check result again in a moment." : "";
      licence.noticeTone = "error";
    } else if (info.code === "ceiling_unchanged") {
      settle(info.current, licenceRefusalText(info));
    } else {
      licence.command = null;
      licence.notice = licenceRefusalText(info);
      licence.noticeTone = "error";
      if (info.code === "notFound") licence.view = null;
    }
  }
  render?.();
}
