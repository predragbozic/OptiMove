import crypto from "node:crypto";
import { Router } from "express";
import { pool, query } from "../db.js";
import { resolveActiveWorkspace } from "../workspace.js";
import { canAccessAthlete } from "../access.js";
import { canManageClub, canManageTeamById, isPlatformAdministrator } from "../authz.js";
import { canManageExternalSchedule, manageableClubIds, manageableTeamIds, resolveExternalScheduleOwnerContext } from "../trainingLoadAccess.js";
import { ensureCurrentExternalOccurrence, ensureCurrentExternalOccurrencesForAthlete, ensureCurrentExternalOccurrencesForCoach } from "../trainingLoadOccurrenceService.js";
import { emitRealtimeEvent } from "../realtime.js";

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

    // On-demand generation right before reading - mirrors WELLNESS's own
    // "ensureCurrentOccurrence, called from the view that needs it" trigger
    // (see trainingLoadOccurrenceService.js's own header comment).
    await ensureCurrentExternalOccurrencesForAthlete(athleteId);

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
         -- Per-session RPE opt-out: a disabled session with NO existing
         -- result is never shown to the athlete as a request at all (not
         -- pending, not "Not rated"). One that already has a result from
         -- before it was disabled keeps showing as its already-rated
         -- summary - existing history is never hidden.
         and (coalesce(ps.rpe_enabled, true) or sf.id is not null)
       order by ps.session_order`,
      [athleteId, localToday],
    );

    // External assignments (outside any Weekly plan) due on this same
    // local date - a cancelled schedule/assignment is never shown, even if
    // it already has a result (matches the planned side: a coach cancelling
    // an external schedule is a different action from disabling RPE on a
    // planned session, and never needs the same "keep showing the result"
    // carve-out since that's an explicit separate concern, not addressed by
    // this phase).
    const externalResult = await query(
      `select asg.id as assignment_id, asg.opens_at, asg.closes_at, asg.status as assignment_status,
              s.id as schedule_id, s.event_name,
              sf.id as feedback_id, sf.rpe, sf.duration_minutes, sf.srpe, sf.athlete_note, sf.submitted_at
       from training_load.external_assignments asg
       join training_load.external_schedule_occurrences o on o.id = asg.occurrence_id
       join training_load.external_schedules s on s.id = o.schedule_id
       left join training_load.session_feedback sf on sf.external_assignment_id = asg.id
       where asg.athlete_id = $1
         and asg.local_scheduled_date = $2::date
         and asg.status <> 'cancelled'
         and s.status <> 'cancelled'
       order by asg.opens_at`,
      [athleteId, localToday],
    );

    res.json({
      date: localToday,
      sessions: [
        ...sessionsResult.rows.map((row) => ({
          sessionId: row.session_id,
          sessionName: row.session_name || "",
          amPm: row.am_pm || "",
          bta: row.bta || "",
          sessionTime: row.session_time || "",
          rated: row.feedback_id != null,
          feedback: formatFeedback(row),
          source: "planned",
          externalAssignmentId: null,
          scheduleId: null,
        })),
        ...externalResult.rows.map((row) => ({
          sessionId: null,
          sessionName: row.event_name || "",
          amPm: "",
          bta: "",
          sessionTime: "",
          rated: row.feedback_id != null,
          feedback: formatFeedback(row),
          source: "scheduled_external",
          externalAssignmentId: row.assignment_id,
          scheduleId: row.schedule_id,
          opensAt: row.opens_at,
          closesAt: row.closes_at,
        })),
      ],
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
      `select ps.id as session_id, ps.logical_session_id, ps.name as session_name, ps.am_pm, ps.bta, ps.session_time, ps.rpe_enabled,
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

    // Per-session RPE opt-out: unlike the not-found/not-yours/not-actionable
    // cases above, a coach explicitly turning RPE off for a real, visible
    // session is not something worth hiding from the athlete behind a bare
    // 404 - a distinguishable, controlled 409 is the correct response here.
    if (session.rpe_enabled === false) {
      await client.query("rollback");
      return res.status(409).json({ error: "RPE isn't being collected for this session." });
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

// Coach quick toggle (Training Load -> Schedule tab). Locks the live
// session row FIRST (same `for update of ps` pattern as the athlete's own
// submit route above), so a concurrent submit-vs-disable race serializes
// cleanly on that one row: whichever transaction's lock is granted first
// wins outright - if submit wins, the result commits and stays untouched;
// if disable wins, the submit that was waiting re-reads rpe_enabled=false
// and gets the controlled 409 the submit route already implements. Never
// a partial write, never a 500.
router.patch("/sessions/:sessionId/rpe-enabled", async (req, res, next) => {
  let client;
  try {
    if (!requireCoachWorkspace(req, res)) return;
    const sessionId = req.params.sessionId;
    if (!UUID_PATTERN.test(sessionId)) return res.status(404).json({ error: "Training session not found." });
    if (typeof req.body?.rpeEnabled !== "boolean") {
      return res.status(400).json({ error: "rpeEnabled must be a boolean." });
    }
    const rpeEnabled = req.body.rpeEnabled;
    const confirmDisableWithResults = req.body?.confirmDisableWithResults === true;

    client = await pool.connect();
    await client.query("begin");

    const sessionResult = await client.query(
      `select ps.id as session_id, ps.logical_session_id, p.id as plan_id, p.athlete_id
       from plans.plan_sessions ps
       join plans.plan_days pd on pd.id = ps.plan_day_id
       join plans.plans p on p.id = pd.plan_id
       where ps.id = $1
         and ${WEEKLY_PLAN_SESSION_FILTER_SQL}
       for update of ps`,
      [sessionId],
    );
    const session = sessionResult.rows[0];
    if (!session) {
      await client.query("rollback");
      return res.status(404).json({ error: "Training session not found." });
    }

    // Real workspace-authorization gate, not just a UI-level restriction -
    // the same EXISTS-against-athlete_memberships/user_athletes shape every
    // other coach-facing query in this file already uses.
    const scope = await coachWorkspaceScopeSql(req, "a", 2);
    const accessResult = await client.query(
      `select 1 from public.athletes a where a.id = $1 ${scope.sql}`,
      [session.athlete_id, ...scope.params],
    );
    if (!accessResult.rowCount) {
      await client.query("rollback");
      return res.status(404).json({ error: "Training session not found." });
    }

    // Disabling a session that already has at least one submitted result
    // needs an explicit, informed confirmation - a real server-side gate
    // (confirmDisableWithResults must be sent back on the SAME request the
    // frontend re-submits after the coach confirms), not just a UI dialog
    // a different/careless client could bypass. Matching by
    // logical_session_id alone already scopes this to real, submitted
    // planned results for this exact logical session - nothing else could
    // ever share that id.
    if (rpeEnabled === false && !confirmDisableWithResults) {
      const existingCountResult = await client.query(
        `select count(*)::int as n from training_load.session_feedback where logical_session_id = $1`,
        [session.logical_session_id],
      );
      if (existingCountResult.rows[0].n > 0) {
        await client.query("rollback");
        return res.status(409).json({ error: "hasExistingResults", resultCount: existingCountResult.rows[0].n });
      }
    }

    // If this live plan currently has an open edit-draft, its own copy of
    // this same session (same logical_session_id, carried over by
    // preserveLogicalId - see builder.js) must be updated in the SAME
    // transaction, or a later Builder "Save and finish" would silently
    // revert this quick toggle back to whatever the draft still has.
    const draftSessionResult = await client.query(
      `select ps2.id
       from plans.plans d
       join plans.plan_days pd2 on pd2.plan_id = d.id
       join plans.plan_sessions ps2 on ps2.plan_day_id = pd2.id
       where d.edit_source_plan_id = $1 and d.is_edit_draft
         and ps2.logical_session_id = $2
       for update of ps2`,
      [session.plan_id, session.logical_session_id],
    );
    const idsToUpdate = [session.session_id, ...draftSessionResult.rows.map((row) => row.id)];
    await client.query(
      `update plans.plan_sessions set rpe_enabled = $1, updated_at = now() where id = any($2::uuid[])`,
      [rpeEnabled, idsToUpdate],
    );
    await client.query("commit");
    return res.json({ sessionId: session.session_id, rpeEnabled, draftSessionUpdated: draftSessionResult.rowCount > 0 });
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
    // External assignments are scoped by the ASSIGNED ATHLETE's own
    // workspace membership - the exact same rule planned sessions/results
    // already use - never by which coach/schedule owns them. Schedule
    // ownership only gates who may MANAGE a schedule (see
    // canManageExternalSchedule); seeing an athlete's aggregated training
    // load in a weekly view is a separate, broader concern.
    let scopeSqlExternal = "";
    let params = [weekStart, weekEnd];

    const { workspace } = await resolveActiveWorkspace(req.user.id, req.authz);
    if (workspace?.type === "athlete") {
      if (!req.authz.athleteId) return res.status(403).json({ error: "This account has no athlete profile." });
      params.push(req.authz.athleteId);
      // Same rule as GET /athlete/today: the athlete's own weekly view
      // (this endpoint doubles as the athlete's weekly overlay) must never
      // show a disabled session that has no result yet - only the coach's
      // own Schedule tab (the `else` branch below) needs every session
      // visible, disabled or not, so its quick-toggle control can re-enable
      // one. A disabled session that already has a result stays visible.
      scopeSqlLive = `and p.athlete_id = $${params.length} and (coalesce(ps.rpe_enabled, true) or sf.id is not null)`;
      scopeSqlSf = `and sf.athlete_id = $${params.length}`;
      scopeSqlExternal = `and a.id = $${params.length}`;
      await ensureCurrentExternalOccurrencesForAthlete(req.authz.athleteId);
    } else {
      if (!requireCoachWorkspace(req, res)) return;
      const scope = await coachWorkspaceScopeSql(req, "a", 3);
      scopeSqlLive = scope.sql;
      scopeSqlSf = scope.sql;
      scopeSqlExternal = scope.sql;
      params = params.concat(scope.params);

      const extraFragment = athleteExtraFilterSql("a", clubFilter.ids, teamFilter.ids, athleteFilter.ids, params);
      scopeSqlLive += extraFragment;
      scopeSqlSf += extraFragment;
      scopeSqlExternal += extraFragment;

      await ensureCurrentExternalOccurrencesForCoach({
        userId: req.user.id,
        clubIds: manageableClubIds(req.authz),
        teamIds: manageableTeamIds(req.authz),
        isPlatformAdmin: isPlatformAdministrator(req.authz),
      });
    }

    const liveResult = await query(
      `select ps.id as session_id, ps.logical_session_id, ps.name as session_name, ps.am_pm, ps.bta, ps.session_time, ps.rpe_enabled,
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

    // External assignments (outside any Weekly plan) due this week -
    // pushed into the SAME days[].sessions[] array below with `source:
    // 'scheduled_external'`, `sessionId: null`, `planId: null`, so any
    // existing frontend code that only reads the already-known fields
    // (.rated/.feedback/.sessionName) is unaffected.
    const externalResult = await query(
      `select asg.id as assignment_id, asg.local_scheduled_date, asg.opens_at, asg.closes_at,
              s.id as schedule_id, s.event_name,
              a.id as athlete_id, coalesce(a.display_name, a.full_name, concat_ws(' ', a.first_name, a.last_name), a.athlete_id) as athlete_name,
              sf.id as feedback_id, sf.rpe, sf.duration_minutes, sf.srpe, sf.athlete_note, sf.submitted_at
       from training_load.external_assignments asg
       join training_load.external_schedule_occurrences o on o.id = asg.occurrence_id
       join training_load.external_schedules s on s.id = o.schedule_id
       join public.athletes a on a.id = asg.athlete_id
       left join training_load.session_feedback sf on sf.external_assignment_id = asg.id
       where asg.local_scheduled_date between $1::date and $2::date
         and asg.status <> 'cancelled'
         and s.status <> 'cancelled'
         ${scopeSqlExternal}
       order by asg.local_scheduled_date, athlete_name, a.id, asg.opens_at`,
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
        // rpe_enabled defaults to true for any pre-v3 row read through a
        // driver/pool that hasn't picked up the column yet - never really
        // reachable in practice (the column is NOT NULL DEFAULT true), but
        // coalesced defensively the same way the SQL-side reads already are.
        rpeEnabled: row.rpe_enabled !== false,
        source: "planned",
        externalAssignmentId: null,
        scheduleId: null,
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
        // A historical/orphaned row has no live plan_sessions row to read
        // rpe_enabled from at all - it's always already-rated, so this
        // is never read as an actionable "off" state either way.
        rpeEnabled: true,
        source: "planned",
        externalAssignmentId: null,
        scheduleId: null,
      });
    }
    for (const row of externalResult.rows) {
      const bucket = byDate.get(row.local_scheduled_date);
      if (!bucket) continue;
      bucket.sessions.push({
        sessionId: null,
        sessionName: row.event_name || "",
        amPm: "",
        bta: "",
        sessionTime: "",
        planId: null,
        planName: null,
        athleteId: row.athlete_id,
        athleteName: row.athlete_name,
        rated: row.feedback_id != null,
        feedback: formatFeedback(row),
        historical: false,
        rpeEnabled: true,
        source: "scheduled_external",
        externalAssignmentId: row.assignment_id,
        scheduleId: row.schedule_id,
        opensAt: row.opens_at,
        closesAt: row.closes_at,
      });
    }

    res.json({ weekStart, weekEnd, days });
  } catch (error) {
    next(error);
  }
});

