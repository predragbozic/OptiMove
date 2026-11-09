// U2 (the Rukovodilac's decision A, 2026-11-09): GET /api/organization/clubs-summary - the platform admin's Home list. One light
// row per active club (id, name, active teams, active athletes) and nothing about a person; no-store. Anyone who is not an active
// platform administrator IN THE PLATFORM WORKSPACE answers the same 404 as an unknown route, whatever their other roles.
// Disposable database through the real runner (support/calendar-fixture.mjs starts the whole app); no persistent database.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { calendarRoleMatrix, startCalendarApp } from "./support/calendar-fixture.mjs";

let env;
let m;
before(async () => {
  env = await startCalendarApp({ label: "u2sum" });
  m = await calendarRoleMatrix(env, "u2");
});
after(async () => { if (env) await env.stop(); });

const get = (cookie, path = "/api/organization/clubs-summary") => env.api(path, { cookie });

test("1. a platform admin in the platform workspace reads the active clubs with their counts, no-store, and no person anywhere", async () => {
  const res = await get(m.roles.platformAdmin.cookie);
  assert.equal(res.status, 200, res.text);
  assert.equal(res.cacheControl, "no-store");
  assert.deepEqual(Object.keys(res.body), ["clubs"]);
  const byId = Object.fromEntries(res.body.clubs.map((c) => [c.id, c]));
  const c1 = byId[m.clubs.c1];
  const c2 = byId[m.clubs.c2];
  assert.match(c1.name, /^u2 C1/);
  assert.match(c2.name, /^u2 C2/);
  assert.deepEqual([c1.teamCount, c1.athleteCount], [2, 1], "t3 is archived and not counted");
  assert.deepEqual([c2.teamCount, c2.athleteCount], [1, 1]);
  assert.equal(byId[m.clubs.c3], undefined, "an archived club is not listed");
  for (const club of res.body.clubs) assert.deepEqual(Object.keys(club).sort(), ["athleteCount", "id", "name", "teamCount"]);
  assert.match(res.text.toLowerCase(), /^(?!.*(athlete t1|own athlete|admin c1|coach t1)).*$/s, "no person's name appears");
});

test("2. every other account gets the same 404 as an unknown route: club admin, coach, private coach, athlete, another club's admin, revoked, archived club", async () => {
  const unknown = "/api/organization/no-such-route-u2";
  for (const [who, role] of Object.entries({ clubAdmin: m.roles.clubAdmin, teamCoach: m.roles.teamCoach, privateCoach: m.roles.privateCoach, athlete: m.roles.athlete, stranger: m.roles.stranger, revokedAdmin: m.roles.revokedAdmin, archivedAdmin: m.roles.archivedAdmin })) {
    const res = await get(role.cookie);
    const ref = await get(role.cookie, unknown);
    assert.equal(res.status, ref.status, `${who}: same status as an unknown route (${res.status})`);
    assert.notEqual(res.status, 200, who);
    if (res.status === 404) assert.equal(res.text.replace("clubs-summary", "no-such-route-u2"), ref.text, `${who}: same body`);
  }
  const anon = await env.api("/api/organization/clubs-summary", {});
  assert.ok([401, 403].includes(anon.status), `no session: ${anon.status}`);
});

test("3. a platform admin who also administers a club, with that club's workspace active, is refused: authorization follows the active workspace", async () => {
  const res = await get(m.roles.platformInClub.cookie);
  assert.equal(res.status, 404, res.text);
  const ref = await get(m.roles.platformInClub.cookie, "/api/organization/no-such-route-u2");
  assert.equal(res.text.replace("clubs-summary", "no-such-route-u2"), ref.text);
});
