// Athlete positions (migration v87; docs/ai/athlete-positions-plan.md). The owner's decision of 2026-11-22: „Jedna
// pozicija po sportisti".
//
// The list: one registry, public.sport_positions (sport 'Football'). A system position is written by an active platform
// admin in the platform workspace; a club position by the club's active admin in that club's workspace. The id is the
// identity; a rename changes only the name; an archive takes the position out of the pickers and leaves it on the
// athletes who hold it. Every write is one transaction: the acting user (optimove.position_actor), the rights (users
// first, PR #346, through public.sport_position_basis), the requestKey replay, the position row FOR UPDATE, the write,
// its log row (the request record), COMMIT. The database guards of v87 check the same right again.
//
// An athlete's position: one per athlete and club, set in the club's workspace (the club's admin, a platform admin) or
// in a team's workspace (the team's coach, for an athlete of that team). The append-only row of public.athlete_positions
// is the change and its request record; the database checks the right (public.athlete_position_right) and that the
// position is offered to the club.
//
// Who reads: a coach account in a club or team workspace (the list of that club; its athletes' positions within the
// workspace's athletes); the platform workspace reads the system list only. Everyone else - an athlete, another club's
// position - gets the identical 404 (ADR-006).
import crypto from "node:crypto";
import { pool } from "./db.js";
import { boundedText } from "./metricTextRules.js";
import { holdsClubAdminRole, holdsTeamCoachRole, isPlatformAdministrator } from "./authz.js";

export const NAME_MAX = 60;
export const SPORT_NAME = "Football";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class PositionError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}
const notFound = () => new PositionError(404, "not_found", "Not found.");
const bad = (code, message) => new PositionError(400, code, message);
const conflict = (code, message, extra) => new PositionError(409, code, message, extra);

// Test-only seams: beforeCommit(client), commit(client) in place of the COMMIT, commitTimeoutMs.
export const testHooks = {};
export const COMMIT_ANSWER_TIMEOUT_MS = 15_000;
function withinBound(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`no answer within ${ms} ms`)), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// The workspace's club and team (null club: the platform's system list only), or a refusal.
async function workspaceScope(ctx, client) {
  if (ctx.accountType !== "coach") throw notFound();
  const w = ctx.workspace;
  if (!w) throw notFound();
  if (w.type === "platform" || w.type === "private_coach") return { clubId: null, teamId: null };
  if (w.type === "club") return { clubId: String(w.scopeId), teamId: null };
  if (w.type === "team") {
    const r = await client.query(`select club_id from public.teams where id = $1 and is_active = true`, [w.scopeId]);
    if (!r.rowCount) throw notFound();
    return { clubId: String(r.rows[0].club_id), teamId: String(w.scopeId) };
  }
  throw notFound();
}

// The positions a club sees: the system (default) ones under the club's own name for them, unless hidden, and the club's
// own. $1 the club (null: the system list only), $2 the sport's name.
const CLUB_POSITIONS_SQL = `
  select p.id, coalesce(o.name, p.name) as name, p.name as default_name, p.owner_scope, p.owner_club_id, p.archived_at, p.sort_order,
         coalesce(o.hidden, false) as hidden
    from public.sport_positions p
    join public.sports s on s.id = p.sport_id
    left join public.club_position_overrides o on o.position_id = p.id and o.club_id = $1
   where s.name = $2 and (p.owner_scope = 'system' or p.owner_club_id = $1)`;

// What this caller may do to a row: a platform admin edits the defaults; a club's admin edits its own positions and
// renames, hides or shows a default for the club only.
function actionsFor(owner, row) {
  if (!owner) return [];
  const archived = row.archived_at !== null;
  if (owner.ownerScope === "system") return row.owner_scope === "system" ? (archived ? ["restore"] : ["rename", "archive"]) : [];
  if (row.owner_scope === "club") return archived ? ["restore"] : ["rename", "archive"];
  if (archived) return [];
  return row.hidden ? ["show"] : ["rename", "hide"];
}

const view = (row, owner = null) => {
  const actions = actionsFor(owner, row);
  return {
    id: String(row.id),
    name: row.name,
    // A default the club renamed names its default too.
    defaultName: row.owner_scope === "system" && row.default_name && row.default_name !== row.name ? row.default_name : null,
    ownerScope: row.owner_scope,
    active: row.archived_at === null && !row.hidden,
    archived: row.archived_at !== null,
    hidden: Boolean(row.hidden),
    sortOrder: row.sort_order,
    actions,
    editable: actions.length > 0,
  };
};

