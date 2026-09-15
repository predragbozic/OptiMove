# Carbon — a Claude skill for the IBM Carbon Design System

A Claude skill for building UIs with **[Carbon](https://carbondesignsystem.com)** — IBM's
open-source design system. It bundles a faithful, offline copy of Carbon's in-repo docs as
structured references, with a concise guide on top.

> Repository overview, installation, and details live in the [root README](../../README.md).

## What it does

Activates when you ask Claude about Carbon, `@carbon/react`, `@carbon/web-components`, Carbon
Sass/styles, themes, the 2x Grid, Carbon icons, or feature flags, and answers from the real docs:

- **Component usage** for both flagships — `@carbon/react` (`<Button>`, `<DataTable>`, …) and
  `@carbon/web-components` (`<cds-button>`, …), including feature-flagged behavior
- **Styling** with `@carbon/styles` Sass — `@use`, Dart Sass setup, the `cds` class prefix
- **Theming** — white/g10/g90/g100, the `<Theme>` component, `$theme` with-config, Layer
- **Elements** — colors, themes, grid, layout, type (IBM Plex), motion, icons, pictograms
- **Feature flags & preview code**, and the **v10 → v11** migration

## Contents

- [`SKILL.md`](SKILL.md) — the guide Claude loads on trigger (workflow + a map into `references/`)
- [`references/`](references/) — 245 pages of faithful Markdown converted from the Carbon monorepo
  - [`references/CONTENTS.md`](references/CONTENTS.md) — full navigation by section
  - [`references/LICENSE`](references/LICENSE) — upstream documentation license (Apache-2.0, IBM Corp.)

## Installation

> **OptiMove note:** OptiMove already has a vendored, commit-pinned project copy of
> [`iamursky/carbon-skill`](https://github.com/iamursky/carbon-skill) at
> `.claude/skills/carbon/` — see [`.upstream-commit`](.upstream-commit) for the exact
> pinned commit. There is nothing to install, sync, or run here; the generic install
> instructions this section originally carried do not apply to this vendored copy and
> have been removed for that reason. For any OptiMove or Training Load task, read
> [`SKILL.md`](SKILL.md)'s **OptiMove project override** section and
> [`references/optimove-dashboard-profile.md`](references/optimove-dashboard-profile.md)
> first — they take precedence over the rest of this skill's generic guidance.

## Provenance & license

`references/` is converted from the official
[carbon-design-system/carbon](https://github.com/carbon-design-system/carbon) monorepo (Storybook
MDX + package READMEs → Markdown), redistributed under the upstream **Apache-2.0** license
([`references/LICENSE`](references/LICENSE)); each page links back to its file on GitHub. The skill
itself is MIT — see the [root license](../../license).

> Unofficial, community-built skill. Not affiliated with or endorsed by IBM or the Carbon Design System.
