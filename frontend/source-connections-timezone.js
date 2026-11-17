// Settings > Source connections: the session time zone of each bound team (manager, 2026-11-17, after PR #587). The club
// admin's own place for it: the zone in force or "Not set", Change (a zone and a mandatory reason) and Clear (a mandatory
// reason and the consequence). Platform admins keep Settings > Data sources as well.
//
// Who sees the line is the server's decision: the GET of a team's zone answers 403 (or 404) to everyone the status would
// not mark with sessionTimezoneAdmin, and then the line is simply not shown. The save rules are the Imports review's
// (gpexe-timezone-data.js): saved, not saved (only the route's refusals before any write), or not confirmed, with a
// Check that only reads.
import { api } from "./api.js";
import { bounded, definiteRefusal, timezoneErrorInfo, timezonePath, TIMEZONE_REASON_MAX } from "./gpexe-timezone-data.js";
import { state } from "./state.js";

export { TIMEZONE_REASON_MAX };

const sc = () => state.sourceConnections;
const zones = () => {
  const d = sc();
  if (!d.zones || typeof d.zones !== "object") d.zones = {};
  return d.zones;
};

export function teamZone(teamId) {
  return zones()[String(teamId)] || null;
}

// A save in flight, a check in flight, or an outcome not confirmed: leaving the screen would lose the only view of it.
export function zoneWriteHeld() {
  return Object.values(zones()).some((z) => z.step === "saving" || z.step === "checking" || z.step === "unknown");
}

// The active bound teams of every connection on screen, once each.
function boundTeamIds() {
  const ids = new Set();
  for (const c of sc().connections || []) for (const b of c.boundTeams || []) if (b.teamId && b.teamActive !== false) ids.add(String(b.teamId));
  return [...ids];
}

function fromAnswer(answer) {
  const current = answer?.sessionTimezone?.current || null;
  return { current: current?.timezone || null, setByName: current?.setByName || "", setAt: current?.setAt || null };
}

// After the list is read: each bound team's zone, in parallel. A held outcome (saving, not confirmed) is never replaced.
// After a write that changed the bound teams (a bind, an Unbind, a Test or Reconnect answer), `onlyMissing` reads just
// the teams that have no line yet, so a line on screen (and an open form) is not drawn again (code review).
export async function loadTeamZones(render, { onlyMissing = false } = {}) {
  const d = sc();
  const generation = d.generation;
  const all = zones();
  const ids = boundTeamIds();
  for (const id of Object.keys(all)) if (!ids.includes(id) && !["saving", "checking", "unknown"].includes(all[id].step)) delete all[id];
  const toRead = onlyMissing ? ids.filter((id) => !all[id]) : ids;
  if (!toRead.length) return;
  await Promise.all(toRead.map((teamId) => readZone(teamId, generation)));
  if (generation === d.generation) render();
}

// An open zone form counts as an open form of the screen: one form, one write at a time (code review).
export function zoneFormOpen() {
  return Object.values(zones()).some((z) => z.step === "open" || z.step === "saving");
}

// What she types stays in state, so a repaint while the form is open keeps it (code review).
export function handleZoneInput(target) {
  const form = target?.closest?.('form[data-source-connections-form="zone"]');
  if (!form) return false;
  const z = teamZone(form.dataset.teamId);
  if (!z || z.step !== "open") return true;
  if (target.name === "timezone") z.timezone = String(target.value ?? "");
  if (target.name === "reason") z.reason = String(target.value ?? "");
  return true;
}

async function readZone(teamId, generation = sc().generation) {
  const all = zones();
  const held = all[teamId];
  if (held && ["saving", "checking", "unknown", "open"].includes(held.step)) return;
  all[teamId] = { ...(held || {}), step: "loading" };
  try {
    const answer = await api(timezonePath(teamId), bounded());
    if (generation !== sc().generation || zones()[teamId]?.step !== "loading") return;
    zones()[teamId] = { step: "shown", ...fromAnswer(answer), notice: held?.notice || "" };
  } catch (error) {
    if (generation !== sc().generation || zones()[teamId]?.step !== "loading") return;
    const info = timezoneErrorInfo(error);
    // Not this viewer's to see (the status would not mark them): no line at all.
    zones()[teamId] = info.status === 403 || info.status === 404 ? { step: "hidden" } : { step: "readFailed" };
  }
}

