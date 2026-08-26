// Public schedule check-in link (/tests/check-in/:publicToken) - mirrors
// backend/src/routes/auth.js's join-link endpoints: reachable with NO
// session (mounted below WITHOUT requireAuth, see server.js), resolves the
// token first, then requires login inline (a plain 401, not router-level
// requireAuth) before it will ever resolve or return anything
// athlete-specific. The link itself is never the authorization - only a
// logged-in session matched against a real test_assignments row is. Never
// exposes a roster or another athlete's answers/status: the ONLY athlete
// this can ever resolve to is req.authz.athleteId, the account that is
// actually logged in.
import { Router } from "express";
import { pool, query } from "../db.js";
import { ensureCurrentOccurrence, assignmentIsOpen } from "../testsOccurrenceService.js";
import { athleteDisplayNameSql, loadAssessmentValuesAndResult, loadWellnessParameters, parametersForResponse } from "./tests.js";

const router = Router();

const GENERIC_INVALID = { error: "This check-in link is invalid or no longer available." };

async function loadUsableLink(token) {
  const result = await query(
    `select l.id, l.schedule_id, l.status, l.expires_at, sch.id as schedule_exists, sch.status as schedule_status, tv.name as test_name
     from tests.test_access_links l
     left join tests.test_schedules sch on sch.id = l.schedule_id
     left join tests.test_versions tv on tv.id = sch.test_version_id
     where l.public_token = $1 and l.link_kind = 'schedule'
     limit 1`,
    [token],
  );
  const link = result.rows[0];
  if (!link) return null;
  if (link.status !== "active") return null;
  if (link.expires_at && new Date(link.expires_at) <= new Date()) return null;
  if (!link.schedule_exists) return null;
  return link;
}

router.get("/:token", async (req, res, next) => {
  try {
    const link = await loadUsableLink(req.params.token);
    if (!link) return res.status(404).json(GENERIC_INVALID);
    res.json({
      testName: link.test_name,
      requiresLogin: !req.user,
    });
  } catch (error) { next(error); }
});

router.get("/:token/my-assignment", async (req, res, next) => {
  try {
    const link = await loadUsableLink(req.params.token);
    if (!link) return res.status(404).json(GENERIC_INVALID);
    if (!req.user) return res.status(401).json({ error: "Log in first, then this page will show your check-in." });
    if (!req.authz?.isAthlete || !req.authz.athleteId) return res.status(403).json({ error: "This account has no athlete profile." });
    const athleteId = req.authz.athleteId;

    if (link.schedule_status !== "active") return res.json({ assignment: null, message: "This check-in is currently paused." });

    const scheduleResult = await query(`select * from tests.test_schedules where id = $1`, [link.schedule_id]);
    const occurrenceId = await ensureCurrentOccurrence(pool, scheduleResult.rows[0]);
    if (!occurrenceId) return res.json({ assignment: null, message: "There is nothing to check in right now." });

    const assignmentResult = await query(
      `select asg.*, o.status as occurrence_status, tv.id as test_version_id, tv.name as test_name,
              a.id as athlete_id, ${athleteDisplayNameSql} as athlete_name, a.image_url as athlete_image_url
       from tests.test_assignments asg
       join tests.test_schedule_occurrences o on o.id = asg.occurrence_id
       join tests.test_versions tv on tv.id = asg.snapshot_test_version_id
       join public.athletes a on a.id = asg.athlete_id
       where asg.occurrence_id = $1 and asg.athlete_id = $2`,
      [occurrenceId, athleteId],
    );
    const assignment = assignmentResult.rows[0];
    if (!assignment) return res.json({ assignment: null, message: "You don't have a check-in assigned right now." });

    const parameterRows = await loadWellnessParameters(query);
    const assessmentResult = await query(
      `select id, status, completed_at from tests.test_assessments
       where standalone_assignment_id = $1 and superseded_by_assessment_id is null
       order by created_at desc limit 1`,
      [assignment.id],
    );
    let latestAssessment = null;
    if (assessmentResult.rows[0]) {
      const row = assessmentResult.rows[0];
      const { values, wellnessScore } = row.status === "completed" ? await loadAssessmentValuesAndResult(query, row.id) : { values: {}, wellnessScore: null };
      latestAssessment = { id: row.id, status: row.status, completedAt: row.completed_at, values, wellnessScore };
    }

    const isOpen = assignmentIsOpen(assignment);
    res.json({
      assignment: {
        id: assignment.id,
        status: assignment.status,
        occurrence: { id: assignment.occurrence_id, opensAt: assignment.opens_at, closesAt: assignment.closes_at, status: assignment.occurrence_status, isOpen },
        athlete: { id: assignment.athlete_id, name: assignment.athlete_name, imageUrl: assignment.athlete_image_url || "" },
      },
      testVersion: { id: assignment.test_version_id, name: assignment.test_name },
      parameters: parametersForResponse(parameterRows),
      latestAssessment,
      canSubmit: isOpen,
    });
  } catch (error) { next(error); }
});

export default router;
