// K2b-1d2, the manager's Q4 (docs/ai/central-calendar-k2b-plan.md 23.6): the platform workspace's month read of the
// central calendar, timed on a DISPOSABLE database with a seeded world - 3 clubs x 10 teams, 300 athletes (10 per
// team), a month of planned sessions (3 a week per athlete) and 8 events per team - through the real app over HTTP
// with a platform admin's session. A measurement, not a test.
//
//   node backend/scripts/calendar-platform-read-cost.mjs [--root <checkout>] [--runs 7]
//
// `--root` names the checkout whose backend is measured (default: this one). Run it once from this branch and once
// with --root pointing at a clean origin/main worktree: the same world, before and after. DATABASE_URL must name a
// server where disposable databases may be created; the fixture (backend/tests/support/calendar-fixture.mjs) creates
// an `optimove_tests_*` database, refuses anything else, and drops it at the end. It prints one JSON line.
// Invented names only.
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(option("--root", path.resolve(here, "../..")));
const runs = Math.max(1, Number(option("--runs", "7")) || 7);
const CLUBS = 3;
const TEAMS_PER_CLUB = 10;
const ATHLETES_PER_TEAM = 10;
const EVENTS_PER_TEAM = 8;

const { startCalendarApp, newKey } = await import(pathToFileURL(path.join(root, "backend/tests/support/calendar-fixture.mjs")).href);

function addDays(iso, days) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
function mondayOf(iso) {
  const d = new Date(`${iso}T00:00:00Z`);
  return addDays(iso, -((d.getUTCDay() + 6) % 7));
}
const median = (values) => {
  const s = [...values].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

const today = new Date().toISOString().slice(0, 10);
const from = `${today.slice(0, 7)}-01`;
const to = addDays(addDays(`${from.slice(0, 8)}28`, 4).slice(0, 8) + "01", -1);

const env = await startCalendarApp({ label: "k2b1d2cost" });
try {
  const { q, api, fx } = env;
  const platform = await fx.platformAdmin("Cost platform admin");
  const teams = [];
  for (let c = 1; c <= CLUBS; c += 1) {
    const clubId = await fx.makeClub(`Cost club ${c}`);
    const admin = await fx.clubAdminOf(clubId, `Cost admin ${c}`);
    for (let t = 1; t <= TEAMS_PER_CLUB; t += 1) teams.push({ clubId, admin, teamId: await fx.makeTeam(clubId, `Cost team ${c}-${t}`) });
  }

  // Planned sessions: a weekly plan per athlete and week, owned by the team, sessions on Monday, Wednesday and Friday.
  let sessions = 0;
  const weeks = [];
  for (let monday = mondayOf(from); monday <= to; monday = addDays(monday, 7)) weeks.push(monday);
  let n = 0;
  for (const team of teams) {
    for (let a = 1; a <= ATHLETES_PER_TEAM; a += 1) {
      n += 1;
      const athlete = await fx.makeAthlete(`Cost athlete ${n}`, { clubId: team.clubId, teamId: team.teamId });
      for (const monday of weeks) {
        const planId = (await q(
          `insert into plans.plans (plan_type, created_by_user_id, athlete_id, name, status, week_start, is_active, is_edit_draft)
           values ('weekly',$1,$2,'Week','active',$3,true,false) returning id`,
          [team.admin.id, athlete.athleteId, monday],
        ))[0].id;
        await q(`insert into training_load.plan_workspace_ownership (plan_id, owner_scope, owner_team_id) values ($1,'team',$2)`, [planId, team.teamId]);
        for (const offset of [0, 2, 4]) {
          const date = addDays(monday, offset);
          if (date < from || date > to) continue;
          const dayId = (await q(`insert into plans.plan_days (plan_id, date, day_order) values ($1,$2,1) returning id`, [planId, date]))[0].id;
          await q(
            `insert into plans.plan_sessions (plan_day_id, name, am_pm, bta, session_order, session_time, rpe_enabled, training_load_enabled, logical_session_id)
             values ($1,'Team training','PM','T',1,'18:00',true,true,gen_random_uuid())`,
            [dayId],
          );
          sessions += 1;
        }
      }
    }
  }

  // Events: 8 per team over the month, through the route, as the club's admin.
  let events = 0;
  const typeOfClub = new Map();
  for (const team of teams) {
    if (!typeOfClub.has(team.clubId)) {
      const types = await api("/api/calendar/events/types", { cookie: team.admin.cookie });
      if (types.status !== 200) throw new Error(`types: ${types.status} ${types.text}`);
      typeOfClub.set(team.clubId, types.body.types.find((t) => t.kind === "match").id);
    }
    for (let e = 0; e < EVENTS_PER_TEAM; e += 1) {
      const day = addDays(from, Math.floor((e * 27) / EVENTS_PER_TEAM));
      const res = await api("/api/calendar/events", {
        method: "POST", cookie: team.admin.cookie,
        body: { requestKey: newKey(), timezone: "Europe/Belgrade", eventTypeId: typeOfClub.get(team.clubId), title: `Cost event ${e + 1}`, day, startTime: "17:00", targets: [{ kind: "team", id: team.teamId }] },
      });
      if (res.status !== 201) throw new Error(`event: ${res.status} ${res.text}`);
      events += 1;
    }
  }

  const url = `/api/calendar?from=${from}&to=${to}&today=${today}`;
  const warm = await api(url, { cookie: platform.cookie });
  if (warm.status !== 200) throw new Error(`read: ${warm.status} ${warm.text}`);
  // The seeding must really reach the read, or the numbers would leave out the athletes x teams cost Q4 is about
  // (code review): the planned sessions and the events come back as cards.
  const answerItems = warm.body.days.flatMap((d) => d.items);
  const plannedCards = answerItems.filter((i) => i.kind === "planned").length;
  const eventCards = answerItems.filter((i) => i.kind === "event").length;
  if (plannedCards === 0) throw new Error("no planned cards in the read: the seeding did not reach the calendar");
  if (eventCards < events) throw new Error(`only ${eventCards} event cards for ${events} events`);
  const times = [];
  for (let i = 0; i < runs; i += 1) {
    const t0 = performance.now();
    const res = await api(url, { cookie: platform.cookie });
    times.push(performance.now() - t0);
    if (res.status !== 200) throw new Error(`read: ${res.status}`);
  }
  let commit = "";
  try {
    commit = execFileSync("git", ["-C", root, "rev-parse", "--short=12", "HEAD"], { encoding: "utf8" }).trim();
  } catch {}
  console.log(JSON.stringify({
    root, commit, from, to, clubs: CLUBS, teams: teams.length, athletes: n, sessions, events,
    answerTeams: warm.body.teams.length, items: answerItems.length, plannedCards, eventCards,
    runs, medianMs: Math.round(median(times)), minMs: Math.round(Math.min(...times)), maxMs: Math.round(Math.max(...times)),
  }));
} finally {
  await env.stop();
}
