// The event panel's redesign (2026-11-23) folds its sections. The suites written for the earlier, unfolded panel
// check what each section holds and sends; they call this before every paint so every section of the open panel is
// drawn open, exactly as a coach who opened them all would see it. Opening, closing and the summary row themselves
// are proven in central-calendar-event-panel-layout.actions.test.mjs through the real actions.
export const CC_PANEL_SECTIONS = Object.freeze(["trainings", "activities", "questions", "tests", "athletes", "details"]);

export function openEveryPanelSection(cal) {
  if (!cal?.panel?.open || !cal.panel.key) return;
  const view = cal.panelView && cal.panelView.key === cal.panel.key ? cal.panelView : { key: cal.panel.key, sections: {}, menu: "" };
  cal.panelView = { ...view, sections: Object.fromEntries(CC_PANEL_SECTIONS.map((id) => [id, true])) };
}