async function readOne(client, clubId, id, owner) {
  const row = (await client.query(`${CLUB_POSITIONS_SQL} and p.id = $3`, [clubId, SPORT_NAME, id])).rows[0];
  return row ? view(row, owner) : null;
}

// Whether a live position of this club (its own, or a default it shows) already carries the name.
async function clubNameTaken(client, clubId, name, exceptId = null) {
  return (await client.query(
    `select 1 from (${CLUB_POSITIONS_SQL}) x where x.archived_at is null and not x.hidden and lower(x.name) = lower($3)
        and ($4::uuid is null or x.id <> $4::uuid) limit 1`,
    [clubId, SPORT_NAME, name, exceptId],
  )).rowCount > 0;
}

// Which owner of the list this caller writes in this workspace, or null.
function writableOwner(ctx) {
  const w = ctx.workspace;
  if (ctx.accountType !== "coach" || !w) return null;
  if (w.type === "platform" && isPlatformAdministrator(ctx.authz)) return { ownerScope: "system", clubId: null };
  if (w.type === "club" && holdsClubAdminRole(ctx.authz, w.scopeId)) return { ownerScope: "club", clubId: String(w.scopeId) };
  return null;
}

// On which basis this caller sets an athlete's position in this workspace, or null.
function settingBasis(ctx, scope) {
  const w = ctx.workspace;
  if (ctx.accountType !== "coach" || !w || !scope.clubId) return null;
  if (w.type === "club") {
    if (holdsClubAdminRole(ctx.authz, w.scopeId)) return { basis: "club_admin", teamId: null };
    if (isPlatformAdministrator(ctx.authz)) return { basis: "platform_admin", teamId: null };
    return null;
  }
  if (w.type === "team") {
    if (holdsTeamCoachRole(ctx.authz, w.scopeId)) return { basis: "team_coach", teamId: String(w.scopeId) };
    if (holdsClubAdminRole(ctx.authz, scope.clubId)) return { basis: "club_admin", teamId: null };
    if (isPlatformAdministrator(ctx.authz)) return { basis: "platform_admin", teamId: null };
  }
  return null;
}

async function footballId(client) {
  const row = (await client.query(`select id from public.sports where name = $1`, [SPORT_NAME])).rows[0];
  if (!row) throw new Error("v87's sport is missing");
  return String(row.id);
}

export async function listPositions(ctx) {
  const client = await pool.connect();
  try {
    const scope = await workspaceScope(ctx, client);
    const rows = (await client.query(
      `${CLUB_POSITIONS_SQL} order by (p.archived_at is null and not coalesce(o.hidden, false)) desc, p.sort_order, lower(coalesce(o.name, p.name)), p.id`,
      [scope.clubId, SPORT_NAME],
    )).rows;
    const owner = writableOwner(ctx);
    return { positions: rows.map((r) => view(r, owner)), canAdd: owner ? owner.ownerScope : null };
  } finally {
    client.release();
  }
}

function nameOf(body, field = "name") {
  const raw = body?.[field];
  if (typeof raw !== "string" || !boundedText(raw.trim(), NAME_MAX)) throw bad("invalid_name", `${field} is 1-${NAME_MAX} visible characters on one line.`);
  return raw.trim();
}
function requestKeyOf(body) {
  if (typeof body?.requestKey !== "string" || !UUID.test(body.requestKey)) throw bad("invalid_request_key", "requestKey must be a UUID.");
  return body.requestKey.toLowerCase();
}
function only(body, allowed) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw bad("invalid_body", "The request body must be a JSON object.");
  for (const k of Object.keys(body)) if (!allowed.includes(k)) throw bad("invalid_body", `Unknown field: ${k}.`);
}
const hashOf = (value) => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
function idOf(raw) {
  if (typeof raw !== "string" || !UUID.test(raw)) throw notFound();
  return raw.toLowerCase();
}

