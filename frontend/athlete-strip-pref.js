// K6 follow-up (2026-11-22): whether a coach hides the athlete strip, remembered per user and per surface (the
// calendar's switcher on a computer, the Weekly plan's switcher). A per-browser convenience only: every read and
// write is inside try/catch, so the screen works without storage (a private window, blocked site data).
const key = (surface, userId) => `optimove.athleteStrip.hidden.${surface}.${String(userId || "anonymous")}`;

export function readAthleteStripHidden(surface, userId) {
  try {
    return globalThis.localStorage?.getItem(key(surface, userId)) === "1";
  } catch {
    return false;
  }
}

export function writeAthleteStripHidden(surface, userId, hidden) {
  try {
    if (hidden) globalThis.localStorage?.setItem(key(surface, userId), "1");
    else globalThis.localStorage?.removeItem(key(surface, userId));
  } catch { /* the choice lives in memory only */ }
}
