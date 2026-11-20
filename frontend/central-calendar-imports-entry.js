// Central calendar K5-4 (docs/ai/central-calendar-k5-4-contract.md 3.1, steps 3-5): Imports opened on day D.
//
// app.js asks Training Load's leave question, pushes the history step and shows Training Load; this module does the
// rest, so the tests run it through Imports' real loader and period chooser:
// - section Imports through Imports' own loader (in a team workspace its only team is the workspace's own; the entry
//   never sets or switches a team);
// - day D chosen through the period chooser's own chooseDay (the same dayOff as a tap);
// - the phone's sheet opened only on a phone; on a computer the chooser is on the page and the caller scrolls to it;
// - then the read Imports' own day pick makes (ensurePeriodData), GET only.
// Nothing else of Imports is touched and nothing is written. With anything of Imports in flight or not confirmed (a
// batch, any write Imports' own leave guard knows, a search starting or running), Imports opens as it is.
import { ensurePeriodData, importsUnloadShouldWarn } from "./gpexe-import-data.js";
import { chooseDay, setPeriodOpen } from "./gpexe-period-data.js";
import { state } from "./state.js";
import { loadTrainingLoadSectionData, setTrainingLoadSection } from "./training-load-actions.js";

// The width at which Imports draws the chooser as a sheet (app.js closes it when the layout widens).
export const IMPORTS_PHONE_QUERY = "(max-width: 760px)";

// The entry's own guard (contract 3.1, step 5): Imports' pickDay has none, so this one is the calendar's.
export function importsEntryBusy(gx) {
  return Boolean(gx?.batch?.sending) || importsUnloadShouldWarn(gx) || Boolean(gx?.checkStarting) || gx?.check?.status === "running";
}

// `stillThere`: whether the screen is still Training Load > Imports after the load (the user may have left).
// Answers "left", "as-is" (Imports opened as it is) or "chosen".
export async function enterImportsOnDay({ teamId, day, phone = false, render = () => {}, scrollToChooser = () => {}, stillThere = () => true }) {
  setTrainingLoadSection("imports");
  render();
  await loadTrainingLoadSectionData("imports", render);
  if (!stillThere() || state.trainingLoad.section !== "imports") return "left";
  const gx = state.trainingLoad.gpexe;
  // Imports' team is the workspace's own; a different one is never switched.
  if (importsEntryBusy(gx) || String(gx?.teamId || "") !== String(teamId || "") || !chooseDay(day, gx)) {
    render();
    return "as-is";
  }
  // The sheet only on a phone: on a computer an open sheet would take the first Back and read as a dialog.
  if (phone) setPeriodOpen(true, gx);
  render();
  if (!phone) scrollToChooser();
  await ensurePeriodData(render, gx);
  return "chosen";
}
