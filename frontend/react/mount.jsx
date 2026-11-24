// The one bridge from the plain app to a React island: the plain code owns the container element and the moment;
// React owns everything inside the container. Mounting the same container again only updates the props (the plain
// app's render functions run often, and each may call it); unmounting removes React's root, its listeners and its
// DOM, so a section left behind leaves nothing running.
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { reportHandlerError } from "../app-errors-capture.js";

const roots = new WeakMap();

export function mountIsland(container, Component, props = {}, { name = "island" } = {}) {
  if (!container || typeof container !== "object" || container.nodeType !== 1) throw new TypeError("mountIsland needs a container element");
  let entry = roots.get(container);
  if (!entry) {
    // An error inside an island is reported like a failed click handler (the app's closed error shape), never shown
    // as text; React then removes that island's tree, and the plain app around it keeps working.
    const root = createRoot(container, { onUncaughtError: (error) => reportHandlerError(error, `react_${name}`) });
    entry = { root };
    roots.set(container, entry);
  }
  // Synchronously: the plain code that called this reads the island's DOM right after (focus, measuring, tests).
  flushSync(() => entry.root.render(<Component {...props} />));
  return {
    update: (next) => mountIsland(container, Component, next, { name }),
    unmount: () => unmountIsland(container),
  };
}

export function unmountIsland(container) {
  const entry = container ? roots.get(container) : null;
  if (!entry) return false;
  roots.delete(container);
  entry.root.unmount();
  return true;
}

export function isIslandMounted(container) {
  return Boolean(container && roots.has(container));
}
