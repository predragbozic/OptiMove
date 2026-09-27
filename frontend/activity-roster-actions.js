// Phase 5a3a/5a3b: interactions of the Activity Roster tab.
// Contract: docs/ai/phase5a3-roster-ux-draft.md, sections 3–7.
//
// Every write is one 5a2 command (PUT/DELETE decision, POST decisions) with
// its own requestKey. Exactly one of three outcomes reaches the coach:
// saved (the roster is read again), nothing saved (a coded refusal; the
// roster is read again and the message says what changed), or result not
// confirmed (the same command is repeated with the same requestKey on
// "Check result"; the server never writes it twice). Nothing here decides
// for the coach: no row is ticked or set by default, and a group decision
// carries only the ticked rows, each as "has no state".
import {
  bulkCommand, clearCommand, currentRosterResetGeneration, decideCommand, loadActivityRoster, newRosterRequestKey, refreshActivityRoster,
  sendRosterCommand,
} from "./activity-roster-data.js";
import {
  DECISION_LABELS, MAX_BULK_ATHLETES, athleteName, bulkEligible, bulkLocked, bulkPlan, currentStateText, expectedDecisionIdOf,
  findRosterAthlete, hasSourceRecord, isPhone, isTwoStates, measuredAfterDecision, rowLocked, selectableAthletes, sourceName, stateWord,
  viewerCanDecide,
} from "./activity-roster-view.js";
import { state } from "./state.js";

const NOTHING_SAVED = "Nothing was saved.";
const TRY_AGAIN = { label: "Try again", action: "training-load-roster-try-again" };

function rosterState() {
  return state.trainingLoad.calendar.roster;
}

function reasonsOf(roster) {
  return roster.data?.reasons ?? [];
}

function nameOf(roster, athleteId) {
  return athleteName(findRosterAthlete(roster.data, athleteId));
}

function plural(n, one, many) {
  return `${n} ${n === 1 ? one : many}`;
}

function maybeOpenRoster(activityId) {
  const roster = rosterState();
  if (roster.activityId !== activityId || !roster.data || roster.userPickedTab) return;
  if (Number(roster.data.counts?.needsState || 0) <= 0) return;
  state.trainingLoad.calendar.activityDetailTab = "roster";
  roster.autoTabFor = activityId;
}

export async function loadRosterForOpenActivity(activityId, render) {
  await loadActivityRoster(activityId, render);
  maybeOpenRoster(activityId);
  render?.();
}

// ---------------------------------------------------------------------------
// Leave protection (section 7): a write in flight or a result not confirmed
// is the only local view of that outcome. Used by the calendar's own
// session changes, by confirmLeaveTrainingLoad and by beforeunload.
// ---------------------------------------------------------------------------
export function rosterHasPendingOutcome(roster = rosterState()) {
  return Boolean(roster?.unconfirmed) || Object.keys(roster?.busy || {}).length > 0;
}

export function rosterMayBeLeft(roster = rosterState()) {
  if (!rosterHasPendingOutcome(roster)) return true;
  const question = roster.unconfirmed
    ? "A roster change is not confirmed yet. If you leave now, you cannot check its result here. Leave anyway?"
    : "A roster change is still being saved. If you leave now, its result is lost. Leave anyway?";
  return Boolean(globalThis.window?.confirm?.(question));
}

export function rosterUnloadShouldWarn(roster = rosterState()) {
  if (state.deliberateNavigation) return false;
  return rosterHasPendingOutcome(roster);
}

// Escape (app.js): closes the open reason list / sheet, then an inline
// confirmation. Returns whether anything closed.
export function closeActivityRosterOverlay() {
  const roster = rosterState();
  if (roster.picker && !roster.picker.sending) { roster.picker = null; return true; }
  if (roster.confirm) { roster.confirm = null; return true; }
  return false;
}

// ---------------------------------------------------------------------------
// Selection (section 6).
// ---------------------------------------------------------------------------
function setSelection(roster, ids) {
  roster.selected = [...new Set(ids)];
}

