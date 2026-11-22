// v88: the list of positions (Settings -> Tags & Presets) and the athletes' positions of the workspace (Settings ->
// Athletes). Routes: GET/POST /api/positions, POST /api/positions/:id/{rename,archive,restore},
// GET /api/positions/athletes, PUT /api/positions/athletes/:athleteId. The server decides who may read and write; a
// 404 means "not in this workspace".
import { api } from "./api.js";
import { emptyPositionsState, state } from "./state.js";

const newKey = () => (globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() : `${Date.now()}-${Math.random()}`.replace(/[^0-9a-f]/g, "0"));

export function resetPositions() {
  state.positions = emptyPositionsState();
}

// The list and the athletes' positions, read together (the athletes' read is the 404 outside a club or team workspace).
let generation = 0;
export async function loadPositions({ force = false } = {}) {
  const p = state.positions;
  if ((p.loaded && !force) || p.loading) return;
  const mine = ++generation;
  p.loading = true;
  try {
    const [list, athletes] = await Promise.all([
      api("/api/positions").catch((error) => (error?.status === 404 ? null : Promise.reject(error))),
      api("/api/positions/athletes").catch((error) => (error?.status === 404 ? null : Promise.reject(error))),
    ]);
    if (mine !== generation) return;
    p.list = list?.positions ?? [];
    p.canAdd = list?.canAdd ?? null;
    p.canSet = Boolean(athletes?.canSet);
    p.assignments = Object.fromEntries((athletes?.assignments ?? []).map((a) => [a.athleteId, a.positionId]));
    p.assignmentsLoaded = Boolean(athletes);
    p.error = "";
    p.loaded = true;
  } catch (error) {
    if (mine === generation) p.error = "Positions could not be read. Try again.";
  } finally {
    if (mine === generation) p.loading = false;
  }
}

// A refusal in the user's words; anything else is "not confirmed" (the same key is kept for a resend).
const REFUSALS = {
  name_taken: "A position with this name already exists.",
  name_changed: "The name was changed meanwhile. Check it and try again.",
  name_unchanged: "That is already its name.",
  position_archived: "This position is archived.",
  position_active: "This position is not archived.",
  position_changed: "The position was changed meanwhile. Check it and save again.",
  position_not_offered: "This position is no longer on your club's list.",
  invalid_name: "Enter a name of 1 to 60 characters on one line.",
  request_key_reused: "Something changed while saving. Try again.",
  try_again: "The list was busy and nothing was saved. Try again.",
  notFound: "You can no longer change this here.",
};

// One write. op names the operation (a lost answer keeps its key under op until a definite answer).
export async function sendPositionWrite(op, path, method, body) {
  const p = state.positions;
  const requestKey = p.keys[op] ?? newKey();
  p.keys[op] = requestKey;
  try {
    const answer = await api(path, { method, body: JSON.stringify({ requestKey, ...body }) });
    delete p.keys[op];
    return { ok: true, answer };
  } catch (error) {
    const status = error?.status;
    const code = error?.data?.error ?? error?.message;
    if (status && status < 500 && status !== 408) {
      delete p.keys[op];
      return { ok: false, message: REFUSALS[code] ?? "Nothing was saved. Try again.", code, current: error?.data?.current ?? null };
    }
    return { ok: false, unconfirmed: true, message: "The result is not confirmed. Save again to check it; it will not be saved twice." };
  }
}

export const positionById = (id) => state.positions.list.find((x) => x.id === id) ?? null;
