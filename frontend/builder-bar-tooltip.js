// B3 (the owner's decision, 2026-11-10): the Builder bar's Exit, Save and Discard are icons. On a computer their
// description (aria-description) shows on hover and on keyboard focus (CSS only, styles.css "Design: the Builder's
// program bar (B3)"). On a touch screen a long press (about 500 ms) shows the same tooltip (.is-tooltip-open) and does
// not run the action:
// the click that ends the press is stopped before any other listener sees it (only that pointer click: a keyboard
// activation, a key press or a second after the finger lifts end it). A short tap is unchanged. Escape closes a
// tooltip until the pointer or focus leaves the button.
const BAR_ICONS = [
  ".builder-program-actions .builder-exit-button",
  ".builder-program-actions .builder-finish-button",
  ".builder-program-actions .icon-button.danger-action",
].join(", ");

export const LONG_PRESS_MS = 500;
const SHOW_MS = 1600;
const MOVE_PX = 10;

// After a long press the swallow waits this long for the click the press ends with, then lapses.
const SWALLOW_MS = 1000;

export function installBuilderBarTooltip(win = window) {
  let press = null; // { button, x, y, timer }
  let swallow = null; // the button whose next pointer click is the end of a long press
  let swallowTimer = null;
  let shown = null;
  let hideTimer = null;

  const hide = () => {
    clearTimeout(hideTimer);
    shown?.classList.remove("is-tooltip-open");
    shown = null;
  };
  const cancelPress = () => {
    if (press) clearTimeout(press.timer);
    press = null;
  };
  const dropSwallow = () => {
    clearTimeout(swallowTimer);
    swallow = null;
  };
  // The finger left: the click this press ends with comes now or never.
  const lapseSwallow = () => {
    if (!swallow) return;
    clearTimeout(swallowTimer);
    swallowTimer = setTimeout(dropSwallow, SWALLOW_MS);
  };

  win.addEventListener("pointerdown", (event) => {
    dropSwallow();
    cancelPress();
    event.target?.closest?.(BAR_ICONS)?.classList.remove("is-tooltip-dismissed");
    if (event.pointerType === "mouse") return;
    const button = event.target?.closest?.(BAR_ICONS);
    if (!button || button.disabled) return;
    hide();
    press = {
      button,
      x: event.clientX,
      y: event.clientY,
      timer: setTimeout(() => {
        press = null;
        swallow = button;
        shown = button;
        button.classList.add("is-tooltip-open");
        hideTimer = setTimeout(hide, SHOW_MS);
      }, LONG_PRESS_MS),
    };
  }, true);

  win.addEventListener("pointermove", (event) => {
    if (press && Math.hypot(event.clientX - press.x, event.clientY - press.y) > MOVE_PX) cancelPress();
  }, true);
  win.addEventListener("pointerup", () => { cancelPress(); lapseSwallow(); }, true);
  win.addEventListener("pointercancel", () => { cancelPress(); lapseSwallow(); }, true);

  win.addEventListener("click", (event) => {
    if (!swallow) return;
    // A keyboard or assistive-technology activation (detail 0) is never the end of a press.
    if (event.detail === 0) return;
    const button = event.target?.closest?.(BAR_ICONS);
    const longPressed = button === swallow;
    dropSwallow();
    if (!longPressed) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);

  // Any key ends a pending swallow; Escape also closes a tooltip shown on hover, focus or a press (WCAG 1.4.13)
  // until the pointer or focus leaves the button.
  win.addEventListener("keydown", (event) => {
    dropSwallow();
    if (event.key !== "Escape") return;
    const button = event.target?.closest?.(BAR_ICONS) || shown;
    if (!button) return;
    hide();
    button.classList.add("is-tooltip-dismissed");
  }, true);
  const undismiss = (event) => event.target?.closest?.(BAR_ICONS)?.classList.remove("is-tooltip-dismissed");
  win.addEventListener("focusout", undismiss, true);
  win.addEventListener("mouseout", (event) => {
    const button = event.target?.closest?.(BAR_ICONS);
    if (button && !button.contains(event.relatedTarget)) button.classList.remove("is-tooltip-dismissed");
  }, true);

  // A long press must not open the browser's own menu over the tooltip.
  win.addEventListener("contextmenu", (event) => {
    if ((press || swallow) && event.target?.closest?.(BAR_ICONS)) event.preventDefault();
  }, true);
}