function addSelectionNote(roster, line) {
  roster.notices.selection = [...(roster.notices.selection ?? []), line];
}

// After a reload a ticked row that can no longer take the state is unticked
// and named (section 6).
function pruneSelection(roster) {
  const keep = [];
  for (const id of roster.selected || []) {
    const athlete = findRosterAthlete(roster.data, id);
    if (athlete && bulkEligible(athlete)) {
      keep.push(id);
      continue;
    }
    const now = athlete ? currentStateText(athlete, reasonsOf(roster)) : "no longer on this session's roster";
    addSelectionNote(roster, `${athlete ? athleteName(athlete) : "An athlete"} was removed from the selection: now ${now}.`);
  }
  roster.selected = keep;
}

function togglePick(roster, athleteId, checked) {
  const selected = roster.selected || [];
  const has = selected.includes(athleteId);
  if (!checked) {
    if (!has) return false;
    setSelection(roster, selected.filter((id) => id !== athleteId));
    return true;
  }
  if (has) return false;
  const athlete = findRosterAthlete(roster.data, athleteId);
  if (!athlete || !bulkEligible(athlete) || rowLocked(roster, athleteId) || bulkLocked(roster)) return false;
  if (selected.length >= MAX_BULK_ATHLETES) {
    roster.notices.top = { tone: "info", text: `Choose at most ${MAX_BULK_ATHLETES} athletes at once.` };
    return false;
  }
  setSelection(roster, [...selected, athleteId]);
  return true;
}

// ---------------------------------------------------------------------------
// The write runner.
// ---------------------------------------------------------------------------
function lockRows(roster, athleteIds, bulk) {
  for (const id of athleteIds) roster.busy[id] = true;
  if (bulk) roster.busy.__bulk = true;
}

function unlockRows(roster, athleteIds, bulk) {
  for (const id of athleteIds) delete roster.busy[id];
  if (bulk) delete roster.busy.__bulk;
}

function currentText(roster, current) {
  return currentStateText(current, reasonsOf(roster));
}

// The message of a refusal, in the coach's words (section 7's table).
function refusalNotice(roster, result, ctx) {
  const code = result.code;
  const data = result.data ?? {};
  const name = ctx.athleteId ? nameOf(roster, ctx.athleteId) : "";
  const notice = { tone: "refused", text: `${NOTHING_SAVED} Try again.`, action: TRY_AGAIN, code };
  if (result.status === 403) return { tone: "refused", text: `Your access changed before this choice was saved. ${NOTHING_SAVED}`, action: null, code, lock: { kind: "forbidden" } };
  if (result.status === 404) return { tone: "refused", text: `This session is not available any more. ${NOTHING_SAVED}`, action: null, code, lock: { kind: "not_found" } };
  if (code === "activity_superseded") {
    return { tone: "refused", text: `This session was merged into another. ${NOTHING_SAVED}`, action: null, code, lock: { kind: "superseded", canonicalActivityId: data.canonicalActivityId ? String(data.canonicalActivityId) : null } };
  }
  if (code === "decision_changed") {
    const who = data.current?.decision?.decidedBy?.name || "Someone";
    return { tone: "refused", text: `${who} changed ${name} a moment ago (now: ${currentText(roster, data.current)}). ${NOTHING_SAVED}`, action: null, code };
  }
  if (code === "measured_record_exists") {
    return { tone: "refused", text: `${sourceName()} values for ${name} just arrived; ${name} is now Measured. ${NOTHING_SAVED}`, action: null, code };
  }
  if (code === "not_on_roster") return { tone: "refused", text: `${name} is no longer on this session's roster. ${NOTHING_SAVED}`, action: null, code };
  if (code === "nothing_to_clear") {
    return { tone: "refused", text: `${name} has no state to remove any more (now: ${currentText(roster, data.current)}). ${NOTHING_SAVED}`, action: null, code };
  }
  if (code === "roster_busy") return { tone: "refused", text: `Someone else is saving this session. Try again. ${NOTHING_SAVED}`, action: TRY_AGAIN, code };
  if (code === "unknown_reason") return { tone: "refused", text: `This reason is no longer available. Choose another. ${NOTHING_SAVED}`, action: null, code, keepPicker: true };
  if (code === "too_many_athletes") return { tone: "refused", text: `Choose at most ${MAX_BULK_ATHLETES} athletes at once. ${NOTHING_SAVED}`, action: null, code };
  if (code === "bulk_conflict") {
    const failed = Array.isArray(data.failed) ? data.failed : [];
    const failedIds = new Set(failed.map((f) => String(f.athleteId)));
    const changed = failed.map((f) => {
      const who = nameOf(roster, f.athleteId);
      if (f.error === "not_on_roster") return `${who} (no longer on the roster)`;
      if (f.error === "measured_record_exists") return `${who} (now Measured)`;
      return `${who} (now ${currentText(roster, f.current)})`;
    });
    const remaining = (ctx.athleteIds || []).filter((id) => !failedIds.has(id));
    setSelection(roster, (roster.selected || []).filter((id) => !failedIds.has(id)));
    roster.retryBulk = remaining.length ? { kind: ctx.kind, reasonKey: ctx.reasonKey ?? null, note: ctx.note ?? null, athleteIds: remaining } : null;
    return {
      tone: "refused",
      text: `${NOTHING_SAVED} ${plural(failed.length, "athlete", "athletes")} changed: ${changed.join(", ")}.`,
      action: remaining.length ? { label: `Apply to the other ${remaining.length}`, action: "training-load-roster-bulk-retry", primary: true } : null,
      code,
    };
  }
  // internal_error, request_key_reused, kind_not_available and every other
  // coded refusal: nothing was saved; a new command with a new key.
  return notice;
}

