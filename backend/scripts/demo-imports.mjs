// Demo world for Imports: the REAL backend and frontend on a DISPOSABLE database, with invented data only.
//
//   DATABASE_URL=postgres://user:pass@localhost:5432/postgres node backend/scripts/demo-imports.mjs [--port 3110] [--out demo.json]
//
// What it does: refuses any server that is not loopback (the T1 runner's rule), creates a NEW database named
// optimove_tests_gpexe_demo_<hex> (never touches the database in DATABASE_URL), runs the migrations the GPEXE suites run,
// seeds a club ("Example Club"), "First team" with 24 invented athletes, a fake GPEXE source (no network: the source host is
// answered in-process), a GPEXE connection and binding, ~16 sessions (6 with unlinked athletes, 2 for manual review, 1 with
// mixed time zones, the rest ready) and 3 imported ones; creates one demo account per role with a random password that is
// printed to this terminal only (and to --out); then serves the app on a local port until Ctrl+C / SIGTERM, which drops the
// database. Demo only: the accounts, the data and the source are fake.
import http from "node:http";
import fs from "node:fs";
import crypto from "node:crypto";
import pg from "pg";
import { createGpexeDisposableDb, createGpexePilotOrg } from "../tests/_gpexe-disposable-db.mjs";
import { makeBundle, standardAthletes } from "../tests/_gpexe-fixtures.mjs";
import { bindThroughRoutes, createFakeSource } from "../tests/support/gpexe-fake-source.mjs";
import { enableTeamImportSwitch } from "../tests/support/team-import-switch.mjs";
import { activateBinding } from "../tests/support/mapped-world.mjs";
import { isLoopbackServerAddress, parseServerUrl } from "../tests/support/disposable-db.mjs";

const args = process.argv.slice(2);
const arg = (name, fallback) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] ? args[i + 1] : fallback; };
const BASE_URL = process.env.DATABASE_URL;
if (!BASE_URL) { console.error("DATABASE_URL (a local Postgres server) is required."); process.exit(2); }
{
  // Only a loopback server, and the database created here is optimove_tests_*: both are enforced again by the shared helpers.
  const { hostname } = new URL(BASE_URL);
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(hostname)) { console.error(`Refusing: ${hostname} is not a loopback server.`); process.exit(2); }
  if (/supabase|render\.com|onrender|pooler|monitoring2/i.test(BASE_URL)) { console.error("Refusing: this looks like a hosted database."); process.exit(2); }
  void isLoopbackServerAddress; void parseServerUrl;
}
const PORT = Number(arg("--port", process.env.DEMO_PORT || 3110));
const OUT = arg("--out", process.env.DEMO_OUT || "");
const FIRST = ["Aron", "Bruno", "Cedric", "Dario", "Emil", "Filip", "Goran", "Hugo", "Ivo", "Jonas", "Karlo", "Luka", "Marin", "Nikola", "Oskar", "Pavle", "Rafael", "Samir", "Tomas", "Uros", "Viktor", "Zoran", "Adam", "Boris"];
const NAMES = FIRST.map((n) => `${n} Example`);

const db = await createGpexeDisposableDb({ baseDatabaseUrl: BASE_URL, label: "demo" });
const admin = new pg.Client({ connectionString: db.url });
await admin.connect();
process.env.DATABASE_URL = db.url;
process.env.GPEXE_IMPORT_APPLY_ENABLED = "true";
process.env.SOURCE_CREDENTIAL_KEYS = (await import("../src/sourceCredentialCrypto.js")).generateKeyEntry(1);
const serverModule = await import("../src/server.js");
const service = await import("../src/gpexeImportService.js");
const connections = await import("../src/sourceConnectionService.js");
const resolver = await import("../src/sourceImportCredentialResolver.js");
const { createSession } = await import("../src/auth.js");
const src = createFakeSource();
connections.setSourceFetchForTests(src.fetchImpl);
resolver.setImportSourceFetchForTests(src.fetchImpl);
globalThis.__fakeFetch = src.fetchImpl;
const server = http.createServer(serverModule.app);
await new Promise((r) => server.listen(PORT, r));
const apiBase = `http://localhost:${PORT}`;