// The transaction around one write: the acting user, the caller's run (rights, replay, write), the deferred guards, a
// bounded COMMIT (a lost answer is "not confirmed", never "not saved").
async function inTransaction(ctx, run) {
  const client = await pool.connect();
  let destroyed = false;
  try {
    await client.query("begin");
    await client.query("set local lock_timeout = '3s'");
    await client.query("set local statement_timeout = '10s'");
    await client.query(`select set_config('optimove.position_actor', $1 || ':' || pg_current_xact_id()::text, true)`, [ctx.userId]);
    const result = await run(client);
    if (result?.replayed || result?.unchanged) {
      await client.query("rollback");
      return result;
    }
    await client.query("set constraints all immediate");
    if (testHooks.beforeCommit) await testHooks.beforeCommit(client);
    try {
      const commit = testHooks.commit ? testHooks.commit(client) : client.query("commit");
      commit.catch(() => {});
      await withinBound(commit, testHooks.commitTimeoutMs ?? COMMIT_ANSWER_TIMEOUT_MS);
    } catch (error) {
      if (error?.code && /^(23|42)/.test(error.code)) throw error;
      destroyed = true;
      client.release(true);
      throw new PositionError(503, "outcome_unknown", "The result is not confirmed. Send the same request again to check it.");
    }
    return { ...result, replayed: false };
  } catch (error) {
    if (!destroyed) await client.query("rollback").catch(() => {});
    if (error instanceof PositionError) throw error;
    if (error?.code === "23505" && /sport_positions_owner_name_live_key/.test(error.constraint ?? error.message ?? "")) {
      throw conflict("name_taken", "A position with this name already exists.");
    }
    if (error?.code === "23505" && /(sport_position_changes|athlete_positions)_request_key/.test(error.constraint ?? error.message ?? "")) {
      throw conflict("try_again", "The same request is being saved. Send it again to read its result.");
    }
    if (error?.code === "55P03" || error?.code === "40P01" || error?.code === "57014") throw conflict("try_again", "The list is being changed. Try again.");
    if (error?.code === "42501") throw notFound();
    throw error;
  } finally {
    if (!destroyed) client.release();
  }
}

// ---------------------------------------------------------------------------
// The list
// ---------------------------------------------------------------------------
async function writeList(ctx, { requestKey, hash, run }) {
  const owner = writableOwner(ctx);
  if (!owner) throw notFound();
  return inTransaction(ctx, async (client) => {
    const basis = (await client.query(`select public.sport_position_basis($1, $2, $3) as b`, [ctx.userId, owner.ownerScope, owner.clubId])).rows[0].b;
    if (!basis) throw notFound();
    // One club's list is changed one write at a time (the code review of v87): its checks (the expected name, a name the
    // club already shows) read rows a concurrent write may create - a club's first override of a default has no row to
    // lock. Taken after the rights rows (users first), before the request key's lock.
    if (owner.ownerScope === "club") {
      await client.query(`select pg_advisory_xact_lock(hashtextextended('positions-club:' || $1, 87))`, [owner.clubId]);
    }
    // The same (user, requestKey) is serialised before the replay read; taken after the rights rows (users first).
    await client.query(`select pg_advisory_xact_lock(hashtextextended($1 || ':' || $2, 88))`, [ctx.userId, requestKey]);
    const seen = (await client.query(
      `select c.request_hash, c.club_id, p.id, p.owner_scope, p.owner_club_id
         from public.sport_position_changes c join public.sport_positions p on p.id = c.position_id
        where c.performed_by_user_id = $1 and c.request_key = $2`, [ctx.userId, requestKey],
    )).rows[0];
    if (seen) {
      // Answered only while the caller still writes the owner the change was made for (a club's change of a default:
      // that club; otherwise the position's own owner).
      const sameOwner = seen.club_id
        ? owner.ownerScope === "club" && String(seen.club_id) === String(owner.clubId)
        : seen.owner_scope === owner.ownerScope && String(seen.owner_club_id ?? "") === String(owner.clubId ?? "");
      if (!sameOwner) throw notFound();
      if (seen.request_hash !== hash) throw conflict("request_key_reused", "This requestKey was used for another change.");
      return { position: await readOne(client, owner.clubId, seen.id, owner), replayed: true };
    }
    return run(client, { owner, basis });
  });
}

