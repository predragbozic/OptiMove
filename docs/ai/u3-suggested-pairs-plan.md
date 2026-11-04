# U3 — suggested athlete pairs and "Confirm all" (discovery and plan, ★★, no migration)

Part of J19 (`docs/ai/gps-import-flow-contract.md`, section 3, U3; R2 amended on 2026-11-04). **Status: Proposed, documentation only; no code before the *Rukovodilac*'s GO.** Verified against `origin/main` `73193fe2` (PR #369, v56). No production read, no GPEXE request.

## 1. The goal and the decisions it rests on

*Link athletes* proposes pairs "GPEXE athlete ↔ team athlete" by name and date of birth and links the clear ones with one confirmation. The coach of the team does this work after the pilot (D3), so (R2, amended by the owner on 2026-11-04) **the coach sees the pair, the GPEXE name and the date of birth**; the explicit *Load names and dates of birth* stays an administrator's act (it is the only act that reads GPEXE). The owner said no legal basis or notice is needed for the club's own members (Q11, 2026-11-04). The v32 snapshot (14-day TTL, deleted on Unbind / archive) is unchanged.

## 2. What exists (verified in code)

| Piece | Where | Reused as |
|---|---|---|
| The stored identities of a team (`gpexe_athlete_identities`: id, display name, birth date, expiry) | v32; `listIdentities()` in `backend/src/gpexeAthleteIdentityService.js` (one transaction holding `FOR SHARE` on the connection, binding, team, the caller's right and the club, then the read) | The suggestion read uses the same lock discipline and the same tables; it is a **sibling function in the same module**, not a change to `listIdentities`. |
| Who may read them | `identityAdminBasis()`: a platform admin (platform or the club's workspace) or the club's admin in the club workspace; **never a team workspace** | Extended for the new read only, by one new basis `team_coach` (section 3.2). The load and `listIdentities` keep their audience. |
| The athlete link write | `POST /teams/:teamId/athlete-links` `{ gpexeAthleteId, athleteId }`, 201 / refusals, idempotent per pair, its own guards (active member of the team, not already linked, canonical id, name collision) | **Unchanged.** *Confirm all* is the Phase 3b pattern: the existing route, one pair at a time, one result per pair. |
| The date-of-birth conflict pairs | `birthDateConflicts` in `listIdentities` (pairs only, never OptiMove's date) | Same rule, computed inside the new read. |
| *Link athletes* screen (whole team, staged choices, *Review N links*, per-pair results) | `frontend/gpexe-import-*.js` (Phase 3b, identity masking PR #145) | The suggestions are a new section on top of it; the staging, review and result code is reused. |

## 3. The design

### 3.1 The read: `GET /api/training-load/gpexe/teams/:teamId/athlete-pair-suggestions`

Additive; no table, column or migration. One transaction, the lock order of `listIdentities`, then:

1. The unlinked GPEXE athletes that have a non-expired stored identity (name present, date of birth present).
2. The team's active athletes without an active link (`athlete_memberships` `membership_type = 'team'`, `status = 'active'`).
3. **Matching rule (server, in code, unit-tested):** a name is *normalized* by Unicode NFKC, case-folding, removing diacritics, trimming and collapsing whitespace, and comparing the **set of name tokens** (so "Ana Marić" equals "Marić Ana"). A pair is **exact** only when the normalized names are equal AND both dates of birth are present and equal AND the match is **one-to-one** (exactly one GPEXE athlete and exactly one team athlete in the group). Anything else with the same name is **ambiguous** (two athletes share the name, or a name matches but one date is missing); the same name with different dates is a **date conflict**. Neither is ever auto-selected.
4. The answer carries only what the screen needs, **never the whole snapshot**: `exact: [{ gpexeAthleteId, gpexeName, birthDate, athleteId, athleteName }]`, `ambiguous: [{ gpexeAthleteId, gpexeName, birthDate, candidateAthleteIds }]` (the candidates are athletes of the team the viewer already sees), `dateConflicts: [{ gpexeAthleteId, athleteId }]` (a boolean pair, as in v32), `snapshotCount`, `expiresAt` of the oldest row, and a closed `state` (`ok` / `no_identities_loaded` / `no_active_binding`). An empty snapshot tells a coach "ask an administrator to load the names"; it does not tell the coach whether any GPEXE athlete exists.
5. `Cache-Control: no-store`; every identical-404 rule of the identity routes (no binding, archived team or club, revoked right).

### 3.2 Who may read it (the ★★ part, trigger 2)

| Viewer | Reads suggestions? |
|---|---|
| Platform admin; the club's admin (club workspace) | Yes (today's identity audience). |
| **The team's coach** (active `team_coach` of that team, in that **team** workspace) | **Yes, new**: only the three lists above for **their own team's** unlinked athletes. The coach never gets `athlete-identities` (the full list), never the load, never an identity of another team. |
| A coach of another team, an athlete, a user without a role, a coach in another workspace, a revoked role, an archived team / club | The same 404 as a missing route. |

The right is checked at the route and **again inside the transaction under `FOR SHARE`** (users row first, then the role row - the revocations' order), exactly as `rightHolds` does for the admins; a coach whose role ended mid-request reads nothing.

### 3.3 *Confirm all* (frontend, no new write route)

- The exact pairs are listed with both names and the date of birth; **only exact pairs are ticked**; ambiguous and conflict entries are shown in a separate list *Needs your choice* with the reason ("two athletes have this name", "the dates of birth differ") and are never ticked.
- One confirmation names every pair; *Link N athletes* sends them through the existing link route one at a time (at most 60), one result per pair (linked / not linked with the reason / not confirmed when an answer is lost - never resent by itself), then reads the links and the suggestions again once. The Phase 3b guards apply as they are (one command at a time, the leave guard, the out-of-date marker).
- The link route is not changed, so a suggestion that went stale (a date edited meanwhile) is still a pair the coach saw with both names and dates a moment ago, and the route's own guards (active member, not linked) refuse the impossible ones. A server-side "still matches" re-check on the link route would change a ★★ write path and is **not** in this part (question Q3).

### 3.4 Not changed

The identity load and its audience, the snapshot, the TTL and the purge; the link route; the importer, mapper and the import switches; Unlink; the administrator's masking rule (an administrator still sees "GPEXE athlete N" outside Technical details; the coach's screens show names because the coach is not an administrator viewer - the masking rule is about the GPEXE *id*, which the coach's suggestion rows carry only as the link route's key, shown under Technical details).

## 4. Tests

- Matching rule (pure unit tests): diacritics, case, token order, extra spaces, a missing date, two athletes with one name on either side, one athlete matching two GPEXE athletes, equal names with different dates.
- The route through the real server on a disposable database: platform admin and club admin (as before); the **team coach** reads the three lists and only for their own team; a coach of another team, an athlete, a revoked coach, an archived team and a team with no binding get the identical 404; a coach never receives a name or date outside the lists (the response is compared to an allow-list of keys); the snapshot TTL (an expired row is never offered); `no-store`.
- Lock order and race: a coach role ended while the read waits (two real sessions) reads nothing; a link made between the suggestion and the confirmation leaves that pair refused by the link route and reported per pair.
- Frontend (fake fetch): only exact pairs ticked; the review names both sides; one request per pair, a lost answer is *Result not confirmed* and never resent; ambiguous entries never ticked; all texts escaped.
- Mutations on every new guard (the coach basis, the lock, the one-to-one rule, the date rule, the allow-list).
- Reviewers: `code-reviewer`, `security-reviewer` (identity audience, trigger 2), `ux-design-reviewer`, `mobile-qa` (the screen is used on phones). **★★ by trigger 2**: both GOs, then the standing merge order (no migration, so no owner order naming one).

## 5. Risks

- **Disclosure to a coach (the accepted change).** A coach now reads GPEXE names and dates of birth of their own team's unlinked GPEXE athletes. Mitigated by the allow-list answer, the identical 404s, the lock-time right check and the 14-day TTL; accepted by the owner (R2, 2026-11-04).
- **A wrong exact match** (two different people with the same name and date of birth in one team) is shown with both names and dates and needs the coach's tick on a one-to-one pair only; a team where both people share both facts is ambiguous by the one-to-one rule and is never offered as exact.
- **A stale snapshot**: the read says when the oldest row expires; an expired row is never used.

## 6. Questions for the *Rukovodilac*

- **Q1:** the coach basis only in the **team** workspace (recommended, as for imports), or also in the club workspace for a person who is both coach and club admin (the club-admin path already covers them)?
- **Q2:** a coach with no loaded names sees "ask an administrator to load the names" (recommended). Or may a coach start the explicit load? (Not recommended: it is the only act that reads GPEXE and is the administrator's.)
- **Q3:** keep the link route unchanged (recommended) or add a server-side "name and date still match" check at link time (a change to a ★★ write path; more tests; a stale-suggestion refusal code)?
- **Q4:** the limit of 60 pairs per confirmation (as Phase 3b) - or 50 to match the import batch?
- **Q5:** token-set name comparison (recommended) or exact normalized string only (stricter, fewer suggestions)?
