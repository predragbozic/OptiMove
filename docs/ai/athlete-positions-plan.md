# Athlete positions and the Position average estimate (plan and as built)

Status: **built on branch `feature/position-average`, not merged.** Level: risky (a migration, rights, an estimate's
transaction), so it goes through the internal reviews, the *Nezavisni revizor* and the *Rukovodilac*'s gate.
Last verified against commit: `be5f62b` (`origin/main`, merge of PR #709).

## 0. The owner's words

- 2026-11-22, relayed by the *Rukovodilac*: „Jedna pozicija po sportisti".
- Earlier (J20, `docs/ai/j20-session-review-contract.md`): the estimate sources in quality order are own average scaled
  by minutes, **position average**, team average, another athlete's values; the position average needs positions first.

## 1. What existed (on `be5f62b`)

| Fact | Where |
|---|---|
| `public.sport_positions` (id, sport_id, name, created_at; unique (sport_id, name)) exists, empty on production; tests reference values may point at it by (id, sport_id). No code writes it. | `migrations_v2/202608220900_tests_v42_schema.sql:78` |
| No athlete, membership, club or team table has a position or a sport. | legacy schema; `public.athletes`, `public.athlete_memberships` |
| The estimate methods: `proportional`, `copy_athlete`, `team_average`, `scale_recording`. `team_average` is the mean of the session's measured values of at least 3 other athletes, no minutes. | `backend/src/metricEstimateService.js` |
| The DB holds the method (CHECK, v69), the basis shape (`estimate_basis_ok`, v69) and which methods may estimate an `avg` variable (`validate_metric_value_estimate`, v64). | v63, v64, v69 |

## 2. As built

- **One registry, one position per athlete and club** — `docs/runbooks/athlete-positions-v87.md` holds the schema,
  guards and rollback.
- **Routes** (`backend/src/routes/positions.js`, `backend/src/positionService.js`), every write with a `requestKey`:

  | Route | Who |
  |---|---|
  | `GET /api/positions` | a coach account in a platform, club or team workspace (system positions plus the workspace club's) |
  | `POST /api/positions` `{ name }`, `POST /:id/rename` `{ name, expectedName }`, `/:id/archive`, `/:id/restore` | system: a platform admin in the platform workspace; club: the club's admin in its workspace |
  | `GET /api/positions/athletes` | the club's admin (club workspace) or the team's coach (team workspace): the positions of the workspace's athletes |
  | `PUT /api/positions/athletes/:athleteId` `{ positionId | null, expectedPositionId | null }` | the same, for an athlete of the workspace (`409 position_changed` when stale) |

  Everyone else gets the identical 404 (ADR-006).
- **Position average** (`position_average`): the mean of the measured values of the other roster athletes whose
  position in force (in the team's club) equals the target's; at least 3 athletes; no minutes, as `team_average`.
  Without a position the method answers `no_position`; with fewer than 3 `too_few_athletes_in_position`; it is never
  replaced by another method. The basis is `{ athletes, positionId }`; the label shows the position's current name and
  the count.
- **Screens:** Settings → Tags & Presets → *Positions* (list; add, rename, archive, restore for the owner); the athlete's
  Edit window → *Position* (its own Save); the Roster tab's estimate panel → *Position average*, offered in the owner's
  quality order.

## 3. Open questions for the owner (with the recommendation built)

1. Is the list one system list, or may a club add its own? **Built:** system list plus club positions (as session
   types). Removing the club's own is a frontend/route change, not a migration.
2. Who sets an athlete's position? **Built:** the club's admin and the coach of the athlete's team (and a platform
   admin). Only admins edit the list.
3. The names of the six system positions. **Built:** Goalkeeper, Centre back, Full back, Midfielder, Winger, Forward.