function savedNotice(ctx, body) {
  if (ctx.type === "bulk") {
    const n = Array.isArray(body?.decisions) ? body.decisions.length : ctx.athleteIds.length;
    return { tone: "saved", text: `Saved for ${plural(n, "athlete", "athletes")}.` };
  }
  if (ctx.type === "clear") {
    return { tone: "saved", text: ctx.useMeasured ? `Saved: ${ctx.name} — measured values are used.` : `Saved: ${ctx.name} — state removed.` };
  }
  return { tone: "saved", text: `Saved: ${ctx.name} — ${DECISION_LABELS[ctx.kind] || stateWord(ctx.kind)}.` };
}

// Sends one command and settles its outcome in the state. `ctx` names the
// command for the messages: { type: decide|clear|bulk, athleteIds, athleteId?,
// name?, kind?, reasonKey?, note?, useMeasured?, retry? }.
async function runWrite(command, ctx, render) {
  const roster = rosterState();
  const activityId = roster.activityId;
  const generation = currentRosterResetGeneration();
  const bulk = ctx.type === "bulk";
  // One command at a time (section 7). While a write is in flight, or one
  // result is not confirmed ("Do not choose another state until this result
  // is checked"), no other write starts: a second command could otherwise
  // settle after the first became unconfirmed and replace or clear its
  // slot. The only live control then is Check result, which never comes
  // through here.
  if (!activityId || roster.writeLock || roster.unconfirmed || Object.keys(roster.busy || {}).length) return;
  if (bulk ? bulkLocked(roster) : ctx.athleteIds.some((id) => rowLocked(roster, id))) return;
  lockRows(roster, ctx.athleteIds, bulk);
  roster.confirm = null;
  // Only the picker this command came from shows "Saving…"; a picker open
  // for another row or for the group is left alone.
  const ownPicker = roster.picker && (bulk ? roster.picker.scope === "bulk" : roster.picker.scope === "row" && roster.picker.athleteId === ctx.athleteId);
  if (ownPicker) roster.picker.sending = true;
  if (bulk) roster.notices.top = null;
  else delete roster.notices.rows[ctx.athleteId];
  // The rest of a refused bulk is stale after any other write: the offer
  // goes with it (never a dead "Apply to the other N").
  roster.retryBulk = null;
  if (roster.notices.top?.action?.action === "training-load-roster-bulk-retry") roster.notices.top = null;
  render();

  const result = await sendRosterCommand(command);

  // The session changed while the request was out (also when the same
  // session was closed and opened again: the reset generation moved): the
  // answer belongs to a roster that is no longer on screen. Nothing of it
  // is applied.
  if (rosterState() !== roster || roster.activityId !== activityId || generation !== currentRosterResetGeneration()) return;
  unlockRows(roster, ctx.athleteIds, bulk);
  await settleOutcome(roster, result, command, ctx, render);
}