// ------------------------------------------------------------
// External scheduling (RPE sessions outside any Weekly plan). See
// migrations_v2/202609011000_training_load_v4_external_scheduling.sql for
// the schema and trainingLoadOccurrenceService.js for occurrence/
// assignment generation. Every route below is additive - nothing here
// changes the planned-session routes above.
// ------------------------------------------------------------

function text(value) { return String(value || "").trim(); }
function nullableText(value) { return text(value) || null; }

// P0001 = a plpgsql RAISE EXCEPTION (every CHECK/trigger violation this
// migration's own functions raise) -> a controlled 400 with the DB's own
// message, never an opaque 500. 23505 = unique_violation (a genuine
// double-submit race that slipped past an app-level check) -> 409. Same
// pattern as tests.js's own respondToWriteError.
function respondToWriteError(res, next, error) {
  if (error?.code === "P0001") return res.status(400).json({ error: error.message });
  if (error?.code === "23505") return res.status(409).json({ error: "This was already submitted." });
  return next(error);
}

// Scopes a list/detail query to schedules THIS coach may manage - the
// list-query equivalent of canManageExternalSchedule's own per-row check.
// Deliberately never reused for VISIBILITY of an athlete's aggregated
// training load (GET /weekly's own scopeSqlExternal, which scopes by the
// assigned athlete's workspace membership instead - see that route's own
// comment).
function externalScheduleScopeSql(req) {
  if (isPlatformAdministrator(req.authz)) return { sql: "true", params: [] };
  const params = [req.user.id];
  const parts = [`(s.owner_scope = 'user' and s.owner_user_id = $1)`];
  const clubIds = manageableClubIds(req.authz) || [];
  if (clubIds.length) {
    params.push(clubIds);
    parts.push(`(s.owner_scope = 'club' and s.owner_club_id = any($${params.length}::uuid[]))`);
  }
  const teamIds = manageableTeamIds(req.authz) || [];
  if (teamIds.length) {
    params.push(teamIds);
    parts.push(`(s.owner_scope = 'team' and s.owner_team_id = any($${params.length}::uuid[]))`);
  }
  return { sql: `(${parts.join(" or ")})`, params };
}

