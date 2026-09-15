# OptiMove dashboard profile — Carbon skill override

This file is the **authoritative OptiMove-specific override** for the Carbon skill. Read
this before applying any Carbon guidance to OptiMove, and especially before touching
Training Load Analysis or any other dashboard surface. Where this file and the rest of
`SKILL.md`/`references/` disagree, **this file wins** — see the "OptiMove project
override" banner at the top of `SKILL.md`.

Carbon here is a **design/UX/accessibility reference**, not a runtime dependency. Nothing
in this skill installs anything, runs anything, or changes application code by itself —
every action below still goes through OptiMove's own normal review/confirmation flow
(`CLAUDE.md`, `.claude/rules/*.md`).

## Current frontend architecture

- OptiMove's frontend is **plain ES modules plus the existing CSS** — no React, no Web
  Components, no CSS-in-JS, no component framework. One domain = `{name}-view.js`
  (render) + `{name}-actions.js` (events/mutations) + `{name}-data.js` (API/cache); see
  `PROJECT_CONTEXT.md`'s repo structure map.
- **Vite is used only in its existing role**: the production build tool. It is not being
  introduced or repurposed as a bundler for a new component framework by this skill.
- **Carbon is currently a design/UX reference, not a runtime framework.** Nothing in
  `@carbon/react`, `@carbon/web-components`, or any other Carbon package runs in
  OptiMove. This skill's job is to inform how OptiMove's own plain-JS/CSS components
  look, behave, and are structured — not to replace them with Carbon's own components.

## Forbidden automatic installs

This skill, and anyone following it in the OptiMove repo, must **never** autonomously:

- install `@carbon/react`;
- install `@carbon/web-components`;
- install `@carbon/styles`;
- install Sass (Dart Sass or otherwise);
- install IBM Plex or any other font package;
- install Carbon Charts (`@carbon/charts`, `@carbon/charts-react`, or the
  `carbon-design-system/carbon-charts` package under any name);
- run `npm install`, `npx`, or any other package-manager mutation on OptiMove's behalf;
- add a CDN `<script>`/`<link>` tag pulling in any Carbon runtime package or IBM Plex.

Every one of Carbon's own upstream code examples that use `npm install`/`npx` (elsewhere
in this skill's `references/`) stays as **upstream reference documentation only** — none
of it is executable against OptiMove without a separate, explicit product and
architecture decision, confirmed by the user, the same way any other new runtime
dependency would be (see `.claude/rules/frontend.md` and `CLAUDE.md`'s general
confirmation requirements). Reading the docs and applying visual/structural inspiration
in plain JS/CSS is in scope; running the install commands they show is not.

## OptiMove identity

- Keep the OptiMove brand — colors, product identity, and voice stay OptiMove's own.
  This is explicitly **not** a rebrand toward IBM's visual identity.
- Use Carbon for **hierarchy, density, spacing, controls, states, tables, accessibility,
  and consistency** — i.e. as a source of proven interaction/layout patterns to adapt,
  not a visual skin to apply wholesale.
- Do not turn the application into an IBM-branded product. No IBM logos, no unmodified
  Carbon theme colors applied as OptiMove's palette, no framing of OptiMove as "built on
  Carbon" in user-facing copy.
- Carbon principles get adapted to OptiMove's **existing** tokens/components (its own
  CSS custom properties, its own spacing scale, its own component markup) — Carbon
  informs the redesign of those existing pieces, it doesn't get bolted on as a second,
  parallel design system.

## Functional boundaries

Visual/design work informed by this skill must **not**, by itself, change:

