# A coach reads the GPEXE name of an unlinked athlete: plan note

Status: **Proposed.** Plan only; no code until the *Rukovodilac* confirms. ★★ (trigger 2: a coach reads the identity
snapshot; `security-reviewer` and the *Nezavisni revizor*). No migration.

Owner decision (2026-11-13, relayed by the *Rukovodilac*): a coach may see the GPEXE name of an unlinked athlete. The
name only: never the date of birth, never the date-of-birth conflict flag.

Checked against `main` `cbede24b`.

## 1. What exists today

- **The snapshot** (v32, `training_load.gpexe_athlete_identities`) holds a GPEXE athlete's display name and date of birth,
  per binding and team, for 14 days. The live read is `GET …/teams/:teamId/athlete-identities` (`listIdentities`,
  `backend/src/gpexeAthleteIdentityService.js`). Its audience is `identityAdminBasis`: a platform admin (platform workspace
  or the team's club workspace) or the club's admin (the club workspace). It returns every identity of the binding with
  `name` and `birthDate`, plus `birthDateConflicts`.
- **The coach's screens** never ask for that list. `identityViewer()` (`frontend/gpexe-import-data.js`) is true only for
  `status.viewer.identityAdmin`. A coach therefore reads "GPEXE athlete <id>" on Link athletes, in the session review and in
  the link chooser.
- **U3 already gives the coach more than this decision allows.** `GET …/athlete-pair-suggestions` (`listPairSuggestions`,
  audience `pairSuggestionBasis`: the administrators and the team's own coach in that team's workspace) returns, for
  unlinked GPEXE athletes only:
  - `gpexeName`;
  - `birthDate`;
  - `dateConflicts` ("the name matches, but the dates of birth differ").

  That is R2 as the owner amended it on 2026-11-04: "the coach sees the pair, the GPEXE name and the date of birth,
  because the date helps pairing" (`docs/ai/gps-import-flow-contract.md` section U3). The frontend shows that date ("Born
  DD.MM.YYYY") in the suggestion box.
- **The coach's identity load** exists too: D3, the team's own coach in team mode only, through `identityLoadBasis`.
- **Legal gate:** closed by C123 ("names, dates of birth … need no legal basis, minors are not in the product"). Adding a
  minor athlete reopens it (contract section 5).

## 2. The question for the owner first (blocks the code)

The new decision ("never the date of birth, never the conflict flag") and U3's R2 (the coach sees the date of birth and
the conflict) cannot both hold for the same coach. One of:

- **(a)** The decision applies to the new places only. Link athletes, the review and the chooser show the name without
  the date, while the U3 suggestion box keeps showing the date and the conflict. The rule stays inconsistent, and the date
  stays visible to the coach.
- **(b)** The decision narrows U3 for the coach as well. The coach's suggestions answer drops `birthDate` and
  `dateConflicts`; a pair whose dates differ becomes one more "choose yourself" row with no reason given. The
  administrators' answer is unchanged.

I make no recommendation on the product question; (b) is the one that matches the decision's words. The answer changes
the scope below (marked **[b]**).

## 3. The change

### Who

The team's own coach, acting in **that team's workspace**: `pairSuggestionBasis` → `team_coach`. The right is held under
`rightHolds(team_coach, teamId)` FOR SHARE, in the same transaction as the read.
- It is not tied to the team's import switch or its mode. It is a read, like U3's suggestions, and unlike the D3 load.
- The administrators keep their bases unchanged.
- Everyone else gets the router's identical 404, no-store:
  - a coach of another team;
  - a coach in the club or platform workspace;
  - a revoked role;
  - an archived team or club;
  - a team without an active binding.

### What

`GET …/athlete-identities` widens its audience to `pairSuggestionBasis`. `listIdentities` gains a coach projection:

- `identities`: only GPEXE athletes with **no active link** in the team, each `{ gpexeAthleteId, name }`. There is no
  `birthDate` key, not even as null. A linked athlete's GPEXE name never reaches a coach; the coach sees the OptiMove
  athlete instead.
- No `birthDateConflicts` key.
- `pendingCount`, `maxPerLoad` and `retentionDays` stay, since the D3 load is already the coach's in team mode.
  `retryLaterCount` stays a count.

