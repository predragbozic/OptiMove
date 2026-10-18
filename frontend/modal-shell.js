// The shell of an administrator dialog over the page (Move to block, Grant
// blocks): an overlay with a backdrop button and a dialog section, the page
// behind out of reach while it is open (every other child of body inert,
// the body not scrolling), Tab kept inside the dialog, Escape and the
// backdrop closing it, and all of that restored however the dialog leaves
// the page - also when something else removes the overlay (a workspace
// change). Returns { overlay, dialog, close }: `close()` closes when
// `canClose()` allows it and then calls `onClosed()` (where focus goes).
export function openModalShell({ overlayClass, dialogClass, label, closeLabel, canClose = () => true, onClosed = () => {} }) {
  const overlay = document.createElement("div");
  overlay.className = `exercise-editor-overlay ${overlayClass}`;
  const backdrop = document.createElement("button");
  backdrop.className = "exercise-editor-backdrop";
  backdrop.type = "button";
  backdrop.setAttribute("aria-label", closeLabel);
  const dialog = document.createElement("section");
  dialog.className = `panel exercise-editor-modal ${dialogClass}`;
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  dialog.setAttribute("aria-label", label);
  overlay.append(backdrop, dialog);
  const background = Array.from(document.body.children).map((child) => [child, child.inert]);
  const previousOverflow = document.body.style.overflow;
  for (const [child] of background) child.inert = true;
  document.body.style.overflow = "hidden";
  document.body.append(overlay);
  let restored = false;
  const restore = () => {
    if (restored) return;
    restored = true;
    for (const [child, inert] of background) child.inert = inert;
    document.body.style.overflow = previousOverflow;
    document.removeEventListener("keydown", keydown);
    watcher?.disconnect();
  };
  const Observer = document.defaultView?.MutationObserver;
  const watcher = Observer ? new Observer(() => { if (!overlay.isConnected) restore(); }) : null;
  watcher?.observe(document.body, { childList: true });
  const close = () => {
    if (!canClose()) return false;
    overlay.remove();
    restore();
    onClosed();
    return true;
  };
  function keydown(event) {
    if (event.key === "Escape") { event.stopPropagation(); close(); return; }
    if (event.key !== "Tab") return;
    const controls = Array.from(dialog.querySelectorAll("button:not(:disabled),select:not(:disabled),input:not(:disabled)"));
    if (!controls.length) { event.preventDefault(); return; }
    if (event.shiftKey && (document.activeElement === controls[0] || !dialog.contains(document.activeElement))) {
      event.preventDefault();
      controls.at(-1).focus();
    } else if (!event.shiftKey && (document.activeElement === controls.at(-1) || !dialog.contains(document.activeElement))) {
      event.preventDefault();
      controls[0].focus();
    }
  }
  document.addEventListener("keydown", keydown);
  backdrop.addEventListener("click", close);
  return { overlay, dialog, close };
}