// The position row, locked: FOR UPDATE when the caller writes the position itself (its owner), FOR SHARE when a club
// changes its own view of a default (mode "override"); everything else is the 404.
async function lockedPosition(client, owner, id, { allowOverride = false } = {}) {
  const peek = (await client.query(`select owner_scope, owner_club_id from public.sport_positions where id = $1`, [id])).rows[0];
  if (!peek) throw notFound();
  const own = peek.owner_scope === owner.ownerScope && String(peek.owner_club_id ?? "") === String(owner.clubId ?? "");
  const override = !own && allowOverride && owner.ownerScope === "club" && peek.owner_scope === "system";
  if (!own && !override) throw notFound();
  await client.query(`select 1 from public.sport_positions where id = $1 for ${override ? "share" : "update"}`, [id]);
  if (override) {
    await client.query(`select 1 from public.club_position_overrides where club_id = $1 and position_id = $2 for update`, [owner.clubId, id]);
  }
  const row = (await client.query(`${CLUB_POSITIONS_SQL} and p.id = $3`, [owner.clubId, SPORT_NAME, id])).rows[0];
  return { row, mode: override ? "override" : "own" };
}

async function log(client, ctx, { id, action, oldName, newName, basis, requestKey, hash, clubId = null }) {
  await client.query(
    `insert into public.sport_position_changes (position_id, action, old_name, new_name, performed_by_user_id, basis, request_key, request_hash, club_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`, [id, action, oldName, newName, ctx.userId, basis, requestKey, hash, clubId],
  );
}

// A club's view of a default: its own name (null: the default name) and whether it hides it. Written before its log row,
// which the database checks against it.
async function writeOverride(client, ctx, clubId, id, { name, hidden }) {
  await client.query(
    `insert into public.club_position_overrides (club_id, position_id, name, hidden, updated_by_user_id)
     values ($1, $2, $3, coalesce($4, false), $5)
     on conflict (club_id, position_id) do update
       set name = case when $6 then excluded.name else club_position_overrides.name end,
           hidden = coalesce($4, club_position_overrides.hidden),
           updated_by_user_id = excluded.updated_by_user_id`,
    [clubId, id, name ?? null, hidden ?? null, ctx.userId, name !== undefined],
  );
}

const RETURNING = "returning id";

export async function createPosition(ctx, body) {
  const owner = writableOwner(ctx);
  if (!owner) throw notFound();
  only(body, ["requestKey", "name"]);
  const requestKey = requestKeyOf(body);
  const name = nameOf(body);
  const hash = hashOf({ op: "create", name, ownerScope: owner.ownerScope, clubId: owner.clubId });
  return writeList(ctx, {
    requestKey, hash,
    run: async (client, { basis }) => {
      const sport = await footballId(client);
      if (owner.ownerScope === "club" && await clubNameTaken(client, owner.clubId, name)) {
        throw conflict("name_taken", "A position with this name already exists.");
      }
      const row = (await client.query(
        `insert into public.sport_positions (sport_id, name, owner_scope, owner_club_id, created_by_user_id, sort_order)
         values ($1, $2, $3, $4, $5,
                 (select coalesce(max(sort_order), 0) + 10 from public.sport_positions
                   where sport_id = $1 and (owner_scope = 'system' or owner_club_id = $4) and sort_order < 10000))
         ${RETURNING}`,
        [sport, name, owner.ownerScope, owner.clubId, ctx.userId],
      )).rows[0];
      await log(client, ctx, { id: row.id, action: "create", oldName: null, newName: name, basis, requestKey, hash });
      return { position: await readOne(client, owner.clubId, row.id, owner) };
    },
  });
}

export async function renamePosition(ctx, rawId, body) {
  if (!writableOwner(ctx)) throw notFound();
  const id = idOf(rawId);
  only(body, ["requestKey", "name", "expectedName"]);
  const requestKey = requestKeyOf(body);
  const name = nameOf(body);
  const expectedName = nameOf(body, "expectedName");
  const hash = hashOf({ op: "rename", id, name, expectedName });
  return writeList(ctx, {
    requestKey, hash,
    run: async (client, { owner, basis }) => {
      const { row, mode } = await lockedPosition(client, owner, id, { allowOverride: true });
      const current = view(row, owner);
      if (row.name !== expectedName) throw conflict("name_changed", "The name was changed meanwhile.", { current });
      if (row.archived_at !== null) throw conflict("position_archived", "Restore the position before renaming it.", { current });
      if (row.name === name) throw conflict("name_unchanged", "That is already its name.", { current });
      if (owner.ownerScope === "club" && await clubNameTaken(client, owner.clubId, name, id)) {
        throw conflict("name_taken", "A position with this name already exists.");
      }
      if (mode === "override") {
        // The club's own name for a default; its default name again clears it.
        await writeOverride(client, ctx, owner.clubId, id, { name: name === row.default_name ? null : name });
        await log(client, ctx, { id, action: "club_rename", oldName: row.name, newName: name, basis, requestKey, hash, clubId: owner.clubId });
      } else {
        await client.query(`update public.sport_positions set name = $2 where id = $1`, [id, name]);
        await log(client, ctx, { id, action: "rename", oldName: row.name, newName: name, basis, requestKey, hash });
      }
      return { position: await readOne(client, owner.clubId, id, owner) };
    },
  });
}

