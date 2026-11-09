// The Imports scenario's starting point, built through the real routes and the backend tests' own helpers:
// the approved pair, the club's connection and binding, the team's import switch, the activated mappings (the
// two database helpers write what no route does yet in a fresh world), the athlete links, and one check that finds
// the fake source's sessions. Nothing is imported here.
import pg from "pg";
import { bindThroughRoutes } from "../../backend/tests/support/gpexe-fake-source.mjs";
import { enableTeamImportSwitch } from "../../backend/tests/support/team-import-switch.mjs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const G = "/api/training-load/gpexe";
const cookieOf = (world, role) => `optimove_session=${world.accounts.find((a) => a.role === role).sessionToken}`;

async function call(world, role, method, path, body) {
  const res = await fetch(`${world.baseUrl}${path}`, { method, headers: { "Content-Type": "application/json", Cookie: cookieOf(world, role) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let parsed = {};
  try { parsed = JSON.parse(text); } catch { parsed = {}; }
  return { status: res.status, body: parsed };
}

export async function prepareImports(world, { link = [101, 102, 103], from = "2026-11-01", to = "2026-11-08", check = true } = {}) {
  const teamId = world.ids.teamA;
  const approved = await call(world, "platform_admin", "PUT", `${G}/teams/${teamId}/settings`, { gpexeTeamId: "7001" });
  if (approved.status !== 200) throw new Error(`approve pair: ${approved.status}`);
  const { bindingId } = await bindThroughRoutes({ apiBase: world.baseUrl, cookie: cookieOf(world, "platform_admin"), clubId: world.ids.clubA, teamId, sourceTeamId: "7001" });
  const admin = new pg.Client({ connectionString: world.databaseUrl });
  await admin.connect();
  try {
    await enableTeamImportSwitch(admin, teamId, world.accounts.find((a) => a.role === "platform_admin").id);
  } finally {
    await admin.end();
  }
  const activated = spawnSync(process.execPath, [path.join(path.dirname(fileURLToPath(import.meta.url)), "activate-binding.mjs"), bindingId], { env: { ...process.env, DATABASE_URL: world.databaseUrl }, encoding: "utf8" });
  if (activated.status !== 0) throw new Error(`activate mappings: ${activated.stderr.slice(0, 400)}`);
  for (const [i, gpexeId] of link.entries()) {
    const r = await call(world, "team_coach", "POST", `${G}/teams/${teamId}/athlete-links`, { gpexeAthleteId: String(gpexeId), athleteId: world.ids.athleteIds[i] });
    if (r.status !== 201) throw new Error(`link ${gpexeId}: ${r.status} ${JSON.stringify(r.body)}`);
  }
  if (!check) return { teamId, bindingId, candidates: [], call: (role, method, path, body) => call(world, role, method, path, body) };
  const started = await call(world, "team_coach", "POST", `${G}/teams/${teamId}/checks`, { from, to });
  if (started.status !== 202) throw new Error(`start check: ${started.status} ${JSON.stringify(started.body)}`);
  for (let i = 0; i < 300; i += 1) {
    const r = await call(world, "team_coach", "GET", `${G}/teams/${teamId}/checks/${started.body.check.id}`);
    if (r.body.check?.status && r.body.check.status !== "running") {
      if (r.body.check.status !== "succeeded") throw new Error(`check ${r.body.check.status}: ${JSON.stringify(r.body.check).slice(0, 300)}`);
      break;
    }
    await new Promise((r2) => setTimeout(r2, 200));
  }
  const candidates = (await call(world, "team_coach", "GET", `${G}/teams/${teamId}/candidates`)).body.candidates || [];
  return { teamId, bindingId, candidates, call: (role, method, path, body) => call(world, role, method, path, body) };
}
