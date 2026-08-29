import { Router } from "express";
import { pool, query } from "../db.js";
import { resolveActiveWorkspace } from "../workspace.js";

const router = Router();

// Training load (RPE/sRPE). One RPE/sRPE submission always belongs to
// exactly one plans.plan_sessions row inside an athlete's ACTIVE
// (published, not draft/edit-draft) Weekly plan - never a bare WELLNESS-
// style schedule of its own. See migrations_v2/
// 202608310900_training_load_v1_session_feedback.sql and
// 202608320900_training_load_v2_logical_session_identity.sql for the full
// data model.
//
// Deliberately NOT built on plans.v_weekly_plan_items (the view the
// existing Calendar/Home reads already use): that view is per plan_ITEM
// (one row per exercise, plus a synthetic row for an empty leaf node) -
// exactly what "one session = one RPE entry" is not. A plan_session with
// zero items yet would never appear in it at all, silently hiding it from
// RPE. Every query below joins plans.plan_sessions -> plan_days -> plans
// directly instead, applying the exact same "is this weekly plan actually
// published" predicate that view already encodes (plan_type = 'weekly',
// status = 'active', coalesce(is_active, true), not coalesce(is_edit_draft,
// false)) - kept in one place, WEEKLY_PLAN_SESSION_FILTER_SQL below.
//
// Correction round 2 (logical session identity): a saved result is looked
// up/deduplicated by plans.plan_sessions.logical_session_id, NEVER by the
// row id (plan_sessions.id) alone - builder.js's applyEditDraft() deletes
// and recreates a weekly plan's entire session tree on every "Save and
// finish", so the row id is not stable across an edit even when the
// logical training session is unchanged. See copyDaySessions' own comment
// in builder.js for exactly which copy paths carry logical_session_id
// forward and which mint a fresh one.

const WEEKLY_PLAN_SESSION_FILTER_SQL = `
  p.plan_type = 'weekly'
  and p.status = 'active'
  and coalesce(p.is_active, true)
  and not coalesce(p.is_edit_draft, false)
`;

function requireAthlete(req, res) {
  if (!req.authz?.isAthlete || !req.authz.athleteId) {
    res.status(403).json({ error: "This account has no athlete profile." });
    return null;
  }
  return req.authz.athleteId;
}

function requireCoachWorkspace(req, res) {
  if (!req.authz?.capabilities?.coachWorkspace) {
    res.status(403).json({ error: "Forbidden" });
    return false;
  }
  return true;
}