export async function retryZone(teamId, render) {
  await readZone(String(teamId));
  render();
}

// Change (mode "change": a zone and a reason) or Clear (mode "clear": a reason only).
export function openZoneForm(teamId, mode) {
  const z = teamZone(teamId);
  if (!z || z.step !== "shown" || zoneFormOpen()) return false;
  if (mode === "clear" && !z.current) return false;
  Object.assign(z, { step: "open", mode, timezone: mode === "change" ? (z.current || "") : "", reason: "", problem: "", error: null, notice: "" });
  return true;
}

export function cancelZoneForm(teamId) {
  const z = teamZone(teamId);
  if (!z || z.step !== "open") return false;
  Object.assign(z, { step: "shown", problem: "", error: null });
  return true;
}

export function zoneFormProblem(z, { timezone, reason }) {
  if (z.mode === "change") {
    if (!timezone) return "Choose a time zone.";
    if (timezone === z.current) return "That is already the team's time zone. Nothing to save.";
  }
  const trimmed = String(reason || "").trim();
  if (!trimmed) return "Write why, for the record.";
  if (trimmed.length > TIMEZONE_REASON_MAX) return `The reason is too long (at most ${TIMEZONE_REASON_MAX} characters).`;
  return "";
}

const savedNotice = (target) => (target ? `Saved. The team's time zone is ${target}.` : "Cleared. The team has no session time zone.");

export async function saveZone(teamId, { timezone, reason }, render) {
  const z = teamZone(teamId);
  if (!z || z.step !== "open") return;
  z.timezone = timezone;
  z.reason = reason;
  z.problem = zoneFormProblem(z, { timezone, reason });
  if (z.problem) {
    render();
    return;
  }
  const target = z.mode === "clear" ? null : timezone;
  const generation = sc().generation;
  z.target = target;
  z.step = "saving";
  z.error = null;
  render();
  try {
    const answer = await api(timezonePath(teamId), bounded({ method: "PUT", body: JSON.stringify({ timezone: target, reason: String(reason).trim() }) }));
    if (generation !== sc().generation || teamZone(teamId) !== z) return;
    // A save the server confirmed stays saved even when its details could not be read back (readError).
    const read = fromAnswer(answer);
    Object.assign(z, { step: "shown", current: answer?.sessionTimezone?.readError ? target : read.current, setByName: read.setByName, setAt: read.setAt, notice: savedNotice(target) });
  } catch (error) {
    if (generation !== sc().generation || teamZone(teamId) !== z) return;
    const info = timezoneErrorInfo(error);
    z.error = info;
    z.step = definiteRefusal(info) ? "open" : "unknown";
  }
  render();
}

// After a lost answer: read the zone again. The save is never sent again from here.
export async function checkZone(teamId, render) {
  const z = teamZone(teamId);
  if (!z || z.step !== "unknown") return;
  const generation = sc().generation;
  z.step = "checking";
  render();
  try {
    const answer = await api(timezonePath(teamId), bounded());
    if (generation !== sc().generation || teamZone(teamId) !== z) return;
    const read = fromAnswer(answer);
    if (read.current === z.target) Object.assign(z, { step: "shown", ...read, error: null, notice: savedNotice(z.target) });
    else Object.assign(z, { step: "open", current: read.current, error: { status: 0, code: "not_saved_after_check", message: "" } });
  } catch (error) {
    if (generation !== sc().generation || teamZone(teamId) !== z) return;
    const info = timezoneErrorInfo(error);
    // No right to read it any more (a revoked role, an archived team): the outcome can never be read from here, so the
    // screen is released with a sentence instead of staying locked (code review).
    z.step = info.status === 403 || info.status === 404 ? "lost" : "unknown";
  }
  render();
}
