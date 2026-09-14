---
paths:
  - "frontend/**/*.js"
  - "frontend/**/*.css"
  - "frontend/**/*.html"
  - "frontend/tests/**"
---

# Frontend

Plain ES modules, no build-time framework, no bundler in dev (Vite is used only for the
production build). `app.js` is the intentional event-delegation orchestrator — a new
`data-action` handler wired there isn't automatically a smell, but a new *domain's* logic
belongs in its own module.

## Module pattern

A new frontend domain follows `{name}-view.js` (rendering, pure template strings) +
`{name}-actions.js` (event handling, mutations) + `{name}-data.js` (API calls, cache).
Check whether an existing domain already does something similar before adding parallel
logic — cross-domain duplication (especially anything training-load-shaped) is a
`code-reviewer` finding.

## Mobile / responsive (check at 360px, 375px, 390px — not just one breakpoint)

- Every `input`/`select`/`textarea`, at every breakpoint, needs `font-size >= 16px` — a
  smaller size triggers iOS Safari's auto-zoom-on-focus. Watch for a parent element
  setting a smaller `font-size` that a child input then inherits via `font: inherit` —
  this has caused a real regression once (Training Load Analysis topbar controls).
- Interactive elements need a real ~44×44px touch target on mobile, including tight
  custom controls like drag handles, resize handles, and add/delete icon buttons — the
  generic `.compact-button`/`.icon-button` base sizing in `styles.css` is smaller than
  that in places; don't assume it's already covered.
- A mobile-only control (e.g. "Move up"/"Move down" replacing desktop drag) needs its own
  touch-target treatment if it reuses a class that's undersized elsewhere.
- **No functionally-dead mobile controls.** If a desktop-only interaction (e.g. a
  drag/resize affordance, or a control whose effect depends on a CSS custom property the
  mobile layout doesn't read) is left visible but inert on mobile, hide it there instead —
  a visible control with no effect reads as broken, not as a graceful degradation.
- No raw ID/UUID as a typed text input anywhere the user has (or should have) a real
  picker/selector instead — this has been treated as a real bug, not a style nit, at
  least once (Training Load Analysis widget filter override).

## CSS cascade discipline

`styles.css` has 50+ media queries and leans on `!important` in newer, wider mobile
blocks (typically `@media (max-width: 760px)`) to reliably beat older, narrower CSS.
Before concluding how something currently behaves on mobile from reading one block,
search the whole file for the same selector — a later rule may already override it. This
has caused a wrong conclusion in this project before.

## Data/cache/batch patterns

- A dashboard-shaped view that needs several widgets' worth of data queries it in ONE
  batch request, not one request per widget/series — check for an existing batch
  endpoint before adding a new per-item fetch.
- Reuse `view-cache.js`'s `loadCachedView`/`buildContextKey`/`invalidateCacheNamespace`
  rather than inventing a parallel caching mechanism for a new domain.
- A fast sequence of user actions (switching dashboards, changing a filter, changing a
  period) must not let a slower, older response overwrite a newer one — use a generation
  counter or context-key check, matching the existing pattern in `training-load-*-data.js`
  files, rather than assuming requests resolve in the order they were sent.

## Browser QA

A real browser check (manual or automated, per `testing-evidence.md`) is only needed
when there's an actual visual or interaction change to verify — not for a pure
data/logic change with existing unit coverage.
