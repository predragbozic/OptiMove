import { Router } from "express";
import { pool, query } from "../db.js";
import { assignmentIsOpen, loadAthleteTodayTestAssignments } from "../testsOccurrenceService.js";

const router = Router();

// feature/athlete-home-mvp: a single aggregated read for the athlete
// shell's new Home tab (today's training, this week's training strip, and
// up to 3 active specific programs).
//
// Athlete resolution is the whole point of this endpoint's safety story:
// req.authz.athleteId is the real public.athletes.id linked via
// athletes.user_id = the authenticated account (loaded once per request by
// attachAuthorizationContext - see backend/src/authz.js). This route never
// reads an athleteId from a route param, query string, or request body -
// there is no way for one account's session to ever ask for a DIFFERENT
// athlete's Home data. req.authz.athleteId is deliberately NOT filtered on
// athletes.is_active (see authz.js's own comment on that query) - an
// archived-but-still-logged-in athlete profile keeps seeing its own Home,
// matching the same already-agreed policy applied everywhere else
// athleteId is resolved this way (workspace/capabilities).
//
// A disabled login can never reach this handler at all: disabling a login
// deletes every one of that account's sessions (see setUserLoginStatus in
// backend/src/routes/organization.js), so requireAuth's session lookup
// already fails before this route runs - no separate is_active check on
// public.users is needed here.
//
// Query count: exactly 3, none per-row/N+1 (documented per query below).
router.get("/", async (req, res, next) => {
  try {
    const athleteId = req.authz?.athleteId;
    if (!athleteId) return res.status(403).json({ error: "NO_ATHLETE_PROFILE" });

    const [athleteResult, weekResult, programsResult, wellnessAssignments] = await Promise.all([
      // 1) Athlete identity for the header (name/photo) - a single row by
      // primary key, not a scan.
      query(
        `select coalesce(display_name, full_name, concat_ws(' ', first_name, last_name), athlete_id) as name,
                image_url
         from public.athletes
         where id = $1
         limit 1`,
        [athleteId],
      ),
      // 2) This week's training, reusing plans.v_weekly_plan_items - the
      // exact same view GET /api/athletes/today and
      // GET /api/athletes/:id/program-data?program=__weekly__ already
      // build on. generate_series produces all 7 calendar days of the
      // current ISO week (Monday-start, matching date_trunc('week', ...))
      // up front, so every day - including ones with zero training - comes
      // back as exactly one row; "today" is identified by Postgres's own
      // current_date, not by comparing against a date computed separately
      // in JS, so there is no server/client clock skew risk. Today's own
      // card is read off this SAME result set (the row where is_today is
      // true) instead of a second, near-duplicate query.
      query(
        `select gs.date::date as date,
                (gs.date::date = current_date) as is_today,
                coalesce(agg.session_count, 0)::int as session_count,
                coalesce(agg.item_count, 0)::int as item_count,
                agg.plan_id,
                agg.plan_name
         from generate_series(
           date_trunc('week', current_date)::date,
           date_trunc('week', current_date)::date + interval '6 days',
           interval '1 day'
         ) as gs(date)
         left join (
           select date,
                  count(distinct plan_session_id) as session_count,
                  count(distinct plan_item_id) filter (where plan_item_id is not null) as item_count,
                  (array_agg(plan_id order by plan_id))[1] as plan_id,
                  (array_agg(plan_name order by plan_id))[1] as plan_name
           from plans.v_weekly_plan_items
           where athlete_uuid = $1
           group by date
         ) agg on agg.date = gs.date::date
         order by gs.date`,
        [athleteId],
      ),
      // 3) Active specific programs, reusing plans.v_plan_summary - the
      // same view GET /api/athletes/:id/program-data?program=__all_programs__
      // already uses. session/item counts and cover images already live on
      // the view itself, so no per-program join is needed here (that's the
      // N+1 this endpoint deliberately avoids - one query returns every
      // program's display data at once, capped to a normal athlete's small
      // program count, never a per-row follow-up query).
      query(
        `select plan_id, plan_name, cover_image_url,
                coalesce(session_count, 0)::int as session_count,
                coalesce(item_count, 0)::int as item_count
         from plans.v_plan_summary
         where athlete_uuid = $1
           and plan_type = 'program'
           and is_template = false
         order by program_order nulls last, plan_name`,
        [athleteId],
      ),
      // 4) Item 5: the athlete's own open, not-yet-completed WELLNESS
      // assignment(s) for today, for the compact card shown just above
      // "Today's training". Shares the exact same "ensure occurrences,
      // then read today's real assignment rows" logic GET /api/tests/
      // athlete/today uses (testsOccurrenceService.js's
      // loadAthleteTodayTestAssignments) - never a second, duplicated copy
      // of that occurrence-generation/query logic. This call itself is
      // what may materialize a brand-new assignment on-demand, so it must
      // never run before this athlete's device timezone has already been
      // reported for this session - callers of GET /api/athlete-home are
      // required to await reportDeviceTimezone() first, exactly the same
      // ordering rule every other Tests entry point already follows (see
      // frontend/tests-data.js's own header comment).
      loadAthleteTodayTestAssignments(pool, query, athleteId),
    ]);

    const athleteRow = athleteResult.rows[0] || {};
    const todayRow = weekResult.rows.find((row) => row.is_today) || null;
    const programRows = programsResult.rows;
    // Only a genuinely actionable assignment counts here - pending, its own
    // SCHEDULE still active (assignmentIsOpen only checks the assignment's
    // own status/opens_at/closes_at, never the schedule's - a paused
    // schedule's still-open assignment would otherwise keep showing as
    // "Complete now" even though POST /assignments/:id/submit already
    // rejects it), AND currently inside its own open window - a completed
    // or missed one must never show as pending either.
    const openWellness = wellnessAssignments.filter((row) => row.status === "pending" && row.schedule_status === "active" && assignmentIsOpen(row));

    res.json({
      athlete: {
        name: athleteRow.name || "",
        imageUrl: athleteRow.image_url || "",
      },
      today: {
        date: todayRow?.date || null,
        hasTraining: Boolean(todayRow && todayRow.session_count > 0),
        planId: todayRow?.plan_id || null,
        planName: todayRow?.plan_name || "",
        sessionCount: todayRow?.session_count || 0,
        itemCount: todayRow?.item_count || 0,
      },
      week: {
        days: weekResult.rows.map((row) => ({
          date: row.date,
          isToday: Boolean(row.is_today),
          hasTraining: row.session_count > 0,
        })),
      },
      programs: {
        rows: programRows.slice(0, 3).map((row) => ({
          id: row.plan_id,
          name: row.plan_name,
          imageUrl: row.cover_image_url || "",
          sessionCount: row.session_count,
          itemCount: row.item_count,
        })),
        total: programRows.length,
      },
      // Item 5: the WELLNESS card. count > 1 means the Home card should
      // route to the Tests Today list rather than opening a single
      // assignment directly - assignmentId/testName/closesAt below are
      // only ever the first one's, used only when count === 1.
      wellness: {
        count: openWellness.length,
        assignmentId: openWellness[0]?.id || null,
        testName: openWellness[0]?.test_name || "",
        closesAt: openWellness[0]?.closes_at || null,
      },
    });
  } catch (error) {
    next(error);
  }
});

export default router;