// A club hides a default from its pickers, or shows it again; the system list and other clubs are unchanged. An athlete
// who holds a hidden position keeps it.
async function setHidden(ctx, rawId, body, hidden) {
  const owner = writableOwner(ctx);
  if (!owner || owner.ownerScope !== "club") throw notFound();
  const id = idOf(rawId);
  only(body, ["requestKey"]);
  const requestKey = requestKeyOf(body);
  const op = hidden ? "hide" : "show";
  const hash = hashOf({ op, id, clubId: owner.clubId });
  return writeList(ctx, {
    requestKey, hash,
    run: async (client, { basis }) => {
      const { row, mode } = await lockedPosition(client, owner, id, { allowOverride: true });
      if (mode !== "override") throw notFound();
      const current = view(row, owner);
      if (row.archived_at !== null) throw conflict("position_archived", "This position is no longer offered.", { current });
      if (row.hidden === hidden) throw conflict(hidden ? "position_hidden" : "position_shown", hidden ? "The position is already hidden." : "The position is not hidden.", { current });
      // Showing a default again must not bring back a name another live position of the club now carries.
      if (!hidden && await clubNameTaken(client, owner.clubId, row.name, id)) throw conflict("name_taken", "A position with this name already exists.");
      await writeOverride(client, ctx, owner.clubId, id, { hidden });
      await log(client, ctx, { id, action: hidden ? "club_hide" : "club_show", oldName: row.name, newName: row.name, basis, requestKey, hash, clubId: owner.clubId });
      return { position: await readOne(client, owner.clubId, id, owner) };
    },
  });
}

export const hidePosition = (ctx, id, body) => setHidden(ctx, id, body, true);
export const showPosition = (ctx, id, body) => setHidden(ctx, id, body, false);

async function setActive(ctx, rawId, body, active) {
  if (!writableOwner(ctx)) throw notFound();
  const id = idOf(rawId);
  only(body, ["requestKey"]);
  const requestKey = requestKeyOf(body);
  const op = active ? "restore" : "archive";
  const hash = hashOf({ op, id });
  return writeList(ctx, {
    requestKey, hash,
    run: async (client, { owner, basis }) => {
      const { row } = await lockedPosition(client, owner, id);
      if ((row.archived_at === null) === active) {
        throw conflict(active ? "position_active" : "position_archived", active ? "The position is not archived." : "The position is already archived.", { current: view(row, owner) });
      }
      if (active && owner.ownerScope === "club" && await clubNameTaken(client, owner.clubId, row.name, id)) {
        throw conflict("name_taken", "A position with this name already exists.");
      }
      await client.query(
        `update public.sport_positions
            set archived_at = case when $2 then null else now() end, archived_by_user_id = case when $2 then null else $3::uuid end
          where id = $1`, [id, active, ctx.userId],
      );
      // The log names the position's own name (the database checks it against the row).
      await log(client, ctx, { id, action: op, oldName: row.default_name, newName: row.default_name, basis, requestKey, hash });
      return { position: await readOne(client, owner.clubId, id, owner) };
    },
  });
}

export const archivePosition = (ctx, id, body) => setActive(ctx, id, body, false);
export const restorePosition = (ctx, id, body) => setActive(ctx, id, body, true);

// ---------------------------------------------------------------------------
// An athlete's position
// ---------------------------------------------------------------------------
// The athletes this workspace manages: a team workspace - the team's active members; a club workspace - the club's.
function scopeAthletesSql(scope) {
  return scope.teamId
    ? { sql: `select distinct m.athlete_id from public.athlete_memberships m
               where m.club_id = $1 and m.team_id = $2 and m.membership_type = 'team' and m.status = 'active'`, params: [scope.clubId, scope.teamId] }
    : { sql: `select distinct m.athlete_id from public.athlete_memberships m where m.club_id = $1 and m.status = 'active'`, params: [scope.clubId] };
}

