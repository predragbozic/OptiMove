// A disposable world for the roles R2 suites: a database built from the legacy
// snapshot and the real runner (every migration of migrations_v2 up to v84,
// v84 included, or every one before v84), the real server on it, and helpers for
// users, clubs, teams, sessions, the Roles API and direct SQL as an acting
// user. Disposable optimove_tests_* databases on a loopback server only.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { createDisposableDatabase } from "./disposable-db.mjs";
import { bootstrapLegacySnapshot } from "./legacy-bootstrap.mjs";
import { runMigrations } from "../../src/migrate.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const MIGRATIONS = path.join(__dirname, "..", "..", "..", "migrations_v2");
export const V84_FILE = "202611201300_roles_v84_permission_roles.sql";
export const V84_NAME = `migrations_v2/${V84_FILE}`;
export const RUNBOOKS = path.join(__dirname, "..", "..", "..", "docs", "runbooks");
export const ROLE_IDS = Object.freeze({
  platform_admin: "00000000-0000-4000-8000-000000000841",
  club_admin: "00000000-0000-4000-8000-000000000842",
  team_coach: "00000000-0000-4000-8000-000000000843",
  independent_coach: "00000000-0000-4000-8000-000000000844",
});
export const NIL = "00000000-0000-0000-0000-000000000000";