The filter is SQL (`not exists` on `gpexe_athlete_links`, as U3 does), inside the same locked transaction. It is not done
in JavaScript after the read.

**Read only.** No new load right. The coach's load stays exactly D3 (team mode).

**Status:** `status.viewer` gains `identityNames: true` for that coach (only when true, like `identityAdmin`). The route
computes it from `pairSuggestionBasis`; the service decides again.

### Where the coach sees the name (frontend)

- `identityViewer()` splits into:
  - `identityNames()`: the name labels and ordinals, for an admin or the team's coach;
  - `identityAdmin()`: the date of birth, the conflict warning, the snapshot counts and Technical details, for admins only.
- **Link athletes** (rows from `source-athletes`): "the GPEXE athlete <name>" with no "Born …" line for a coach.
- **The session review modal** (entries of the candidate detail): the same labels on the athlete rows, in the link chooser
  under a row, in the confirmation and in the result sentences.
- The last-link notice and the errors.
- **The unlink question:** it names a linked athlete, so the coach sees the OptiMove name as today.
- **The U3 suggestion box:**
  - under (a), unchanged;
  - **[b]** the coach's rows lose "Born …" and the date-conflict reason.
- **Unchanged:** the board (`sourceMetricBoardService`), and an athlete who is linked.
- Duplicate names: the ordinal "(GPEXE athlete N)" as for an admin. N is never the id.

### What does not change

- `source-athletes` and the candidate detail / preview server projections. The name is not put into a stored preview, so
  the preview hash and the stored previews are untouched.
- Info-hiding (the identical 404; no-store; the answer in memory only, dropped on Close, a team or workspace switch, or
  sign-out).
- The 14-day retention, the purge before every read, and the deletion on Unbind or archive.
- The legal gate (C123): no new basis is needed; it reopens if a minor athlete is added.

## 4. Files

| File | Change |
|---|---|
| `backend/src/routes/gpexeImport.js` | the `athlete-identities` GET audience; `viewer.identityNames` in status |
| `backend/src/gpexeAthleteIdentityService.js` | `listIdentities`: the coach projection (unlinked only, name only); **[b]** `listPairSuggestions`: the coach answer without `birthDate` / `dateConflicts` |
| `frontend/gpexe-import-data.js` | `identityNames` / `identityAdmin` split; load the list for the coach |
| `frontend/gpexe-import-view.js` | no "Born" line or conflict for a coach; **[b]** the suggestion box |
| `docs/ai/gps-import-flow-contract.md` | the decision, and **[b]** R2 amended |

## 5. Tests

**Backend** (`gpexe-athlete-identity.test.mjs`, `gpexe-pair-suggestions-u3.test.mjs`):
- the team's coach in the team workspace gets names of unlinked athletes only. The answer has no `birthDate` and no
  `birthDateConflicts` key at all (key presence asserted). A linked athlete is absent; an athlete unlinked later appears;
- the identical 404 (same bytes as a missing team) for:
  - a coach of another team;
  - the coach in the club or platform workspace;
  - a revoked role, also revoked during the read through `listHold`;
  - an archived team or club;
  - no binding;
- the administrators' answer byte-identical to today's;
- the recorded SQL lock order of the coach read is the same as an admin's (connection, binding, team, users, role, club);
- **[b]** the coach's suggestions carry no `birthDate` or `dateConflicts`; an admin's are unchanged.

**Frontend** (`gpexe-athlete-identity.actions`, `gpexe-imports-id-masking.actions`, `gpexe-pair-suggestions.actions`):
- the coach sees names and no "Born", no conflict and no Technical details;
- the admin is unchanged;
- a 404 shows nothing.

**Also:**
- mutations of the audience, the unlinked filter and the dropped keys;
- e2e on the coach's Link athletes and the review (390 and 1280 px);
- `--preset frontend-fast` against `origin/main`, the frontend PR gate.

## 6. Reviews and order

- ★★ trigger 2: `security-reviewer`, `code-reviewer`, `ux-design-reviewer` and `mobile-qa` (frontend), then both GOs.
- One PR, backend and frontend together, so the coach never gets an answer the screen does not expect. No migration and no
  preflight.
- Needs before code: your confirmation and the owner's answer to section 2.
