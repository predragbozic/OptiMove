// Runs the real `npm test` command against the dev database several times
// in a row and confirms two things every run: the tests themselves pass,
// and the dev database is exactly as it was before - same platform_admin
// headcount (id, email, login status, role-active status all unchanged),
// no leftover @test.local users, and no net change in athletes/clubs/
// teams/sessions counts. A single leaked fixture row (e.g. an athlete
// orphaned by ON DELETE SET NULL when its linked user is deleted first)
// would show up here even if every individual test still reports green.
//
// This is a manually-run maintenance check, not part of `npm test` itself -
// invoke it with `npm run test:verify-isolation` from backend/.
import "dotenv/config";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { query, pool } from "../src/db.js";

const RUNS = Number(process.env.VERIFY_ISOLATION_RUNS || 3);
const backendDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function snapshot() {
  const admins = await query(
    `select u.id, u.email, u.is_active as login_active
     from public.users u
     join public.user_global_roles g on g.user_id = u.id and g.role = 'platform_admin' and g.is_active = true
     order by u.email`,
  );
  const [testLocalUsers, athletes, clubs, teams, sessions] = await Promise.all([
    query(`select count(*)::int as c from public.users where email like '%@test.local'`),
    query(`select count(*)::int as c from public.athletes`),
    query(`select count(*)::int as c from public.clubs`),
    query(`select count(*)::int as c from public.teams`),
    query(`select count(*)::int as c from public.auth_sessions`),
  ]);
  return {
    admins: admins.rows,
    testLocalUsers: testLocalUsers.rows[0].c,
    athletes: athletes.rows[0].c,
    clubs: clubs.rows[0].c,
    teams: teams.rows[0].c,
    sessions: sessions.rows[0].c,
  };
}

function describeAdmins(admins) {
  return admins.map((a) => `${a.email} (login_active=${a.login_active})`).join(", ") || "(none)";
}

function diffSnapshots(before, after) {
  const problems = [];
  const beforeAdmins = JSON.stringify([...before.admins].sort((a, b) => a.email.localeCompare(b.email)));
  const afterAdmins = JSON.stringify([...after.admins].sort((a, b) => a.email.localeCompare(b.email)));
  if (beforeAdmins !== afterAdmins) {
    problems.push(`platform_admin set changed:\n    before: ${describeAdmins(before.admins)}\n    after:  ${describeAdmins(after.admins)}`);
  }
  if (before.testLocalUsers !== after.testLocalUsers) {
    problems.push(`@test.local user count changed: ${before.testLocalUsers} -> ${after.testLocalUsers}`);
  }
  if (before.athletes !== after.athletes) problems.push(`athletes count changed: ${before.athletes} -> ${after.athletes}`);
  if (before.clubs !== after.clubs) problems.push(`clubs count changed: ${before.clubs} -> ${after.clubs}`);
  if (before.teams !== after.teams) problems.push(`teams count changed: ${before.teams} -> ${after.teams}`);
  if (before.sessions !== after.sessions) problems.push(`auth_sessions count changed: ${before.sessions} -> ${after.sessions}`);
  return problems;
}

async function main() {
  console.log(`Running \`npm test\` ${RUNS} times in a row and checking dev DB state after each run...\n`);
  const initial = await snapshot();
  console.log(`Baseline: ${initial.admins.length} active platform_admin(s) [${describeAdmins(initial.admins)}], ` +
    `${initial.testLocalUsers} @test.local users, ${initial.athletes} athletes, ${initial.clubs} clubs, ${initial.teams} teams, ${initial.sessions} sessions.\n`);

  let allOk = true;
  for (let run = 1; run <= RUNS; run++) {
    console.log(`--- Run ${run}/${RUNS} ---`);
    const result = spawnSync("npm", ["test"], { cwd: backendDir, stdio: "inherit", shell: true });
    const testsPassed = result.status === 0;
    console.log(testsPassed ? `Run ${run}: tests passed.` : `Run ${run}: tests FAILED (exit code ${result.status}).`);

    const after = await snapshot();
    const problems = diffSnapshots(initial, after);
    if (problems.length) {
      allOk = false;
      console.log(`Run ${run}: dev DB state changed:`);
      for (const problem of problems) console.log(`  - ${problem}`);
    } else {
      console.log(`Run ${run}: dev DB state unchanged from baseline.`);
    }
    if (!testsPassed) allOk = false;
    console.log("");
  }

  await pool.end();
  if (!allOk) {
    console.error("VERIFY FAILED: at least one run either failed or left the dev database changed.");
    process.exit(1);
  }
  console.log(`VERIFY PASSED: all ${RUNS} runs succeeded and the dev database was unchanged after every run.`);
}

main().catch((error) => {
  console.error("verify-test-suite-isolation crashed:", error);
  process.exitCode = 1;
});