- Training Load functionality (data, calculations, metrics, behavior);
- backend code or services;
- API contracts (request/response shapes, endpoints, status codes);
- authorization or workspace rules (`owner_scope`, `data_workspace`, `resolveActiveWorkspace()` — see
  `PROJECT_CONTEXT.md`'s "Identity, ownership, and workspace" section and ADR-002);
- dashboard query semantics (what data is fetched, how it's aggregated);
- the database, or any persisted data.

A Carbon-informed visual change is a **presentation-layer** change. If a piece of visual
work seems to require touching any of the above, that's a signal it has grown beyond
"design/UX/accessibility reference application" and needs its own scoped task with its
own product decision — not something this skill authorizes on its own.

## Dashboard grid

The current Training Load dashboard uses a **persisted 12-column grid model**, enforced
across multiple layers of the system: `migrations_v2` schema/constraints and the
sanctioned dashboard/widget/series functions (ADR-003), existing saved dashboards and
template layout data, backend API validation, and frontend width-limiting/clamping,
collision-handling, and drag/resize logic (see `docs/ai/CURRENT_STATE.md` for what's
shipped, and `.claude/rules/migrations.md` for the schema-change contract).

**For the first Carbon-informed proof-of-concept, keep 12 columns.** Carbon's own
spacing, alignment, breakpoint, and 2x Grid *principles* (consistent gutters, a real
breakpoint scale, predictable column math) can be applied independently of the exact
column count — adopting Carbon's spacing/alignment thinking does not require adopting
Carbon's specific 16-column number.

Moving from 12 to 16 columns is **not forbidden forever**, but it is explicitly **out of
scope for any PoC this skill's guidance leads to**, and must become its own dedicated
future task. That future task would need to cover, at minimum:

- DB constraints and the sanctioned dashboard/widget/series functions (ADR-003) that
  currently assume/enforce 12 columns;
- existing saved dashboards' and template layouts' stored column data (a real data
  migration, not just a schema change);
- API validation of layout/width values;
- frontend width limits and clamping logic;
- collision handling between widgets during layout edits;
- drag/resize interaction logic (desktop pointer-based editing);
- responsive/mobile behavior at the new column count;
- a real test pass covering all of the above;
- a conversion path for every existing 12-column layout to whatever the 16-column
  equivalent should be.

**Do not treat a 12→16 column change as "just a CSS update."** It touches persisted data,
sanctioned DB functions, and API contracts — the same category of change
`.claude/rules/migrations.md` and `CLAUDE.md`'s external-review triggers already require
extra care for.

## Charts

- `carbon-design-system/carbon-charts` (and its React wrapper) is a **separate runtime
  library**. It is not part of this skill and must not be installed by anything this
  skill's guidance leads to.
- For the first PoC, use OptiMove's **existing** charting/rendering approach — whatever
  the current Training Load Analysis widgets already use (plain JS/CSS, or whatever
  library is already a dependency) — informed by Carbon's data-visualization *design*
  guidance (density, color use, state handling), not Carbon's chart *code*.
- Any chart or data visualization should have: a **title**, a stated **unit**, the
  **time period** it covers, **comparison context** (e.g. vs. a prior period or target,
  where relevant), a **legend** when multiple series are shown, and explicit
  **loading/empty/error** states — not just a "happy path" render.
- **Color must not be the only carrier of meaning.** Anything distinguished by color
  (series, status, threshold crossing) needs a second cue — a label, a pattern, an icon,
  or text — so the information survives color-blindness or a grayscale render.
- Where a chart communicates a value someone needs to act on, provide a **tabular or
  textual equivalent** of that value for accessibility (screen readers can't read a
  canvas/SVG chart's visual encoding).

## Mobile

Follow OptiMove's existing, already-established mobile rules (see
`.claude/rules/frontend.md` and the shipped Training Load Analysis mobile work in
`docs/ai/CURRENT_STATE.md`) — Carbon's own responsive guidance gets adapted to fit these,
not the other way around:

- verify at **360px, 375px, and 390px** viewport widths;
- `input`/`select`/`textarea` font size is **at least 16px** on mobile (prevents iOS
  auto-zoom);
- interactive touch targets are **approximately 44×44px**;
- desktop-only controls (e.g. pointer-based drag/resize handles) must not remain
  **visible-but-non-functional** on mobile — either provide a working mobile equivalent
  (e.g. the existing Move up/down pattern) or hide the control entirely on mobile
  viewports.
