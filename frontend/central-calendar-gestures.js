const WEEK_COLUMNS = 7;
const ZOOMED_COLUMNS = 3;
const HOUR_HEIGHT = 48;

let visibleColumns = WEEK_COLUMNS;
let firstColumn = 0;
let hourHeight = HOUR_HEIGHT;

export function bindCentralCalendarGestures(calendar) {
  if (!calendar) return;
  const phone = calendar.classList.contains("cc-layout-phone");
  const grid = calendar.querySelector(".cc-timegrid");
  const weekGrid = phone && grid && !grid.classList.contains("cc-timegrid-day");
  let start;

  function updateGrid() {
    grid.style.setProperty("--cc-hour-px", `${hourHeight}px`);
    if (!weekGrid) return;
    grid.style.setProperty("--cc-visible-days", visibleColumns);
    grid.querySelectorAll(".cc-timegrid-row").forEach((row) => {
      Array.from(row.children).slice(1).forEach((column, index) => {
        column.hidden = index < firstColumn || index >= firstColumn + visibleColumns;
      });
    });
  }

  function setHourHeight(height) {
    hourHeight = Math.max(32, Math.min(96, height));
    updateGrid();
  }

  function navigate(direction) {
    if (weekGrid && visibleColumns === ZOOMED_COLUMNS) {
      const next = firstColumn + direction;
      if (next >= 0 && next <= WEEK_COLUMNS - ZOOMED_COLUMNS) {
        firstColumn = next;
        updateGrid();
        return;
      }
      firstColumn = direction === 1 ? 0 : WEEK_COLUMNS - ZOOMED_COLUMNS;
    }
    calendar.querySelector(`[data-action="central-calendar-${direction === 1 ? "next" : "prev"}"]`)?.click();
  }

  if (grid) {
    updateGrid();
    if (!phone) grid.addEventListener("wheel", (event) => {
      if (!event.deltaY || Math.abs(event.deltaX) > Math.abs(event.deltaY) || !event.cancelable) return;
      event.preventDefault();
      setHourHeight(hourHeight - Math.sign(event.deltaY) * 6);
    }, { passive: false });
  }
  if (!phone) return;

  calendar.addEventListener("touchstart", (event) => {
    const [a, b] = event.touches;
    if (calendar.querySelector(".cc-sheet") || event.target.closest(".cc-panel, .cc-toolbar, .cc-filters, .cc-chip-row, input, select, textarea")) {
      start = null;
      return;
    }
    if (b && event.touches.length === 2 && grid?.contains(event.target)) {
      const rect = grid.getBoundingClientRect();
      const fraction = ((a.clientX + b.clientX) / 2 - rect.left - 34) / Math.max(1, rect.width - 34);
      const column = firstColumn + Math.max(0, Math.min(visibleColumns - 1, Math.floor(fraction * visibleColumns)));
      start = { pinch: true, x: Math.abs(a.clientX - b.clientX), y: Math.abs(a.clientY - b.clientY), height: hourHeight, column };
    } else {
      const width = calendar.ownerDocument.defaultView.innerWidth;
      start = !b && a.clientX > 20 && a.clientX < width - 20 ? { x: a.clientX, y: a.clientY } : null;
    }
  }, { passive: true });

  calendar.addEventListener("touchmove", (event) => {
    if (!start?.pinch || event.touches.length !== 2) return;
    if (event.cancelable) event.preventDefault();
    const [a, b] = event.touches;
    const dx = Math.abs(a.clientX - b.clientX) - start.x;
    const dy = Math.abs(a.clientY - b.clientY) - start.y;
    if (!start.axis && Math.max(Math.abs(dx), Math.abs(dy)) > 12) {
      start.axis = weekGrid && Math.abs(dx) > Math.abs(dy) ? "width" : "height";
    }
    if (start.axis === "height") setHourHeight(start.height * (1 + dy / Math.max(45, start.y)));
    if (start.axis === "width") start.widthDelta = dx;
  }, { passive: false });

  calendar.addEventListener("touchcancel", () => { start = null; });
  calendar.addEventListener("touchend", (event) => {
    const gesture = start;
    start = null;
    if (!gesture) return;
    if (gesture.pinch) {
      if (Math.abs(gesture.widthDelta) <= 28 || !gesture.widthDelta) return;
      visibleColumns = gesture.widthDelta > 0 ? ZOOMED_COLUMNS : WEEK_COLUMNS;
      firstColumn = visibleColumns === WEEK_COLUMNS ? 0 : Math.max(0, Math.min(WEEK_COLUMNS - ZOOMED_COLUMNS, gesture.column - 1));
      updateGrid();
      return;
    }
    const touch = event.changedTouches[0];
    const dx = touch.clientX - gesture.x;
    const dy = touch.clientY - gesture.y;
    if (Math.abs(dx) > 54 && Math.abs(dx) > 1.6 * Math.abs(dy)) navigate(dx < 0 ? 1 : -1);
  }, { passive: true });
}