async function settleOutcome(roster, result, command, ctx, render) {
  const activityId = roster.activityId;
  const bulk = ctx.type === "bulk";
  const ownPicker = roster.picker && (bulk ? roster.picker.scope === "bulk" : roster.picker.scope === "row" && roster.picker.athleteId === ctx.athleteId);
  if (result.outcome === "unconfirmed") {
    if (ownPicker) roster.picker = null;
    roster.unconfirmed = {
      requestKey: command.body.requestKey, command, ctx, athleteIds: [...ctx.athleteIds],
      names: ctx.athleteIds.map((id) => nameOf(roster, id)), label: unconfirmedLabel(ctx), checks: roster.unconfirmed?.checks ?? 0,
      checking: false, code: result.code || "",
    };
    render();
    return;
  }
  if (result.outcome === "saved") {
    if (ownPicker) roster.picker = null;
    roster.changing = null;
    roster.unconfirmed = null;
    // Only this command's own pending Try again is spent; another row's stays.
    if (roster.retry && (bulk ? roster.retry.type === "bulk" : roster.retry.athleteId === ctx.athleteId)) roster.retry = null;
    const notice = savedNotice(ctx, result.body);
    if (bulk) {
      roster.notices.top = notice;
      roster.notices.selection = [];
      setSelection(roster, (roster.selected || []).filter((id) => !ctx.athleteIds.includes(id)));
    } else {
      roster.notices.rows[ctx.athleteId] = notice;
    }
    render();
    const ok = await refreshActivityRoster(activityId, render, { exclude: ctx.athleteIds });
    if (ok && rosterState() === roster && roster.activityId === activityId && roster.data) pruneSelection(roster);
    render();
    return;
  }
  // Refused: a coded answer, nothing written.
  const notice = refusalNotice(roster, result, ctx);
  roster.unconfirmed = null;
  roster.retry = notice.action === TRY_AGAIN ? ctx : null;
  const rowAction = notice.action === TRY_AGAIN && ctx.athleteId ? { ...TRY_AGAIN, athleteId: ctx.athleteId } : notice.action;
  if (notice.keepPicker && ownPicker) {
    roster.picker.sending = false;
    roster.picker.error = notice.text;
  } else {
    if (ownPicker) roster.picker = null;
    if (bulk || !ctx.athleteId) roster.notices.top = { tone: notice.tone, text: notice.text, action: notice.action, code: notice.code };
    else roster.notices.rows[ctx.athleteId] = { tone: notice.tone, text: notice.text, action: rowAction, code: notice.code };
  }
  if (notice.lock) {
    roster.writeLock = notice.lock;
    roster.selected = [];
    roster.picker = null;
    roster.confirm = null;
    render();
    return;
  }
  render();
  // The roster is read again once after every confirmed refusal; the
  // rows that changed under the coach are marked from the previous read.
  const ok = await refreshActivityRoster(activityId, render);
  if (ok && rosterState() === roster && roster.activityId === activityId && roster.data) pruneSelection(roster);
  render();
}

function unconfirmedLabel(ctx) {
  if (ctx.type === "bulk") return `${DECISION_LABELS[ctx.kind] || ctx.kind} for ${plural(ctx.athleteIds.length, "athlete", "athletes")}`;
  if (ctx.type === "clear") return ctx.useMeasured ? `measured values for ${ctx.name}` : `removing the state of ${ctx.name}`;
  return `${DECISION_LABELS[ctx.kind] || ctx.kind} for ${ctx.name}`;
}

