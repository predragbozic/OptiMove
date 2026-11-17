// "My training" (owner, 2026-11-16): the athlete's taps on her own sessions. Read-only: nothing here writes.
import { state } from "./state.js";
import { closeMyTrainingSession, loadMyTrainingAvailability, loadMyTrainingList, loadMyTrainingSession } from "./my-training-data.js";

// The tab itself: the list is read on every entry (a new session may have been recorded meanwhile).
// The server's answer is read again too: the entry follows it here as well (`renderNav` redraws the menu).
export async function enterMyTraining({ render, renderNav }) {
  closeMyTrainingSession();
  render();
  // The menu item may hide while it holds the keyboard focus: the focus then goes to the page's heading, after the last
  // render of both reads (each render replaces the heading) (code review).
  let moveFocus = false;
  await Promise.all([
    loadMyTrainingList({}, render),
    loadMyTrainingAvailability().then(() => {
      const focused = globalThis.document?.activeElement?.closest?.('[data-athlete-tab="my-training"]');
      renderNav?.();
      render();
      moveFocus = Boolean(focused?.hidden);
    }),
  ]);
  if (moveFocus) globalThis.document?.querySelector?.(".my-training-title")?.focus?.();
}

// Home and the menu: the server's answer, then (only when she has sessions) her last one for Home's line.
export async function refreshMyTrainingEntry({ render }) {
  const available = await loadMyTrainingAvailability();
  render();
  if (available === true && !state.myTraining.list.loaded && !state.myTraining.list.loading) await loadMyTrainingList({}, render);
}

export async function handleMyTrainingAction(action, { render, pushHistory }) {
  const type = action.dataset.action;
  if (type === "my-training-open") {
    const id = action.dataset.activityId;
    if (!id) return true;
    // Phone Back closes the session and returns to the list (handleMyTrainingBack).
    if (!state.myTraining.openId) pushHistory?.();
    globalThis.scrollTo?.(0, 0);
    await loadMyTrainingSession(id, render);
    return true;
  }
  if (type === "my-training-back") {
    // Closes here, at once (a double tap cannot step past her list). The history entry the open added stays, as with the
    // app's other layers: the next phone Back on her list goes Home.
    closeMyTrainingSession();
    render();
    return true;
  }
  if (type === "my-training-more") {
    await loadMyTrainingList({ more: true }, render);
    return true;
  }
  if (type === "my-training-retry") {
    await loadMyTrainingList({}, render);
    return true;
  }
  return false;
}

// Phone Back: an open session closes first, back to her list.
export function handleMyTrainingBack(render) {
  if (state.activeTab !== "my-training" || !state.myTraining.openId) return false;
  closeMyTrainingSession();
  render();
  return true;
}