// Dedupe by (kind, id) - the same athlete targeted both directly AND via a
// team/club they belong to is deliberately NOT deduped away here (two
// genuinely different target rows) - resolve_external_schedule_target_
// athletes' own UNION already collapses that to one materialized
// assignment regardless (see migrations_v2's own comment, and test F3).
function dedupeExternalTargets(rawTargets) {
  const seen = new Set();
  const result = [];
  for (const raw of Array.isArray(rawTargets) ? rawTargets : []) {
    const kind = text(raw?.kind);
    const id = text(raw?.id);
    if (!["athlete", "team", "club"].includes(kind) || !id) continue;
    const key = `${kind}:${id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ kind, id });
  }
  return result;
}

async function validateExternalTarget(req, target) {
  if (target.kind === "athlete") return canAccessAthlete(query, req, target.id);
  if (target.kind === "team") return canManageTeamById(req.authz, target.id);
  if (target.kind === "club") return canManageClub(req.authz, target.id);
  return false;
}

// The WHOLE request is rejected on the FIRST invalid target - never a
// partial accepted set (matches tests.js's own resolveValidTargets).
async function resolveValidExternalTargets(req, rawTargets) {
  const targets = dedupeExternalTargets(rawTargets);
  if (!targets.length) return { ok: false, status: 400, error: "Choose at least one athlete, team or club." };
  for (const target of targets) {
    const allowed = await validateExternalTarget(req, target);
    if (!allowed) return { ok: false, status: 403, error: "One of the chosen targets is outside your access." };
  }
  return { ok: true, targets };
}

async function insertExternalTargets(client, scheduleId, targets) {
  for (const target of targets) {
    await client.query(
      `insert into training_load.external_schedule_targets (schedule_id, target_kind, target_athlete_id, target_team_id, target_club_id)
       values ($1, $2, $3, $4, $5)`,
      [
        scheduleId,
        target.kind,
        target.kind === "athlete" ? target.id : null,
        target.kind === "team" ? target.id : null,
        target.kind === "club" ? target.id : null,
      ],
    );
  }
}

function formatExternalScheduleRow(row) {
  return {
    id: row.id,
    scheduleKind: row.schedule_kind,
    timezone: row.timezone,
    startDate: row.start_date,
    endDate: row.end_date,
    recurrenceRule: row.recurrence_rule || null,
    opensTime: row.opens_time,
    dueTime: row.due_time,
    closesTime: row.closes_time,
    status: row.status,
    eventName: row.event_name,
    eventNote: row.event_note || "",
    ownerScope: row.owner_scope,
    ownerUserId: row.owner_user_id,
    ownerClubId: row.owner_club_id,
    ownerTeamId: row.owner_team_id,
    targetCount: row.target_count != null ? Number(row.target_count) : undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function formatExternalTargetRow(row) {
  return {
    kind: row.target_kind,
    athleteId: row.target_athlete_id,
    teamId: row.target_team_id,
    clubId: row.target_club_id,
    name: row.athlete_name || row.team_name || row.club_name || "",
  };
}

// Builds the schedule_kind/recurrence_rule pair from the create/schedule-
// again request body. "Dates" (multiple specific dates) has no dedicated
// schema-level kind of its own - it's expressed as N independent
// one_time schedules sharing everything else, created together in one
// request via a `dates` array; "Daily" is a single recurring schedule
// with a start/end range.
function resolveExternalScheduleKindAndDates(body) {
  const datesInput = Array.isArray(body?.dates) ? body.dates.map((d) => text(d)).filter(Boolean) : [];
  if (datesInput.length) {
    return { scheduleKind: "one_time", recurrenceRule: null, dateSets: datesInput.map((d) => ({ startDate: d, endDate: null })) };
  }
  const scheduleKindInput = text(body?.scheduleKind) === "recurring" ? "recurring" : "one_time";
  if (scheduleKindInput === "recurring") {
    const startDate = text(body?.startDate);
    const endDate = text(body?.endDate) || null;
    return { scheduleKind: "recurring", recurrenceRule: { version: 1, freq: "daily" }, dateSets: [{ startDate, endDate }] };
  }
  const startDate = text(body?.startDate);
  return { scheduleKind: "one_time", recurrenceRule: null, dateSets: [{ startDate, endDate: null }] };
}

async function insertExternalSchedule(client, { scheduleKind, timezone, startDate, endDate, recurrenceRule, opensTime, dueTime, closesTime, eventName, eventNote, userId, owner }) {
  const result = await client.query(
    `insert into training_load.external_schedules
       (schedule_kind, timezone, start_date, end_date, recurrence_rule, recurrence_rule_version, opens_time, due_time, closes_time, status, event_name, event_note, created_by_user_id, owner_scope, owner_user_id, owner_club_id, owner_team_id)
     values ($1,$2,$3,$4,$5,1,$6,$7,$8,'active',$9,$10,$11,$12,$13,$14,$15)
     returning *`,
    [scheduleKind, timezone, startDate, endDate, recurrenceRule, opensTime, dueTime, closesTime, eventName, eventNote, userId, owner.ownerScope, owner.ownerUserId, owner.ownerClubId, owner.ownerTeamId],
  );
  return result.rows[0];
}

router.post("/external-schedules", async (req, res, next) => {
  const client = await pool.connect();
  try {
    if (!requireCoachWorkspace(req, res)) return;
    const body = req.body || {};
    const eventName = text(body.eventName);
    if (!eventName || eventName.length > 120) return res.status(400).json({ error: "Event name is required (120 characters max)." });
    const eventNote = nullableText(body.eventNote);
    if (eventNote && eventNote.length > 500) return res.status(400).json({ error: "Note is too long (500 characters max)." });
    const timezone = text(body.timezone);
    const opensTime = text(body.opensTime);
    const dueTime = text(body.dueTime) || null;
    const closesTime = text(body.closesTime);
    if (!timezone || !opensTime || !closesTime) {
      return res.status(400).json({ error: "Timezone, opens time and closes time are required." });
    }
    const { scheduleKind, recurrenceRule, dateSets } = resolveExternalScheduleKindAndDates(body);
    if (dateSets.some((d) => !d.startDate)) return res.status(400).json({ error: "At least one date is required." });

    const resolved = await resolveValidExternalTargets(req, body.targets);
    if (!resolved.ok) return res.status(resolved.status).json({ error: resolved.error });

    const owner = await resolveExternalScheduleOwnerContext(req);
    await client.query("begin");
    const schedules = [];
    for (const dateSet of dateSets) {
      const schedule = await insertExternalSchedule(client, {
        scheduleKind, timezone, startDate: dateSet.startDate, endDate: dateSet.endDate,
        recurrenceRule: recurrenceRule ? JSON.stringify(recurrenceRule) : null,
        opensTime, dueTime, closesTime, eventName, eventNote, userId: req.user.id, owner,
      });
      await insertExternalTargets(client, schedule.id, resolved.targets);
      schedules.push(schedule);
    }
    await client.query("commit");
    res.status(201).json({ schedules: schedules.map(formatExternalScheduleRow) });
  } catch (error) {
    await client.query("rollback").catch(() => {});
    respondToWriteError(res, next, error);
  } finally {
    client.release();
  }
});

router.get("/external-schedules", async (req, res, next) => {
  try {
    if (!requireCoachWorkspace(req, res)) return;
    const scope = externalScheduleScopeSql(req);
    const statusFilter = text(req.query?.status);
    const params = [...scope.params];
    let statusSql = "";
    if (["active", "paused", "cancelled"].includes(statusFilter)) {
      params.push(statusFilter);
      statusSql = `and s.status = $${params.length}`;
    }
    const result = await query(
      `select s.*, (select count(*)::int from training_load.external_schedule_targets t where t.schedule_id = s.id) as target_count
       from training_load.external_schedules s
       where ${scope.sql} ${statusSql}
       order by s.start_date desc, s.created_at desc`,
      params,
    );
    res.json({ schedules: result.rows.map(formatExternalScheduleRow) });
  } catch (error) {
    next(error);
  }
});

router.get("/external-schedules/:scheduleId", async (req, res, next) => {
  try {
    if (!requireCoachWorkspace(req, res)) return;
    if (!UUID_PATTERN.test(req.params.scheduleId)) return res.status(404).json({ error: "Schedule not found." });
    const scheduleResult = await query(`select * from training_load.external_schedules where id = $1`, [req.params.scheduleId]);
    const schedule = scheduleResult.rows[0];
    if (!schedule || !canManageExternalSchedule(req, schedule)) return res.status(404).json({ error: "Schedule not found." });
    const targetsResult = await query(
      `select t.target_kind, t.target_athlete_id, t.target_team_id, t.target_club_id,
              coalesce(a.display_name, a.full_name, concat_ws(' ', a.first_name, a.last_name), a.athlete_id) as athlete_name,
              tm.name as team_name, cl.name as club_name
       from training_load.external_schedule_targets t
       left join public.athletes a on a.id = t.target_athlete_id
       left join public.teams tm on tm.id = t.target_team_id
       left join public.clubs cl on cl.id = t.target_club_id
       where t.schedule_id = $1`,
      [schedule.id],
    );
    const occurrencesResult = await query(
      `select o.id, o.scheduled_date, o.status,
              (select count(*)::int from training_load.external_assignments asg where asg.occurrence_id = o.id) as assignment_count,
              (select count(*)::int from training_load.external_assignments asg join training_load.session_feedback sf on sf.external_assignment_id = asg.id where asg.occurrence_id = o.id) as rated_count
       from training_load.external_schedule_occurrences o
       where o.schedule_id = $1
       order by o.scheduled_date desc
       limit 30`,
      [schedule.id],
    );
    res.json({
      schedule: formatExternalScheduleRow(schedule),
      targets: targetsResult.rows.map(formatExternalTargetRow),
      occurrences: occurrencesResult.rows.map((row) => ({ id: row.id, scheduledDate: row.scheduled_date, status: row.status, assignmentCount: row.assignment_count, ratedCount: row.rated_count })),
    });
  } catch (error) {
    next(error);
  }
});

router.patch("/external-schedules/:scheduleId", async (req, res, next) => {
  const client = await pool.connect();
  try {
    if (!requireCoachWorkspace(req, res)) return;
    if (!UUID_PATTERN.test(req.params.scheduleId)) return res.status(404).json({ error: "Schedule not found." });
    await client.query("begin");
    const scheduleResult = await client.query(`select * from training_load.external_schedules where id = $1 for update`, [req.params.scheduleId]);
    const schedule = scheduleResult.rows[0];
    if (!schedule || !canManageExternalSchedule(req, schedule)) {
      await client.query("rollback");
      return res.status(404).json({ error: "Schedule not found." });
    }
    const body = req.body || {};
    const eventName = body.eventName !== undefined ? text(body.eventName) : schedule.event_name;
    if (!eventName || eventName.length > 120) {
      await client.query("rollback");
      return res.status(400).json({ error: "Event name is required (120 characters max)." });
    }
    const eventNote = body.eventNote !== undefined ? nullableText(body.eventNote) : schedule.event_note;
    const opensTime = body.opensTime !== undefined ? text(body.opensTime) : schedule.opens_time;
    const dueTime = body.dueTime !== undefined ? (text(body.dueTime) || null) : schedule.due_time;
    const closesTime = body.closesTime !== undefined ? text(body.closesTime) : schedule.closes_time;
    const endDate = body.endDate !== undefined ? (text(body.endDate) || null) : schedule.end_date;

    await client.query(
      `update training_load.external_schedules
       set event_name = $2, event_note = $3, opens_time = $4, due_time = $5, closes_time = $6, end_date = $7, updated_at = now()
       where id = $1`,
      [schedule.id, eventName, eventNote, opensTime, dueTime, closesTime, endDate],
    );
    if (body.targets !== undefined) {
      const resolved = await resolveValidExternalTargets(req, body.targets);
      if (!resolved.ok) {
        await client.query("rollback");
        return res.status(resolved.status).json({ error: resolved.error });
      }
      await client.query(`delete from training_load.external_schedule_targets where schedule_id = $1`, [schedule.id]);
      await insertExternalTargets(client, schedule.id, resolved.targets);
    }
    await client.query("commit");
    const freshResult = await query(`select * from training_load.external_schedules where id = $1`, [schedule.id]);
    res.json({ schedule: formatExternalScheduleRow(freshResult.rows[0]) });
  } catch (error) {
    await client.query("rollback").catch(() => {});
    respondToWriteError(res, next, error);
  } finally {
    client.release();
  }
});

async function setExternalScheduleStatus(req, res, next, newStatus) {
  try {
    if (!requireCoachWorkspace(req, res)) return;
    if (!UUID_PATTERN.test(req.params.scheduleId)) return res.status(404).json({ error: "Schedule not found." });
    const scheduleResult = await query(`select * from training_load.external_schedules where id = $1`, [req.params.scheduleId]);
    const schedule = scheduleResult.rows[0];
    if (!schedule || !canManageExternalSchedule(req, schedule)) return res.status(404).json({ error: "Schedule not found." });
    if (schedule.status === "cancelled") return res.status(400).json({ error: "This schedule was already cancelled." });
    await query(`update training_load.external_schedules set status = $2, updated_at = now() where id = $1`, [schedule.id, newStatus]);
    const freshResult = await query(`select * from training_load.external_schedules where id = $1`, [schedule.id]);
    res.json({ schedule: formatExternalScheduleRow(freshResult.rows[0]) });
  } catch (error) {
    next(error);
  }
}
router.post("/external-schedules/:scheduleId/pause", (req, res, next) => setExternalScheduleStatus(req, res, next, "paused"));
router.post("/external-schedules/:scheduleId/resume", (req, res, next) => setExternalScheduleStatus(req, res, next, "active"));
router.post("/external-schedules/:scheduleId/cancel", (req, res, next) => setExternalScheduleStatus(req, res, next, "cancelled"));

// Creates a genuinely NEW schedule seeded from this one's fields/targets -
// never mutates or reactivates the original (cancelled or not). Copies
// everything except dates/occurrences/assignments/responses/history, which
// is exactly why a new startDate (and optional endDate) is required in the
// request body rather than reused from the source.
router.post("/external-schedules/:scheduleId/schedule-again", async (req, res, next) => {
  const client = await pool.connect();
  try {
    if (!requireCoachWorkspace(req, res)) return;
    if (!UUID_PATTERN.test(req.params.scheduleId)) return res.status(404).json({ error: "Schedule not found." });
    const sourceResult = await query(`select * from training_load.external_schedules where id = $1`, [req.params.scheduleId]);
    const source = sourceResult.rows[0];
    if (!source || !canManageExternalSchedule(req, source)) return res.status(404).json({ error: "Schedule not found." });

    const body = req.body || {};
    const startDate = text(body.startDate);
    if (!startDate) return res.status(400).json({ error: "A new start date is required." });
    const endDate = text(body.endDate) || null;

    const targetsResult = await query(
      `select target_kind, target_athlete_id, target_team_id, target_club_id from training_load.external_schedule_targets where schedule_id = $1`,
      [source.id],
    );

    await client.query("begin");
    const schedule = await insertExternalSchedule(client, {
      scheduleKind: source.schedule_kind,
      timezone: source.timezone,
      startDate,
      endDate: source.schedule_kind === "recurring" ? endDate : null,
      recurrenceRule: source.recurrence_rule,
      opensTime: source.opens_time,
      dueTime: source.due_time,
      closesTime: source.closes_time,
      eventName: source.event_name,
      eventNote: source.event_note,
      userId: req.user.id,
      owner: { ownerScope: source.owner_scope, ownerUserId: source.owner_user_id, ownerClubId: source.owner_club_id, ownerTeamId: source.owner_team_id },
    });
    for (const t of targetsResult.rows) {
      await client.query(
        `insert into training_load.external_schedule_targets (schedule_id, target_kind, target_athlete_id, target_team_id, target_club_id) values ($1,$2,$3,$4,$5)`,
        [schedule.id, t.target_kind, t.target_athlete_id, t.target_team_id, t.target_club_id],
      );
    }
    await client.query("commit");
    res.status(201).json({ schedule: formatExternalScheduleRow(schedule) });
  } catch (error) {
    await client.query("rollback").catch(() => {});
    respondToWriteError(res, next, error);
  } finally {
    client.release();
  }
});

// Athlete submits RPE for an external (outside-plan) assignment. Unlocked
// lookup -> locks in the fixed schedule -> occurrence -> assignment order
// (same lock-order discipline as WELLNESS's own submit route) -> re-
// confirms the assignment still belongs to this athlete -> gates on the
// schedule's own status and the ASSIGNMENT's own opens_at/closes_at window
// (never a shared occurrence-level window) -> the same ON CONFLICT DO
// NOTHING / idempotent-200 / genuine-409 shape the planned route already
// uses, keyed on unique(external_assignment_id) instead of
// (athlete_id, logical_session_id).
router.post("/external-assignments/:assignmentId/rpe", async (req, res, next) => {
  let client;
  try {
    const athleteId = requireAthlete(req, res);
    if (!athleteId) return;
    const assignmentId = req.params.assignmentId;
    if (!UUID_PATTERN.test(assignmentId)) return res.status(404).json({ error: "Training session not found." });

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
    if (note.length > 500) return res.status(400).json({ error: "Note is too long (500 characters max)." });

    client = await pool.connect();
    await client.query("begin");

    const lookupResult = await client.query(
      `select asg.id as assignment_id, asg.athlete_id, o.id as occurrence_id, s.id as schedule_id
       from training_load.external_assignments asg
       join training_load.external_schedule_occurrences o on o.id = asg.occurrence_id
       join training_load.external_schedules s on s.id = o.schedule_id
       where asg.id = $1`,
      [assignmentId],
    );
    const lookup = lookupResult.rows[0];
    if (!lookup || lookup.athlete_id !== athleteId) {
      await client.query("rollback");
      return res.status(404).json({ error: "Training session not found." });
    }

    await client.query(`select status from training_load.external_schedules where id = $1 for update`, [lookup.schedule_id]);
    await client.query(`select id from training_load.external_schedule_occurrences where id = $1 for update`, [lookup.occurrence_id]);
    const assignmentResult = await client.query(`select * from training_load.external_assignments where id = $1 for update`, [lookup.assignment_id]);
    const assignment = assignmentResult.rows[0];
    if (!assignment || assignment.athlete_id !== athleteId) {
      await client.query("rollback");
      return res.status(404).json({ error: "Training session not found." });
    }

    const scheduleResult = await client.query(`select status, event_name from training_load.external_schedules where id = $1`, [lookup.schedule_id]);
    const schedule = scheduleResult.rows[0];
    if (schedule.status !== "active") {
      await client.query("rollback");
      return res.status(409).json({ error: "This isn't currently accepting submissions." });
    }

    const nowResult = await client.query(`select now() as now`);
    const now = nowResult.rows[0].now;
    if (assignment.status === "cancelled" || now < assignment.opens_at || now > assignment.closes_at) {
      await client.query("rollback");
      return res.status(409).json({ error: "This check-in window is closed." });
    }

    const insertResult = await client.query(
      `insert into training_load.session_feedback
         (athlete_id, external_assignment_id, source, event_name, session_date, rpe, duration_minutes, athlete_note)
       values ($1,$2,'scheduled_external',$3,$4,$5,$6,$7)
       on conflict (external_assignment_id) do nothing
       returning id, rpe, duration_minutes, srpe, athlete_note, submitted_at`,
      [athleteId, assignment.id, schedule.event_name, assignment.local_scheduled_date, rpe, durationMinutes, note || null],
    );

    if (insertResult.rows.length) {
      await client.query(`update training_load.external_assignments set status = 'completed', completed_at = now() where id = $1 and status <> 'completed'`, [assignment.id]);
      await client.query("commit");
      return res.status(201).json({ feedback: formatFeedback({ feedback_id: insertResult.rows[0].id, ...insertResult.rows[0] }) });
    }

    const existingResult = await client.query(
      `select id, rpe, duration_minutes, srpe, athlete_note, submitted_at from training_load.session_feedback where external_assignment_id = $1`,
      [assignment.id],
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

// Real 5-minute SLIDING cooldown - never a fixed bucket
// (Math.floor(now/5min) lets two requests seconds apart, straddling a
// bucket boundary, both succeed - a real bug in the first version of
// WELLNESS's own equivalent route). Safe/atomic specifically because it
// runs while the assignment's own row is already locked (FOR UPDATE,
// below) - the row lock IS the serialization point, no separate advisory
// lock needed.
const MANUAL_REMINDER_COOLDOWN_MS = 5 * 60 * 1000;
const athleteDisplayNameSql = `coalesce(a.display_name, a.full_name, nullif(concat_ws(' ', a.first_name, a.last_name), ''), a.source_external_id, a.athlete_id::text)`;

// Coach-triggered manual reminder for one or more external assignments -
// line-for-line mirror of tests.js's own POST /schedules/:scheduleId/remind:
// lock order schedule (FOR SHARE) -> occurrence(s) (FOR SHARE, resolved via
// an unlocked lookup first) -> assignment rows (FOR UPDATE), schedule-level
// gates checked once, per-assignment gates each producing a distinct
// outcome (never a silent drop), the real sliding-window cooldown above,
// and the same shared public.app_notifications.dedupe_key convention
// builder.js's own one-shot notifications already use.
router.post("/external-schedules/:scheduleId/remind", async (req, res, next) => {
  const assignmentIds = Array.isArray(req.body?.assignmentIds) ? [...new Set(req.body.assignmentIds.filter((id) => typeof id === "string" && id))] : [];
  if (!requireCoachWorkspace(req, res)) return;
  if (!assignmentIds.length) return res.status(400).json({ error: "assignmentIds is required." });

  const client = await pool.connect();
  let results;
  const toEmit = [];
  try {
    await client.query("begin");

    const scheduleResult = await client.query(`select * from training_load.external_schedules where id = $1 for share`, [req.params.scheduleId]);
    const schedule = scheduleResult.rows[0];
    if (!schedule) {
      await client.query("rollback");
      return res.status(404).json({ error: "Schedule not found." });
    }
    if (!canManageExternalSchedule(req, schedule)) {
      await client.query("rollback");
      return res.status(403).json({ error: "Forbidden" });
    }
    if (schedule.status === "cancelled") {
      await client.query("rollback");
      return res.status(400).json({ error: "This schedule is cancelled." });
    }
    if (schedule.status === "paused") {
      await client.query("rollback");
      return res.status(400).json({ error: "This schedule is paused - athletes can't submit right now, so a reminder would be pointless." });
    }

    const occurrenceLookup = await client.query(
      `select distinct o.id
       from training_load.external_assignments asg
       join training_load.external_schedule_occurrences o on o.id = asg.occurrence_id
       where o.schedule_id = $1 and asg.id = any($2::uuid[])
       order by o.id`,
      [schedule.id, assignmentIds],
    );
    if (occurrenceLookup.rowCount) {
      await client.query(
        `select id from training_load.external_schedule_occurrences where id = any($1::uuid[]) order by id for share`,
        [occurrenceLookup.rows.map((r) => r.id)],
      );
    }

    const assignmentRows = await client.query(
      `select asg.*, a.user_id, ${athleteDisplayNameSql} as athlete_name
       from training_load.external_assignments asg
       join training_load.external_schedule_occurrences o on o.id = asg.occurrence_id
       join public.athletes a on a.id = asg.athlete_id
       where o.schedule_id = $1 and asg.id = any($2::uuid[])
       order by asg.id
       for update of asg`,
      [schedule.id, assignmentIds],
    );
    const rowsById = new Map(assignmentRows.rows.map((row) => [row.id, row]));

    const now = new Date();
    results = [];
    for (const assignmentId of assignmentIds) {
      const row = rowsById.get(assignmentId);
      if (!row) {
        results.push({ assignmentId, outcome: "skippedNotFound" });
        continue;
      }
      const base = { assignmentId, athleteId: row.athlete_id, athleteName: row.athlete_name };
      if (row.status === "completed") {
        results.push({ ...base, outcome: "skippedCompleted" });
        continue;
      }
      if (["missed", "excused", "cancelled"].includes(row.status)) {
        results.push({ ...base, outcome: "skippedNotOpen" });
        continue;
      }
      if (new Date(row.opens_at) > now) {
        results.push({ ...base, outcome: "skippedNotOpen" });
        continue;
      }
      if (new Date(row.closes_at) < now) {
        results.push({ ...base, outcome: "skippedClosed" });
        continue;
      }
      if (!row.user_id) {
        results.push({ ...base, outcome: "skippedNoUser" });
        continue;
      }

      const cooldownResult = await client.query(
        `select exists (
           select 1 from public.app_notifications
           where entity_type = 'training_load_external_assignment' and entity_id = $1 and type = 'training_load_manual_reminder'
             and created_at > now() - ($2 || ' milliseconds')::interval
         ) as in_cooldown`,
        [assignmentId, MANUAL_REMINDER_COOLDOWN_MS],
      );
      if (cooldownResult.rows[0].in_cooldown) {
        results.push({ ...base, outcome: "skippedCooldown" });
        continue;
      }

      const dedupeKey = `manual_reminder:v1:${assignmentId}:${crypto.randomUUID()}`;
      const inserted = await client.query(
        `insert into public.app_notifications (recipient_user_id, actor_user_id, type, title, body, entity_type, entity_id, metadata, dedupe_key)
         values ($1, $2, 'training_load_manual_reminder', 'Training load reminder', $3, 'training_load_external_assignment', $4, $5::jsonb, $6)
         returning id`,
        [
          row.user_id,
          req.user.id,
          `Your coach sent you a reminder to log RPE for "${schedule.event_name}".`,
          assignmentId,
          JSON.stringify({ scheduleId: schedule.id, assignmentId }),
          dedupeKey,
        ],
      );
      toEmit.push({ userId: row.user_id, notificationId: inserted.rows[0].id });
      results.push({ ...base, outcome: "notified" });
    }

    await client.query("commit");
  } catch (error) {
    await client.query("rollback").catch(() => {});
    return next(error);
  } finally {
    client.release();
  }

  for (const { userId, notificationId } of toEmit) {
    emitRealtimeEvent(userId, "notifications_changed", { notificationId, type: "training_load_manual_reminder" });
  }

  res.json({
    results,
    notifiedCount: results.filter((r) => r.outcome === "notified").length,
    noUserCount: results.filter((r) => r.outcome === "skippedNoUser").length,
  });
});

export default router;
