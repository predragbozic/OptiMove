// Central calendar K7 (docs/ai/central-calendar-k7-timegrid-contract.md, section 2): the time grid laid out like a
// professional calendar. Pure functions only: they take a column's entries and return where each one goes; the view
// draws what they return. No DOM, no state.
//
// An entry is { item, start, end, minor }:
// - `start`, `end`: minutes from midnight; `end` null when the item has no end (a planned training, an activity, a
//   chip): it is laid out with a nominal NOMINAL_MINUTES and drawn with an open lower edge;
// - `minor`: a chip (K5-2), the first to move into "+N more" when a cluster is full (cards keep their columns).

export const NOMINAL_MINUTES = 30;
export const DAY_MINUTES = 24 * 60;

const TIME = /^(\d{2}):(\d{2})/;

// "09:30" or "09:30:00" -> 570; anything else -> null.
export function centralCalendarMinutesOf(time) {
  const match = TIME.exec(String(time || ""));
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

// The drawn extent: never shorter than NOMINAL_MINUTES (a short event or no end), never past midnight.
function drawnEndOf(entry) {
  const real = entry.end != null && entry.end > entry.start ? entry.end : null;
  return Math.min(DAY_MINUTES, Math.max(entry.start + NOMINAL_MINUTES, real ?? 0));
}

// The grid's hours (2.1): the default window, widened to the earliest start and to the latest drawn end (rounded up
// to the next hour), never past 24:00. `endHour` is exclusive: the grid runs startHour:00 to endHour:00.
export function centralCalendarGridHours(entries, { startHour, endHour }) {
  let start = startHour;
  let end = endHour;
  for (const entry of entries || []) {
    if (entry.start == null) continue;
    start = Math.min(start, Math.floor(entry.start / 60));
    end = Math.max(end, Math.ceil(drawnEndOf(entry) / 60));
  }
  return { startHour: Math.max(0, start), endHour: Math.min(24, end) };
}

// Column assignment inside one cluster (2.2, 3): each entry takes the first column whose last entry has already
// ended (drawn end <= this start), otherwise a new column. Touching is not overlapping.
function assignColumns(cluster) {
  const columnEnds = [];
  for (const entry of cluster) {
    let column = columnEnds.findIndex((end) => end <= entry.start);
    if (column === -1) {
      column = columnEnds.length;
      columnEnds.push(entry.drawnEnd);
    } else {
      columnEnds[column] = entry.drawnEnd;
    }
    entry.column = column;
  }
  return columnEnds.length;
}

const overlaps = (a, b) => a.start < b.drawnEnd && b.start < a.drawnEnd;

// One column's layout (2.1-2.3). Returns
//   placed: [{ item, top, height, column, columns, span, openEnd, minor }]
//   more:   [{ top, height, column, columns, items }]
// in reading order (cluster by cluster, each cluster's entries in the sort order, its "+N more" after them). `top` and
// `height` are minutes from `startHour`; `column`/`span`/`columns` give the left edge and width as fractions.
export function centralCalendarTimeLayout(entries, { startHour = 0, maxColumns = 3 } = {}) {
  const origin = startHour * 60;
  const timed = (entries || [])
    .map((entry, index) => ({ ...entry, index, drawnEnd: drawnEndOf(entry) }))
    .filter((entry) => entry.start != null);
  // 1. Drawn start, then the longer first, then the server's order.
  timed.sort((a, b) => a.start - b.start || (b.drawnEnd - b.start) - (a.drawnEnd - a.start) || a.index - b.index);
  // 2. Clusters: a new one when the start is at or after the running maximum drawn end.
  const clusters = [];
  let current = null;
  let runningEnd = -1;
  for (const entry of timed) {
    if (!current || entry.start >= runningEnd) {
      current = [];
      clusters.push(current);
      runningEnd = entry.drawnEnd;
    } else {
      runningEnd = Math.max(runningEnd, entry.drawnEnd);
    }
    current.push(entry);
  }
  const placed = [];
  const more = [];
  for (const cluster of clusters) {
    let columns = assignColumns(cluster);
    let shown = cluster;
    let hidden = [];
    if (columns > maxColumns) {
      // 2.3: too many at once. The cards are placed before the chips, so chips are the first to move into "+N";
      // the last visible column is the "+N more" button.
      const ordered = [...cluster.filter((entry) => !entry.minor), ...cluster.filter((entry) => entry.minor)];
      assignColumns(ordered);
      const keep = maxColumns - 1;
      shown = cluster.filter((entry) => entry.column < keep);
      hidden = cluster.filter((entry) => entry.column >= keep);
      columns = maxColumns;
    }
    const block = hidden.length
      ? { start: Math.min(...hidden.map((entry) => entry.start)), drawnEnd: Math.max(...hidden.map((entry) => entry.drawnEnd)), column: columns - 1 }
      : null;
    // 4. Width to the right: over every column to the right that is free for the entry's whole drawn extent.
    for (const entry of shown) {
      let span = 1;
      for (let column = entry.column + 1; column < columns; column += 1) {
        const taken = shown.some((other) => other !== entry && other.column === column && overlaps(entry, other))
          || (block && block.column === column && overlaps(entry, block));
        if (taken) break;
        span += 1;
      }
      placed.push({
        item: entry.item, top: entry.start - origin, height: entry.drawnEnd - entry.start,
        column: entry.column, columns, span, openEnd: entry.end == null || entry.end <= entry.start, minor: Boolean(entry.minor),
      });
    }
    if (block) {
      more.push({ top: block.start - origin, height: block.drawnEnd - block.start, column: block.column, columns, items: hidden.map((entry) => entry.item), after: placed.length });
    }
  }
  return { placed, more };
}
