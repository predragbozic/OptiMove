// The app's own Back (docs/ai/central-calendar-k2c-plan.md, Back history):
// every in-app history entry pushAppHistory() adds records where the user was,
// so a Back press returns there instead of to Home. The stack moves in step
// with state.appHistoryDepth: one entry per pushed history state.

const entries = [];

// Where the user is now: the tab, and on the central calendar its view, week,
// day and open panel (by key, re-opened only when the item still exists).
// K4a: `extra.athleteCalendar` is the athlete's Calendar's own place (its week,
// day and scroll; athlete-calendar-data.js keeps that slice), given by the caller.
export function appHistoryEntryOf(state, extra = {}) {
  const tab = String(state?.activeTab || "");
  const cal = state?.centralCalendar;
  const calendar = tab === "central-calendar" && cal
    ? {
      view: String(cal.view || ""),
      anchor: String(cal.anchor || ""),
      selectedDate: String(cal.selectedDate || ""),
      panelKey: cal.panel?.open ? String(cal.panel.key || "") : "",
      panelDate: cal.panel?.open ? String(cal.panel.date || "") : "",
      // The event panel's opened / closed sections (the redesign of 2026-11-23): Back returns with them as they were.
      panelSections: cal.panel?.open && cal.panelView?.key === cal.panel.key ? { ...(cal.panelView.sections || {}) } : null,
    }
    : null;
  const athleteCalendar = tab === "athlete-calendar" && extra.athleteCalendar ? { ...extra.athleteCalendar } : null;
  return { tab, calendar, athleteCalendar };
}

export function pushAppHistoryEntry(entry) {
  entries.push(entry || null);
}

// The newest entry, or null when none is left (the root fallback then applies).
export function popAppHistoryEntry() {
  return entries.length ? entries.pop() : null;
}

// The newest entry still on the stack (the step the user is on), or null.
export function appHistoryTopEntry() {
  return entries.length ? entries[entries.length - 1] : null;
}

export function appHistoryEntryCount() {
  return entries.length;
}

// A workspace switch or a sign-out: nothing is restored across workspaces.
export function clearAppHistoryEntries() {
  entries.length = 0;
}

// One Back press at a time: the entry handleBrowserBack popped, offered to
// handleAppBack's last step (takeAppBackEntry). endAppBack() says whether it
// was used, so a press that closed an overlay or stayed can put it back.
let pending = null;

export function beginAppBack(entry) {
  pending = { entry: entry || null, taken: false };
}

// Only a place on another tab is taken: an entry of the tab the user is on
// (an exercise detail's) is used up by the overlay it opened, as before.
export function takeAppBackEntry(currentTab) {
  if (!pending || pending.taken || !pending.entry?.tab || pending.entry.tab === currentTab) return null;
  pending.taken = true;
  return pending.entry;
}

// A place of the tab the user is on that no overlay used (an Athletes list or
// an exercise detail left some other way): stale. It is used up, and Back
// goes on to the next older place instead of falling back to Home.
export function skipStaleAppBackEntry(currentTab) {
  if (!pending || pending.taken || !pending.entry) return false;
  if (pending.entry.tab && pending.entry.tab !== currentTab) return false;
  pending.taken = true;
  return true;
}

export function endAppBack() {
  const done = pending || { entry: null, taken: false };
  pending = null;
  return done;
}