export async function listAthletePositions(ctx) {
  const client = await pool.connect();
  try {
    const scope = await workspaceScope(ctx, client);
    const setter = settingBasis(ctx, scope);
    if (!setter) throw notFound();
    const athletes = scopeAthletesSql(scope);
    const rows = (await client.query(
      `with a as (${athletes.sql})
       select a.athlete_id, public.athlete_position_in_force(a.athlete_id, $1) as position_id from a`,
      athletes.params,
    )).rows;
    return {
      clubId: scope.clubId,
      canSet: true,
      assignments: rows.filter((r) => r.position_id).map((r) => ({ athleteId: String(r.athlete_id), positionId: String(r.position_id) })),
    };
  } finally {
    client.release();
  }
}

export async function setAthletePosition(ctx, rawAthleteId, body) {
  // Who may never set a position gets the 404 whatever it sends (the rights are checked again under lock below).
  if (ctx.accountType !== "coach" || !ctx.workspace || !["club", "team"].includes(ctx.workspace.type)) throw notFound();
  const athleteId = idOf(rawAthleteId);
  only(body, ["requestKey", "positionId", "expectedPositionId"]);
  const requestKey = requestKeyOf(body);
  const positionOf = (v, field) => {
    if (v === null) return null;
    if (typeof v !== "string" || !UUID.test(v)) throw bad("invalid_position", `${field} must be a UUID or null.`);
    return v.toLowerCase();
  };
  if (!("positionId" in body) || !("expectedPositionId" in body)) throw bad("invalid_body", "positionId and expectedPositionId are required (null for none).");
  const positionId = positionOf(body.positionId, "positionId");
  const expectedPositionId = positionOf(body.expectedPositionId, "expectedPositionId");
  return inTransaction(ctx, async (client) => {
    const scope = await workspaceScope(ctx, client);
    const setter = settingBasis(ctx, scope);
    if (!setter) throw notFound();
    const hash = hashOf({ op: "athlete_position", athleteId, clubId: scope.clubId, positionId, expectedPositionId });
    // The rights under lock (users first), the same function the guard calls; a refusal is the 404.
    const right = (await client.query(
      `select public.athlete_position_right($1, $2, $3, $4, $5) as ok`, [ctx.userId, athleteId, scope.clubId, setter.basis, setter.teamId],
    )).rows[0].ok;
    if (!right) throw notFound();
    const inScope = scopeAthletesSql(scope);
    const member = await client.query(`select 1 from (${inScope.sql}) a where a.athlete_id = $${inScope.params.length + 1}`, [...inScope.params, athleteId]);
    if (!member.rowCount) throw notFound();
    await client.query(`select pg_advisory_xact_lock(hashtextextended($1 || ':' || $2, 88))`, [ctx.userId, requestKey]);
    const seen = (await client.query(
      `select request_hash, athlete_id, club_id, position_id from public.athlete_positions where set_by_user_id = $1 and request_key = $2`,
      [ctx.userId, requestKey],
    )).rows[0];
    if (seen) {
      if (seen.request_hash !== hash) throw conflict("request_key_reused", "This requestKey was used for another change.");
      return { athleteId, positionId: seen.position_id ? String(seen.position_id) : null, replayed: true };
    }
    // The athlete row: two changes of one athlete are decided one after the other (the guard takes the same lock).
    await client.query(`select 1 from public.athletes where id = $1 for update`, [athleteId]);
    const current = (await client.query(`select public.athlete_position_in_force($1, $2) as p`, [athleteId, scope.clubId])).rows[0].p;
    const currentId = current ? String(current) : null;
    if (currentId !== expectedPositionId) throw conflict("position_changed", "The position was changed meanwhile.", { current: { positionId: currentId } });
    if (currentId === positionId) return { athleteId, positionId, unchanged: true };
    if (positionId !== null) {
      const offered = (await client.query(`select public.sport_position_offered($1, $2, true) as ok`, [positionId, scope.clubId])).rows[0].ok;
      if (!offered) throw conflict("position_not_offered", "This position is not on your club's list.");
    }
    await client.query(
      `insert into public.athlete_positions (athlete_id, club_id, position_id, set_by_user_id, basis, via_team_id, request_key, request_hash)
       values ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [athleteId, scope.clubId, positionId, ctx.userId, setter.basis, setter.teamId, requestKey, hash],
    );
    return { athleteId, positionId };
  });
}