// A migrations_v2 folder (same basename, so the runner records the same names)
// holding every file of the repository's folder except those `skip` names.
export const V92_FILE = "202611241000_roles_v92_layers_foundation.sql";
export const V92_NAME = `migrations_v2/${V92_FILE}`;
// `upTo`: the last file kept (v84's by default; "all" keeps every file of the folder).
export function migrationsWithout(skip, upTo = V84_FILE) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "optimove-roles-mig-"));
  const dir = path.join(root, "migrations_v2");
  fs.mkdirSync(dir);
  for (const f of fs.readdirSync(MIGRATIONS)) {
    // The world is v84's own: migrations that sort after v84 (v85 on) are left out, so the v84 rollback is never
    // refused for a migration applied after it (that refusal is test 1b's own case, planted on purpose).
    if (!f.endsWith(".sql") || skip.includes(f) || (upTo !== "all" && f > upTo)) continue;
    fs.copyFileSync(path.join(MIGRATIONS, f), path.join(dir, f));
  }
  return { dir, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

export async function buildDatabase({ label, baseDatabaseUrl = process.env.DATABASE_URL, withoutV84 = false, upTo = V84_FILE, skip = [] }) {
  const snapshotSql = fs.readFileSync(path.join(__dirname, "legacy-schema.sql"), "utf8");
  const last = snapshotSql.match(/^-- Last migration contained in the dump: (\S+)\.$/m)[1];
  const db = await createDisposableDatabase({ prefix: "roles", label, baseDatabaseUrl });
  try {
    await bootstrapLegacySnapshot({ databaseUrl: db.url, snapshotSql, migrationsRoot: MIGRATIONS, lastMigration: last });
    const tmp = migrationsWithout([...(withoutV84 ? [V84_FILE] : []), ...skip], upTo);
    try { await runMigrations({ databaseUrl: db.url, migrationsRoot: tmp.dir }); } finally { tmp.cleanup(); }
  } catch (error) {
    await db.drop().catch(() => {});
    throw error;
  }
  return db;
}

const hex = (n) => crypto.randomBytes(n).toString("hex");
export const rankedId = (rank) => {
  const r = hex(16);
  return `${rank.toString(16).padStart(2, "0")}${r.slice(2, 8)}-${r.slice(8, 12)}-4${r.slice(13, 16)}-8${r.slice(17, 20)}-${r.slice(20, 32)}`;
};

// The fixtures, written by the admin connection `k` (no guard of v84 is on
// these tables).
export function fixtures(k) {
  const one = async (sql, params = []) => (await k.query(sql, params)).rows[0];
  return {
    one,
    async user(label = "user", { rank = null, active = true } = {}) {
      const id = rank == null ? crypto.randomUUID() : rankedId(rank);
      await k.query(`insert into public.users (id, email, first_name, last_name, full_name, display_name, is_active)
                     values ($1, $2, $3, 'Test', $3, $3, $4)`, [id, `${label}-${hex(4)}@test.local`, label, active]);
      return id;
    },
    async club(label = "Club") {
      return (await one(`insert into public.clubs (name, is_active) values ($1, true) returning id`, [`${label} ${hex(3)}`])).id;
    },
    async team(clubId, label = "Team") {
      return (await one(`insert into public.teams (club_id, name, is_active) values ($1, $2, true) returning id`, [clubId, `${label} ${hex(3)}`])).id;
    },
    grantPlatform: (userId) => k.query(`insert into public.user_global_roles (user_id, role, is_active) values ($1,'platform_admin',true)`, [userId]),
    grantIndependent: (userId) => k.query(`insert into public.user_global_roles (user_id, role, is_active) values ($1,'independent_coach',true)`, [userId]),
    grantClub: (userId, clubId, active = true) => k.query(`insert into public.user_club_roles (user_id, club_id, role, is_active) values ($1,$2,'club_admin',$3)`, [userId, clubId, active]),
    grantTeam: (userId, teamId, active = true) => k.query(`insert into public.user_team_roles (user_id, team_id, role, is_active) values ($1,$2,'team_coach',$3)`, [userId, teamId, active]),
    makeAthlete: (userId) => k.query(`insert into public.athletes (athlete_id, user_id, first_name, last_name, full_name) values ($1, $2, 'Ath', 'Lete', 'Ath Lete')`, [`R2-${hex(5)}`, userId]),
  };
}

// One transaction on its own connection as the acting user (the setting the
// service sets), for direct-SQL guard tests. `fn(c)` runs inside; the result is
// COMMITted unless `rollback` is set. Throws the database error as it is.
export async function asActor(dbUrl, actorId, fn, { rollback = false, actor = "current" } = {}) {
  const c = new pg.Client({ connectionString: dbUrl });
  await c.connect();
  try {
    await c.query("begin");
    if (actorId) {
      if (actor === "current") await c.query(`select set_config('optimove.permission_actor', $1 || ':' || pg_current_xact_id()::text, true)`, [actorId]);
      else await c.query(`select set_config('optimove.permission_actor', $1, true)`, [actor]);
    }
    const out = await fn(c);
    await c.query(rollback ? "rollback" : "commit");
    return out;
  } catch (error) {
    await c.query("rollback").catch(() => {});
    throw error;
  } finally {
    await c.end().catch(() => {});
  }
}

// The real server on the database; sessions by cookie.
export async function startServer(dbUrl) {
  process.env.DATABASE_URL = dbUrl;
  const serverModule = await import("../../src/server.js");
  const { createSession } = await import("../../src/auth.js");
  const dbModule = await import("../../src/db.js");
  assert.equal((await dbModule.pool.query("select current_database() as d")).rows[0].d, new URL(dbUrl).pathname.slice(1), "SAFETY: the app talks to the disposable database");
  const server = http.createServer(serverModule.app);
  await new Promise((resolve) => server.listen(0, resolve));
  const base = `http://localhost:${server.address().port}`;
  const cookieFor = async (userId) => `optimove_session=${await createSession(userId)}`;
  async function api(cookie, p, { method = "GET", body } = {}) {
    const res = await fetch(`${base}${p}`, {
      method,
      headers: { ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...(cookie ? { Cookie: cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json = {};
    try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, body: json, text };
  }
  async function stop() {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    let timer;
    await Promise.race([dbModule.pool.end(), new Promise((res) => { timer = setTimeout(res, 5_000); })]);
    clearTimeout(timer);
  }
  return { api, cookieFor, stop, pool: dbModule.pool };
}

export const key = () => crypto.randomUUID();
