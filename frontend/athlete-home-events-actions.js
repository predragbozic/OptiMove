// The athlete's *Upcoming events* on Home (K2b-1e, docs/ai/central-calendar-k2b-plan.md section 22): *Try again* reads
// the list again; *Show N more* / *Show fewer* opens or folds the rows already read, with no request.
import { loadAthleteHomeEvents, toggleAthleteHomeEvents } from "./athlete-home-events-data.js";

export async function handleAthleteHomeEventsAction(action, { render }) {
  const type = action?.dataset?.action;
  if (type === "athlete-home-events-retry") {
    await loadAthleteHomeEvents({ render, forceRefresh: true });
    return true;
  }
  if (type === "athlete-home-events-toggle") {
    toggleAthleteHomeEvents();
    render?.();
    // Home is painted again: the keyboard focus stays on the button that now says the other thing.
    globalThis.document?.querySelector?.('[data-action="athlete-home-events-toggle"]')?.focus?.();
    return true;
  }
  return false;
}
