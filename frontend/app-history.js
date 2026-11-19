// The app's own Back (docs/ai/central-calendar-k2c-plan.md, Back history):
// every in-app history entry pushAppHistory() adds records where the user was,
// so a Back press returns there instead of to Home. The stack moves in step
// with state.appHistoryDepth: one entry per pushed history state.

const entries = [];

// Where the user is now: the tab, and on the central calendar its view, week,
// day and open panel (by key, re-opened only when the item still exists).
export function appHistoryEntryOf(state) {
  const tab = String(state?.activeTab || "");
  const cal = state?.centralCalendar;
  const calendar = tab === "central-calendar" && cal
    ? {
      view: String(cal.view || ""),
      anchor: String(cal.anchor || ""),
      selectedDate: String(cal.selectedDate || ""),
      panelKey: cal.panel?.open ? String(cal.panel.key || "") : "",
      panelDate: cal.panel?.open ? String(cal.panel.date || "") : "",
    }
    : null;
  return { tab, calendar };
}

export function pushAppHistoryEntry(entry) {
  entries.push(entry || null);
}

// The newest entry, or null when none is left (the root fallback then applies).
export function popAppHistoryEntry() {
  return entries.length ? entries.pop() : null;
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