// --- the commands as the coach triggers them --------------------------------
function decide(roster, athleteId, kind, { reasonKey = null, note = null } = {}, render) {
  const athlete = findRosterAthlete(roster.data, athleteId);
  if (!athlete) return Promise.resolve();
  const requestKey = newRosterRequestKey();
  const command = decideCommand(roster.activityId, athleteId, { kind, reasonKey, note, expectedDecisionId: expectedDecisionIdOf(athlete), requestKey });
  return runWrite(command, { type: "decide", athleteIds: [athleteId], athleteId, name: athleteName(athlete), kind, reasonKey, note }, render);
}

function clear(roster, athleteId, { useMeasured = false } = {}, render) {
  const athlete = findRosterAthlete(roster.data, athleteId);
  if (!athlete?.decision?.id) return Promise.resolve();
  const requestKey = newRosterRequestKey();
  const command = clearCommand(roster.activityId, athleteId, { expectedDecisionId: athlete.decision.id, requestKey });
  return runWrite(command, { type: "clear", athleteIds: [athleteId], athleteId, name: athleteName(athlete), useMeasured }, render);
}

function bulk(roster, { kind, reasonKey = null, note = null, athleteIds }, render) {
  if (!athleteIds.length) return Promise.resolve();
  const requestKey = newRosterRequestKey();
  const command = bulkCommand(roster.activityId, { kind, reasonKey, note, athleteIds, requestKey });
  return runWrite(command, { type: "bulk", athleteIds: [...athleteIds], kind, reasonKey, note }, render);
}

// Try again after roster_busy / internal_error / request_key_reused: the
// same intent, rebuilt from the roster as it is now (fresh expected ids),
// with a new requestKey — the refused one wrote nothing.
function retryLast(roster, render) {
  const ctx = roster.retry;
  if (!ctx) return Promise.resolve();
  roster.retry = null;
  if (ctx.type === "bulk") {
    const ids = ctx.athleteIds.filter((id) => bulkEligible(findRosterAthlete(roster.data, id)));
    return bulk(roster, { kind: ctx.kind, reasonKey: ctx.reasonKey, note: ctx.note, athleteIds: ids }, render);
  }
  if (ctx.type === "clear") return clear(roster, ctx.athleteId, { useMeasured: ctx.useMeasured }, render);
  return decide(roster, ctx.athleteId, ctx.kind, { reasonKey: ctx.reasonKey, note: ctx.note }, render);
}

// Check result: the same command, the same requestKey. A stored result comes
// back as 200 (saved), a refusal as its code; both settle as usual.
async function checkResult(roster, render) {
  const u = roster.unconfirmed;
  if (!u || u.checking) return;
  const activityId = roster.activityId;
  const generation = currentRosterResetGeneration();
  u.checking = true;
  render();
  const result = await sendRosterCommand(u.command);
  if (rosterState() !== roster || roster.activityId !== activityId || roster.unconfirmed !== u || generation !== currentRosterResetGeneration()) return;
  u.checking = false;
  if (result.outcome === "unconfirmed") {
    u.checks += 1;
    u.code = result.code || u.code;
    render();
    return;
  }
  await settleOutcome(roster, result, u.command, u.ctx, render);
}

// ---------------------------------------------------------------------------
// Handlers.
// ---------------------------------------------------------------------------
function openRowPicker(roster, athleteId) {
  roster.confirm = null;
  roster.changing = null;
  roster.picker = { scope: "row", athleteId, kind: "did_not_participate", reasonKey: null, note: "", error: null, sending: false, step: "reasons" };
}

function openBulkPicker(roster, kind) {
  roster.confirm = null;
  roster.changing = null;
  roster.picker = { scope: "bulk", kind: kind || null, reasonKey: null, note: "", error: null, sending: false };
}

