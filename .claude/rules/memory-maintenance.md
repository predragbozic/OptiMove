# Memory maintenance

How the project brain itself (`PROJECT_CONTEXT.md`, `docs/ai/CURRENT_STATE.md`,
`docs/decisions/`) gets updated — this is about writing to the brain, not about the
application's own code or database.

## What changes, and when

- **`PROJECT_CONTEXT.md`** changes only when stable architecture actually changes — a
  new domain module, a changed identity/workspace model, a changed source-of-truth. Not
  for every merged PR.
- **`docs/ai/CURRENT_STATE.md`** changes after a merged milestone, or when the active
  development phase changes. This is the one file expected to go stale between sessions —
  update it, don't let it silently rot.
- **An ADR** is added or edited only for a confirmed, implemented architectural decision —
  provable by current code or a merged migration. A decision that's still just a plan,
  not yet implemented or confirmed by the user, does not get written up as a permanent
  decision.
- A superseded decision gets a new ADR (or a status change) marking it **Superseded**,
  with a link both ways (`Supersedes` / `Superseded by` in `docs/decisions/README.md`'s
  table) — never silently deleted or edited in place to erase the old reasoning.

## What never goes in the brain

- Transient test results, pass/fail counts, or one-off delivery-report numbers — those
  belong in the session's own report to the user, not in `CLAUDE.md` or `PROJECT_CONTEXT.md`.
- Chat transcripts, credentials, connection strings, tokens, or personal/medical data —
  see `database-safety.md` for the DB-string rule specifically.
- A claim not provable by current code, migrations, git history, or a merged PR.

## Who writes

- Only the main session writes to the brain files. Review agents (`code-reviewer`,
  `db-reviewer`, `mobile-qa`, `security-reviewer`, `ux-design-reviewer`) are read-only — a finding they report
  is text for the main session to act on, never a file they edit themselves, and that
  includes the brain files.
- At the end of a task, the main session decides whether a memory write-back is actually
  warranted — not every session needs one. A routine bugfix with no architectural
  implication needs no `PROJECT_CONTEXT.md`/ADR change.

## Keeping the brain itself sane

- Don't duplicate a rule's full text into `CLAUDE.md` — `CLAUDE.md` links to
  `.claude/rules/*.md` and `docs/decisions/README.md`; each rule file owns one topic.
- Before adding new content, check whether it contradicts something already written in
  `CLAUDE.md`, another rule file, or an ADR — a contradiction found later is harder to
  untangle than one caught at write time.
- If a fact can't be verified against the current repo state in the session making the
  change, don't write it as fact — note it as unverified, or leave it out.
