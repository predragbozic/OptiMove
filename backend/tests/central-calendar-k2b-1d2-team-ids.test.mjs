// K2b-1d2, the owner's decision of 2026-11-18 (docs/ai/central-calendar-k2b-plan.md 23.6): the athletes' team ids of
// the calendar (calendarQuery.js athleteTeamIdsSql) go from the athlete's own team periods to the teams of the list,
// instead of from every team of the list to the athlete. This suite proves the new form EQUAL to the earlier one, which
// it keeps frozen below exactly as it was (and THE membership rule, membershipOnDaySql, equal to its earlier text after
// its day condition moved into membershipPeriodOnDaySql), on one world built for the rule's edges:
//   - an athlete who changes team in the middle of the range;
//   - one whose team membership was archived before the range;
//   - one before their first period in the club (the fallback), and one with an earlier club period (no fallback);
//   - one in two teams; one paused;
//   - a team archived in the middle of the range (D45: its membership ends that day);
//   - a team moved to another club with a raw write (D43; only an empty team can move: a membership holds its
//     (team, club) key), joined afterwards;
//   - the joining day and the leaving day at the edges of a UTC day.
// For every athlete, every day of the range and every team list a viewer can have (the platform's, each club's, each
// single team, all of them, none), old and new give the same array, in the same order. And THE rule still gives, for a
// window of days, exactly the union of its single days.
// One disposable database through the real runner; nothing touches OPTIMOVE or any persistent database. Invented names.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { addDays, startCalendarApp, uid } from "./support/calendar-fixture.mjs";

const TODAY = new Date().toISOString().slice(0, 10);
const D0 = addDays(TODAY, -5);
const D_LAST = addDays(TODAY, 8);
const MID = TODAY;

let env;
let athleteTeamIdsSql;
let membershipOnDaySql;
const w = {};

// ---------------------------------------------------------------------------
// The earlier forms, frozen exactly as they were before this change.
// ---------------------------------------------------------------------------
const OLD_periodDaySql = (expr) => `(${expr} at time zone 'UTC')::date`;
const OLD_periodCoversSql = (mp, fromExpr, toExpr = fromExpr) =>
  `${OLD_periodDaySql(`${mp}.valid_from`)} <= (${toExpr})::date and (${fromExpr})::date <= coalesce(${OLD_periodDaySql(`${mp}.valid_to`)}, 'infinity'::date)`;
function OLD_membershipOnDaySql(athleteIdExpr, cond, fromExpr, toExpr = fromExpr) {
  return `exists (select 1 from public.athlete_membership_periods mp
           where mp.athlete_id = ${athleteIdExpr} and ${cond("mp")}
             and (${OLD_periodCoversSql("mp", fromExpr, toExpr)}
                  or (mp.valid_to is null
                      and not exists (select 1 from public.athlete_membership_periods mp0
                                       where mp0.athlete_id = ${athleteIdExpr} and mp0.club_id = mp.club_id
                                         and ${OLD_periodDaySql("mp0.valid_from")} <= (${fromExpr})::date))))`;
}
const OLD_athleteTeamIdsSql = (alias, teamsParam, dayExpr) =>
  `(select coalesce(array_agg(distinct wt.id), '{}') from unnest($${teamsParam}::uuid[]) as wt(id)
     where ${OLD_membershipOnDaySql(`${alias}.id`, (m) => `(${m}.membership_type = 'team' and ${m}.team_id = wt.id)`, dayExpr)})`;

const q = (sql, params) => env.q(sql, params);

async function membership({ athleteId, clubId, teamId = null, startsAt, archivedAt = null, status = archivedAt ? "archived" : "active" }) {
  return (await q(
    `insert into public.athlete_memberships (athlete_id, club_id, team_id, membership_type, status, starts_at, archived_at)
     values ($1,$2,$3,$4,$5,$6,$7) returning id`,
    [athleteId, clubId, teamId, teamId ? "team" : "club", status, startsAt, archivedAt],
  ))[0].id;
}
async function athlete(label) {
  return (await env.fx.makeAthlete(`${label} ${uid()}`)).athleteId;
}

