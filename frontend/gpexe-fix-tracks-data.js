// Imports Fix flow, slice 2: the track choice of an athlete GPEXE recorded on more than one track (MT, plan
// docs/ai/mt-multiple-tracks-plan.md sections 4 and 12). The read and the write are MT-A's routes, for whoever may approve
// the import; the mapper applies a choice (MT-B), and the J20-A1 recompute shows it in the review. Nothing here decides: the
// server does, under the approval's own locks. A lost answer keeps its request key and is sent again only on "Check the
// result", never by itself.
import { api } from "./api.js";
import { errorInfo, isDefiniteRefusal, recomputeGpexeReview, teamPath } from "./gpexe-import-data.js";
import { state } from "./state.js";

const g = () => state.trainingLoad.gpexe;

// The athletes of the open review that the mapper left out for more than one track.
export function multiTrackIds(candidate) {
  return (candidate?.preview?.athletes || [])
    .filter((a) => a?.notImported?.code === "multiple_tracks")
    .map((a) => String(a.gpexeAthleteId));
}

// The read: per athlete its tracks (start, whole-session duration and distance) and the current choice. Only an approver
// asks (anyone else would get the identical 404).
export async function loadFixTracks(detail, render) {
  const gx = g();
  if (!detail?.fix || !multiTrackIds(detail.candidate).length || gx.status?.viewer?.canApprove !== true) return;
  const generation = gx.generation;
  const candidateId = detail.id;
  detail.fix.tracks = { status: "loading", athletes: [] };
  render();
  try {
    const answer = await api(teamPath(gx.teamId, `/candidates/${encodeURIComponent(candidateId)}/track-choices`));
    if (generation !== gx.generation || gx.detail !== detail) return;
    detail.fix.tracks = { status: "ready", athletes: Array.isArray(answer?.athletes) ? answer.athletes : [] };
  } catch (error) {
    if (generation !== gx.generation || gx.detail !== detail) return;
    detail.fix.tracks = { status: "error", athletes: [], error: errorInfo(error) };
  } finally {
    if (generation === gx.generation && gx.detail === detail) render();
  }
}

// One athlete's entry of the read, or null.
export function trackEntry(detail, gpexeAthleteId) {
  return (detail?.fix?.tracks?.athletes || []).find((a) => String(a.gpexeAthleteId) === String(gpexeAthleteId)) || null;
}

// The athletes the sheet asks about: in the review as multiple_tracks, choosable in the read, without a current choice (or
// with a stale one), not skipped. A choice that is current but not yet in the review waits for the recompute.
export function trackStepIds(detail) {
  const t = detail?.fix?.tracks;
  if (t?.status !== "ready") return [];
  const skipped = new Set(detail.fix.skipped || []);
  return multiTrackIds(detail.candidate).filter((id) => {
    const e = trackEntry(detail, id);
    if (!e || e.choosable !== true || skipped.has(id)) return false;
    return !e.currentChoice || e.currentChoice.choice === "cleared" || e.currentChoice.stale === true;
  });
}

// Choosing is local (a radio); nothing is sent before Save.
export function chooseFixTrack(detail, gpexeAthleteId, value) {
  if (!detail?.fix) return false;
  const w = detail.fix.trackWrite;
  if (w && (w.sending || w.unknown)) return false;
  detail.fix.trackPick = { gpexeAthleteId: String(gpexeAthleteId), value: String(value) };
  detail.fix.trackError = null;
  return true;
}

// Save: one PUT with a fresh key (or, on "Check the result", the same key and body again), then the review's recompute.
export async function sendFixTrack(detail, render, { again = false } = {}) {
  const gx = g();
  const fix = detail?.fix;
  if (!fix) return;
  let w = fix.trackWrite;
  if (again) {
    if (!w?.unknown) return;
  } else {
    if (w?.sending || w?.unknown) return;
    const pick = fix.trackPick;
    const entry = pick ? trackEntry(detail, pick.gpexeAthleteId) : null;
    if (!pick || !entry) return;
    const choice = pick.value === "none" ? "none" : "track";
    if (choice === "track" && !entry.tracks.some((t) => String(t.trackId) === pick.value)) return;
    w = {
      gpexeAthleteId: pick.gpexeAthleteId,
      body: { requestKey: globalThis.crypto.randomUUID(), choice, ...(choice === "track" ? { trackId: pick.value } : {}), expectedChoiceId: entry.currentChoice?.id ?? null },
    };
  }
  const generation = gx.generation;
  fix.trackWrite = { ...w, sending: true, unknown: false };
  fix.trackError = null;
  render();
  try {
    await api(teamPath(gx.teamId, `/candidates/${encodeURIComponent(detail.id)}/track-choices/${encodeURIComponent(w.gpexeAthleteId)}`), { method: "PUT", body: JSON.stringify(w.body) });
    if (generation !== gx.generation || gx.detail !== detail) return;
    fix.trackWrite = null;
    fix.trackPick = null;
    // The review is read again by the server (J20-A1): the athlete leaves "more than one track". Then the read is made again.
    await recomputeGpexeReview(render);
    if (generation !== gx.generation || gx.detail !== detail) return;
    await loadFixTracks(detail, render);
  } catch (error) {
    if (generation !== gx.generation || gx.detail !== detail) return;
    const info = errorInfo(error);
    if (isDefiniteRefusal(info)) {
      // Nothing was saved: the choice can be made again with a new key (a 409 means it changed meanwhile: read it again).
      fix.trackWrite = null;
      fix.trackError = info;
      if (info.status === 409) await loadFixTracks(detail, render);
    } else {
      fix.trackWrite = { ...w, sending: false, unknown: true };
    }
  } finally {
    if (generation === gx.generation && gx.detail === detail && fix.trackWrite?.sending) fix.trackWrite = { ...fix.trackWrite, sending: false };
    if (generation === gx.generation && gx.detail === detail) render();
  }
}
