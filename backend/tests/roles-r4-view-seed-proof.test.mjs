// Roles R4-1, the old-vs-new proof per row of contract 4.1 (the Nezavisni revizor's M4; a condition of R4-1): each
// view word v92 seeds into Club admin and Team coach is held exactly by accounts that pass that module's read gate
// TODAY - a club's admin in its club workspace, a team's coach in its team workspace - and by no account that does not
// pass it (an athlete, an account without a role, the admin of another club). The gates are the module's own read
// routes, reached through the real server on a disposable database; can() and the twin are read for the same accounts.
// A word whose row could not be proven is not seeded (none here).
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import pg from "pg";
import { buildDatabase, fixtures, startServer } from "./support/permission-roles-world.mjs";

const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;
let db, k, F, srv, authz, perms;
const W = {};
before(async () => {
  db = await buildDatabase({ label: "r4seed", upTo: "all" });
  k = new pg.Client({ connectionString: db.url });
  await k.connect();
  F = fixtures(k);
  srv = await startServer(db.url);
  authz = await import("../src/authz.js");
  perms = await import("../src/permissions.js");
  W.A = await F.club("A"); W.B = await F.club("B");
  W.T = await F.team(W.A, "T");
  W.admin = await F.user("admin"); await F.grantClub(W.admin, W.A);
  W.otherAdmin = await F.user("adminB"); await F.grantClub(W.otherAdmin, W.B);
  W.coach = await F.user("coach"); await F.grantTeam(W.coach, W.T);
  W.athlete = await F.user("athlete"); await F.makeAthlete(W.athlete);
  W.none = await F.user("none");
});
after(async () => {
  await srv?.stop();
  await k?.end().catch(() => {});
  await db?.drop();
  process.env.DATABASE_URL = ORIGINAL_DATABASE_URL;
});

const day = new Date().toISOString().slice(0, 10);
const monday = (() => { const d = new Date(`${day}T00:00:00Z`); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); return d.toISOString().slice(0, 10); })();
// Module -> its view words and one read route that the module's gate decides (contract 4.1, "Evidence of today's reach").
const ROWS = [
  { words: ["athletes.view"], path: "/api/athletes" },
  { words: ["programs.view"], path: "/api/builder/drafts" },
  { words: ["exercises.use"], path: "/api/exercises" },
  { words: ["presets.use"], path: "/api/taxonomy/node-presets" },
  { words: ["calendar.view"], path: `/api/calendar?from=${day}&to=${day}` },
  { words: ["load.view.team", "load.view.athlete"], path: `/api/training-load/weekly?weekStart=${monday}` },
  { words: ["dashboards.view"], path: "/api/training-load/dashboards" },
  { words: ["tests.view", "tests.results.view"], path: "/api/tests/schedules" },
  { words: ["variables.view"], path: "/api/training-load/sources/metrics/variables" },
];

async function session(userId, workspace) {
  const cookie = await srv.cookieFor(userId);
  if (workspace) {
    const res = await srv.api(cookie, "/api/auth/workspace", { method: "PUT", body: workspace });
    assert.equal(res.status, 200, res.text);
  }
  return cookie;
}

test("1. every seeded view word: the seeded holders pass the module's read gate today and hold the word; outsiders pass neither", async () => {
  const holders = [
    { name: "club admin in its club", user: W.admin, ws: { type: "club", scopeId: W.A }, scope: perms.clubScope(W.A) },
    { name: "team coach in its team", user: W.coach, ws: { type: "team", scopeId: W.T }, scope: perms.teamScope(W.T) },
  ];
  const outsiders = [
    { name: "athlete", user: W.athlete, ws: { type: "athlete", scopeId: null }, scope: perms.clubScope(W.A) },
    { name: "no role", user: W.none, ws: null, scope: perms.clubScope(W.A) },
    { name: "admin of another club, asked about club A", user: W.otherAdmin, ws: { type: "club", scopeId: W.B }, scope: perms.clubScope(W.A) },
  ];
  const proven = [];
  for (const row of ROWS) {
    for (const h of holders) {
      const res = await srv.api(await session(h.user, h.ws), row.path);
      assert.equal(res.status, 200, `${h.name} reaches ${row.path} today (${res.status} ${res.text.slice(0, 200)})`);
      const ctx = await authz.loadAuthorizationContext({ id: h.user, role_hint: null });
      for (const word of row.words) {
        assert.equal(perms.can(ctx, word, h.scope), true, `${h.name} holds ${word}`);
        assert.equal((await k.query(`select public.user_has_permission($1, $2, $3, $4) as ok`, [h.user, word, h.scope.type, h.scope.id])).rows[0].ok, true);
      }
    }
    for (const o of outsiders) {
      const ctx = await authz.loadAuthorizationContext({ id: o.user, role_hint: null });
      for (const word of row.words) assert.equal(perms.can(ctx, word, o.scope), false, `${o.name} does not hold ${word}`);
      if (o.name !== "admin of another club, asked about club A") {
        const res = await srv.api(await session(o.user, o.ws), row.path);
        // Some read routes answer an athlete or an account without a role with 200 and its own (empty) view: the
        // gate is then the data scope - nothing of club A or its team reaches them.
        assert.ok(res.status !== 200 || (!res.text.includes(W.A) && !res.text.includes(W.T)), `${o.name} sees nothing of club A through ${row.path} (${res.status})`);
      }
    }
    proven.push(...row.words);
  }
  // Every VIEW word seeded by v92 has its row. Later Calendar, schedule and roster seeds are Manage words.
  const seeded = (await k.query(`select permission_word from public.permission_role_items where role_id = '00000000-0000-4000-8000-000000000843'
      and permission_word not in ('org.view', 'athletes.manage', 'athletes.remove', 'calendar.events.manage', 'load.roster.decide', 'load.schedule.manage', 'load.estimates.manage', 'load.activities.manage', 'dashboards.manage', 'programs.rpe_settings', 'exercises.add', 'exercises.remove', 'programs.edit', 'programs.assign', 'programs.publish', 'tests.schedule.manage') order by 1`)).rows.map((r) => r.permission_word);
  assert.deepEqual([...proven].sort(), seeded);
  void crypto;
});
