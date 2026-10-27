# Apache ECharts

- Version: 6.1.0, https://github.com/apache/echarts/releases/tag/6.1.0
- Source: `npm pack echarts@6.1.0 --ignore-scripts`, package `dist/echarts.esm.min.mjs`.
- Local file: `echarts-6.1.0.min.mjs`, unmodified.
- SHA-256: `28515f26aa57f87eb1e4ed4eb446927eaf329b5f5e02b4bfd4b0264fea40d1da`.
- License: Apache-2.0; upstream LICENSE and NOTICE retained alongside the file.
- The upstream BSD d3 notice is retained at `licenses/LICENSE-d3`. The production
  build emits all three notices under `dist/licenses/echarts/` without changing
  their contents or the vendor distribution.
- Lazy, same-origin browser import. No CDN, telemetry or data-source access.
- The full browser ESM build preserves the existing unbundled development flow;
  Vite emits a separate lazy production chunk. No npm dependency or lockfile change.

To update, obtain a pinned upstream package, replace the distribution and its
LICENSE/NOTICE, update the import and hash, then run chart adapter/lifecycle tests,
dashboard regressions, production build and desktop/mobile fixture browser QA.
