# Training Load — Analysis Dashboard UX contract (design only, no frontend code)

Textual UX contract for desktop, tablet, and mobile. Style: neutral white/gray surfaces, SVG line icons matching Tests/Calendar, teal (`var(--accent)`) reserved for active selection, warning, conflict, or status — never a large solid color block, exactly as the rest of Training Load already does. No visual mockup tool was used; this is the same textual-contract format the Calendar phase's own UX decisions were driven by.

---

## Desktop (and any viewport ≥ ~960px)

### Layout
- A **12-column grid**, same visual density as the rest of the app's card-based sections — no dedicated "dashboard chrome" that looks foreign to Training Load.
- Two modes: **View** (default) and **Edit**, toggled by a single header button ("Edit layout" / "Done editing" — never a padlock icon or a modal; the grid itself gains a light dashed outline and per-widget drag handles only while in Edit mode).

### Header row
```
[Dashboard name ▾]   [Global filter: period · activity · athletes ▾]   [Edit layout]   [⋮]
```
- **Dashboard name ▾** — click opens the dashboard switcher (recently used + "Browse all" + "New dashboard"). If the current dashboard is a template being viewed (not yet cloned) by someone who cannot edit it, this shows a small neutral "Template" tag next to the name and offers **Clone** instead of **Edit layout**.
- **Global filter** — a single compact control combining period, the Calendar-provided `activityId`/`componentId` context (when arriving from Calendar, pre-filled and visually pinned with a small "from Calendar" hint), and athlete/team selection. Opens the same recipient-style picker pattern already used elsewhere in Training Load (Club/Team/Athletes tabs) — not a new picker design.
- **⋮** — Rename, Duplicate, Archive (with the same "this has X active viewers/clones" confirmation copy pattern Training Load already uses for destructive-feeling actions), Save as default.

### View mode
- Widgets render read-only. Clicking a KPI/chart/table row that maps to a specific athlete/activity/component narrows the *global* filter (never silently mutates a widget's own saved config) — same "runtime filter, not a saved rewrite" rule as §D7/§4 of the model report.
- A widget that failed its own query (batch partial-error, §8 of the model report) shows a small inline error state **scoped to that one widget** — never a full-page error, never blocking the other widgets.
- A widget whose series resolved to nothing (e.g., a template's hint never matched anything in this workspace) shows a neutral "No matching metric available" empty state, not a red error.

### Edit mode
- **Add widget** — a button opens a small picker: widget type (4 icons — KPI/Table/Line/Bar) → metric/series picker (same domain/category/search UI as the Calendar's own metric picker, reused verbatim, not redesigned) → drops onto the grid at the first free position, sized at that type's own `default_width`/`default_height`.
- **Drag** — a widget's whole header area is the drag handle; dragging shows a live "ghost" outline at 12-column granularity; drop is rejected (widget snaps back, brief shake) if it would overlap another widget — matching the DB's own deterministic-reject behavior (model report §D3), never a silent auto-push of other widgets.
- **Resize** — a small handle at the widget's bottom-right corner, constrained live to that widget type's own min/max size (model report §D3/`dashboard_widget_types`) — the handle simply cannot be dragged past the bound, no error message needed.
- **Per-widget menu** (small `⋮` in each widget's own header, Edit mode only) — Edit series/metrics, Change type-specific display options, Collapse (`state='collapsed'`, model report), Remove.
- **Save / Discard** — a small bar appears at the bottom once anything has changed (position, size, added/removed widget, series edit): "Discard changes" / "Save layout". Discard reverts to the last-saved `revision` for every touched widget and the dashboard itself. Save sends the batch of changes; a `409` (stale revision — another editor saved first) surfaces as: *"This dashboard changed while you were editing. Your layout changes were not saved — reload to see the latest version."* — never a silent overwrite, matching model report §D5.

---

## Tablet (~600–959px)

- The SAME 12-column grid model, rendered at reduced effective density: widgets are laid out using their own stored `x`/`width` but visually scaled/wrapped so nothing requires horizontal scroll of the *page* — this is a **responsive reduction of the desktop grid**, not a second stored layout (model report §D3). In practice: columns 7-12 wrap to a second visual row beneath columns 1-6 for any widget whose `x+width` would otherwise exceed the tablet's own reduced column count, preserving relative left-to-right/top-to-bottom order.
- Drag/resize stays available (tablet has room for direct manipulation) but touch-sized (larger handles, same overlap-reject behavior).
- Global filter control collapses labels but keeps the same three-part shape (period/activity/athletes).

---

## Mobile (< 600px)

- **Single column**, ordered by each widget's own `mobile_order` — never `x`/`y`/`width`/`height` (those are meaningless below the grid breakpoint).
- **No free drag/resize.** In Edit mode, each widget instead gets **Move up / Move down** controls (matching the "no free-form drag on mobile" rule already established for the Calendar's own month view and every other mobile-constrained control in this app) — swapping `mobile_order` with its neighbor, sent as one PATCH per swap (or batched on Save, matching desktop's own Save/Discard bar).
- **Table widgets** get their own internal horizontal scroll container (`overflow-x: auto` on the table wrapper only — exact same pattern as the Calendar Results table) — the page itself never scrolls horizontally, verified the same way the Calendar phase verified it (`document.documentElement.scrollWidth <= clientWidth` at 360/375/390px, zero overflow).
- **Calendar/activity context stays visible** — when opened from an activity, a slim, non-scrolling context bar ("9 Sep 2026 › Morning Strength") stays pinned above the widget list, exactly mirroring the Calendar's own context bar component (not a new pattern) — tapping it returns to the Calendar view without losing the dashboard's own scroll position on return (same `view-cache.js`-backed instant-redisplay behavior as switching Calendar tabs).
- **Add widget** on mobile opens the same type→series picker as desktop, full-screen (matching the Calendar's own metric-picker mobile treatment), and appends the new widget to the *bottom* of the mobile order (never asks for a manual mobile-position pick on creation — that's what Move up/down is for afterward).
- KPI widgets stack as compact single-row tiles (icon + value + label), never full-width empty space around a single number.

---

## Accessibility (all breakpoints)

- Every widget is a labelled region (`aria-label` = widget title); the grid container has `role="list"`, each widget `role="listitem"`.
- Drag handles are also operable via keyboard in Edit mode (arrow keys move by one grid unit on desktop/tablet; on mobile the Move up/down buttons are the only mechanism, already keyboard-native).
- The global filter control and per-widget menus follow the exact same `aria-expanded`/focus-return conventions already used by the Calendar's own filter picker and metric picker — not reinvented.
- Focus never disappears after a re-render (same rule already enforced for Calendar/Results — carried forward here as a hard requirement, not a nice-to-have).
- Color is never the *only* signal: a conflict cell, an error widget, and a collapsed widget each also carry a distinct icon/label, not just a color change.
