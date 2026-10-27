# D5 — Carbon-referenced Dashboard UX

The existing application remains plain ES modules and its current visual shell.
Carbon is a design reference, not a new React/component-library dependency.

- Single-category plots use Carbon's Blue 80 (`#002d9c`) on the light surface.
  Each partition has a visible caption; identity never relies on color alone.
- Explicit status text accompanies missing/conflicted/unsupported values. A failed
  series has a readable recovery message rather than an internal error code.
- Every chart retains an initially expanded Values and status table, with a
  caption, column headers, real numeric text and all supplied identity context.
  Keyboard users can focus and scroll the widget body and table. SVG is hidden
  from assistive technology because the table supplies the authoritative values.
- Native disclosure controls retain keyboard operation, visible focus and a 44px
  target. KPI context wraps; table values use aligned tabular numerals.
- V2 legend and value-label settings remain honored, including the contract's
  default visible legend. No automatic configuration write occurs.

References: [Carbon visualization colors](https://www.carbondesignsystem.com/building-blocks/data-visualization/color-palettes),
[table accessibility](https://www.carbondesignsystem.com/building-blocks/core/components/data-table/accessibility),
[developer accessibility guidance](https://www.carbondesignsystem.com/building-blocks/foundations/accessibility/developers).
This is not a claim of full Carbon or WCAG certification; browser fixture QA and
independent review are recorded separately in D6.