const DATE_STRING_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Same round-trip-through-Date.UTC validation as tests.js's own
// isValidGregorianDateString (backend/src/routes/tests.js) - duplicated
// rather than imported, matching that file's own convention of keeping
// small, self-contained validators local to each route module.
function isValidGregorianDateString(value) {
  const match = DATE_STRING_PATTERN.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function addDaysIso(iso, days) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// Correction: validates every id is a real UUID before it ever reaches a
// ::uuid[] cast - a malformed id used to surface as a raw Postgres 500
// ("invalid input syntax for type uuid"), never a controlled 400.
// Returns { ids, invalid } - `invalid` true means the caller must 400
// immediately, ids is null when the param was absent (never filtered).
function parseUuidListParam(raw) {
  if (!raw) return { ids: null, invalid: false };
  const ids = String(raw).split(",").map((s) => s.trim()).filter(Boolean);
  if (!ids.length) return { ids: null, invalid: false };
  if (ids.some((id) => !UUID_PATTERN.test(id))) return { ids: null, invalid: true };
  return { ids, invalid: false };
}

function formatFeedback(row) {
  if (row.feedback_id == null && row.rpe == null) return null;
  return {
    rpe: row.rpe,
    durationMinutes: row.duration_minutes,
    srpe: row.srpe,
    note: row.athlete_note || "",
    submittedAt: row.submitted_at,
  };
}

// Athlete's own "today", from their effective device timezone with a UTC
// fallback - the same public.athletes.device_timezone column and reporting
// mechanism the Tests module already established (POST /api/tests/athlete/
// timezone, reported eagerly on every athlete app boot - see frontend/
// tests-data.js's reportDeviceTimezone). Never a bare server current_date.
// There is no per-schedule timezone concept in the weekly-plan domain to
// fall back to (unlike Tests' schedule.timezone fallback), so the ultimate
// fallback here is UTC. `executor` defaults to the plain pool-backed
// `query` but accepts a transaction client too (see POST /sessions/:id/rpe
// below, which must read this WITHIN its own locked transaction).
async function athleteLocalDate(athleteId, executor = query) {
  const result = await executor(
    `select (now() at time zone coalesce(device_timezone, 'UTC'))::date as local_date
     from public.athletes where id = $1`,
    [athleteId],
  );
  return result.rows[0]?.local_date || null;
}

// ------------------------------------------------------------
// Athlete
// ------------------------------------------------------------

router.get("/athlete/today", async (req, res, next) => {
  try {
    const athleteId = requireAthlete(req, res);
    if (!athleteId) return;
    const localToday = await athleteLocalDate(athleteId);
    if (!localToday) return res.status(404).json({ error: "Athlete profile not found." });

    const sessionsResult = await query(
      `select ps.id as session_id, ps.name as session_name, ps.am_pm, ps.bta, ps.session_time,
              sf.id as feedback_id, sf.rpe, sf.duration_minutes, sf.srpe, sf.athlete_note, sf.submitted_at
       from plans.plan_sessions ps
       join plans.plan_days pd on pd.id = ps.plan_day_id
       join plans.plans p on p.id = pd.plan_id
       left join training_load.session_feedback sf on sf.logical_session_id = ps.logical_session_id and sf.athlete_id = p.athlete_id
       where ${WEEKLY_PLAN_SESSION_FILTER_SQL}
         and p.athlete_id = $1
         and pd.date = $2::date
       order by ps.session_order`,
      [athleteId, localToday],
    );

    res.json({
      date: localToday,
      sessions: sessionsResult.rows.map((row) => ({
        sessionId: row.session_id,
        sessionName: row.session_name || "",
        amPm: row.am_pm || "",
        bta: row.bta || "",
        sessionTime: row.session_time || "",
        rated: row.feedback_id != null,
        feedback: formatFeedback(row),
      })),
    });
  } catch (error) {
    next(error);
  }
});

// Client sends ONLY rpe/durationMinutes/note - sRPE is always DB-derived
// (training_load.session_feedback.srpe is a GENERATED ALWAYS AS STORED
// column), a client-supplied sRPE is never read or trusted.
//
// Correction (transaction/race safety): the session lookup, the future-
// date check, and the insert now all run inside ONE transaction, with the
// session row locked (`for update of ps`) from the very first read. A
// concurrent Builder edit/delete that touches this exact session (a coach
// clicking "Save and finish", or deleting the day/session outright) must
// now wait behind this lock rather than racing it - it can never delete
// the row out from under an in-flight INSERT (which used to be able to
// produce a foreign-key violation surfaced as a raw 500) or leave a
// feedback row pointing at a configuration that was never actually live.
// If the lock wait ends because the row is gone (Builder's delete went
// first and committed), the re-read after the lock simply finds nothing
// and this responds with the same controlled 404 as any other not-found
// session - never a 500.
router.post("/sessions/:sessionId/rpe", async (req, res, next) => {
  let client;
  try {
    const athleteId = requireAthlete(req, res);
    if (!athleteId) return;
    const sessionId = req.params.sessionId;
    // A malformed id (not a real UUID) can never match a real session -
    // reject it BEFORE it ever reaches a `ps.id = $1` comparison, or
    // Postgres itself rejects the query with a raw 22P02 type-mismatch
    // error (a 500, and a distinguishable response from the info-hiding
    // 404 every other not-found/not-yours/not-actionable case below uses).
    if (!UUID_PATTERN.test(sessionId)) {
      return res.status(404).json({ error: "Training session not found." });
    }

    // Correction: only a real JSON integer number is ever accepted -
    // Number(null) === 0 and Number("") === 0 used to let a missing/null
    // rpe silently pass as a false "RPE 0". typeof must be "number" before
    // any numeric validation even runs.
    const rpeRaw = req.body?.rpe;
    const durationRaw = req.body?.durationMinutes;
    if (typeof rpeRaw !== "number" || !Number.isInteger(rpeRaw) || rpeRaw < 0 || rpeRaw > 10) {
      return res.status(400).json({ error: "RPE must be a whole number from 0 to 10." });
    }
    if (typeof durationRaw !== "number" || !Number.isInteger(durationRaw) || durationRaw < 1 || durationRaw > 600) {
      return res.status(400).json({ error: "Duration must be a whole number of minutes, from 1 to 600." });
    }
    const rpe = rpeRaw;
    const durationMinutes = durationRaw;
    const note = typeof req.body?.note === "string" ? req.body.note.trim() : "";
    if (note.length > 500) {
      return res.status(400).json({ error: "Note is too long (500 characters max)." });
    }

    client = await pool.connect();
    await client.query("begin");

    const sessionResult = await client.query(
      `select ps.id as session_id, ps.logical_session_id, ps.name as session_name, ps.am_pm, ps.bta, ps.session_time,
              pd.date as session_date, p.id as plan_id, p.name as plan_name, p.week_start, p.athlete_id,
              p.plan_type, p.status, p.is_active, p.is_edit_draft,
              exists (
                select 1 from plans.plans ld
                where ld.edit_source_plan_id = p.id and ld.is_edit_draft and ld.legacy_pre_migration_draft
              ) as has_pending_legacy_draft
       from plans.plan_sessions ps
       join plans.plan_days pd on pd.id = ps.plan_day_id
       join plans.plans p on p.id = pd.plan_id
       where ps.id = $1
       for update of ps`,
      [sessionId],
    );
    const session = sessionResult.rows[0];
    const actionable = session
      && session.plan_type === "weekly"
      && session.status === "active"
      && (session.is_active === null || session.is_active === undefined || session.is_active === true)
      && !session.is_edit_draft;
    // Same 404, whether the session doesn't exist, belongs to a draft/
    // inactive plan, belongs to a DIFFERENT athlete (IDOR - "sportista ne
    // sme poslati rezultat za tuđu sesiju"), or was deleted by a
    // concurrent Builder edit while this request was waiting on the lock
    // above - never distinguishable from the outside, so a probing
    // request learns nothing either way.
    if (!actionable || session.athlete_id !== athleteId) {
      await client.query("rollback");
      return res.status(404).json({ error: "Training session not found." });
    }

    // Legacy pre-migration edit-draft policy (see migrations_v2/
    // 202608320900_training_load_v2_logical_session_identity.sql's own
    // comment): a draft that already existed at migration time was never
    // proven to share this live session's identity - there is no safe way
    // to know without guessing. Block new submissions against this live
    // plan until the coach saves or discards that draft; both paths
    // delete the draft row (and its marker with it) through the existing
    // Builder flow, at which point this check simply stops firing.
    if (session.has_pending_legacy_draft) {
      await client.query("rollback");
      return res.status(409).json({ error: "This plan has a pending update from before a recent system upgrade. Ask your coach to finish or discard it, then try again." });
    }

    const localToday = await athleteLocalDate(athleteId, (sql, params) => client.query(sql, params));
    if (localToday && session.session_date > localToday) {
      await client.query("rollback");
      return res.status(400).json({ error: "This session hasn't happened yet - you can rate it once its day arrives." });
    }

    // ON CONFLICT DO NOTHING (against the logical_session_id unique
    // constraint) instead of a try/catch on a raw unique_violation - both
    // work, but this stays entirely inside the one open transaction/lock
    // rather than needing a second round trip after an aborted statement.
    const insertResult = await client.query(
      `insert into training_load.session_feedback
         (athlete_id, plan_session_id, logical_session_id, session_date, plan_name, plan_week_start, session_name, session_time, session_am_pm, session_bta, rpe, duration_minutes, athlete_note)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       on conflict (athlete_id, logical_session_id) do nothing
       returning id, rpe, duration_minutes, srpe, athlete_note, submitted_at`,
      [athleteId, session.session_id, session.logical_session_id, session.session_date, session.plan_name, session.week_start, session.session_name, session.session_time, session.am_pm, session.bta, rpe, durationMinutes, note || null],
    );

    if (insertResult.rows.length) {
      await client.query("commit");
      return res.status(201).json({ feedback: formatFeedback({ feedback_id: insertResult.rows[0].id, ...insertResult.rows[0] }) });
    }

    // Conflict: a row for this (athlete, logical_session_id) already
    // exists - read it back WITHIN this same transaction/lock (so it
    // reflects the committed reality, never a stale read from before the
    // lock) and decide idempotent-200 vs genuine-409. An exact retry
    // (identical rpe/duration/note) is a silent no-op; anything else is
    // rejected - a second, genuinely different submission must never
    // quietly overwrite the original.
    const existingResult = await client.query(
      `select id, rpe, duration_minutes, srpe, athlete_note, submitted_at
       from training_load.session_feedback where athlete_id = $1 and logical_session_id = $2`,
      [athleteId, session.logical_session_id],
    );
    const existing = existingResult.rows[0];
    const identical = existing && existing.rpe === rpe && existing.duration_minutes === durationMinutes && (existing.athlete_note || "") === (note || "");
    await client.query("commit");
    if (identical) return res.status(200).json({ feedback: formatFeedback({ feedback_id: existing.id, ...existing }) });
    return res.status(409).json({ error: "This session already has a submitted result." });
  } catch (error) {
    if (client) {
      try { await client.query("rollback"); } catch {}
    }
    next(error);
  } finally {
    if (client) client.release();
  }
});

// ------------------------------------------------------------
// Coach workspace scoping - correction: the previous version branched
// purely on req.authz.isAthlete (a permission fact: "does this account
// have an athlete profile at all"), which is wrong for a multi-role
// account (e.g. a club_admin who is ALSO an athlete) - it silently
// dropped them into the athlete branch regardless of which workspace they
// are actually presenting as in the coach shell. The real signal is the
// CURRENT active workspace (resolveActiveWorkspace, workspace.js - the
// same source of truth GET /api/organization already scopes by), never a
// bare permission check. Mirrors filterOrganizationDataForWorkspace's own
// per-type scoping in organization.js, expressed as a SQL predicate here
// instead of a JS array filter:
//   - platform: no restriction.
//   - club: athletes with an ACTIVE club membership in this workspace's
//     own club.
//   - team: athletes with an ACTIVE team membership in this workspace's
//     own team.
//   - private_coach: athletes with a real, active public.user_athletes
//     tie to THIS account specifically - never via an unrelated club/team
//     role the same account might separately hold.
//   - athlete (or no workspace at all): a coach request must never reach
//     this branch presenting as an athlete's own workspace - "and false"
//     so it can never leak club/team/private-coach data.
// ------------------------------------------------------------
async function coachWorkspaceScopeSql(req, alias, startIndex) {
  const { workspace } = await resolveActiveWorkspace(req.user.id, req.authz);
  if (!workspace) return { sql: "and false", params: [] };
  if (workspace.type === "platform") return { sql: "", params: [] };
  if (workspace.type === "club") {
    return {
      sql: `and exists (select 1 from public.athlete_memberships am where am.athlete_id = ${alias}.id and am.membership_type = 'club' and am.status = 'active' and am.club_id = $${startIndex})`,
      params: [workspace.scopeId],
    };
  }
  if (workspace.type === "team") {
    return {
      sql: `and exists (select 1 from public.athlete_memberships am where am.athlete_id = ${alias}.id and am.membership_type = 'team' and am.status = 'active' and am.team_id = $${startIndex})`,
      params: [workspace.scopeId],
    };
  }
  if (workspace.type === "private_coach") {
    return {
      sql: `and exists (select 1 from public.user_athletes ua where ua.athlete_id = ${alias}.id and ua.user_id = $${startIndex} and ua.is_active = true)`,
      params: [req.user.id],
    };
  }
  return { sql: "and false", params: [] };
}

// ------------------------------------------------------------
// Shared weekly projection - Coach Today/Schedule/Results tabs AND the
// athlete's own Weekly plan view all read this one endpoint. Purely
// read-only: no materialization, no write, of any kind - browsing a week
// (past, present, or future) can never create or alter a training session
// or a feedback row.
//
// Dual-scoped by caller: an athlete account whose CURRENT active
// workspace is "athlete" is always scoped to their own athlete_id (never
// a client-supplied one - same rule as every other athlete-facing
// endpoint here) and the clubIds/teamIds/athleteIds filter params are
// ignored for them; every other (coach) workspace is scoped by
// coachWorkspaceScopeSql above, further narrowed by an optional Club/
// Team/Athletes filter - see athleteextraFilterSql below for why that
// filter is a UNION across kinds, not an AND.
// ------------------------------------------------------------

// Correction (filter semantics): the picker is explicitly "Any mix of
// clubs, teams and individual athletes" - within one kind, any selected
// id (already true via `= any(...)`); ACROSS kinds, a union (club OR team
// OR direct athlete), never an AND (which would routinely match nothing -
// "athletes who are both in this club AND specifically this one person").
// The whole union still sits inside the mandatory workspace scope (ANDed
// with it), never instead of it - a coach can never widen their own
// current-workspace scope via this filter, only narrow it.
function athleteExtraFilterSql(alias, clubIds, teamIds, athleteIds, params) {
  const conditions = [];
  if (clubIds) {
    params.push(clubIds);
    conditions.push(`exists (select 1 from public.athlete_memberships am where am.athlete_id = ${alias}.id and am.membership_type = 'club' and am.status = 'active' and am.club_id = any($${params.length}::uuid[]))`);
  }
  if (teamIds) {
    params.push(teamIds);
    conditions.push(`exists (select 1 from public.athlete_memberships am where am.athlete_id = ${alias}.id and am.membership_type = 'team' and am.status = 'active' and am.team_id = any($${params.length}::uuid[]))`);
  }
  if (athleteIds) {
    params.push(athleteIds);
    conditions.push(`${alias}.id = any($${params.length}::uuid[])`);
  }
  return conditions.length ? ` and (${conditions.join(" or ")})` : "";
}

router.get("/weekly", async (req, res, next) => {
  try {
    const weekStart = String(req.query?.weekStart || "");
    if (!isValidGregorianDateString(weekStart)) return res.status(400).json({ error: "weekStart must be a valid YYYY-MM-DD date." });
    const weekEnd = addDaysIso(weekStart, 6);

    const clubFilter = parseUuidListParam(req.query.clubIds);
    const teamFilter = parseUuidListParam(req.query.teamIds);
    const athleteFilter = parseUuidListParam(req.query.athleteIds);
    if (clubFilter.invalid || teamFilter.invalid || athleteFilter.invalid) {
      return res.status(400).json({ error: "clubIds/teamIds/athleteIds must be valid UUIDs." });
    }

    // Two variants of the same scope predicate: scopeSqlLive references the
    // live-session query's own `p`/`a` aliases (plans/athletes), scopeSqlSf
    // references the historical-feedback query's `sf`/`a` aliases (session_
    // feedback/athletes) below - see that query's own comment for why a
    // second query exists at all. Both variants share the exact same
    // `params` array and `a` (public.athletes) alias, so the filter
    // fragment is appended identically to both.
    let scopeSqlLive = "";
    let scopeSqlSf = "";
    let params = [weekStart, weekEnd];

    const { workspace } = await resolveActiveWorkspace(req.user.id, req.authz);
    if (workspace?.type === "athlete") {
      if (!req.authz.athleteId) return res.status(403).json({ error: "This account has no athlete profile." });
      params.push(req.authz.athleteId);
      scopeSqlLive = `and p.athlete_id = $${params.length}`;
      scopeSqlSf = `and sf.athlete_id = $${params.length}`;
    } else {
      if (!requireCoachWorkspace(req, res)) return;
      const scope = await coachWorkspaceScopeSql(req, "a", 3);
      scopeSqlLive = scope.sql;
      scopeSqlSf = scope.sql;
      params = params.concat(scope.params);

      const extraFragment = athleteExtraFilterSql("a", clubFilter.ids, teamFilter.ids, athleteFilter.ids, params);
      scopeSqlLive += extraFragment;
      scopeSqlSf += extraFragment;
    }

    const liveResult = await query(
      `select ps.id as session_id, ps.logical_session_id, ps.name as session_name, ps.am_pm, ps.bta, ps.session_time,
              pd.date as session_date, p.id as plan_id, p.name as plan_name,
              a.id as athlete_id, coalesce(a.display_name, a.full_name, concat_ws(' ', a.first_name, a.last_name), a.athlete_id) as athlete_name,
              sf.id as feedback_id, sf.rpe, sf.duration_minutes, sf.srpe, sf.athlete_note, sf.submitted_at
       from plans.plan_sessions ps
       join plans.plan_days pd on pd.id = ps.plan_day_id
       join plans.plans p on p.id = pd.plan_id
       join public.athletes a on a.id = p.athlete_id
       left join training_load.session_feedback sf on sf.logical_session_id = ps.logical_session_id and sf.athlete_id = p.athlete_id
       where ${WEEKLY_PLAN_SESSION_FILTER_SQL}
         and pd.date between $1::date and $2::date
         ${scopeSqlLive}
       order by pd.date, athlete_name, a.id, ps.session_order`,
      params,
    );

    // A submitted result whose logical_session_id no longer matches ANY
    // currently-live, actionable plan_session (the original row was
    // deleted by Builder and never recreated with the same
    // logical_session_id) can never be reached through the query above at
    // all - it starts from plans.plan_sessions, which has no matching row.
    // Results must still show it (the whole point of snapshotting
    // session_date/plan_name/session_name/etc onto the feedback row
    // itself), so it's picked up here as its own historical entry - never
    // click-through-able to a live session (there isn't one).
    //
    // Correction: this is now keyed on logical_session_id via NOT EXISTS
    // against the live/actionable session set, not a bare
    // "plan_session_id is null" check - a result that survived an edit-
    // draft round trip (plan_session_id nulled by the OLD row's deletion,
    // but a NEW live row now carries the SAME logical_session_id) is
    // already correctly picked up as `rated` by the live query above via
    // that logical_session_id join, and must NOT also be returned here as
    // a second, duplicate entry (which would double the athlete's sRPE in
    // every aggregate).
    const orphanedResult = await query(
      `select sf.id as feedback_id, sf.session_date, sf.plan_name, sf.session_name, sf.session_am_pm as am_pm, sf.session_bta as bta, sf.session_time,
              sf.athlete_id, coalesce(a.display_name, a.full_name, concat_ws(' ', a.first_name, a.last_name), a.athlete_id) as athlete_name,
              sf.rpe, sf.duration_minutes, sf.srpe, sf.athlete_note, sf.submitted_at
       from training_load.session_feedback sf
       join public.athletes a on a.id = sf.athlete_id
       where sf.session_date between $1::date and $2::date
         ${scopeSqlSf}
         and not exists (
           select 1
           from plans.plan_sessions ps2
           join plans.plan_days pd2 on pd2.id = ps2.plan_day_id
           join plans.plans p2 on p2.id = pd2.plan_id
           where ps2.logical_session_id = sf.logical_session_id
             and ${WEEKLY_PLAN_SESSION_FILTER_SQL.replace(/\bp\./g, "p2.")}
         )`,
      params,
    );

    const days = [];
    for (let i = 0; i < 7; i += 1) days.push({ date: addDaysIso(weekStart, i), sessions: [] });
    const byDate = new Map(days.map((day) => [day.date, day]));
    for (const row of liveResult.rows) {
      const bucket = byDate.get(row.session_date);
      if (!bucket) continue;
      bucket.sessions.push({
        sessionId: row.session_id,
        sessionName: row.session_name || "",
        amPm: row.am_pm || "",
        bta: row.bta || "",
        sessionTime: row.session_time || "",
        planId: row.plan_id,
        planName: row.plan_name,
        athleteId: row.athlete_id,
        athleteName: row.athlete_name,
        rated: row.feedback_id != null,
        feedback: formatFeedback(row),
        historical: false,
      });
    }
    for (const row of orphanedResult.rows) {
      const bucket = byDate.get(row.session_date);
      if (!bucket) continue;
      bucket.sessions.push({
        sessionId: null,
        sessionName: row.session_name || "",
        amPm: row.am_pm || "",
        bta: row.bta || "",
        sessionTime: row.session_time || "",
        planId: null,
        planName: row.plan_name,
        athleteId: row.athlete_id,
        athleteName: row.athlete_name,
        rated: true,
        feedback: formatFeedback(row),
        historical: true,
      });
    }

    res.json({ weekStart, weekEnd, days });
  } catch (error) {
    next(error);
  }
});

export default router;
