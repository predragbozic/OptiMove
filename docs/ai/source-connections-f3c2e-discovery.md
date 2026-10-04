# F3c2e — verified team binding: discovery result (2026-10-03, before implementation)

Owner order of 2026-10-03 (binding route) and its amendment of the same day (club admin manages
the connection and the bindings of their own club; the list of the GPEXE teams a connection can
see, id and name only, after a successful Connect / Test; the GPEXE team is chosen, not typed).
Read: v27 (`source_credential_connections`, `source_team_bindings`, `source_connection_audit`,
their functions and triggers), v28 (host catalog), v29 (state / fact CHECKs, the throttle index),
`backend/src/sourceConnectionService.js` and `backend/src/routes/sourceConnections.js` (F3c2d),
`backend/src/gpexeRestV1Adapter.js` (`verifyBoundTeam()`, `countVisibleTeams()`),
`training_load.gpexe_team_settings` and its history (v22, v24, `setTeamSettings()` in
`gpexeImportService.js`), `docs/ai/source-connections-f3c2-contract.md` 2.2 / 2.3 / 2.5 and D2,
D3, D11, D12 of `docs/ai/gpexe-f3c-auth-discovery.md`.

## 1. The binding table as it exists (v27, unchanged since)

`training_load.source_team_bindings`: `id`, `team_id` (→ `public.teams`), `connection_id`
(→ `source_credential_connections`), `source_system` (copied from the connection, kept equal by
the trigger), `source_team_id` (text; for `gpexe` the canonical `^(0|[1-9][0-9]{0,11})$`),
`state` (`active` | `ended`), `bound_by_user_id`, `bound_at`, `bind_reason` (optional, 1–500),
`ended_at` / `ended_by_user_id` / `end_reason` (all three null while active, all three set when
ended), `legacy_gpexe_settings_team_id` (→ `gpexe_team_settings.owner_team_id`; provenance only,
must equal `team_id`; gpexe only).

## 2. The guards the database already has

- One active binding per `(team_id, source_system)` and one active OptiMove team per
  `(source_system, source_team_id)` across every connection: two partial unique indexes
  (`23505`).
- `source_team_bindings_check_owner` (before insert): takes the team's import lock try-lock
  style (`hold_gpexe_team_lock`, `P0001` when busy), reads the connection `FOR SHARE`, refuses a
  retired host (catalog row `FOR SHARE`), a source other than the connection's, a team outside the
  owning club (`public.teams` `FOR SHARE`), and a legacy pointer that is not the binding's own
  team — all `check_violation` (`23514`).
- Rows end but never disappear (`DELETE` / `TRUNCATE` refused; an ended row is immutable; the
  only update of an active row is ending it).
- `teams_source_binding_guard_move`: a team with an active binding to its club's connection
  cannot move to another club (same team try-lock first).
- A connection that ever had a binding keeps its owner, source and host.
- Audit: action `bind` exists and **requires `team_id`** (`source_connection_audit_bind_names_team`);
  the actor CHECK takes basis `platform_admin` or `club_admin`; `source_team_id` is **not** a
  secret-named key (`key_name_is_secret`), so it may be a metadata fact; `host_key`,
  `credential_kind` stay allowed.
- v29: every state but `not_connected` carries a credential; `linked_untested` carries its facts.

## 3. Lock order of one bind (derived; no cycle with the existing orders)

Same transaction shape as a Connect / Reconnect / Test (the bind is a branch of the same
`attempt()` so there is exactly one lock, audit, COMMIT and compensation path):

1. body checked (`teamId` UUID, `sourceTeamId` canonical, nothing else) → `400` before any lock;
2. unlocked identity read of the connection and of the team (exists, active, club = owning club,
   caller may see the club) → the same `404` as a missing id for every other case;
3. per-user advisory lock (bounded, `try_again`);
4. the connection row `FOR NO KEY UPDATE` (2 s `lock_timeout`, `try_again`); state must be
   `verified`;
5. the connection's active bindings: the same team + same source team on this connection →
   idempotent answer (no row, no request, no audit); the team already bound for this source, or
   the source team bound to another team → `409` conflict, nothing written;
6. catalog row `FOR SHARE` + `resolveApprovedSourceHost()` (`host_not_allowed`);
7. the team row `FOR SHARE` (club and activity re-read under the lock; a team move or archive
   running meanwhile holds that row and this waits at most the row `lock_timeout` → `try_again`);
8. every active bound team of the connection AND the target team, ascending, once each,
   `hold_gpexe_team_lock(team, 'bind')` try-lock (`try_again` when a check, import, settings
   change, team move or another binding of any of them runs) — the same rule as a credential
   attempt, because a refused credential during the bind changes the connection's state; the
   insert trigger re-takes the target's xact lock, which is re-entrant for the session;
9. `gpexe_team_settings` of the team `FOR SHARE` — the approved pair: missing → `409
   team_setting_missing`; a different canonical GPEXE Team ID → `409 team_setting_mismatch`;
   the same → the binding carries the provenance pointer. The settings row and its history are
   never written (D12); v30 keeps the pair final while the binding is active;
10. the 5 / 15 min window, key ring, decrypt, savepoint, then the one `GET team/<sourceTeamId>/`
    through the adapter with the bound team fixed to the chosen id (`verifyBoundTeam()`),
    tracked fetch;
11. rights and club re-checked `FOR SHARE` after the network (`rights_changed`); the team row
    `FOR SHARE` only now, re-qualified (archived or moved meanwhile → the same 404, nothing
    bound);
