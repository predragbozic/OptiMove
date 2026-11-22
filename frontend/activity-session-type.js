// ST-5 (docs/ai/session-type-plan.md sections 3, 5 and 17): the session's type and an athlete's own type on the Roster tab.
//
// The session's type is changed in the roster's header; an athlete's own type ("did RTP in this session") in the row's
// Details. Both are saved as soon as they are picked, with Undo (the same route sets the previous type back for the same
// person, no reason asked). Routes of ST-3:
//   POST /api/training-activity/:activityId/type                    { activityTypeKey, requestKey }
//   PUT  /api/training-activity/:activityId/roster/:athleteId/type  { activityTypeKey | null, requestKey }
//
// One small module (data, view and the two handlers) beside the roster's own three: it uses the roster's command
// sender and its three outcomes - saved, refused (nothing written), not confirmed (Check result repeats the same
// request with the same key, so it can never write twice).
import { api } from "./api.js";
import { state } from "./state.js";
import { escapeAttr, escapeHtml } from "./utils.js";
import { newRosterRequestKey, refreshActivityRoster, sendRosterCommand } from "./activity-roster-data.js";

function roster() {
  return state.trainingLoad.calendar.roster;
}

// The slice: `list` = the session types of the workspace; `busy` = a change in flight; `unconfirmed` = the one command
// whose answer was lost; `notice` = the last outcome.
export function typeState(r = roster()) {
  if (!r.types) r.types = { list: null, busy: null, unconfirmed: null, notice: null };
  return r.types;
}

export function typeChangeBusy(r = roster()) {
  const t = r?.types;
  return Boolean(t?.busy || t?.unconfirmed);
}

// "c_1a2b3c4d_gym" -> "Gym", "rtp_session" -> "Rtp session": only until the list is read, or for a type the list lacks.
function wordsOf(key) {
  return String(key || "").replace(/^[cs]_[0-9a-f]{8}_/, "").replace(/_/g, " ").replace(/^./, (ch) => ch.toUpperCase());
}

export function sessionTypeLabelOf(key, r = roster()) {
  if (!key) return "";
  const found = (r.types?.list?.types || []).find((t) => t.key === key);
  return found ? found.label : wordsOf(key);
}

// Read once per opened session; a failed read leaves the labels as words and the choosers with the current type only.
export async function loadRosterSessionTypes(render, { again = false } = {}) {
  const r = roster();
  const t = typeState(r);
  if (t.list && !(again && t.list.status === "error")) return;
  const activityId = r.activityId;
  const mine = { status: "loading", types: [] };
  t.list = mine;
  try {
    const answer = await api("/api/training-activity/session-types");
    if (roster().activityId !== activityId || typeState().list !== mine) return;
    typeState().list = {
      status: "ready",
      types: (Array.isArray(answer?.types) ? answer.types : []).filter((x) => x && typeof x.key === "string").map((x) => ({ key: x.key, label: String(x.label ?? x.key), active: x.active !== false })),
    };
  } catch {
    if (roster().activityId !== activityId || typeState().list !== mine) return;
    typeState().list = { status: "error", types: [] };
  }
  render();
}

const REFUSAL_TEXT = {
  session_type_not_offered: "That session type is no longer offered. Choose another. Nothing was saved.",
  same_as_session: "That is already the session's type, so there is nothing to set. Nothing was saved.",
  athlete_has_no_record: "This athlete has no values in this session yet. Use \"Estimate values…\" in the athlete's row first, then set the type. Nothing was saved.",
  activity_superseded: "This session was merged into another. Nothing was saved - open the current session.",
  try_again: "The session is being changed right now. Nothing was saved - try again in a moment.",
  roster_busy: "The session is being changed right now. Nothing was saved - try again in a moment.",
  not_a_team_coach: "You can no longer change this session. Nothing was saved.",
  notFound: "This session is no longer available to you. Nothing was saved.",
};

function commandFor(activityId, target, requestKey) {
  const base = `/api/training-activity/${encodeURIComponent(activityId)}`;
  if (target.scope === "session") return { method: "POST", path: `${base}/type`, body: { activityTypeKey: target.typeKey, requestKey } };
  return { method: "PUT", path: `${base}/roster/${encodeURIComponent(target.athleteId)}/type`, body: { activityTypeKey: target.typeKey ?? null, requestKey } };
}

function savedText(target, body, r) {
  if (target.scope === "session") {
    if (body?.changed === false) return `The session type is already ${sessionTypeLabelOf(target.typeKey, r)}.`;
    const ended = (body?.endedExceptionAthleteIds || []).length;
    return `Session type saved: ${sessionTypeLabelOf(target.typeKey, r)}.${ended ? ` ${ended === 1 ? "1 athlete's own type was the same and was removed." : `${ended} athletes' own types were the same and were removed.`}` : ""}`;
  }
  const who = target.athleteName || "The athlete";
  if (body?.changed === false) return `Nothing changed for ${who}.`;
  return target.typeKey ? `Saved: ${who} did ${sessionTypeLabelOf(target.typeKey, r)} in this session.` : `Saved: ${who} has the session's type again.`;
}

