import { roleLabel } from "./access.js";
import { els } from "./dom.js";
import { renderAccessNav } from "./navigation.js";
import { state } from "./state.js";

export function renderUserControls() {
  const authenticated = Boolean(state.currentUser);
  if (els.signOut) els.signOut.hidden = !authenticated;
  if (els.userRole) {
    els.userRole.hidden = !authenticated;
    els.userRole.textContent = authenticated ? roleLabel(state.currentUser) : "";
  }
  renderAccessNav();
}
