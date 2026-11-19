// The time of a session that is linked to a calendar event (central calendar
// K3 / K2c-3, docs/ai/central-calendar-k3-plan.md section 7 with O14).
//
// A session that has its own time (plans.plan_sessions.session_time) keeps
// it. A session without one, linked to a planned event, shows the event's
// time: its start on the event's first day and its end on its last day. The
// time is read from the event every time, never copied into the plan, so the
// two can never disagree.
//
// The link is matched by its slot key (plan, day, AM/PM, B/T/A, order: the
// key calendar.event_session_links stores, migration v49). The event's time
// is used only while
//   - the link is live (ended_at is null),
//   - the event is planned (a cancelled event's time is never shown), and
//   - the session's athlete is still a target of the event on that day (the
//     same rule the link was made under, eventTargetsAthleteSql), so an
//     athlete taken out of the event is never shown its time.
// Every reader that calls this has already decided that the caller may read
// these rows (canAccessAthlete / canAccessPlan); this adds the event's time
// to them and nothing else (no event id, title or place).
//
// One statement for any number of rows (and none when every row has its own
// time or no slot); `rows` are rows of plans.v_weekly_plan_items (plan_id,
// athlete_uuid, date, am_pm, bta, session_order, session_time). Each row
// without its own time gets `linked_event_start_time` / `linked_event_end_time`
// ("HH:MM" or null); a row that has its own time is left as it is.
import { eventTargetsAthleteSql } from "./calendarAccess.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function dayOf(value) {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  const day = String(value).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : null;
}
function hhmm(value) {
  if (value == null) return null;
  const s = String(value);
  return /^\d{2}:\d{2}/.test(s) ? s.slice(0, 5) : null;
}
function slotKey(row) {
  return [row.plan_id, dayOf(row.date), row.am_pm ?? "", row.bta ?? "", Number(row.session_order), row.athlete_uuid].join("|");
}

export async function linkedSessionTimes(queryable, rows) {
  const candidates = new Map();
  for (const row of rows || []) {
    if (!row || row.session_time != null) continue;
    const day = dayOf(row.date);
    if (!day || !UUID_PATTERN.test(String(row.plan_id || "")) || !UUID_PATTERN.test(String(row.athlete_uuid || ""))) continue;
    if (row.session_order == null || !Number.isInteger(Number(row.session_order))) continue;
    const key = slotKey(row);
    if (!candidates.has(key)) candidates.set(key, []);
    candidates.get(key).push(row);
  }
  if (!candidates.size) return rows;
  const keys = [...candidates.keys()];
  const first = keys.map((key) => candidates.get(key)[0]);
  const result = await queryable.query(
    `select k.i::int as i,
            case when k.day = e.day then to_char(e.start_time, 'HH24:MI') end as start_time,
            case when k.day = coalesce(e.end_day, e.day) then to_char(e.end_time, 'HH24:MI') end as end_time
       from unnest($1::uuid[], $2::date[], $3::text[], $4::text[], $5::int[], $6::uuid[])
            with ordinality as k(plan_id, day, am_pm, bta, session_order, athlete_id, i)
       join calendar.event_session_links l
         on l.plan_id = k.plan_id and l.day = k.day
        and l.am_pm is not distinct from k.am_pm and l.bta is not distinct from k.bta
        and l.session_order = k.session_order and l.ended_at is null
       join calendar.events e on e.id = l.event_id and e.status = 'planned'
      where ${eventTargetsAthleteSql("e.id", "k.athlete_id", "k.day")}`,
    [
      first.map((r) => String(r.plan_id)), first.map((r) => dayOf(r.date)), first.map((r) => r.am_pm ?? null),
      first.map((r) => r.bta ?? null), first.map((r) => Number(r.session_order)), first.map((r) => String(r.athlete_uuid)),
    ],
  );
  for (const found of result.rows) {
    const start = hhmm(found.start_time);
    const end = hhmm(found.end_time);
    if (!start && !end) continue;
    for (const row of candidates.get(keys[found.i - 1]) || []) {
      row.linked_event_start_time = start;
      row.linked_event_end_time = end;
    }
  }
  return rows;
}