before(async () => {
  env = await startCalendarApp({ label: "k2b1d2ids" });
  ({ athleteTeamIdsSql } = await import("../src/calendarQuery.js"));
  ({ membershipOnDaySql } = await import("../src/calendarAccess.js"));
  const fx = env.fx;
  // Clock-independent (db review).
  const LONG_AGO = `${addDays(TODAY, -300)}T00:00:00Z`;
  w.clubA = await fx.makeClub("Ids club A");
  w.clubB = await fx.makeClub("Ids club B");
  w.A1 = await fx.makeTeam(w.clubA, "Ids A1");
  w.A2 = await fx.makeTeam(w.clubA, "Ids A2");
  w.A3 = await fx.makeTeam(w.clubA, "Ids A3");
  w.B1 = await fx.makeTeam(w.clubB, "Ids B1");
  // D43: an empty team of club A moved to club B with a raw write, joined afterwards.
  w.E = await fx.makeTeam(w.clubA, "Ids E");
  await q(`update public.teams set club_id = $2 where id = $1`, [w.E, w.clubB]);

  // An athlete who changes team in the middle of the range: A1 until MID 12:00, A2 from MID 12:00.
  w.mover = await athlete("Ids mover");
  await membership({ athleteId: w.mover, clubId: w.clubA, startsAt: LONG_AGO });
  await membership({ athleteId: w.mover, clubId: w.clubA, teamId: w.A1, startsAt: LONG_AGO, archivedAt: `${MID}T12:00:00Z` });
  await membership({ athleteId: w.mover, clubId: w.clubA, teamId: w.A2, startsAt: `${MID}T12:00:00Z` });
  // A team membership archived before the range.
  w.archivedOnly = await athlete("Ids archived");
  await membership({ athleteId: w.archivedOnly, clubId: w.clubA, startsAt: LONG_AGO });
  await membership({ athleteId: w.archivedOnly, clubId: w.clubA, teamId: w.A1, startsAt: LONG_AGO, archivedAt: `${addDays(D0, -10)}T12:00:00Z` });
  // Before the first period in the club: the fallback (no earlier period there).
  w.late = await athlete("Ids late");
  await membership({ athleteId: w.late, clubId: w.clubA, startsAt: `${addDays(TODAY, 3)}T08:00:00Z` });
  await membership({ athleteId: w.late, clubId: w.clubA, teamId: w.A2, startsAt: `${addDays(TODAY, 3)}T08:00:00Z` });
  // An earlier club period: no fallback for the later team.
  w.lateWithClub = await athlete("Ids late with club");
  await membership({ athleteId: w.lateWithClub, clubId: w.clubA, startsAt: LONG_AGO });
  await membership({ athleteId: w.lateWithClub, clubId: w.clubA, teamId: w.A1, startsAt: `${addDays(TODAY, 3)}T08:00:00Z` });
  // Two teams at once.
  w.twoTeams = await athlete("Ids two teams");
  await membership({ athleteId: w.twoTeams, clubId: w.clubA, startsAt: LONG_AGO });
  await membership({ athleteId: w.twoTeams, clubId: w.clubA, teamId: w.A1, startsAt: LONG_AGO });
  await membership({ athleteId: w.twoTeams, clubId: w.clubA, teamId: w.A2, startsAt: LONG_AGO });
  // Paused: still a member (an open period).
  w.paused = await athlete("Ids paused");
  await membership({ athleteId: w.paused, clubId: w.clubA, startsAt: LONG_AGO });
  await membership({ athleteId: w.paused, clubId: w.clubA, teamId: w.A2, startsAt: LONG_AGO, status: "paused" });
  // D45: team A3 archived in the middle of the range, its membership ended that day.
  w.teamArchived = await athlete("Ids team archived");
  await membership({ athleteId: w.teamArchived, clubId: w.clubA, startsAt: LONG_AGO });
  const a3 = await membership({ athleteId: w.teamArchived, clubId: w.clubA, teamId: w.A3, startsAt: LONG_AGO });
  await q(`update public.athlete_memberships set status = 'archived', archived_at = $2, updated_at = now() where id = $1`, [a3, `${MID}T12:00:00Z`]);
  await q(`update public.teams set is_active = false where id = $1`, [w.A3]);
  // The edges of a UTC day: joined late on D0+2, left early on D0+6; both days count.
  w.boundary = await athlete("Ids boundary");
  await membership({ athleteId: w.boundary, clubId: w.clubA, startsAt: LONG_AGO });
  await membership({ athleteId: w.boundary, clubId: w.clubA, teamId: w.A1, startsAt: `${addDays(D0, 2)}T23:00:00Z`, archivedAt: `${addDays(D0, 6)}T01:00:00Z` });
  // The moved team's member, joined after the move.
  w.movedMember = await athlete("Ids moved member");
  await membership({ athleteId: w.movedMember, clubId: w.clubB, startsAt: LONG_AGO });
  await membership({ athleteId: w.movedMember, clubId: w.clubB, teamId: w.E, startsAt: `${MID}T08:00:00Z` });
  // Another club's member.
  w.otherClub = await athlete("Ids other club");
  await membership({ athleteId: w.otherClub, clubId: w.clubB, startsAt: LONG_AGO });
  await membership({ athleteId: w.otherClub, clubId: w.clubB, teamId: w.B1, startsAt: LONG_AGO });
  // Archived before the range, then restored (v25 opens a second period of the same membership at now()): two
  // periods of one team, a gap between them (db review).
  w.restored = await athlete("Ids restored");
  await membership({ athleteId: w.restored, clubId: w.clubA, startsAt: LONG_AGO });
  const restoredA1 = await membership({ athleteId: w.restored, clubId: w.clubA, teamId: w.A1, startsAt: LONG_AGO, archivedAt: `${addDays(D0, -3)}T12:00:00Z` });
  await q(`update public.athlete_memberships set status = 'active', archived_at = null, updated_at = now() where id = $1`, [restoredA1]);
  // The restore's day as the DATABASE wrote it (its now(), a UTC day), not this file's TODAY: a run across midnight UTC
  // would otherwise fail the anchors falsely (code review LOW; the manager's NIT).
  w.restoredDay = (await q(
    `select ((valid_from at time zone 'UTC')::date)::text as day from public.athlete_membership_periods where membership_id = $1 and valid_to is null`,
    [restoredA1],
  ))[0].day;
  // Archived before it started: a period of zero length on its one day (db review).
  w.zeroLength = await athlete("Ids zero length");
  await membership({ athleteId: w.zeroLength, clubId: w.clubA, startsAt: LONG_AGO });
  await membership({ athleteId: w.zeroLength, clubId: w.clubA, teamId: w.A2, startsAt: `${addDays(TODAY, 2)}T10:00:00Z`, archivedAt: `${addDays(TODAY, 2)}T09:00:00Z` });
  // The first period in ANOTHER club does not stop the fallback in this one: club B long ago, team A2 (club A) from
  // TODAY+3 with no earlier period in club A (pins the fallback's club condition, db review).
  w.crossClub = await athlete("Ids cross club");
  await membership({ athleteId: w.crossClub, clubId: w.clubB, startsAt: LONG_AGO });
  await membership({ athleteId: w.crossClub, clubId: w.clubA, teamId: w.A2, startsAt: `${addDays(TODAY, 3)}T08:00:00Z` });
  // A closed period with no earlier period in its club: joins TODAY+2, leaves TODAY+4. The fallback is for an OPEN
  // period only, so before TODAY+2 the athlete is in no team (kills BM16, code review).
  w.leftLater = await athlete("Ids left later");
  await membership({ athleteId: w.leftLater, clubId: w.clubA, startsAt: `${addDays(TODAY, 2)}T08:00:00Z`, archivedAt: `${addDays(TODAY, 4)}T08:00:00Z` });
  await membership({ athleteId: w.leftLater, clubId: w.clubA, teamId: w.A1, startsAt: `${addDays(TODAY, 2)}T08:00:00Z`, archivedAt: `${addDays(TODAY, 4)}T08:00:00Z` });
  // Two teams of one club, no club period: A1 from TODAY+3, A2 from TODAY+5. On TODAY+3 the A1 period starting THAT DAY
  // is already the first period in the club, so A2 takes no fallback; the first period's day counts (`<=`, kills RM1,
  // the independent review).
  w.firstPeriodDay = await athlete("Ids first period day");
  await membership({ athleteId: w.firstPeriodDay, clubId: w.clubA, teamId: w.A1, startsAt: `${addDays(TODAY, 3)}T08:00:00Z` });
  await membership({ athleteId: w.firstPeriodDay, clubId: w.clubA, teamId: w.A2, startsAt: `${addDays(TODAY, 5)}T08:00:00Z` });
  w.athletes = [w.mover, w.archivedOnly, w.late, w.lateWithClub, w.twoTeams, w.paused, w.teamArchived, w.boundary, w.movedMember, w.otherClub, w.restored, w.zeroLength, w.crossClub, w.leftLater, w.firstPeriodDay];
});