12. a source team bound to another team → `409 source_team_already_bound` (answered only for a
    team the credential really sees; the v27 unique index is the backstop, mapped by its exact
    name); insert binding + audit `bind` (same transaction) → bounded COMMIT (F2 discipline).

The idempotent answer (the same binding exists already) comes right after the row lock, BEFORE
the `verified` gate, so a retry after an unknown outcome gets its binding even when a Test moved
the connection's state meanwhile. `55P03` and `40P01` are both `try_again`.

Why no cycle: the connection row is taken before the team's try-lock (never a blocking wait on a
team lock while holding the connection row, contract condition 3); the trigger's reverse order is
a try-lock; a Connect / Reconnect / Test of the same connection is serialized by the connection
row; a team move / club archive is a row lock this waits for only within `lock_timeout`; a Check
now / import holds the team's advisory lock and makes the bind answer `try_again` at once.

## 4. Migration

**Superseded on 2026-10-04.** The first conclusion was "none": v27–v29 express the binding, its
uniqueness, its owner rule, its provenance pointer and its audit. After the security review of
the first build (HIGH F-1: a club admin could bind any team the shared credential sees) the owner
decided option (a): the existing `gpexe_team_settings` row of an OptiMove team is the
platform-admin allowlist — the approved pair `OptiMove team ↔ GPEXE Team ID` — and a binding may
only bind that exact pair. An active binding must then stay bound to the same approved pair, which
v27–v29 cannot promise: v24 keeps the settings row from being deleted, truncated or moved to
another team, but lets its GPEXE Team ID change (with a reason) whenever no check, candidate, link,
approval or imported data exists — a binding is none of those. **Migration v30**
(`migrations_v2/202610041000_training_load_v30_gpexe_team_settings_bound_final.sql`, approved by
the owner on 2026-10-04) adds exactly that backstop: a BEFORE UPDATE trigger on
`gpexe_team_settings` that refuses a change of the canonical GPEXE Team ID (or of the OptiMove
team) of a row whose team has an active gpexe `source_team_binding`; the same canonical value
passes; `gpexe_team_id_canonical(text)` is the comparison (no stored value changes). **After the
owner's external review of PR #135 (2026-10-04) v30 also makes the database guarantee the other
half of the pair:** a BEFORE INSERT trigger on `source_team_bindings`
(`source_team_bindings_check_pair`, firing after v27's owner check and so after the team's
import try-lock, reading the settings row `FOR SHARE` — the bind route's own order) refuses an
active gpexe binding that does not point at its own team's settings row, whose team has no
settings row, or whose canonical `source_team_id` differs from the canonical approved Team ID
(`23514`, constraint `source_team_bindings_approved_pair`); and a unique index on
`gpexe_team_id_canonical(gpexe_team_id)` makes "981" and "0981" one GPEXE team for the whole
database (the migration refuses, changing nothing, when such duplicates already exist). What v30
refuses and what it leaves to v24: UPDATE changing the canonical Team ID while bound → refused
(`23514`, constraint `gpexe_team_settings_bound_team_final`); UPDATE changing `owner_team_id` →
already refused for every row by v24 (`refuse_gpexe_team_repoint`), repeated for the bound case;
DELETE / TRUNCATE → already refused for every row by v24 (`gpexe_team_settings_refuse_delete`,
`gpexe_team_settings_no_truncate`); the table has no archive flag, so "archiving a setting" does
not exist and no decision was needed. Rollback:
`docs/runbooks/source-connections-v30-rollback.sql` (refuses under a later migration and while an
active gpexe binding of a team with a settings row relies on the protection). The application side
of the same rule: `setTeamSettings()` answers `409 gpexe_team_bound` (its own pre-check under the
team lock, and the trigger's `23514` mapped to the same code; never SQL text), and the bind
requires the pair (`team_setting_missing` / `team_setting_mismatch`, locally, zero requests).

## 5. Authorization change (owner amendment 2026-10-03) — one path, two bases

`resolveConnectionAdmin()` answers one of exactly two bases, from the ACTIVE workspace: an
active platform admin in the platform workspace or in the owning club's workspace (basis
`platform_admin`, as before), or an active club admin acting in the club workspace of their own
active club (basis `club_admin`). Everything else is the same `404`. The right and the club are
re-checked `FOR SHARE` after every source call, by basis (`user_global_roles` or
`user_club_roles`, plus `users` and `clubs`). The audit basis is the context's basis. Coaches keep
seeing the connection state through the existing Imports status route; they get nothing here.

## 6. The team list (owner amendment, narrowed on 2026-10-04 by the allowlist decision)

Connect and Test read the first page of `team/` (adapter `listVisibleTeams()`: canonical id and a
sanitized name per row, the total count; a row without a canonical id refuses the list) and then
verify every active bound team as before. Every visible team is matched, server-side, against the
approved pairs of the owning club (the `gpexe_team_settings` rows of its active teams). A platform
admin gets the bounded list with the approved OptiMove team per row (support, setting the
allowlist); a club admin gets **only the intersection** (`sourceTeamId`, `name`, `approvedTeamId`,
`approvedTeamName`) and `sourceTeamCount` is the size of that intersection — no name, id, count or
other fact of a team outside it leaves the server. `sourceTeamsTruncated` is reported to both and
is `false` only when the source list was complete. Nothing is preselected, stored or bound from
the list, and the chosen team is verified again, alone, by the bind, which must name an approved
pair whoever calls it. A bind that reached the source without succeeding counts in the 5 / 15 min
window like a credential attempt; a successful bind does not.
