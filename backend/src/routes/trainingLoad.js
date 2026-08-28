import { Router } from "express";
import { query } from "../db.js";
import { athleteListAccessFilter } from "../access.js";

const router = Router();

// Training load (RPE/sRPE), first complete phase. One RPE/sRPE submission
// always belongs to exactly one plans.plan_sessions row inside an athlete's
// ACTIVE (published, not draft/edit-draft) Weekly plan - never a bare
// WELLNESS-style schedule of its own. See migrations_v2/
// 202608310900_training_load_v1_session_feedback.sql for the full data
// model and why every session-identifying column on a saved result is an
// immutable snapshot rather than a live join.
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

function parseIdListParam(raw) {
  if (!raw) return null;
  const ids = String(raw).split(",").map((s) => s.trim()).filter(Boolean);
  return ids.length ? ids : null;
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
// fallback here is UTC.
async function athleteLocalDate(athleteId) {
  const result = await query(
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
       left join training_load.session_feedback sf on sf.plan_session_id = ps.id
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
router.post("/sessions/:sessionId/rpe", async (req, res, next) => {
  try {
    const athleteId = requireAthlete(req, res);
    if (!athleteId) return;
    const sessionId = req.params.sessionId;

    const rpe = Number(req.body?.rpe);
    const durationMinutes = Number(req.body?.durationMinutes);
    const note = typeof req.body?.note === "string" ? req.body.note.trim() : "";
    if (!Number.isInteger(rpe) || rpe < 0 || rpe > 10) {
      return res.status(400).json({ error: "RPE must be a whole number from 0 to 10." });
    }
    if (!Number.isInteger(durationMinutes) || durationMinutes < 1 || durationMinutes > 600) {
      return res.status(400).json({ error: "Duration must be a whole number of minutes, from 1 to 600." });
    }
    if (note.length > 500) {
      return res.status(400).json({ error: "Note is too long (500 characters max)." });
    }

    const sessionResult = await query(
      `select ps.id as session_id, ps.name as session_name, ps.am_pm, ps.bta, ps.session_time,
              pd.date as session_date, p.name as plan_name, p.week_start, p.athlete_id,
              p.plan_type, p.status, p.is_active, p.is_edit_draft
       from plans.plan_sessions ps
       join plans.plan_days pd on pd.id = ps.plan_day_id
       join plans.plans p on p.id = pd.plan_id
       where ps.id = $1`,
      [sessionId],
    );
    const session = sessionResult.rows[0];
    const actionable = session
      && session.plan_type === "weekly"
      && session.status === "active"
      && (session.is_active === null || session.is_active === undefined || session.is_active === true)
      && !session.is_edit_draft;
    // Same 404, whether the session doesn't exist, belongs to a draft/
    // inactive plan, or belongs to a DIFFERENT athlete (IDOR - "sportista
    // ne sme poslati rezultat za tuđu sesiju") - never distinguishable
    // from the outside, so a probing request learns nothing either way.
    if (!actionable || session.athlete_id !== athleteId) {
      return res.status(404).json({ error: "Training session not found." });
    }

    const localToday = await athleteLocalDate(athleteId);
    if (localToday && session.session_date > localToday) {
      return res.status(400).json({ error: "This session hasn't happened yet - you can rate it once its day arrives." });
    }

    try {
      const insertResult = await query(
        `insert into training_load.session_feedback
           (athlete_id, plan_session_id, session_date, plan_name, plan_week_start, session_name, session_time, session_am_pm, session_bta, rpe, duration_minutes, athlete_note)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         returning id, rpe, duration_minutes, srpe, athlete_note, submitted_at`,
        [athleteId, session.session_id, session.session_date, session.plan_name, session.week_start, session.session_name, session.session_time, session.am_pm, session.bta, rpe, durationMinutes, note || null],
      );
      return res.status(201).json({ feedback: formatFeedback({ feedback_id: insertResult.rows[0].id, ...insertResult.rows[0] }) });
    } catch (error) {
      // 23505 = unique_violation, from unique (athlete_id, plan_session_id)
      // - see the migration's own header comment for the full reasoning.
      // An exact retry (identical rpe/duration/note) is a silent 200
      // idempotent no-op; anything else is a 409 - a second, genuinely
      // different submission must never quietly overwrite the original.
      if (error.code === "23505") {
        const existingResult = await query(
          `select id, rpe, duration_minutes, srpe, athlete_note, submitted_at
           from training_load.session_feedback where athlete_id = $1 and plan_session_id = $2`,
          [athleteId, session.session_id],
        );
        const existing = existingResult.rows[0];
        const identical = existing && existing.rpe === rpe && existing.duration_minutes === durationMinutes && (existing.athlete_note || "") === (note || "");
        if (identical) return res.status(200).json({ feedback: formatFeedback({ feedback_id: existing.id, ...existing }) });
        return res.status(409).json({ error: "This session already has a submitted result." });
      }
      throw error;
    }
  } catch (error) {
    next(error);
  }
});

// ------------------------------------------------------------
// Shared weekly projection - Coach Today/Schedule/Results tabs AND the
// athlete's own Weekly plan view all read this one endpoint. Purely
// read-only: no materialization, no write, of any kind - browsing a week
// (past, present, or future) can never create or alter a training session
// or a feedback row.
//
// Dual-scoped by caller: an athlete account is always scoped to their own
// athlete_id (never a client-supplied one - same rule as every other
// athlete-facing endpoint here) and the clubIds/teamIds/athleteIds filter
// params are ignored for them; a coach account is scoped by
// athleteListAccessFilter (the exact same "which athletes can I see in my
// current workspace" predicate backend/src/routes/athletes.js already
// uses), further narrowed by an optional Club/Team/Athletes filter.
// ------------------------------------------------------------

router.get("/weekly", async (req, res, next) => {
  try {
    const weekStart = String(req.query?.weekStart || "");
    if (!isValidGregorianDateString(weekStart)) return res.status(400).json({ error: "weekStart must be a valid YYYY-MM-DD date." });
    const weekEnd = addDaysIso(weekStart, 6);

    // Two variants of the same scope predicate: scopeSqlLive references the
    // live-session query's own `p`/`a` aliases (plans/athletes), scopeSqlSf
    // references the orphaned-feedback query's `sf`/`a` aliases (session_
    // feedback/athletes) below - see that query's own comment for why a
    // second query exists at all. Both variants share the exact same
    // `params` array and `a` (public.athletes) alias, so the club/team/
    // athlete filter fragments are appended identically to both.
    let scopeSqlLive = "";
    let scopeSqlSf = "";
    let params = [weekStart, weekEnd];

    if (req.authz?.isAthlete && req.authz.athleteId) {
      params.push(req.authz.athleteId);
      scopeSqlLive = `and p.athlete_id = $${params.length}`;
      scopeSqlSf = `and sf.athlete_id = $${params.length}`;
    } else {
      if (!requireCoachWorkspace(req, res)) return;
      const accessFilter = athleteListAccessFilter(req, "a", 3);
      scopeSqlLive = accessFilter.sql;
      scopeSqlSf = accessFilter.sql;
      params = params.concat(accessFilter.params);

      const clubIds = parseIdListParam(req.query.clubIds);
      const teamIds = parseIdListParam(req.query.teamIds);
      const athleteIds = parseIdListParam(req.query.athleteIds);
      if (clubIds) {
        params.push(clubIds);
        const fragment = ` and exists (select 1 from public.athlete_memberships am where am.athlete_id = a.id and am.membership_type = 'club' and am.status = 'active' and am.club_id = any($${params.length}::uuid[]))`;
        scopeSqlLive += fragment;
        scopeSqlSf += fragment;
      }
      if (teamIds) {
        params.push(teamIds);
        const fragment = ` and exists (select 1 from public.athlete_memberships am where am.athlete_id = a.id and am.membership_type = 'team' and am.status = 'active' and am.team_id = any($${params.length}::uuid[]))`;
        scopeSqlLive += fragment;
        scopeSqlSf += fragment;
      }
      if (athleteIds) {
        params.push(athleteIds);
        const fragment = ` and a.id = any($${params.length}::uuid[])`;
        scopeSqlLive += fragment;
        scopeSqlSf += fragment;
      }
    }

    const liveResult = await query(
      `select ps.id as session_id, ps.name as session_name, ps.am_pm, ps.bta, ps.session_time,
              pd.date as session_date, p.id as plan_id, p.name as plan_name,
              a.id as athlete_id, coalesce(a.display_name, a.full_name, concat_ws(' ', a.first_name, a.last_name), a.athlete_id) as athlete_name,
              sf.id as feedback_id, sf.rpe, sf.duration_minutes, sf.srpe, sf.athlete_note, sf.submitted_at
       from plans.plan_sessions ps
       join plans.plan_days pd on pd.id = ps.plan_day_id
       join plans.plans p on p.id = pd.plan_id
       join public.athletes a on a.id = p.athlete_id
       left join training_load.session_feedback sf on sf.plan_session_id = ps.id
       where ${WEEKLY_PLAN_SESSION_FILTER_SQL}
         and pd.date between $1::date and $2::date
         ${scopeSqlLive}
       order by pd.date, athlete_name, a.id, ps.session_order`,
      params,
    );

    // A submitted result whose original plan_session was since deleted
    // (plan_session_id nulled by the FK's own "on delete set null" -
    // typically a coach editing-and-re-finishing the weekly plan, see the
    // migration's header comment) can never be reached through the query
    // above at all - it starts from plans.plan_sessions, which no longer
    // has a matching row. Results must still show it (the whole point of
    // snapshotting session_date/plan_name/session_name/etc onto the
    // feedback row itself), so it's picked up here as its own historical
    // entry - never click-through-able to a live session (there isn't
    // one), always rated (a feedback row is the only way this exists).
    const orphanedResult = await query(
      `select sf.id as feedback_id, sf.session_date, sf.plan_name, sf.session_name, sf.session_am_pm as am_pm, sf.session_bta as bta, sf.session_time,
              sf.athlete_id, coalesce(a.display_name, a.full_name, concat_ws(' ', a.first_name, a.last_name), a.athlete_id) as athlete_name,
              sf.rpe, sf.duration_minutes, sf.srpe, sf.athlete_note, sf.submitted_at
       from training_load.session_feedback sf
       join public.athletes a on a.id = sf.athlete_id
       where sf.plan_session_id is null
         and sf.session_date between $1::date and $2::date
         ${scopeSqlSf}`,
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