after(async () => {
  if (env) await env.stop();
});

// Every team list a viewer can have: the platform's (active teams of active clubs), each club's active teams, a club's
// list from before its team was archived, each single team, all of them, none.
async function teamLists() {
  const platform = (await q(`select t.id from public.teams t join public.clubs c on c.id = t.club_id where coalesce(t.is_active, true) and coalesce(c.is_active, true) order by t.id`)).map((r) => r.id);
  const clubOf = async (clubId) => (await q(`select id from public.teams where club_id = $1 and coalesce(is_active, true) order by id`, [clubId])).map((r) => r.id);
  return {
    platform, clubA: await clubOf(w.clubA), clubB: await clubOf(w.clubB), clubABeforeArchive: [w.A1, w.A2, w.A3],
    A1: [w.A1], A2: [w.A2], A3: [w.A3], B1: [w.B1], E: [w.E], all: [w.A1, w.A2, w.A3, w.B1, w.E], none: [],
    // A NULL element in the list, and no list at all (db review).
    withNull: [w.A1, null, w.A2], nullList: null,
  };
}
const parseIds = (text) => (text === "{}" ? [] : text.slice(1, -1).split(","));

test("1. the athletes' team ids: the new form equals the earlier one for every athlete, every day of the range and every viewer's team list, in the same order", async () => {
  const lists = await teamLists();
  let compared = 0;
  let nonEmpty = 0;
  for (const athleteId of w.athletes) {
    for (const [name, list] of Object.entries(lists)) {
      const rows = await q(
        `select d::date::text as day, ${OLD_athleteTeamIdsSql("a", 4, "d::date")}::text as old_ids, ${athleteTeamIdsSql("a", 4, "d::date")}::text as new_ids
           from public.athletes a, generate_series($1::date, $2::date, interval '1 day') d
          where a.id = $3`,
        [D0, D_LAST, athleteId, list],
      );
      assert.equal(rows.length, 14);
      for (const row of rows) {
        assert.equal(row.new_ids, row.old_ids, `athlete ${athleteId}, list ${name}, day ${row.day}`);
        compared += 1;
        if (row.new_ids !== "{}") nonEmpty += 1;
      }
    }
  }
  assert.equal(compared, w.athletes.length * Object.keys(lists).length * 14);
  assert.ok(nonEmpty > 100, `the comparison is not vacuous (${nonEmpty} non-empty of ${compared})`);
});

