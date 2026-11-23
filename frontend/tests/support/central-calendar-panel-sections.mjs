// The event panel's redesign (2026-11-23) folds its sections. The suites written for the earlier, unfolded panel
// check what each section holds and sends; they call this before every paint so every section of the open panel is
// drawn open, exactly as a coach who opened them all would see it. It overrides the coach's folds, so the folds
// themselves (opening, closing, the summary row, the "⋯" menus, a section kept open by an unconfirmed result) are
// proven without it: central-calendar-links.actions.test.mjs 20a-20f, central-calendar-event-details D-layout,
// central-calendar-questions P-fold, central-calendar-k6-3 (the See each athlete chooser), and the e2e
// central-calendar-event-panel-layout.test.mjs in a real browser.
export const CC_PANEL_SECTIONS = Object.freeze(["trainings", "activities", "questions", "tests", "athletes", "details"]);

export function openEveryPanelSection(cal) {
  if (!cal?.panel?.open || !cal.panel.key) return;
  const view = cal.panelView && cal.panelView.key === cal.panel.key ? cal.panelView : { key: cal.panel.key, sections: {}, menu: "" };
  cal.panelView = { ...view, sections: Object.fromEntries(CC_PANEL_SECTIONS.map((id) => [id, true])) };
}