async function api(path, { method = "GET", body, cookie } = {}) {
  const res = await fetch(`${apiBase}/api/training-load/gpexe${path}`, { method, headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let parsed = {}; try { parsed = JSON.parse(text); } catch { parsed = {}; }
  return { status: res.status, body: parsed };
}

// --- the club, the team, 24 athletes
const org = await createGpexePilotOrg(admin, { athleteNames: NAMES });
await admin.query(`update public.clubs set name = 'Example Club' where id = $1`, [org.clubId]);
await admin.query(`update public.teams set name = 'First team' where id = $1`, [org.teamId]);
const { hashPassword } = await import("../src/auth.js");
const demoPassword = () => `Demo-${crypto.randomBytes(9).toString("base64url")}`;
const setWs = (id, type, scope) => admin.query(`insert into public.user_workspace_preferences (user_id, workspace_type, scope_id) values ($1,$2,$3) on conflict (user_id) do update set workspace_type = excluded.workspace_type, scope_id = excluded.scope_id`, [id, type, scope]);
// One demo account per role: a login (email + a random password, demo only), a rights row and the workspace it opens in.
async function account(role, label, email) {
  const password = demoPassword();
  const id = (await admin.query(`insert into public.users (email, full_name, display_name, password_hash) values ($1,$2,$2,$3) returning id`, [email, label, hashPassword(password)])).rows[0].id;
  const token = await createSession(id);
  return { role, id, email, password, token, cookie: `optimove_session=${token}` };
}
const padmin = await account("platform_admin", "Platform Admin Example", "platform.admin@example.invalid");
await admin.query(`insert into public.user_global_roles (user_id, role, is_active) values ($1,'platform_admin',true)`, [padmin.id]);
await setWs(padmin.id, "club", org.clubId);
const clubAdmin = await account("club_admin", "Club Admin Example", "club.admin@example.invalid");
await admin.query(`insert into public.user_club_roles (user_id, club_id, role, is_active) values ($1,$2,'club_admin',true)`, [clubAdmin.id, org.clubId]);
await setWs(clubAdmin.id, "club", org.clubId);
const coach = await account("team_coach", "Coach Example", "coach@example.invalid");
await admin.query(`insert into public.user_team_roles (user_id, team_id, role, is_active) values ($1,$2,'team_coach',true)`, [coach.id, org.teamId]);
await setWs(coach.id, "team", org.teamId);
const athleteAccount = await account("athlete", "Aron Example", "athlete@example.invalid");
await admin.query(`update public.athletes set user_id = $1 where id = $2`, [athleteAccount.id, org.athleteIds[0]]);
await setWs(athleteAccount.id, "athlete", org.athleteIds[0]);

// --- GPEXE: team, connection, binding, switch, mappings
const SRC_TEAM = "7001";
assert(await api(`/teams/${org.teamId}/settings`, { method: "PUT", cookie: padmin.cookie, body: { gpexeTeamId: SRC_TEAM } }), 200);
src.show(SRC_TEAM);
const { bindingId } = await bindThroughRoutes({ apiBase, cookie: padmin.cookie, clubId: org.clubId, teamId: org.teamId, sourceTeamId: SRC_TEAM });
await enableTeamImportSwitch(admin, org.teamId, padmin.id);
await activateBinding(admin, bindingId);
function assert(r, status) { if (r.status !== status) throw new Error(`expected ${status}, got ${r.status} ${JSON.stringify(r.body)}`); }

// GPEXE athletes 101..118 are linked to the first 18 team athletes; 121..124 stay unlinked.
for (let i = 0; i < 18; i += 1) assert(await api(`/teams/${org.teamId}/athlete-links`, { method: "POST", cookie: coach.cookie, body: { gpexeAthleteId: String(101 + i), athleteId: org.athleteIds[i] } }), 201);

// --- bundles
const proto = standardAthletes()[0];
function athleteOf(id, sessionId, k, extraTrack = false) {
  const a = structuredClone(proto);
  a.id = id;
  const base = sessionId * 100 + (id % 100);
  a.tracks = extraTrack ? [base, base + 50] : [base];
  const f = 0.85 + ((id * 7 + k) % 30) / 100;
  for (const p of a.parts) {
    p.time = Math.round(p.time * f); p.distance = Math.round(p.distance * f * 10) / 10; p.maxV = Math.round((p.maxV * (0.9 + ((id + k) % 12) / 100)) * 100) / 100;
    p.burst = (p.burst ?? 0) + (id % 3) + (p.drill === 1 ? 1 : 0); p.brake = (p.brake ?? 0) + (id % 2);
    delete p.track;
  }
  if (extraTrack) {
    const second = structuredClone(a.parts.find((p) => p.drill === null));
    second.track = a.tracks[1]; second.time = Math.round(second.time / 3);
    a.parts.find((p) => p.drill === null).track = a.tracks[0];
    a.parts.push(second);
  }
  return a;
}
const days = ["2026-10-27", "2026-10-28", "2026-10-29", "2026-10-30", "2026-11-01", "2026-11-02", "2026-11-03", "2026-11-04", "2026-11-05", "2026-11-06", "2026-11-07", "2026-11-08", "2026-10-31", "2026-10-26", "2026-11-02", "2026-11-04"];
let sid = 9100;
const bundles = [];
const mk = (ids, { day, hour = 9, category = "FULL TRAINING", extra = [], tz = null } = {}) => {
  sid += 1;
  const athletes = ids.map((id, i) => athleteOf(id, sid, i, extra.includes(id)));
  const b = makeBundle({ sessionId: sid, gpexeTeamId: Number(SRC_TEAM), start: `${day}T${String(hour).padStart(2, "0")}:08:12`, updatedOn: `${day}T${String(hour + 2).padStart(2, "0")}:18:09.337`, category, athletes, detailsDrills: [0, 1] });
  if (tz) for (const t of Object.values(b.tracks)) if (t.athlete === tz) t.timezone = "Europe/Stockholm";
  bundles.push(b);
  return sid;
};
const linked = Array.from({ length: 18 }, (_, i) => 101 + i);
const pick = (from, n) => Array.from({ length: n }, (_, i) => linked[(from + i) % linked.length]);
let d = 0;
const readySids = [];
for (let i = 0; i < 7; i += 1) readySids.push(mk(pick(i * 2, 15), { day: days[d++ % days.length], hour: 8 + (i % 3) }));
for (let i = 0; i < 6; i += 1) mk([...pick(i, 13), 121 + (i % 4), 122 + (i % 3)], { day: days[d++ % days.length], hour: 11 + (i % 2) });
for (let i = 0; i < 2; i += 1) mk(pick(i + 3, 14), { day: days[d++ % days.length], hour: 16, extra: [pick(i + 3, 14)[2]] });
mk(pick(5, 14), { day: "2026-11-04", hour: 18, tz: pick(5, 14)[1] });
src.serve(SRC_TEAM, bundles);

// --- one check over the whole window, then import 3 of the ready sessions
const started = await api(`/teams/${org.teamId}/checks`, { method: "POST", cookie: coach.cookie, body: { from: "2026-10-25", to: "2026-11-08" } });
assert(started, 202);
for (let i = 0; i < 600; i += 1) {
  const r = await api(`/teams/${org.teamId}/checks/${started.body.check.id}`, { cookie: coach.cookie });
  if (r.body.check?.status !== "running") { if (r.body.check.status !== "succeeded") throw new Error(JSON.stringify(r.body.check)); break; }
  await new Promise((r2) => setTimeout(r2, 100));
}
const list = (await api(`/teams/${org.teamId}/candidates`, { cookie: coach.cookie })).body.candidates;
const bySession = Object.fromEntries(list.map((c) => [c.gpexeTeamSessionId, c]));
const toImport = readySids.slice(0, 3).map((s) => bySession[String(s)]).filter(Boolean);
const imp = await api(`/teams/${org.teamId}/imports`, { method: "POST", cookie: padmin.cookie, body: { candidateIds: toImport.map((c) => c.id), previewHashes: Object.fromEntries(toImport.map((c) => [c.id, c.previewHash])) } });
const final = (await api(`/teams/${org.teamId}/candidates`, { cookie: coach.cookie })).body.candidates;
const tally = {};
for (const c of final) tally[`${c.status}/${c.previewStatus}/${(c.reasons || []).map((r) => r.code).join("+") || c.blockedCode || "-"}`] = (tally[`${c.status}/${c.previewStatus}/${(c.reasons || []).map((r) => r.code).join("+") || c.blockedCode || "-"}`] || 0) + 1;
const accounts = [padmin, clubAdmin, coach, athleteAccount].map(({ role, email, password, token }) => ({ role, email, password, sessionToken: token }));
const info = { port: PORT, url: `http://localhost:${PORT}/`, database: db.name, clubId: org.clubId, teamId: org.teamId, accounts, candidates: final.length, tally, importOutcomes: (imp.body.results || []).map((r) => r.outcome) };
if (OUT) fs.writeFileSync(OUT, JSON.stringify(info, null, 2), { mode: 0o600 });
console.log(`\nDemo ready on ${info.url}  (database ${db.name}; Ctrl+C drops it)\n`);
for (const a of accounts) console.log(`  ${a.role.padEnd(15)} ${a.email}  ${a.password}`);
console.log(`\n  sessions: ${info.candidates} candidates, ${JSON.stringify(tally)}\n  (demo only: invented data, fake GPEXE source, no network)`);
let closing = false;
async function shutdown() {
  if (closing) return; closing = true;
  server.closeAllConnections(); await new Promise((r) => server.close(r));
  const { pool } = await import("../src/db.js"); await pool.end(); await admin.end(); await db.drop();
  console.log("Dropped", db.name); process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