// Sends one change. `target` = { scope: "session" | "athlete", athleteId?, athleteName?, typeKey, previousKey }.
// `command` is given only by Check result (the same request again).
async function send(target, render, command = null) {
  const r = roster();
  const t = typeState(r);
  const activityId = r.activityId;
  if (!activityId || t.busy) return;
  const cmd = command ?? commandFor(activityId, target, newRosterRequestKey());
  t.busy = { scope: target.scope, athleteId: target.athleteId ?? null };
  t.unconfirmed = null;
  t.notice = null;
  // The roster's own "one command at a time" lock sees this write too.
  const busyKey = target.scope === "athlete" ? target.athleteId : "__session_type";
  r.busy = { ...(r.busy || {}), [busyKey]: true };
  render();
  const result = await sendRosterCommand(cmd);
  if (roster().activityId !== activityId) return;
  const { [busyKey]: _done, ...rest } = roster().busy || {};
  roster().busy = rest;
  t.busy = null;
  if (result.outcome === "saved") {
    const changed = result.body?.changed !== false;
    t.notice = {
      tone: "saved", scope: target.scope, athleteId: target.athleteId ?? null, text: savedText(target, result.body, r),
      // Undo sets the previous type back; not offered when nothing changed or when the change also ended other rows.
      undo: changed && !(result.body?.endedExceptionAthleteIds || []).length
        ? { scope: target.scope, athleteId: target.athleteId ?? null, athleteName: target.athleteName ?? null, typeKey: target.previousKey ?? null, previousKey: target.typeKey ?? null }
        : null,
    };
    await refreshActivityRoster(activityId, render);
  } else if (result.outcome === "refused") {
    t.notice = { tone: "refused", scope: target.scope, athleteId: target.athleteId ?? null, text: REFUSAL_TEXT[result.code] || "Nothing was saved. Try again.", code: result.code };
    // The session may have changed under the coach (another type, a merge): show it as it is now.
    await refreshActivityRoster(activityId, render);
  } else {
    t.unconfirmed = { target, command: cmd };
    t.notice = { tone: "unconfirmed", scope: target.scope, athleteId: target.athleteId ?? null, text: `We can't tell yet whether the ${target.scope === "athlete" ? "athlete's type" : "session type"} was saved. Check the result; it will not be saved twice.` };
  }
  render();
}

// --- the handlers (called from activity-roster-actions.js) ---
export async function handleSessionTypeAction(action, { render, locked }) {
  const type = action.dataset.action;
  const r = roster();
  const t = typeState(r);
  if (type === "training-load-roster-type-list-again") {
    await loadRosterSessionTypes(render, { again: true });
    return true;
  }
  if (type === "training-load-roster-type-check") {
    if (t.unconfirmed && !t.busy) await send(t.unconfirmed.target, render, t.unconfirmed.command);
    return true;
  }
  if (type === "training-load-roster-type-dismiss") {
    t.notice = null;
    render();
    return true;
  }
  // Every change below obeys the roster's lock and this module's own.
  if (locked || typeChangeBusy(r) || !r.data) return true;
  const sessionKey = r.data.activity?.activityTypeKey ?? null;
  if (type === "training-load-roster-type-undo") {
    const undo = t.notice?.undo;
    if (undo) await send(undo, render);
    return true;
  }
  if (type === "training-load-roster-session-type") {
    const next = String(action.value || "");
    if (!next || next === sessionKey) return true;
    await send({ scope: "session", typeKey: next, previousKey: sessionKey }, render);
    return true;
  }
  if (type === "training-load-roster-athlete-type") {
    const athleteId = action.dataset.athleteId;
    const athlete = (r.data.athletes || []).find((a) => a.athleteId === athleteId);
    if (!athlete?.sessionType) return true;
    const current = athlete.sessionType.exception?.activityTypeKey ?? null;
    const next = String(action.value || "") || null;
    if (next === current || (next !== null && next === sessionKey)) return true;
    await send({ scope: "athlete", athleteId, athleteName: athlete.name || "The athlete", typeKey: next, previousKey: current }, render);
    return true;
  }
  return true;
}

// --- the view ---
function optionsFor(r, currentKey) {
  const types = (r.types?.list?.types || []).filter((x) => x.active || x.key === currentKey);
  if (currentKey && !types.some((x) => x.key === currentKey)) types.unshift({ key: currentKey, label: sessionTypeLabelOf(currentKey, r), active: false });
  return types;
}

function noticeFor(r, scope, athleteId = null) {
  const n = r.types?.notice;
  if (!n || n.scope !== scope || (scope === "athlete" && n.athleteId !== athleteId)) return "";
  const busy = Boolean(r.types?.busy);
  const buttons = [
    n.tone === "unconfirmed" ? `<button type="button" class="primary-button tl-roster-button" data-action="training-load-roster-type-check" ${busy ? "disabled" : ""}>Check result</button>` : "",
    n.tone === "saved" && n.undo ? `<button type="button" class="plain-button tl-roster-button" data-action="training-load-roster-type-undo" ${busy ? "disabled" : ""}>Undo</button>` : "",
    n.tone !== "unconfirmed" ? `<button type="button" class="plain-button tl-roster-button" data-action="training-load-roster-type-dismiss">OK</button>` : "",
  ].join("");
  return `<div class="tl-roster-notice tl-roster-type-notice${scope === "athlete" ? " is-row" : ""} is-${escapeAttr(n.tone)}" role="${n.tone === "saved" ? "status" : "alert"}"><p>${escapeHtml(n.text)}</p>${buttons}</div>`;
}

