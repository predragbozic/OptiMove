import crypto from "node:crypto";
import { Router } from "express";
import { pool, query } from "../db.js";
import { resolveActiveWorkspace } from "../workspace.js";
import {
  canManageExternalScheduleInScope,
  canResolvePlanOwnership,
  externalScheduleScopeForWorkspace,
  externalScheduleScopeSqlForWorkspace,
  isAthleteInWorkspaceScope,
  resolveExternalScheduleWorkspaceScope,
} from "../trainingLoadAccess.js";
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

// The external-schedule-specific gate: resolves the account's CURRENTLY
// ACTIVE workspace into the discriminated scope object every schedule
// CRUD/lifecycle/target-validation function below is threaded through.
// Unlike requireCoachWorkspace above (a global "does this account hold
// ANY coach role" check), this returns { type: null } for an athlete
// workspace even when the same account also holds a real coach role
// elsewhere - a coach schedule route must be unreachable while presenting
// as an athlete, full stop. Writes the 403 itself and returns null on
// failure, matching this file's existing requireX(req,res) convention.
async function requireExternalScheduleWorkspace(req, res) {
  const scope = await resolveExternalScheduleWorkspaceScope(req);
  if (scope.type === null) {
    res.status(403).json({ error: "Forbidden" });
    return null;
  }
  return scope;
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

// HH:MM or HH:MM:SS, 24-hour - external_schedules.opens_time/due_time/
// closes_time are all Postgres `time` columns; a malformed string bound
// straight into one of those (create/PATCH/schedule-again all read these
// from the request body with no format check today) is a raw Postgres
// 22007 ("invalid input syntax for type time"), not a controlled 400.
const TIME_STRING_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)(:([0-5]\d))?$/;
function isValidTimeString(value) {
  return typeof value === "string" && TIME_STRING_PATTERN.test(value);
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
         -- Per-session RPE opt-out, AND (v9) the workspace-level master
         -- toggle - a disabled session, OR one whose OWN plan is not
         -- currently governed by an enabled workspace (see
         -- planned_rpe_effective_for_plan - this is the plan's own
         -- STORED ownership snapshot, never the athlete's current,
         -- possibly-unrelated memberships), is never shown to the
         -- athlete as a request at all (not pending, not "Not rated")
         -- unless it already has a result. An existing result from
         -- before either was turned off keeps showing as its already-
         -- rated summary - existing history is never hidden.
         and (
           (coalesce(ps.rpe_enabled, true) and training_load.planned_rpe_effective_for_plan(p.id, pd.date))
           or sf.id is not null
         )
       order by ps.session_order`,
      [athleteId, localToday],
    );

    // External assignments (outside any Weekly plan) due on this same
    // local date. Hardening correction: this used to hide a row only once
    // its OWN status (or its schedule's) was 'cancelled' - a PAUSED
    // schedule's still-pending assignment kept showing as an actionable
    // Home card even though submit already 409s for it, and a CANCELLED
    // schedule's already-submitted result vanished from history along
    // with it. The rule now mirrors the planned side's own rpe_enabled
    // carve-out exactly: an already-rated row (sf.id is not null) always
    // stays visible, read-only, regardless of what happened to the
    // schedule/assignment afterward; an UNRATED row is only ever shown at
    // all when it's genuinely actionable right now (schedule active,
    // assignment still pending/open/in_progress) - paused/cancelled never
    // renders as "a request" in the first place.
    const externalResult = await query(
      `select asg.id as assignment_id, asg.opens_at, asg.closes_at, asg.status as assignment_status,
              s.id as schedule_id, s.event_name, s.status as schedule_status,
              sf.id as feedback_id, sf.rpe, sf.duration_minutes, sf.srpe, sf.athlete_note, sf.submitted_at
       from training_load.external_assignments asg
       join training_load.external_schedule_occurrences o on o.id = asg.occurrence_id
       join training_load.external_schedules s on s.id = o.schedule_id
       left join training_load.session_feedback sf on sf.external_assignment_id = asg.id
       where asg.athlete_id = $1
         and asg.local_scheduled_date = $2::date
         and (
           sf.id is not null
           or (s.status = 'active' and asg.status in ('pending','open','in_progress'))
         )
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
          scheduleStatus: row.schedule_status,
          assignmentStatus: row.assignment_status,
          // Explicit, never re-derived by the frontend from row presence
          // alone - the SQL above already excludes a non-actionable,
          // unrated row entirely, so any row reaching this branch is
          // actionable unless it's already rated.
          actionable: row.feedback_id == null,
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

    // Workspace-level master toggle (v9) - the effective rule is
    // "workspace automatic planned RPE enabled AND session.rpe_enabled",
    // the per-session gate just above. This SESSION's own PLAN carries a
    // stable, stored ownership snapshot (training_load.
    // plan_workspace_ownership, written once at plan-creation time - see
    // routes/builder.js) - never the athlete's current, possibly-
    // unrelated memberships. The ONE settings row that snapshot maps to
    // (if any) is locked FOR UPDATE before reading the effective value,
    // so a concurrent PATCH /planned-rpe-setting turning it off must
    // wait behind this lock - a submit can never succeed after a
    // disable has already committed, and a disable can never commit
    // while a submit against it is still mid-flight. A plan with no
    // ownership row, or owner_scope='unresolved', matches nothing here -
    // there is no settings row to lock, and the effective check below
    // correctly reads false.
    await client.query(
      `select s.id
       from training_load.plan_workspace_ownership o
       join training_load.planned_rpe_workspace_settings s
         on s.owner_scope = o.owner_scope
        and s.owner_user_id is not distinct from o.owner_user_id
        and s.owner_club_id is not distinct from o.owner_club_id
        and s.owner_team_id is not distinct from o.owner_team_id
       where o.plan_id = $1
       for update of s`,
      [session.plan_id],
    );
    const workspaceEnabledResult = await client.query(
      `select training_load.planned_rpe_effective_for_plan($1, $2) as enabled`,
      [session.plan_id, session.session_date],
    );
    if (!workspaceEnabledResult.rows[0].enabled) {
      await client.query("rollback");
      return res.status(409).json({ error: "Automatic planned RPE is currently turned off for this workspace." });
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
// Workspace-level MASTER toggle for automatic planned-session RPE (v9,
// migrations_v2/202609040900). Reuses trainingLoadAccess.js's own
// requireExternalScheduleWorkspace/resolveExternalScheduleWorkspaceScope
// - the exact same owner_scope/owner_user_id/owner_club_id/owner_team_id
// shape external_schedules already established, resolved from the
// account's CURRENTLY ACTIVE workspace, ONCE per request (never a second
// independent resolveActiveWorkspace call - same discipline as the
// external-scheduling hardening pass). An athlete workspace (or no
// workspace at all) is rejected with 403 by that same shared helper - an
// athlete can never read or change this setting, only a coach managing
// the scope it belongs to.
// ------------------------------------------------------------

router.get("/planned-rpe-setting", async (req, res, next) => {
  try {
    const scope = await requireExternalScheduleWorkspace(req, res);
    if (!scope) return;
    const owner = scope.ownerContext;
    const result = await query(
      `select enabled, enabled_at from training_load.planned_rpe_workspace_settings
       where owner_scope = $1 and owner_user_id is not distinct from $2 and owner_club_id is not distinct from $3 and owner_team_id is not distinct from $4`,
      [owner.ownerScope, owner.ownerUserId, owner.ownerClubId, owner.ownerTeamId],
    );
    const row = result.rows[0];
    // Absent row = OFF - a workspace that has never touched this switch
    // gets the safe default, never inferred as "on" from anything else.
    res.json({ enabled: row?.enabled === true, enabledAt: row?.enabled_at || null });
  } catch (error) {
    next(error);
  }
});

router.patch("/planned-rpe-setting", async (req, res, next) => {
  const client = await pool.connect();
  try {
    const scope = await requireExternalScheduleWorkspace(req, res);
    if (!scope) return;
    if (typeof req.body?.enabled !== "boolean") {
      return res.status(400).json({ error: "enabled must be a boolean." });
    }
    const enabled = req.body.enabled;
    const owner = scope.ownerContext;

    await client.query("begin");
    // Locks the existing row (if any) FIRST - the same row a concurrent
    // planned-RPE submit locks FOR SHARE (see POST /sessions/:id/rpe's
    // own comment) - so a Turn off racing an in-flight submit is
    // genuinely serialized: whichever transaction's lock is granted
    // first decides the outcome, never a submit succeeding after the
    // disable has already committed.
    const existingResult = await client.query(
      `select enabled, enabled_at from training_load.planned_rpe_workspace_settings
       where owner_scope = $1 and owner_user_id is not distinct from $2 and owner_club_id is not distinct from $3 and owner_team_id is not distinct from $4
       for update`,
      [owner.ownerScope, owner.ownerUserId, owner.ownerClubId, owner.ownerTeamId],
    );
    const current = existingResult.rows[0];
    const wasEnabled = current?.enabled === true;
    // enabled_at only ever moves on a genuine false -> true transition -
    // re-saving an already-true value must NEVER push the retroactivity
    // cutoff forward (see this table's own migration comment), and
    // turning it off leaves the last real enabled_at untouched (it's
    // simply not read while enabled=false).
    const enabledAt = enabled && !wasEnabled ? new Date() : (current?.enabled_at || null);

    const upserted = await client.query(
      `insert into training_load.planned_rpe_workspace_settings
         (owner_scope, owner_user_id, owner_club_id, owner_team_id, enabled, enabled_at, updated_by_user_id)
       values ($1,$2,$3,$4,$5,$6,$7)
       on conflict (owner_scope, owner_user_id, owner_club_id, owner_team_id)
       do update set enabled = excluded.enabled, enabled_at = excluded.enabled_at, updated_by_user_id = excluded.updated_by_user_id, updated_at = now()
       returning enabled, enabled_at`,
      [owner.ownerScope, owner.ownerUserId, owner.ownerClubId, owner.ownerTeamId, enabled, enabledAt, req.user.id],
    );
    await client.query("commit");
    res.json({ enabled: upserted.rows[0].enabled, enabledAt: upserted.rows[0].enabled_at });
  } catch (error) {
    await client.query("rollback").catch(() => {});
    next(error);
  } finally {
    client.release();
  }
});

// ------------------------------------------------------------
// Explicit unresolved-plan ownership resolution (correction round 2).
//
// A pre-existing Weekly plan the legacy backfill (migrations_v2/
// 202609040900) couldn't deterministically attribute is stamped
// owner_scope='unresolved' - by design, it can never match ANY real
// settings row, so it stays permanently inactive for automatic planned
// RPE until an explicit, authorized action assigns it a real scope. That
// action is this endpoint: it never runs automatically (no background
// job, no implicit "resolve everything" behavior anywhere), and a coach
// only ever resolves plans they can see and manage through their own
// CURRENTLY ACTIVE workspace.
//
// Body: { planIds: [uuid, ...] } - always explicit, client-supplied ids
// (a single "Use current workspace for RPE" button sends one id, a bulk
// action sends every currently-VISIBLE unresolved id this account can
// actually resolve for the shown week/future - never "every unresolved
// plan this coach could ever reach", and the frontend's own filtering is
// never trusted as authorization - see below). The whole batch is
// atomic: the first plan that fails authorization (or doesn't exist as a
// real weekly plan) rolls back the entire request - same "reject the
// whole thing on the first bad item" discipline as
// resolveValidExternalTargets above.
//
// Correction round 4: a genuinely UNRESOLVED plan may only be resolved
// by its own ORIGINAL creator (canResolvePlanOwnership, trainingLoadAccess.js)
// - workspace-scope coverage of the athlete ALONE is not proof of
// ownership (see that function's own header for the exact cross-
// workspace leak this closes). An already-resolved plan keeps the
// original, simpler isAthleteInWorkspaceScope gate below it - that
// branch only ever produces an idempotent no-op or a 409, never an
// actual scope change, so the stricter creator check has nothing to
// protect there.
//
// Per-plan outcome once authorized:
//   - currently 'unresolved' -> resolved to the caller's own scope.
//   - already resolved to the EXACT SAME scope -> idempotent no-op
//     (a retried/double-submitted request is never an error).
//   - already resolved to a DIFFERENT scope -> 409, and (being a single
//     bad item) rolls back the whole batch, matching the atomic rule
//     above - a plan can never change scope through this endpoint once
//     it has a real owner; that would silently move RPE data across
//     workspace boundaries, exactly the isolation bug this branch's own
//     ownership model exists to prevent.
//
// Locks each plan's own ownership row FOR UPDATE, in ascending plan_id
// order (a stable, deterministic lock order across every caller so two
// concurrent multi-plan batches can never deadlock against each other) -
// the same row a concurrent resolution attempt for the SAME plan would
// also lock, so two racing requests targeting one plan serialize
// cleanly: whichever transaction's lock is granted first commits its own
// scope: the second re-reads the now-updated row and correctly sees
// either an idempotent match or a genuine 409, never a lost update.
function sameOwnerContext(a, b) {
  return (
    a.ownerScope === b.ownerScope
    && String(a.ownerUserId ?? "") === String(b.ownerUserId ?? "")
    && String(a.ownerClubId ?? "") === String(b.ownerClubId ?? "")
    && String(a.ownerTeamId ?? "") === String(b.ownerTeamId ?? "")
  );
}

router.post("/plans/resolve-rpe-ownership", async (req, res, next) => {
  const client = await pool.connect();
  try {
    const scope = await requireExternalScheduleWorkspace(req, res);
    if (!scope) return;
    const rawIds = req.body?.planIds;
    if (!Array.isArray(rawIds) || !rawIds.length) {
      return res.status(400).json({ error: "planIds must be a non-empty array." });
    }
    const planIds = [...new Set(rawIds.map((id) => String(id)))];
    if (planIds.some((id) => !UUID_PATTERN.test(id))) {
      return res.status(400).json({ error: "One of the chosen plans has an invalid id." });
    }
    planIds.sort();
    const owner = scope.ownerContext;

    await client.query("begin");
    const resolvedPlanIds = [];
    const alreadyMatchingPlanIds = [];
    for (const planId of planIds) {
      const planResult = await client.query(
        `select p.id, p.athlete_id, p.created_by_user_id, o.owner_scope, o.owner_user_id, o.owner_club_id, o.owner_team_id
         from plans.plans p
         join training_load.plan_workspace_ownership o on o.plan_id = p.id
         where p.id = $1 and p.plan_type = 'weekly'
         for update of o`,
        [planId],
      );
      const plan = planResult.rows[0];
      if (!plan) {
        await client.query("rollback");
        return res.status(404).json({ error: `Weekly plan ${planId} not found.` });
      }
      if (plan.owner_scope !== "unresolved") {
        // An already-resolved plan can only ever end up idempotent-200
        // or 409 below - never a real scope change - so this keeps the
        // original, simpler "does my current workspace cover this
        // athlete" gate rather than the stricter creator check below.
        const allowed = await isAthleteInWorkspaceScope(scope, plan.athlete_id);
        if (!allowed) {
          await client.query("rollback");
          return res.status(403).json({ error: "One of the chosen plans is outside your access." });
        }
        const existingOwner = { ownerScope: plan.owner_scope, ownerUserId: plan.owner_user_id, ownerClubId: plan.owner_club_id, ownerTeamId: plan.owner_team_id };
        if (sameOwnerContext(existingOwner, owner)) {
          alreadyMatchingPlanIds.push(planId);
          continue;
        }
        await client.query("rollback");
        return res.status(409).json({ error: `Plan ${planId} is already assigned to a different workspace.` });
      }
      // Genuinely unresolved: only the plan's own original creator (or a
      // real platform administrator) may assign it a scope - see
      // canResolvePlanOwnership's own header for why workspace coverage
      // of the athlete alone is not enough here.
      const allowed = await canResolvePlanOwnership(scope, plan, req.user.id);
      if (!allowed) {
        await client.query("rollback");
        return res.status(403).json({ error: "One of the chosen plans is outside your access." });
      }
      await client.query(
        `update training_load.plan_workspace_ownership
         set owner_scope = $2, owner_user_id = $3, owner_club_id = $4, owner_team_id = $5, resolved_at = now()
         where plan_id = $1`,
        [planId, owner.ownerScope, owner.ownerUserId, owner.ownerClubId, owner.ownerTeamId],
      );
      resolvedPlanIds.push(planId);
    }
    await client.query("commit");
    res.json({ resolvedPlanIds, alreadyMatchingPlanIds });
  } catch (error) {
    await client.query("rollback").catch(() => {});
    next(error);
  } finally {
    client.release();
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
  return coachWorkspaceScopeSqlForWorkspace(workspace, req, alias, startIndex);
}

// Same predicate as coachWorkspaceScopeSql, for a caller that has ALREADY
// resolved the active workspace itself this request - see GET /weekly
// below, which reuses ONE resolveActiveWorkspace read for both this
// predicate and its own external-schedule scoping (hardening correction,
// item 5: two independent reads in the same request could observe a
// workspace switch landing between them and scope different parts of the
// SAME response to two different workspaces).
function coachWorkspaceScopeSqlForWorkspace(workspace, req, alias, startIndex) {
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
    // (correction round 4) Only ever set on the coach branch below - an
    // athlete account never resolves plan ownership, so every row it
    // sees simply gets canResolveOwnership: false.
    let resolutionScope = null;

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
      // (v9) Same workspace-level master-toggle gate as GET /athlete/today -
      // the session's own PLAN's stored ownership snapshot, never the
      // athlete's current memberships.
      scopeSqlLive = `and p.athlete_id = $${params.length} and ((coalesce(ps.rpe_enabled, true) and training_load.planned_rpe_effective_for_plan(p.id, pd.date)) or sf.id is not null)`;
      scopeSqlSf = `and sf.athlete_id = $${params.length}`;
      // Same rule as GET /athlete/today's own external-assignment fix: an
      // unrated row only shows here if it's genuinely actionable right
      // now (schedule active, assignment still pending/open/in_progress);
      // an already-rated row always stays visible regardless of what
      // later happened to the schedule/assignment. Only the coach's own
      // Schedule tab (the `else` branch below) needs every row, any
      // status, unfiltered.
      scopeSqlExternal = `and a.id = $${params.length} and (sf.id is not null or (s.status = 'active' and asg.status in ('pending','open','in_progress')))`;
      await ensureCurrentExternalOccurrencesForAthlete(req.authz.athleteId);
    } else {
      if (!requireCoachWorkspace(req, res)) return;
      // Resolved ONCE and reused for BOTH the athlete-visibility scope
      // below AND the external-schedule scope/occurrence generation
      // further down - hardening correction, item 5: this used to call
      // resolveActiveWorkspace a second, independent time (inside
      // resolveExternalScheduleWorkspaceScope) later in the same
      // request, so a workspace switch landing between the two reads
      // could scope planned/session_feedback rows to workspace A while
      // generating/scoping external-schedule occurrences for workspace B
      // in the very same response.
      const scope = coachWorkspaceScopeSqlForWorkspace(workspace, req, "a", 3);
      scopeSqlLive = scope.sql;
      scopeSqlSf = scope.sql;
      scopeSqlExternal = scope.sql;
      params = params.concat(scope.params);

      const extraFragment = athleteExtraFilterSql("a", clubFilter.ids, teamFilter.ids, athleteFilter.ids, params);
      scopeSqlLive += extraFragment;
      scopeSqlSf += extraFragment;
      scopeSqlExternal += extraFragment;

      // Only the ACTIVE workspace's own schedules get materialized here -
      // never every schedule the account could manage across every
      // club/team it happens to hold a role in (see
      // resolveExternalScheduleWorkspaceScope's own header comment).
      await ensureCurrentExternalOccurrencesForCoach(externalScheduleScopeForWorkspace(workspace, req));
      // (correction round 4) Reuses the SAME workspace read (never a
      // second, independent resolveActiveWorkspace call) to compute the
      // discriminated scope object canResolvePlanOwnership needs below,
      // for each unresolved row's own canResolveOwnership field -
      // whether THIS account, in its currently active workspace, could
      // actually resolve that specific plan if it clicked "Use current
      // workspace for RPE". Purely informational for the frontend (which
      // button/state to render) - the resolve endpoint itself re-checks
      // this from scratch and is the only real authorization boundary.
      resolutionScope = externalScheduleScopeForWorkspace(workspace, req);
    }

    const liveResult = await query(
      `select ps.id as session_id, ps.logical_session_id, ps.name as session_name, ps.am_pm, ps.bta, ps.session_time, ps.rpe_enabled,
              pd.date as session_date, p.id as plan_id, p.name as plan_name, p.created_by_user_id as plan_created_by_user_id,
              a.id as athlete_id, coalesce(a.display_name, a.full_name, concat_ws(' ', a.first_name, a.last_name), a.athlete_id) as athlete_name,
              sf.id as feedback_id, sf.rpe, sf.duration_minutes, sf.srpe, sf.athlete_note, sf.submitted_at,
              -- (v9) Never used to FILTER this coach-facing query (the
              -- Schedule tab must keep showing every session so its own
              -- quick-toggle can re-enable one) - only returned so the
              -- frontend can render an individual row correctly instead
              -- of looking actionable while the workspace master switch
              -- is off. The session's own PLAN's stored ownership
              -- snapshot decides this, never the athlete's current
              -- memberships (see planned_rpe_effective_for_plan).
              training_load.planned_rpe_effective_for_plan(p.id, pd.date) as workspace_planned_rpe_enabled,
              -- (correction round 2) Surfaces WHY a session is currently
              -- non-actionable: the workspace switch being off (see
              -- above) and "this plan's own ownership was never resolved"
              -- are two different situations the coach needs to react to
              -- differently (flip the switch vs. explicitly assign a
              -- workspace) - collapsing them into one boolean would leave
              -- the second case looking like a silently broken switch.
              -- Left join: a weekly plan should always have exactly one
              -- ownership row (backfill + routes/builder.js both
              -- guarantee it), but a missing row is treated the same as
              -- 'unresolved' rather than crashing this query.
              coalesce(o.owner_scope, 'unresolved') as plan_owner_scope
       from plans.plan_sessions ps
       join plans.plan_days pd on pd.id = ps.plan_day_id
       join plans.plans p on p.id = pd.plan_id
       join public.athletes a on a.id = p.athlete_id
       left join training_load.plan_workspace_ownership o on o.plan_id = p.id
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
    // Hardening correction: this used to drop the row entirely once
    // asg.status or s.status was 'cancelled' - which also silently erased
    // an already-COMPLETED result the instant its schedule was cancelled,
    // contradicting the schedule detail view's own promise that
    // historical results stay available. No status-based WHERE filter
    // here at all now - every external assignment in range/scope comes
    // back, tagged with explicit scheduleStatus/assignmentStatus/
    // actionable fields (see the row-building loop below) so each reader
    // (Coach Today/Schedule/Results, the athlete's own weekly overlay)
    // decides what to DO with a paused/cancelled row from those explicit
    // fields, never implicitly from whether the row exists at all.
    const externalResult = await query(
      `select asg.id as assignment_id, asg.local_scheduled_date, asg.opens_at, asg.closes_at, asg.status as assignment_status,
              s.id as schedule_id, s.event_name, s.status as schedule_status,
              a.id as athlete_id, coalesce(a.display_name, a.full_name, concat_ws(' ', a.first_name, a.last_name), a.athlete_id) as athlete_name,
              sf.id as feedback_id, sf.rpe, sf.duration_minutes, sf.srpe, sf.athlete_note, sf.submitted_at
       from training_load.external_assignments asg
       join training_load.external_schedule_occurrences o on o.id = asg.occurrence_id
       join training_load.external_schedules s on s.id = o.schedule_id
       join public.athletes a on a.id = asg.athlete_id
       left join training_load.session_feedback sf on sf.external_assignment_id = asg.id
       where asg.local_scheduled_date between $1::date and $2::date
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
         -- "Orphaned" is inherently a PLANNED concept (a since-changed
         -- plan's own logical_session_id no longer matches a live session);
         -- a scheduled_external result has NO logical_session_id at all
         -- (NULL, per the XOR identity), which trivially satisfies the
         -- NOT EXISTS below for every external row unless excluded here -
         -- found live as a real duplicate row in this exact QA pass.
         and sf.source = 'planned'
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
      const ownershipUnresolved = row.plan_owner_scope === "unresolved";
      // Only ever computed for a row that actually needs it - every
      // resolved/actionable row (the overwhelming majority) skips the
      // extra DB round trip canResolvePlanOwnership's own
      // isAthleteInWorkspaceScope check can require.
      const canResolveOwnership = ownershipUnresolved && resolutionScope
        ? await canResolvePlanOwnership(resolutionScope, { athlete_id: row.athlete_id, created_by_user_id: row.plan_created_by_user_id }, req.user.id)
        : false;
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
        // (v9) The workspace master toggle's own current effective value
        // for THIS session's date - kept separate from rpeEnabled (the
        // per-session flag) so the frontend can tell the two OFF reasons
        // apart ("this session" vs. "this whole workspace") rather than
        // collapsing them into one ambiguous boolean.
        workspacePlannedRpeEnabled: row.workspace_planned_rpe_enabled === true,
        actionable: row.rpe_enabled !== false && row.workspace_planned_rpe_enabled === true,
        // (correction round 2) true when this session's own PLAN has
        // never been assigned a real workspace scope - workspace
        // Planned RPE can never turn this session on by itself; a coach
        // must explicitly resolve the plan's ownership first (see POST
        // /plans/resolve-rpe-ownership). Kept separate from
        // workspacePlannedRpeEnabled so the UI can distinguish "the
        // switch is off" from "this plan was never assigned" - the two
        // require different actions from the coach.
        ownershipUnresolved,
        // (correction round 4) Purely informational - see resolutionScope's
        // own comment above. The frontend uses this ONLY to decide which
        // control to render (an active "Use current workspace for RPE"
        // button vs. a plain "ask the creator/administrator" note); the
        // resolve endpoint itself is the real, re-checked authorization
        // boundary.
        canResolveOwnership,
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
        workspacePlannedRpeEnabled: true,
        actionable: false,
        ownershipUnresolved: false,
        canResolveOwnership: false,
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
        // Explicit fields so every reader (Coach Today/Schedule/Results,
        // the athlete's own weekly overlay) decides what a paused/
        // cancelled row means for itself, never implicitly from whether
        // the row is present at all - see this query's own header
        // comment. actionable never overrides `rated`: a completed
        // result is never "actionable" again, no matter the current
        // schedule/assignment status.
        scheduleStatus: row.schedule_status,
        assignmentStatus: row.assignment_status,
        actionable: row.feedback_id == null && row.schedule_status === "active" && ["pending", "open", "in_progress"].includes(row.assignment_status),
        ownershipUnresolved: false,
        canResolveOwnership: false,
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

// Workspace-scoped target validation - a target must be reachable from
// the CURRENTLY ACTIVE workspace, never from the account's full global
// role set (see trainingLoadAccess.js's own header comment for the exact
// dual-role bug this closes). isAthleteInWorkspaceScope now lives in
// trainingLoadAccess.js (shared with routes/builder.js's own weekly-plan
// target validation) - imported above.
async function isTeamInWorkspaceScope(scope, teamId) {
  if (scope.type === "platform") {
    const r = await query(`select 1 from public.teams where id = $1 and coalesce(is_active, true)`, [teamId]);
    return r.rowCount > 0;
  }
  if (scope.type === "club") {
    const r = await query(`select 1 from public.teams where id = $1 and club_id = $2 and coalesce(is_active, true)`, [teamId, scope.clubId]);
    return r.rowCount > 0;
  }
  if (scope.type === "team") return String(teamId) === String(scope.teamId);
  return false; // private_coach has no team concept to target
}
async function isClubInWorkspaceScope(scope, clubId) {
  if (scope.type === "platform") {
    const r = await query(`select 1 from public.clubs where id = $1 and coalesce(is_active, true)`, [clubId]);
    return r.rowCount > 0;
  }
  if (scope.type === "club") return String(clubId) === String(scope.clubId);
  return false; // a team/private_coach workspace can never target a club
}
async function validateExternalTargetInScope(scope, target) {
  if (target.kind === "athlete") return isAthleteInWorkspaceScope(scope, target.id);
  if (target.kind === "team") return isTeamInWorkspaceScope(scope, target.id);
  if (target.kind === "club") return isClubInWorkspaceScope(scope, target.id);
  return false;
}

// The WHOLE request is rejected on the FIRST invalid target - never a
// partial accepted set (matches tests.js's own resolveValidTargets).
async function resolveValidExternalTargets(scope, rawTargets) {
  const targets = dedupeExternalTargets(rawTargets);
  if (!targets.length) return { ok: false, status: 400, error: "Choose at least one athlete, team or club." };
  // Every target's own id is validated as a real UUID BEFORE it ever
  // reaches a query against a uuid-typed column - isAthleteInWorkspaceScope
  // /isTeamInWorkspaceScope/isClubInWorkspaceScope below bind it straight
  // into a `= $N` comparison against an athletes/teams/clubs.id column,
  // and a malformed string there is a raw Postgres 22P02, not a
  // controlled response.
  if (targets.some((t) => !UUID_PATTERN.test(t.id))) {
    return { ok: false, status: 400, error: "One of the chosen targets has an invalid id." };
  }
  for (const target of targets) {
    const allowed = await validateExternalTargetInScope(scope, target);
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

// Optional label only - never referenced by scheduling/timezone/occurrence
// logic (see migrations_v2/202609011200_training_load_v6...).
const EXTERNAL_EVENT_TYPES = ["team_training", "individual", "gym", "rehabilitation", "match", "other"];

// ------------------------------------------------------------
// Per-schedule notification configuration (migrations_v2/
// 202609020900_training_load_v7...) - notify-when-open / remind-
// incomplete (+ offset) / final-summary. No "kind" for a coach live
// digest - training_load's own GET /weekly already covers that live, by
// design (see this feature's original architecture note).
// ------------------------------------------------------------

const NOTIFICATION_RULE_KINDS = ["athlete_invitation", "athlete_reminder", "final_digest"];
const DEFAULT_NOTIFICATION_RULES = [
  { kind: "athlete_invitation", enabled: true, reminderOffsetMinutes: null },
  { kind: "athlete_reminder", enabled: true, reminderOffsetMinutes: 60 },
  { kind: "final_digest", enabled: true, reminderOffsetMinutes: null },
];
// training_load.external_schedule_notification_rules.reminder_offset_minutes
// is a Postgres `int` column - an offset bigger than this overflows it
// (22003) as a raw 500, not a controlled 400.
const POSTGRES_INT_MAX = 2147483647;

// Validates the client's own notificationRules array (if provided at all -
// omitting the field entirely means "use the defaults", never "disable
// everything"). Each kind may appear at most once; an unrecognized kind,
// a non-boolean enabled, or an out-of-range offset is a controlled 400 -
// never silently dropped or coerced.
//
// Hardening correction: a PARTIAL array (some kinds present, the rest
// omitted) used to leave the omitted kinds with zero DB rows - read by
// the worker as enabled=true (coalesce(nr.enabled, true)), but by the
// edit form's own display fallback (notificationRuleFor) as enabled=
// false once at least one real row existed. Requiring the full set of
// three kinds whenever the field is sent at all (never a partial one)
// closes that gap at the API boundary - normalizeNotificationRuleRows
// below closes the matching read-side gap, so a kind that genuinely has
// no row (e.g. a schedule created before v7) still reads back with the
// SAME true/60/null defaults on every path: UI, detail response, worker.
function resolveValidNotificationRules(rawRules) {
  if (rawRules === undefined) return { ok: true, rules: DEFAULT_NOTIFICATION_RULES };
  if (!Array.isArray(rawRules)) return { ok: false, error: "notificationRules must be an array." };
  const seen = new Set();
  const rules = [];
  for (const raw of rawRules) {
    const kind = text(raw?.kind);
    if (!NOTIFICATION_RULE_KINDS.includes(kind)) return { ok: false, error: `Unrecognized notification kind: ${kind || "(none)"}.` };
    if (seen.has(kind)) return { ok: false, error: `Duplicate notification kind: ${kind}.` };
    seen.add(kind);
    if (typeof raw.enabled !== "boolean") return { ok: false, error: `notificationRules.${kind}.enabled must be a boolean.` };
    let reminderOffsetMinutes = null;
    if (kind === "athlete_reminder") {
      const offsetRaw = raw.reminderOffsetMinutes;
      reminderOffsetMinutes = offsetRaw === undefined || offsetRaw === null ? 60 : offsetRaw;
      if (!Number.isInteger(reminderOffsetMinutes) || reminderOffsetMinutes <= 0 || reminderOffsetMinutes > POSTGRES_INT_MAX) {
        return { ok: false, error: "notificationRules.athlete_reminder.reminderOffsetMinutes must be a positive whole number of minutes." };
      }
    }
    rules.push({ kind, enabled: raw.enabled, reminderOffsetMinutes });
  }
  if (seen.size !== NOTIFICATION_RULE_KINDS.length) {
    return { ok: false, error: `notificationRules must include all of: ${NOTIFICATION_RULE_KINDS.join(", ")}.` };
  }
  return { ok: true, rules };
}

async function insertNotificationRules(client, scheduleId, rules) {
  for (const rule of rules) {
    await client.query(
      `insert into training_load.external_schedule_notification_rules (schedule_id, kind, enabled, reminder_offset_minutes) values ($1,$2,$3,$4)`,
      [scheduleId, rule.kind, rule.enabled, rule.reminderOffsetMinutes],
    );
  }
}

function formatNotificationRuleRow(row) {
  return { kind: row.kind, enabled: row.enabled, reminderOffsetMinutes: row.reminder_offset_minutes };
}

// Normalizes a possibly-partial (or empty) set of DB rows into all three
// kinds, filling any missing kind with the exact same true/60/null
// default resolveValidNotificationRules itself falls back to when the
// field is omitted entirely on create - the one, single effective
// semantics every reader (UI, this detail response, the worker) shares.
function normalizeNotificationRuleRows(rows) {
  const byKind = new Map(rows.map((row) => [row.kind, row]));
  return DEFAULT_NOTIFICATION_RULES.map((def) => {
    const row = byKind.get(def.kind);
    return row ? formatNotificationRuleRow(row) : { ...def };
  });
}

// `datesList` is only ever populated for a schedule_kind='dates' row -
// the caller is expected to have queried external_schedule_dates itself
// (or joined a dates_list array via SQL) and passed it through; every
// other kind's start_date/end_date pair remains the single source of
// truth, unchanged.
function formatExternalScheduleRow(row, datesList) {
  return {
    id: row.id,
    scheduleKind: row.schedule_kind,
    timezone: row.timezone,
    startDate: row.start_date,
    endDate: row.end_date,
    dates: row.schedule_kind === "dates" ? (datesList || row.dates_list || []) : undefined,
    recurrenceRule: row.recurrence_rule || null,
    opensTime: row.opens_time,
    dueTime: row.due_time,
    closesTime: row.closes_time,
    status: row.status,
    eventName: row.event_name,
    eventType: row.event_type || null,
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

// Builds the schedule_kind/recurrence_rule/date-range/explicit-dates
// shape from the create/schedule-again request body.
//
// Hardening correction (item 10): "Dates" (multiple specific dates)
// used to have no dedicated schema-level kind of its own - it was
// expressed as N independent one_time schedules, created together in
// one request via a `dates` array, but with no shared identity
// afterward (N separate Edit/Pause/Cancel, no single "Schedule again").
// Now it resolves to exactly ONE schedule of kind 'dates', with its
// own explicit date rows in training_load.external_schedule_dates
// (see migrations_v2/202609030900). start_date/end_date on that one row
// are only ever the min/max of its own dates, for sorting/display -
// never authoritative (see generate_external_schedule_occurrence). A
// single-element `dates` array is still `dates`, not `one_time` -
// "5 disconnected cards" was the actual bug, not whether N happened to
// be 1 on a given request.
function resolveExternalScheduleKindAndDates(body) {
  const datesInput = Array.isArray(body?.dates) ? body.dates.map((d) => text(d)).filter(Boolean) : [];
  if (datesInput.length) {
    const dates = Array.from(new Set(datesInput)).sort();
    return { scheduleKind: "dates", recurrenceRule: null, startDate: dates[0], endDate: dates[dates.length - 1], dates };
  }
  const scheduleKindInput = text(body?.scheduleKind) === "recurring" ? "recurring" : "one_time";
  if (scheduleKindInput === "recurring") {
    const startDate = text(body?.startDate);
    const endDate = text(body?.endDate) || null;
    return { scheduleKind: "recurring", recurrenceRule: { version: 1, freq: "daily" }, startDate, endDate, dates: null };
  }
  const startDate = text(body?.startDate);
  return { scheduleKind: "one_time", recurrenceRule: null, startDate, endDate: null, dates: null };
}

async function insertExternalSchedule(client, { scheduleKind, timezone, startDate, endDate, recurrenceRule, opensTime, dueTime, closesTime, eventName, eventType, eventNote, userId, owner }) {
  const result = await client.query(
    `insert into training_load.external_schedules
       (schedule_kind, timezone, start_date, end_date, recurrence_rule, recurrence_rule_version, opens_time, due_time, closes_time, status, event_name, event_type, event_note, created_by_user_id, owner_scope, owner_user_id, owner_club_id, owner_team_id)
     values ($1,$2,$3,$4,$5,1,$6,$7,$8,'active',$9,$10,$11,$12,$13,$14,$15,$16)
     returning *`,
    [scheduleKind, timezone, startDate, endDate, recurrenceRule, opensTime, dueTime, closesTime, eventName, eventType, eventNote, userId, owner.ownerScope, owner.ownerUserId, owner.ownerClubId, owner.ownerTeamId],
  );
  return result.rows[0];
}

async function insertExternalScheduleDates(client, scheduleId, dates) {
  for (const scheduledDate of dates) {
    await client.query(
      `insert into training_load.external_schedule_dates (schedule_id, scheduled_date) values ($1,$2)`,
      [scheduleId, scheduledDate],
    );
  }
}

// Shared field validator/resolver for POST create AND POST schedule-again -
// eliminates the split where schedule-again used to accept only
// startDate/endDate and blindly copy every other field from the source,
// silently discarding anything the coach actually changed on a form that
// showed it as editable (hardening correction, item 1). `fallback` is
// null for a real create (every field below is required, exactly as
// before); the SOURCE schedule row for schedule-again (an omitted field
// falls back to the source's own current value - but scheduleKind/dates
// are NEVER read from `fallback` at all, only from `body`, via
// resolveExternalScheduleKindAndDates below - a fresh pick is always
// required, and the new schedule is free to pick a DIFFERENT kind than
// the source, closing the "source dates, coach picks Daily" mismatch).
//
// Also where the DB's own CHECK-constraint RELATIONSHIPS (opens<=closes,
// due between opens/closes, end>=start) are validated before the
// transaction even starts (item 3) - previously only each individual
// field's own FORMAT was checked, never how they relate to each other,
// so e.g. opensTime later than closesTime reached the DB as a raw 23514.
function resolveAndValidateExternalScheduleBody(body, fallback) {
  const eventName = body.eventName !== undefined ? text(body.eventName) : (fallback ? fallback.event_name : "");
  if (!eventName || eventName.length > 120) return { ok: false, status: 400, error: "Event name is required (120 characters max)." };
  const eventNote = body.eventNote !== undefined ? nullableText(body.eventNote) : (fallback ? fallback.event_note : null);
  if (eventNote && eventNote.length > 500) return { ok: false, status: 400, error: "Note is too long (500 characters max)." };
  let eventType = fallback ? fallback.event_type : null;
  if (body.eventType !== undefined) {
    const eventTypeInput = nullableText(body.eventType);
    if (eventTypeInput && !EXTERNAL_EVENT_TYPES.includes(eventTypeInput)) return { ok: false, status: 400, error: "Invalid event type." };
    eventType = eventTypeInput || null;
  }
  const timezone = body.timezone !== undefined ? text(body.timezone) : (fallback ? fallback.timezone : "");
  const opensTime = body.opensTime !== undefined ? text(body.opensTime) : (fallback ? fallback.opens_time : "");
  const dueTime = body.dueTime !== undefined ? (text(body.dueTime) || null) : (fallback ? fallback.due_time : null);
  const closesTime = body.closesTime !== undefined ? text(body.closesTime) : (fallback ? fallback.closes_time : "");
  if (!timezone || !opensTime || !closesTime) return { ok: false, status: 400, error: "Timezone, opens time and closes time are required." };
  if (!isValidTimeString(opensTime) || !isValidTimeString(closesTime) || (dueTime !== null && !isValidTimeString(dueTime))) {
    return { ok: false, status: 400, error: "Opens/due/closes time must be a valid HH:MM time." };
  }
  if (opensTime > closesTime) return { ok: false, status: 400, error: "Opens time must not be after closes time." };
  if (dueTime !== null && (dueTime < opensTime || dueTime > closesTime)) {
    return { ok: false, status: 400, error: "Due time must be between opens time and closes time." };
  }

  const { scheduleKind, recurrenceRule, startDate, endDate, dates } = resolveExternalScheduleKindAndDates(body);
  const datesToValidate = scheduleKind === "dates" ? dates : [startDate, ...(endDate ? [endDate] : [])];
  if (!datesToValidate.length || !startDate) return { ok: false, status: 400, error: "At least one date is required." };
  if (datesToValidate.some((d) => !isValidGregorianDateString(d))) {
    return { ok: false, status: 400, error: "Every date must be a valid YYYY-MM-DD date." };
  }
  if (scheduleKind === "recurring" && endDate !== null && endDate < startDate) {
    return { ok: false, status: 400, error: "endDate must not be before startDate." };
  }

  return { ok: true, eventName, eventType, eventNote, timezone, opensTime, dueTime, closesTime, scheduleKind, recurrenceRule, startDate, endDate, dates };
}

router.post("/external-schedules", async (req, res, next) => {
  const client = await pool.connect();
  try {
    const scope = await requireExternalScheduleWorkspace(req, res);
    if (!scope) return;
    const body = req.body || {};
    const validated = resolveAndValidateExternalScheduleBody(body, null);
    if (!validated.ok) return res.status(validated.status).json({ error: validated.error });

    const resolved = await resolveValidExternalTargets(scope, body.targets);
    if (!resolved.ok) return res.status(resolved.status).json({ error: resolved.error });

    const resolvedRules = resolveValidNotificationRules(body.notificationRules);
    if (!resolvedRules.ok) return res.status(400).json({ error: resolvedRules.error });

    // Resolved ONCE, inside requireExternalScheduleWorkspace above - never
    // re-derived from a second resolveActiveWorkspace call later in this
    // same request (hardening correction, item 5: a workspace switch
    // landing between two independent reads could validate targets
    // against workspace A but stamp ownership from workspace B).
    const owner = scope.ownerContext;
    await client.query("begin");
    // One schedule row regardless of kind - a "Dates" pick of N dates is
    // ONE logical schedule (item 10's own fix), never N independent rows.
    const schedule = await insertExternalSchedule(client, {
      scheduleKind: validated.scheduleKind, timezone: validated.timezone, startDate: validated.startDate, endDate: validated.endDate,
      recurrenceRule: validated.recurrenceRule ? JSON.stringify(validated.recurrenceRule) : null,
      opensTime: validated.opensTime, dueTime: validated.dueTime, closesTime: validated.closesTime,
      eventName: validated.eventName, eventType: validated.eventType, eventNote: validated.eventNote,
      userId: req.user.id, owner,
    });
    if (validated.scheduleKind === "dates") await insertExternalScheduleDates(client, schedule.id, validated.dates);
    await insertExternalTargets(client, schedule.id, resolved.targets);
    await insertNotificationRules(client, schedule.id, resolvedRules.rules);
    await client.query("commit");
    // Still an array in the response - existing/older callers reading
    // schedules[0] keep working unchanged; it's simply always length 1 now.
    res.status(201).json({ schedules: [formatExternalScheduleRow(schedule, validated.scheduleKind === "dates" ? validated.dates : undefined)] });
  } catch (error) {
    await client.query("rollback").catch(() => {});
    respondToWriteError(res, next, error);
  } finally {
    client.release();
  }
});

router.get("/external-schedules", async (req, res, next) => {
  try {
    const workspaceScope = await requireExternalScheduleWorkspace(req, res);
    if (!workspaceScope) return;
    const params = [];
    const scopeSql = externalScheduleScopeSqlForWorkspace(workspaceScope, params);
    const statusFilter = text(req.query?.status);
    let statusSql = "";
    if (["active", "paused", "cancelled"].includes(statusFilter)) {
      params.push(statusFilter);
      statusSql = `and s.status = $${params.length}`;
    }
    const result = await query(
      `select s.*, (select count(*)::int from training_load.external_schedule_targets t where t.schedule_id = s.id) as target_count,
              (select array_agg(d.scheduled_date::text order by d.scheduled_date) from training_load.external_schedule_dates d where d.schedule_id = s.id) as dates_list
       from training_load.external_schedules s
       where ${scopeSql} ${statusSql}
       order by s.start_date desc, s.created_at desc`,
      params,
    );
    res.json({ schedules: result.rows.map((row) => formatExternalScheduleRow(row, row.dates_list)) });
  } catch (error) {
    next(error);
  }
});

router.get("/external-schedules/:scheduleId", async (req, res, next) => {
  try {
    const scope = await requireExternalScheduleWorkspace(req, res);
    if (!scope) return;
    if (!UUID_PATTERN.test(req.params.scheduleId)) return res.status(404).json({ error: "Schedule not found." });
    const scheduleResult = await query(`select * from training_load.external_schedules where id = $1`, [req.params.scheduleId]);
    const schedule = scheduleResult.rows[0];
    if (!schedule || !canManageExternalScheduleInScope(scope, schedule)) return res.status(404).json({ error: "Schedule not found." });
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
    const notificationRulesResult = await query(
      `select kind, enabled, reminder_offset_minutes from training_load.external_schedule_notification_rules where schedule_id = $1`,
      [schedule.id],
    );
    const datesResult = schedule.schedule_kind === "dates"
      ? await query(`select scheduled_date::text as scheduled_date from training_load.external_schedule_dates where schedule_id = $1 order by scheduled_date`, [schedule.id])
      : null;
    res.json({
      schedule: formatExternalScheduleRow(schedule, datesResult?.rows.map((r) => r.scheduled_date)),
      targets: targetsResult.rows.map(formatExternalTargetRow),
      occurrences: occurrencesResult.rows.map((row) => ({ id: row.id, scheduledDate: row.scheduled_date, status: row.status, assignmentCount: row.assignment_count, ratedCount: row.rated_count })),
      notificationRules: normalizeNotificationRuleRows(notificationRulesResult.rows),
    });
  } catch (error) {
    next(error);
  }
});

router.patch("/external-schedules/:scheduleId", async (req, res, next) => {
  const client = await pool.connect();
  try {
    const scope = await requireExternalScheduleWorkspace(req, res);
    if (!scope) return;
    if (!UUID_PATTERN.test(req.params.scheduleId)) return res.status(404).json({ error: "Schedule not found." });
    await client.query("begin");
    const scheduleResult = await client.query(`select * from training_load.external_schedules where id = $1 for update`, [req.params.scheduleId]);
    const schedule = scheduleResult.rows[0];
    if (!schedule || !canManageExternalScheduleInScope(scope, schedule)) {
      await client.query("rollback");
      return res.status(404).json({ error: "Schedule not found." });
    }
    const body = req.body || {};
    // Hardening correction (item 2): startDate/dates/scheduleKind are
    // identity, fixed at creation - Schedule again is the only way to
    // pick a new one. These three used to be silently ignored (PATCH
    // never read them at all) rather than rejected, the same "control
    // that looks functional while the backend ignores it" problem the
    // Edit calendar itself had (item 10) - now a controlled 400, exactly
    // like the existing endDate-on-a-non-recurring-schedule guard below.
    if (body.startDate !== undefined || body.dates !== undefined || body.scheduleKind !== undefined) {
      await client.query("rollback");
      return res.status(400).json({ error: "startDate/dates/scheduleKind cannot be changed after creation - use Schedule again to pick a new date/kind." });
    }
    const eventName = body.eventName !== undefined ? text(body.eventName) : schedule.event_name;
    if (!eventName || eventName.length > 120) {
      await client.query("rollback");
      return res.status(400).json({ error: "Event name is required (120 characters max)." });
    }
    const eventNote = body.eventNote !== undefined ? nullableText(body.eventNote) : schedule.event_note;
    // Hardening correction (item 3): this length check was missing on
    // PATCH entirely (POST create always had it) - a note over 500
    // characters reached the DB's own event_note CHECK as a raw 23514.
    if (eventNote && eventNote.length > 500) {
      await client.query("rollback");
      return res.status(400).json({ error: "Note is too long (500 characters max)." });
    }
    let eventType = schedule.event_type;
    if (body.eventType !== undefined) {
      const eventTypeInput = nullableText(body.eventType);
      if (eventTypeInput && !EXTERNAL_EVENT_TYPES.includes(eventTypeInput)) {
        await client.query("rollback");
        return res.status(400).json({ error: "Invalid event type." });
      }
      eventType = eventTypeInput || null;
    }
    const opensTime = body.opensTime !== undefined ? text(body.opensTime) : schedule.opens_time;
    const dueTime = body.dueTime !== undefined ? (text(body.dueTime) || null) : schedule.due_time;
    const closesTime = body.closesTime !== undefined ? text(body.closesTime) : schedule.closes_time;
    // Hardening correction (item 2): the fallback timezone shown on Edit
    // was fully editable and sent in the PATCH body, but this route never
    // read it at all - a silently-ignored control, same class of bug as
    // the old Edit calendar (item 10). A schedule's own timezone column
    // is only ever a FALLBACK read at MATERIALIZATION time for an athlete
    // with no device_timezone of their own (see migrations_v2's own
    // resolve_current_external_target_dates/materialize_external_
    // assignments_for_occurrence) - changing it here can only ever affect
    // a future, not-yet-materialized assignment; every already-
    // materialized external_assignments row already has its OWN frozen
    // timezone/window snapshot, immutable via its own DB trigger, so
    // existing assignments are structurally unaffected by this change,
    // never re-read. An invalid IANA name is rejected by the schedule's
    // own existing insert/update trigger (validate_external_schedule_
    // timezone_and_recurrence), mapped to a controlled 400 by
    // respondToWriteError's P0001 branch below - never a raw 500.
    const timezone = body.timezone !== undefined ? text(body.timezone) : schedule.timezone;
    if (body.timezone !== undefined && !timezone) {
      await client.query("rollback");
      return res.status(400).json({ error: "timezone must not be empty." });
    }
    // endDate is only ever a real, meaningful edit for a 'recurring'
    // schedule (extending/shortening its own open-ended window) - for
    // 'one_time'/'dates', start_date/end_date are fixed identity (a
    // 'dates' schedule's own end_date is just the max of its
    // external_schedule_dates rows, informational only). Rather than
    // silently ignoring a client-supplied endDate there (which would
    // look like it worked), it's a controlled 400 - same "never leave a
    // control that looks functional while the backend ignores it" rule
    // this whole correction is about, applied at the API boundary too.
    // scheduleKind/startDate/dates are never accepted here at all (never
    // read from body anywhere in this route) - the same rule, for the
    // fields that are already read-only, not just editable-but-ignored.
    if (body.endDate !== undefined && schedule.schedule_kind !== "recurring") {
      await client.query("rollback");
      return res.status(400).json({ error: "endDate can only be changed on a recurring (Daily) schedule." });
    }
    const endDate = body.endDate !== undefined ? (text(body.endDate) || null) : schedule.end_date;
    // Only a client-SUPPLIED value's own FORMAT is validated here - the
    // existing stored value (read straight from the DB row above when a
    // field was omitted) was already validated on the request that wrote
    // it. The RELATIONSHIPS between the final, merged values (item 3)
    // are checked separately right after, regardless of which individual
    // field actually changed - a lone opensTime edit that now lands
    // after the UNCHANGED closesTime must be caught here too, not just
    // when both are supplied in the same request.
    if (
      (body.opensTime !== undefined && !isValidTimeString(opensTime))
      || (body.closesTime !== undefined && !isValidTimeString(closesTime))
      || (body.dueTime !== undefined && dueTime !== null && !isValidTimeString(dueTime))
    ) {
      await client.query("rollback");
      return res.status(400).json({ error: "Opens/due/closes time must be a valid HH:MM time." });
    }
    if (body.endDate !== undefined && endDate !== null && !isValidGregorianDateString(endDate)) {
      await client.query("rollback");
      return res.status(400).json({ error: "endDate must be a valid YYYY-MM-DD date." });
    }
    if (opensTime > closesTime) {
      await client.query("rollback");
      return res.status(400).json({ error: "Opens time must not be after closes time." });
    }
    if (dueTime !== null && (dueTime < opensTime || dueTime > closesTime)) {
      await client.query("rollback");
      return res.status(400).json({ error: "Due time must be between opens time and closes time." });
    }
    if (endDate !== null && endDate < schedule.start_date) {
      await client.query("rollback");
      return res.status(400).json({ error: "endDate must not be before startDate." });
    }

    await client.query(
      `update training_load.external_schedules
       set event_name = $2, event_type = $3, event_note = $4, opens_time = $5, due_time = $6, closes_time = $7, end_date = $8, timezone = $9, updated_at = now()
       where id = $1`,
      [schedule.id, eventName, eventType, eventNote, opensTime, dueTime, closesTime, endDate, timezone],
    );
    if (body.targets !== undefined) {
      const resolved = await resolveValidExternalTargets(scope, body.targets);
      if (!resolved.ok) {
        await client.query("rollback");
        return res.status(resolved.status).json({ error: resolved.error });
      }
      await client.query(`delete from training_load.external_schedule_targets where schedule_id = $1`, [schedule.id]);
      await insertExternalTargets(client, schedule.id, resolved.targets);
    }
    if (body.notificationRules !== undefined) {
      // Unlike create (where an omitted field means "use the defaults"),
      // PATCH omitting the field entirely means "leave rules untouched" -
      // only entering this branch at all means the coach actually sent a
      // new array, replaced wholesale (same "touched if present" rule as
      // targets above).
      const resolvedRules = resolveValidNotificationRules(body.notificationRules);
      if (!resolvedRules.ok) {
        await client.query("rollback");
        return res.status(400).json({ error: resolvedRules.error });
      }
      await client.query(`delete from training_load.external_schedule_notification_rules where schedule_id = $1`, [schedule.id]);
      await insertNotificationRules(client, schedule.id, resolvedRules.rules);
    }
    await client.query("commit");
    const freshResult = await query(
      `select s.*, (select array_agg(d.scheduled_date::text order by d.scheduled_date) from training_load.external_schedule_dates d where d.schedule_id = s.id) as dates_list
       from training_load.external_schedules s where s.id = $1`,
      [schedule.id],
    );
    res.json({ schedule: formatExternalScheduleRow(freshResult.rows[0], freshResult.rows[0].dates_list) });
  } catch (error) {
    await client.query("rollback").catch(() => {});
    respondToWriteError(res, next, error);
  } finally {
    client.release();
  }
});

// Hardening correction (item 4): this used to run an UNLOCKED SELECT,
// check `status` in JS, then an unconditional UPDATE - no protection
// against a concurrent request racing between those two steps. A cancel
// and a resume issued back-to-back could both read the same pre-
// transition status, and whichever UPDATE happened to commit LAST would
// win regardless of which the coach actually intended - including
// reviving an already-cancelled schedule via a late-landing resume. A
// real row lock (FOR UPDATE) here is the "schedule" step of this
// feature's own existing lock-order convention (schedule -> occurrence
// -> assignment, e.g. ensureCurrentExternalOccurrence/the submit route)
// - this function only ever touches the schedule row itself, so
// acquiring just that lock fully serializes concurrent status changes.
// The UPDATE's own `and status <> 'cancelled'` guard then re-asserts the
// same invariant at the SQL level, not just in JS before it - belt and
// suspenders, not redundant: the JS check covers the normal case with a
// clear error message, the WHERE guard covers it even if that check were
// ever bypassed or reordered by a future edit.
async function setExternalScheduleStatus(req, res, next, newStatus) {
  const client = await pool.connect();
  try {
    const scope = await requireExternalScheduleWorkspace(req, res);
    if (!scope) return;
    if (!UUID_PATTERN.test(req.params.scheduleId)) return res.status(404).json({ error: "Schedule not found." });
    await client.query("begin");
    const scheduleResult = await client.query(`select * from training_load.external_schedules where id = $1 for update`, [req.params.scheduleId]);
    const schedule = scheduleResult.rows[0];
    if (!schedule || !canManageExternalScheduleInScope(scope, schedule)) {
      await client.query("rollback");
      return res.status(404).json({ error: "Schedule not found." });
    }
    if (schedule.status === "cancelled") {
      await client.query("rollback");
      return res.status(400).json({ error: "This schedule was already cancelled." });
    }
    const updateResult = await client.query(
      `update training_load.external_schedules set status = $2, updated_at = now() where id = $1 and status <> 'cancelled' returning *`,
      [schedule.id, newStatus],
    );
    if (!updateResult.rowCount) {
      await client.query("rollback");
      return res.status(400).json({ error: "This schedule was already cancelled." });
    }
    await client.query("commit");
    res.json({ schedule: formatExternalScheduleRow(updateResult.rows[0]) });
  } catch (error) {
    await client.query("rollback").catch(() => {});
    next(error);
  } finally {
    client.release();
  }
}
router.post("/external-schedules/:scheduleId/pause", (req, res, next) => setExternalScheduleStatus(req, res, next, "paused"));
router.post("/external-schedules/:scheduleId/resume", (req, res, next) => setExternalScheduleStatus(req, res, next, "active"));
router.post("/external-schedules/:scheduleId/cancel", (req, res, next) => setExternalScheduleStatus(req, res, next, "cancelled"));

// Creates a genuinely NEW schedule - never mutates or reactivates the
// original (cancelled or not), and never copies dates/occurrences/
// assignments/responses/history.
//
// Hardening correction (item 1): this used to accept ONLY startDate/
// endDate and blindly copy every other field straight from the source
// row - the coach's own Edit form showed name/type/times/note/targets/
// timezone/notifications as fully editable on THIS same screen, but any
// change to them was silently discarded, and the source's own targets
// were re-inserted without re-checking whether they're still inside the
// coach's currently active workspace. This route now runs the exact same
// validator as a real create (resolveAndValidateExternalScheduleBody),
// with the SOURCE row as the fallback for any field the client omits -
// so every displayed field genuinely applies when changed, an omitted
// field still round-trips through the same validation the source itself
// once passed, and scheduleKind/dates are ALWAYS taken fresh from the
// request (never the source) - a genuinely new pick is required, and the
// new schedule is free to pick a different kind entirely (closes the old
// "source is Dates, coach picks Daily" mismatch, where the backend kept
// silently requiring a dates[] array regardless of what the form showed).
router.post("/external-schedules/:scheduleId/schedule-again", async (req, res, next) => {
  const client = await pool.connect();
  try {
    const scope = await requireExternalScheduleWorkspace(req, res);
    if (!scope) return;
    if (!UUID_PATTERN.test(req.params.scheduleId)) return res.status(404).json({ error: "Schedule not found." });
    const sourceResult = await query(`select * from training_load.external_schedules where id = $1`, [req.params.scheduleId]);
    const source = sourceResult.rows[0];
    if (!source || !canManageExternalScheduleInScope(scope, source)) return res.status(404).json({ error: "Schedule not found." });

    const body = req.body || {};
    const validated = resolveAndValidateExternalScheduleBody(body, source);
    if (!validated.ok) return res.status(validated.status).json({ error: validated.error });

    // Targets: from the request body if supplied; otherwise fall back to
    // the source's own current targets - but EITHER WAY, always
    // re-validated against the request's own active workspace scope, the
    // exact same check a real create runs. A target that has since left
    // the active workspace can never be silently copied over unchecked.
    let targetsInput = body.targets;
    if (targetsInput === undefined) {
      const sourceTargetsResult = await query(
        `select target_kind, target_athlete_id, target_team_id, target_club_id from training_load.external_schedule_targets where schedule_id = $1`,
        [source.id],
      );
      targetsInput = sourceTargetsResult.rows.map((t) => ({ kind: t.target_kind, id: t.target_athlete_id || t.target_team_id || t.target_club_id }));
    }
    const resolvedTargets = await resolveValidExternalTargets(scope, targetsInput);
    if (!resolvedTargets.ok) return res.status(resolvedTargets.status).json({ error: resolvedTargets.error });

    // Notification rules: same "from body if present, else copy source"
    // fallback, still fully re-validated either way.
    let rulesInput = body.notificationRules;
    if (rulesInput === undefined) {
      const sourceRulesResult = await query(
        `select kind, enabled, reminder_offset_minutes from training_load.external_schedule_notification_rules where schedule_id = $1`,
        [source.id],
      );
      rulesInput = normalizeNotificationRuleRows(sourceRulesResult.rows);
    }
    const resolvedRules = resolveValidNotificationRules(rulesInput);
    if (!resolvedRules.ok) return res.status(400).json({ error: resolvedRules.error });

    // Resolved once, inside requireExternalScheduleWorkspace above - see
    // the matching comment on POST /external-schedules (item 5).
    const owner = scope.ownerContext;
    await client.query("begin");
    const schedule = await insertExternalSchedule(client, {
      scheduleKind: validated.scheduleKind, timezone: validated.timezone, startDate: validated.startDate, endDate: validated.endDate,
      recurrenceRule: validated.recurrenceRule ? JSON.stringify(validated.recurrenceRule) : null,
      opensTime: validated.opensTime, dueTime: validated.dueTime, closesTime: validated.closesTime,
      eventName: validated.eventName, eventType: validated.eventType, eventNote: validated.eventNote,
      userId: req.user.id, owner,
    });
    if (validated.scheduleKind === "dates") await insertExternalScheduleDates(client, schedule.id, validated.dates);
    await insertExternalTargets(client, schedule.id, resolvedTargets.targets);
    await insertNotificationRules(client, schedule.id, resolvedRules.rules);
    await client.query("commit");
    res.status(201).json({ schedule: formatExternalScheduleRow(schedule, validated.scheduleKind === "dates" ? validated.dates : undefined) });
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
    const occurrenceResult = await client.query(`select status from training_load.external_schedule_occurrences where id = $1 for update`, [lookup.occurrence_id]);
    const occurrence = occurrenceResult.rows[0];
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
    // Defensive: no route currently transitions an occurrence to
    // 'cancelled' (only a schedule itself is cancelled, already gated
    // above), but the notification worker's own guard treats a cancelled
    // occurrence as terminal too (see runInvitationPhase/runReminderPhase)
    // - submit must agree, never rely on it being unreachable today.
    if (occurrence.status === "cancelled") {
      await client.query("rollback");
      return res.status(409).json({ error: "This isn't currently accepting submissions." });
    }

    // Every terminal assignment state EXCEPT 'completed' is closed here,
    // up front, before any INSERT is attempted. 'completed' is
    // deliberately NOT included - an identical retry against an already-
    // completed assignment is a valid, tested idempotent 200 (see the
    // ON CONFLICT DO NOTHING + existing-row comparison below), and must
    // stay reachable. 'missed'/'excused'/'cancelled' are genuinely
    // terminal-non-submittable: without this check, the INSERT below
    // would succeed and only THEN hit the DB's own forward-only lifecycle
    // trigger on the follow-up `status = 'completed'` UPDATE, surfacing
    // as an uncontrolled 500 (via this route's own catch -> next(error),
    // not respondToWriteError) instead of a clean 409 - found in review.
    if (["missed", "excused", "cancelled"].includes(assignment.status)) {
      await client.query("rollback");
      return res.status(409).json({ error: "This check-in window is closed." });
    }

    const nowResult = await client.query(`select now() as now`);
    const now = nowResult.rows[0].now;
    if (now < assignment.opens_at || now > assignment.closes_at) {
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
  // Hardening correction: scheduleId itself used to reach the very first
  // DB query with no UUID format check at all - a malformed path param
  // was a raw Postgres 22P02, not the controlled 404 every other route
  // in this file already gives a malformed id.
  if (!UUID_PATTERN.test(req.params.scheduleId)) return res.status(404).json({ error: "Schedule not found." });

  // Hardening correction: assignmentIds used to be silently FILTERED
  // (non-string/empty elements just dropped) before ever being checked
  // for length or UUID shape - [validUuid, 123] or [validUuid, ""]
  // quietly became a single-element batch that then succeeded, instead
  // of the whole malformed request being rejected. Every element's own
  // TYPE is now checked first (never silently dropped), then every
  // surviving id's FORMAT, both before any transaction/write starts -
  // one malformed element rejects the whole batch with zero writes.
  const rawInput = req.body?.assignmentIds;
  if (!Array.isArray(rawInput) || !rawInput.length) return res.status(400).json({ error: "assignmentIds is required." });
  if (rawInput.some((id) => typeof id !== "string" || !id)) {
    return res.status(400).json({ error: "assignmentIds must all be non-empty strings." });
  }
  const rawAssignmentIds = [...new Set(rawInput)];
  if (rawAssignmentIds.some((id) => !UUID_PATTERN.test(id))) {
    return res.status(400).json({ error: "assignmentIds must all be valid UUIDs." });
  }
  const assignmentIds = rawAssignmentIds;

  const scope = await requireExternalScheduleWorkspace(req, res);
  if (!scope) return;

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
    if (!canManageExternalScheduleInScope(scope, schedule)) {
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
