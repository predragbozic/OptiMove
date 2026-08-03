import { els } from "./dom.js";
import { renderAccessNav } from "./navigation.js";
import { state } from "./state.js";
import { renderWorkspaceSwitcher } from "./workspace-actions.js";

export function renderUserControls() {
  const authenticated = Boolean(state.currentUser);
  if (els.signOut) els.signOut.hidden = !authenticated;
  renderWorkspaceSwitcher();
  renderAccessNav();
}
