# Metrics Core, source metrics and mapping

Applies to any work on Metrics Core (`training_load.metric_definitions` and its versions,
scope capabilities, domains, categories, structure links), the source metric catalog,
source-to-canonical mapping, the GPEXE mapper / writer (`backend/src/gpexeImportMapper.js`,
`gpexeImportWriter.js`, `gpexeImportPreview.js`) or dashboard metric definitions.

- **Read first:** `docs/ai/gpexe-metric-variable-mapping-discovery.md` — the proven existing
  state (sections A, B), the owner's accepted decisions (C) and the accepted, not yet
  implemented design (D–K). Do not re-derive what it already records.
- **Do not repeat the whole discovery** when the relevant migrations and modules have not
  changed. Check only what changed since the document's `Last verified against commit`
  (`git diff <that commit>..HEAD -- migrations_v2 backend/src frontend` for the files the
  document's header lists), and verify those parts.
- **A PR that changes any contract the document describes** (a listed table, trigger,
  constraint, route, module or the GPEXE map) updates the document in the same PR and sets
  `Last verified against commit` to the commit the change was verified against (the PR's base,
  or the head commit named in the PR description — a PR cannot name its own head in its diff).
- **Code and migrations win** when they differ from the document: fix the document, never
  argue from it against the checked-out code.
- **No parallel canonical registry.** Metrics Core is the only registry of OptiMove variables;
  a new table of "metrics", "variables" or "parameters" for Training Load needs a new owner
  decision first (document section C, ADR-007).
- **M1 is not started because the document exists.** The accepted design (T2a–T8,
  `unit_conversions`, `api_family`) is implemented only on an explicit owner order, as the
  separate PRs M1–M6 of section J.