// The header line: the session's type, with a chooser for a viewer who decides.
export function sessionTypeHeaderHtml(r, data, canDecide, locked) {
  if (!data?.activity || !("activityTypeKey" in data.activity)) return "";
  const key = data.activity.activityTypeKey ?? null;
  const label = key ? sessionTypeLabelOf(key, r) : "Not set";
  if (!canDecide) return `<p class="tl-roster-session-type"><span class="tl-roster-type-label">Session type</span> <strong>${escapeHtml(label)}</strong></p>`;
  const options = optionsFor(r, key);
  const failed = r.types?.list?.status === "error";
  const disabled = locked || typeChangeBusy(r) || options.length < 2 ? "disabled" : "";
  return `
    <div class="tl-roster-session-type">
      <label class="tl-roster-type-field">
        <span class="tl-roster-type-label">Session type</span>
        <select data-action="training-load-roster-session-type" data-roster-session-type ${disabled}>
          ${key ? "" : `<option value="" selected>Choose...</option>`}
          ${options.map((x) => `<option value="${escapeAttr(x.key)}"${x.key === key ? " selected" : ""}>${escapeHtml(x.label)}</option>`).join("")}
        </select>
      </label>
      ${r.types?.busy?.scope === "session" ? `<span class="muted" aria-live="polite">Saving…</span>` : ""}
      ${!failed && r.types?.list?.status === "ready" && options.length < 2 ? `<p class="muted">No other session type to choose. Add one in Settings &gt; Tags &amp; Presets.</p>` : ""}
      ${failed ? `<p class="muted">The session types could not be read. <button type="button" class="plain-button tl-roster-button" data-action="training-load-roster-type-list-again">Try again</button></p>` : ""}
      ${locked ? "" : `<p class="muted tl-roster-type-hint">Did one athlete do something else, for example RTP? Open Details in their row.</p>`}
      ${noticeFor(r, "session")}
    </div>
  `;
}

// What a row says about the athlete's own type (always visible, in the coach's words).
export function athleteTypeNotes(athlete, r = roster()) {
  const st = athlete?.sessionType;
  if (!st) return [];
  if (st.exception) {
    const who = [st.exception.setBy, st.exception.setAt ? new Date(st.exception.setAt).toLocaleDateString("en-GB").replace(/\//g, ".") : ""].filter(Boolean).join(", ");
    return [`Did ${sessionTypeLabelOf(st.exception.activityTypeKey, r)} in this session${who ? ` — ${who}` : ""}.`];
  }
  if (st.endedException) {
    const why = st.endedException.cause === "merge" ? "two sessions were merged" : "the athlete was moved to this session";
    return [`The athlete's own type (${sessionTypeLabelOf(st.endedException.activityTypeKey, r)}) was removed when ${why}. Set it again in Details if it still applies.`];
  }
  return [];
}

// The chooser in a row's Details: "As the session" or another type. Only for an athlete the read gives a type for.
export function athleteTypeControlHtml(r, data, athlete, canDecide, locked) {
  const st = athlete?.sessionType;
  if (!st) return "";
  const sessionKey = data?.activity?.activityTypeKey ?? null;
  const current = st.exception?.activityTypeKey ?? null;
  const id = athlete.athleteId;
  if (!canDecide) return "";
  const options = optionsFor(r, current).filter((x) => x.key !== sessionKey);
  // Nothing to choose (one active type, the session's own): no control rather than a dead one.
  if (!options.length && !current && r.types?.list?.status === "ready") return "";
  const disabled = locked || typeChangeBusy(r) ? "disabled" : "";
  return `
    <div class="tl-roster-athlete-type">
      <label class="tl-roster-type-field">
        <span class="tl-roster-type-label">Athlete's own type in this session</span>
        <select data-action="training-load-roster-athlete-type" data-athlete-id="${escapeAttr(id)}" aria-label="Athlete's own type in this session, ${escapeAttr(athlete.name || "the athlete")}" ${disabled}>
          <option value=""${current ? "" : " selected"}>${escapeHtml(sessionKey ? `As the session (${sessionTypeLabelOf(sessionKey, r)})` : "As the session")}</option>
          ${options.map((x) => `<option value="${escapeAttr(x.key)}"${x.key === current ? " selected" : ""}>${escapeHtml(x.label)}</option>`).join("")}
        </select>
      </label>
      <p class="muted">Use it when this athlete did something else than the team, for example RTP. Estimates then compare with that type.</p>
    </div>
  `;
}

// The outcome of an athlete's change, shown on the row itself (outside Details, so it is seen).
export function athleteTypeNoticeHtml(r, athleteId) {
  return noticeFor(r, "athlete", athleteId);
}