test("2. anchors: the cases the rule is about give what the rule says (with every team listed)", async () => {
  const all = (await teamLists()).all;
  const idsOn = async (athleteId, day) => parseIds((await q(`select ${athleteTeamIdsSql("a", 2, "$1::date")}::text as ids from public.athletes a where a.id = $3`, [day, all, athleteId]))[0].ids).sort();
  const sorted = (...ids) => ids.map(String).sort();
  // The mover: A1 through the leaving day, A2 from the joining day; both on MID.
  assert.deepEqual(await idsOn(w.mover, addDays(MID, -1)), sorted(w.A1));
  assert.deepEqual(await idsOn(w.mover, MID), sorted(w.A1, w.A2));
  assert.deepEqual(await idsOn(w.mover, addDays(MID, 1)), sorted(w.A2));
  // Archived before the range: no team.
  assert.deepEqual(await idsOn(w.archivedOnly, D0), []);
  // The fallback: before the first period in the club, the current team; with an earlier club period, none.
  assert.deepEqual(await idsOn(w.late, TODAY), sorted(w.A2));
  assert.deepEqual(await idsOn(w.lateWithClub, TODAY), []);
  assert.deepEqual(await idsOn(w.lateWithClub, addDays(TODAY, 3)), sorted(w.A1));
  // Two teams; paused counts.
  assert.deepEqual(await idsOn(w.twoTeams, TODAY), sorted(w.A1, w.A2));
  assert.deepEqual(await idsOn(w.paused, TODAY), sorted(w.A2));
  // D45: through the archive day, none after.
  assert.deepEqual(await idsOn(w.teamArchived, MID), sorted(w.A3));
  assert.deepEqual(await idsOn(w.teamArchived, addDays(MID, 1)), []);
  // The edges of a UTC day.
  assert.deepEqual(await idsOn(w.boundary, addDays(D0, 1)), []);
  assert.deepEqual(await idsOn(w.boundary, addDays(D0, 2)), sorted(w.A1));
  assert.deepEqual(await idsOn(w.boundary, addDays(D0, 6)), sorted(w.A1));
  assert.deepEqual(await idsOn(w.boundary, addDays(D0, 7)), []);
  // D43: the moved team, from its joining day (an earlier club period: no fallback).
  assert.deepEqual(await idsOn(w.movedMember, addDays(MID, -1)), []);
  assert.deepEqual(await idsOn(w.movedMember, MID), sorted(w.E));
  // Restored: through the first period's last day, none in the gap, the team again from the restore's day (read from the
  // database).
  assert.deepEqual(await idsOn(w.restored, addDays(D0, -3)), sorted(w.A1));
  assert.deepEqual(await idsOn(w.restored, addDays(w.restoredDay, -1)), []);
  assert.deepEqual(await idsOn(w.restored, w.restoredDay), sorted(w.A1));
  // A period of zero length covers its one day.
  assert.deepEqual(await idsOn(w.zeroLength, addDays(TODAY, 1)), []);
  assert.deepEqual(await idsOn(w.zeroLength, addDays(TODAY, 2)), sorted(w.A2));
  assert.deepEqual(await idsOn(w.zeroLength, addDays(TODAY, 3)), []);
  // The fallback looks at the period's own club only: an earlier period in club B does not stop it in club A (BM17).
  assert.deepEqual(await idsOn(w.crossClub, TODAY), sorted(w.A2));
  // A closed period never takes the fallback (BM16): none before joining, the team while a member, none after.
  assert.deepEqual(await idsOn(w.leftLater, TODAY), []);
  assert.deepEqual(await idsOn(w.leftLater, addDays(TODAY, 3)), sorted(w.A1));
  assert.deepEqual(await idsOn(w.leftLater, addDays(TODAY, 5)), []);
  // The day of the first period in the club counts as "on or before" (RM1): both before it by the fallback, only A1 on
  // A1's joining day, both again once A2 starts.
  assert.deepEqual(await idsOn(w.firstPeriodDay, TODAY), sorted(w.A1, w.A2));
  assert.deepEqual(await idsOn(w.firstPeriodDay, addDays(TODAY, 3)), sorted(w.A1));
  assert.deepEqual(await idsOn(w.firstPeriodDay, addDays(TODAY, 5)), sorted(w.A1, w.A2));
});