function liveNote(roster) {
  // The textarea keeps the typed note (data.js repaints it from state); at
  // the moment of the tap the DOM value is the freshest.
  try {
    const el = globalThis.document?.querySelector?.("[data-roster-note]");
    if (el && typeof el.value === "string") return el.value;
  } catch {
    // no DOM in tests
  }
  return roster.picker?.note ?? "";
}

export async function handleActivityRosterAction(action, { render }) {
  const type = action.dataset.action;
  if (!type?.startsWith("training-load-roster-")) return false;
  const roster = rosterState();
  const athleteId = action.dataset.athleteId || null;

  if (type === "training-load-roster-filter") {
    const filter = action.dataset.rosterFilter;
    if (["needs_state", "needs_review", "done", "all"].includes(filter)) roster.filter = filter;
    // A card marked Saved stays until the filter changes (section 1).
    // ... and so does a refusal the coach has read (one without a next step);
    // a notice with Try again / Apply to the other N stays until it is used.
    roster.notices.rows = Object.fromEntries(Object.entries(roster.notices.rows || {}).filter(([, n]) => n.tone !== "saved" && !(n.tone === "refused" && !n.action)));
    roster.notices.selection = [];
    render();
    return true;
  }

  if (type === "training-load-roster-retry") {
    const activityId = state.trainingLoad.calendar.selectedActivityId;
    if (activityId && !roster.loading) await loadRosterForOpenActivity(activityId, render);
    return true;
  }

  if (type === "training-load-roster-refresh") {
    if (roster.activityId && !roster.loading) {
      const ok = await refreshActivityRoster(roster.activityId, render);
      if (ok && roster.data) pruneSelection(roster);
      render();
    }
    return true;
  }

  if (!roster.data || !viewerCanDecide(roster.data)) return true;

  // --- selection ---
  if (type === "training-load-roster-pick") {
    const checked = Boolean(action.checked);
    const changed = togglePick(roster, athleteId, checked);
    if (changed || checked !== (roster.selected || []).includes(athleteId)) render();
    return true;
  }
  if (type === "training-load-roster-select-needing") {
    if (bulkLocked(roster)) return true;
    const ids = selectableAthletes(roster).map((a) => a.athleteId);
    const merged = [...new Set([...(roster.selected || []), ...ids])];
    if (merged.length > MAX_BULK_ATHLETES) {
      roster.notices.top = { tone: "info", text: `Choose at most ${MAX_BULK_ATHLETES} athletes at once.` };
      setSelection(roster, merged.slice(0, MAX_BULK_ATHLETES));
    } else {
      setSelection(roster, merged);
    }
    render();
    return true;
  }
  if (type === "training-load-roster-clear-selection") {
    if (roster.busy.__bulk) return true;
    roster.selected = [];
    roster.notices.selection = [];
    roster.retryBulk = null;
    if (roster.picker?.scope === "bulk" && !roster.picker.sending) roster.picker = null;
    render();
    return true;
  }
  if (type === "training-load-roster-bulk") {
    if (bulkLocked(roster) || !(roster.selected || []).length) return true;
    openBulkPicker(roster, action.dataset.kind);
    render();
    return true;
  }
  if (type === "training-load-roster-set-state") {
    if (bulkLocked(roster) || !(roster.selected || []).length) return true;
    openBulkPicker(roster, null);
    render();
    return true;
  }
  if (type === "training-load-roster-bulk-kind") {
    if (roster.picker?.scope === "bulk" && !roster.picker.sending) {
      roster.picker.kind = action.dataset.kind || null;
      roster.picker.reasonKey = null;
      roster.picker.error = null;
      render();
    }
    return true;
  }
  if (type === "training-load-roster-bulk-apply") {
    const picker = roster.picker;
    if (!picker || picker.scope !== "bulk" || picker.sending || !picker.kind) return true;
    if (picker.kind === "did_not_participate" && !picker.reasonKey) return true;
    picker.note = liveNote(roster);
    const plan = bulkPlan(roster, picker.kind);
    const ids = plan.included.map(({ athlete }) => athlete.athleteId);
    if (!ids.length) return true;
    await bulk(roster, { kind: picker.kind, reasonKey: picker.reasonKey, note: picker.note.trim() || null, athleteIds: ids }, render);
    return true;
  }
  if (type === "training-load-roster-bulk-retry") {
    const plan = roster.retryBulk;
    if (!plan || bulkLocked(roster)) return true;
    roster.retryBulk = null;
    roster.notices.top = null;
    const ids = plan.athleteIds.filter((id) => bulkEligible(findRosterAthlete(roster.data, id)));
    await bulk(roster, { ...plan, athleteIds: ids }, render);
    return true;
  }

  // --- one row ---
  if (type === "training-load-roster-set") {
    const athlete = findRosterAthlete(roster.data, athleteId);
    if (!athlete || rowLocked(roster, athleteId)) return true;
    const kind = action.dataset.kind || "participated_no_values";
    if (kind !== "participated_no_values") return true;
    if (isTwoStates(athlete)) {
      roster.picker = null;
      roster.confirm = { type: "two_states_participated", athleteId, text: `Set "${DECISION_LABELS.participated_no_values}" for ${athleteName(athlete)}? It replaces both states.`, proceedLabel: "Replace both states" };
      render();
      return true;
    }
    await decide(roster, athleteId, "participated_no_values", {}, render);
    return true;
  }
  if (type === "training-load-roster-absent") {
    const athlete = findRosterAthlete(roster.data, athleteId);
    if (!athlete || rowLocked(roster, athleteId)) return true;
    if (!isTwoStates(athlete) && hasSourceRecord(athlete)) {
      roster.picker = null;
      roster.changing = null;
      roster.confirm = { type: "absent_anyway", athleteId, text: `${sourceName()} has a record for ${athleteName(athlete)}. Mark ${athleteName(athlete)} as not participating anyway?`, proceedLabel: "Choose a reason" };
      if (athlete.decision) roster.confirm.text = `${sourceName()} has a record for ${athleteName(athlete)}. Change the state to "Did not participate" anyway?`;
      render();
      return true;
    }
    openRowPicker(roster, athleteId);
    render();
    return true;
  }
  if (type === "training-load-roster-change") {
    if (rowLocked(roster, athleteId)) return true;
    roster.changing = roster.changing === athleteId ? null : athleteId;
    roster.confirm = null;
    if (roster.picker?.scope === "row" && !roster.picker.sending) roster.picker = null;
    render();
    return true;
  }
  if (type === "training-load-roster-remove") {
    const athlete = findRosterAthlete(roster.data, athleteId);
    if (!athlete?.decision || rowLocked(roster, athleteId)) return true;
    const back = hasSourceRecord(athlete) ? stateWord("no_usable_device_record") : stateWord("unknown");
    roster.picker = null;
    roster.confirm = {
      type: "remove", athleteId,
      text: `Remove the state of ${athleteName(athlete)}? ${athleteName(athlete)} returns to "${back}" and needs a state again. The earlier entry is kept, not erased.`,
      proceedLabel: "Remove this state",
    };
    render();
    return true;
  }
  if (type === "training-load-roster-use-measured") {
    const athlete = findRosterAthlete(roster.data, athleteId);
    if (!measuredAfterDecision(athlete) || rowLocked(roster, athleteId)) return true;
    const who = athlete.decision.decidedBy?.name ? ` set by ${athlete.decision.decidedBy.name}` : "";
    roster.picker = null;
    roster.confirm = {
      type: "use_measured", athleteId,
      text: `Use the measured values for ${athleteName(athlete)}? The state "${athlete.decision.label || stateWord(athlete.decision.kind)}"${who} will be removed. It stays recorded, but it cannot be set again while measured values exist. If these values belong to another athlete, sort that out in Imports first.`,
      proceedLabel: "Use measured values",
    };
    render();
    return true;
  }
  if (type === "training-load-roster-confirm-cancel") {
    roster.confirm = null;
    render();
    return true;
  }
  if (type === "training-load-roster-confirm-proceed") {
    const c = roster.confirm;
    if (!c || c.athleteId !== athleteId || rowLocked(roster, athleteId)) return true;
    if (c.type === "absent_anyway") {
      openRowPicker(roster, athleteId);
      render();
      return true;
    }
    if (c.type === "remove") { await clear(roster, athleteId, {}, render); return true; }
    if (c.type === "use_measured") { await clear(roster, athleteId, { useMeasured: true }, render); return true; }
    if (c.type === "two_states_participated") { await decide(roster, athleteId, "participated_no_values", {}, render); return true; }
    return true;
  }

  // --- the reason list ---
  if (type === "training-load-roster-note") {
    if (roster.picker) roster.picker.note = String(action.value ?? "").slice(0, 500);
    try {
      const counter = globalThis.document?.querySelector?.("[data-roster-note-count]");
      if (counter) counter.textContent = `${(roster.picker?.note ?? "").length}/500`;
    } catch {
      // no DOM in tests
    }
    return true;
  }
  if (type === "training-load-roster-reason") {
    const picker = roster.picker;
    if (!picker || picker.sending) return true;
    const reasonKey = action.dataset.reasonKey;
    if (!reasonsOf(roster).some((r) => r.key === reasonKey)) return true;
    picker.reasonKey = reasonKey;
    picker.error = null;
    picker.note = liveNote(roster);
    if (picker.scope === "bulk") { render(); return true; }
    const athlete = findRosterAthlete(roster.data, picker.athleteId);
    if (!athlete || rowLocked(roster, picker.athleteId)) return true;
    if (isTwoStates(athlete)) {
      picker.step = "confirm_two";
      render();
      return true;
    }
    await decide(roster, picker.athleteId, "did_not_participate", { reasonKey, note: picker.note.trim() || null }, render);
    return true;
  }
  if (type === "training-load-roster-picker-back") {
    if (roster.picker?.scope === "row" && !roster.picker.sending) { roster.picker.step = "reasons"; render(); }
    return true;
  }
  if (type === "training-load-roster-picker-confirm") {
    const picker = roster.picker;
    if (!picker || picker.scope !== "row" || picker.sending || !picker.reasonKey) return true;
    if (rowLocked(roster, picker.athleteId)) return true;
    await decide(roster, picker.athleteId, "did_not_participate", { reasonKey: picker.reasonKey, note: (picker.note || "").trim() || null }, render);
    return true;
  }
  if (type === "training-load-roster-picker-cancel") {
    if (roster.picker && !roster.picker.sending) roster.picker = null;
    render();
    return true;
  }

  // --- outcomes ---
  if (type === "training-load-roster-check-result") {
    await checkResult(roster, render);
    return true;
  }
  if (type === "training-load-roster-try-again") {
    if (roster.retry && !bulkLocked(roster)) {
      if (athleteId) delete roster.notices.rows[athleteId];
      else roster.notices.top = null;
      await retryLast(roster, render);
    }
    return true;
  }

  return true;
}

// A <details> owns its native open/close behaviour. The captured toggle
// event persists the choice across app repaints without racing the browser.
export function activityRosterDisclosureToggled(panel) {
  const key = panel?.dataset?.rosterDisclosure;
  if (!key || panel.open === (panel.dataset.renderedOpen === "1")) return;
  const roster = rosterState();
  const opened = new Set(roster.openDisclosures || []);
  const closed = new Set(roster.closedDisclosures || []);
  if (panel.open) {
    opened.add(key);
    closed.delete(key);
  } else {
    opened.delete(key);
    closed.add(key);
  }
  roster.openDisclosures = [...opened];
  roster.closedDisclosures = [...closed];
}

// Test seam: whether a phone layout is assumed right now.
export function rosterIsPhoneForTests() {
  return isPhone();
}