test("3. THE membership rule after the refactor equals its earlier text, for every athlete, team and club, single days and windows; and a window is the union of its days", async () => {
  const conds = [
    ...[w.A1, w.A2, w.A3, w.B1, w.E].map((id) => ({ id, cond: (m) => `(${m}.membership_type = 'team' and ${m}.team_id = $4)` })),
    ...[w.clubA, w.clubB].map((id) => ({ id, cond: (m) => `(${m}.membership_type = 'club' and ${m}.club_id = $4)` })),
  ];
  let windows = 0;
  let trues = 0;
  for (const athleteId of w.athletes) {
    for (const { id, cond } of conds) {
      const rows = await q(
        `select d1::date::text as d1, d2::date::text as d2,
                ${OLD_membershipOnDaySql("a.id", cond, "d1::date", "d2::date")} as old_wide,
                ${membershipOnDaySql("a.id", cond, "d1::date", "d2::date")} as new_wide,
                (select coalesce(bool_or(${membershipOnDaySql("a.id", cond, "dd::date")}), false)
                   from generate_series(d1, d2, interval '1 day') dd) as union_days
           from public.athletes a,
                generate_series($1::date, $2::date, interval '1 day') d1,
                lateral generate_series(d1, least(d1 + interval '4 days', $2::date), interval '1 day') d2
          where a.id = $3`,
        [D0, D_LAST, athleteId, id],
      );
      for (const row of rows) {
        assert.equal(row.new_wide, row.old_wide, `old and new rule, athlete ${athleteId}, ${id}, ${row.d1}..${row.d2}`);
        assert.equal(row.new_wide, row.union_days, `a window is the union of its days, athlete ${athleteId}, ${id}, ${row.d1}..${row.d2}`);
        windows += 1;
        if (row.new_wide) trues += 1;
      }
    }
  }
  assert.ok(windows > 1000 && trues > 100, `not vacuous (${trues} true of ${windows})`);
});
