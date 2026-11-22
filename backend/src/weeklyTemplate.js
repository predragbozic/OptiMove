// Weekly program templates (docs/ai/weekly-program-template-plan.md).
//
// A weekly program template is an ordinary program template (plan_type
// 'program', is_template, no athlete) whose blocks are ALL
// block_type = 'template_week_day': exactly 7 x N rows with
// block_index = block_order = (week - 1) * 7 + day (day 1..7 of the template
// week, not a weekday: "Day 1" lands on the date the coach assigns from).
// No schema change: block_type has no check constraint, and every copy path
// (copyProgramTree, the edit draft, block copy) already carries it.
import { copyBuilderSessionContents } from "./builderTreeBatch.js";

export const WEEKLY_BLOCK_TYPE = "template_week_day";
export const MAX_TEMPLATE_WEEKS = 52;

export const weekOfIndex = (blockIndex) => Math.floor((Number(blockIndex) - 1) / 7) + 1;
export const dayOfIndex = (blockIndex) => ((Number(blockIndex) - 1) % 7) + 1;
export const blockIndexOf = (week, day) => (week - 1) * 7 + day;
export const weekDayName = (week, day) => `Week ${week} - Day ${day}`;

// The plan's weekly-template facts, on the caller's connection: null when the
// plan is not a weekly template (a program with no block, or any block of
// another type), else { weekCount }.
export async function weeklyTemplateFacts(runQuery, planId) {
  const row = (await runQuery(
    `select count(*)::int as total,
            count(*) filter (where block_type = $2)::int as weekly,
            coalesce(max(block_index), 0)::int as last_index
     from plans.plan_days where plan_id = $1`,
    [planId, WEEKLY_BLOCK_TYPE],
  )).rows[0];
  if (!row || row.total === 0 || row.weekly !== row.total) return null;
  return { weekCount: Math.ceil(row.last_index / 7) };
}

// Inserts the seven days of template weeks `fromWeek`..`toWeek` (inclusive).
export async function insertTemplateWeeks(client, planId, fromWeek, toWeek) {
  await client.query(
    `insert into plans.plan_days (plan_id, block_index, block_order, block_name, block_type)
     select $1, i, i, 'Week ' || ((i - 1) / 7 + 1) || ' - Day ' || ((i - 1) % 7 + 1), $4
     from generate_series($2::int, $3::int) as i`,
    [planId, blockIndexOf(fromWeek, 1), blockIndexOf(toWeek, 7), WEEKLY_BLOCK_TYPE],
  );
}

// Renumbers a template's weeks: `order` is the new list of old week numbers
// (e.g. [2, 1, 3] puts week 2 first). (plan_id, block_index) is unique and not
// deferrable, so two passes: every row to a negative index, then to its new one.
export async function renumberTemplateWeeks(client, planId, order) {
  const mapping = order.map((oldWeek, position) => ({ old_week: oldWeek, new_week: position + 1 }));
  await client.query(
    `update plans.plan_days pd set block_index = -pd.block_index
     where pd.plan_id = $1 and pd.block_index > 0`,
    [planId],
  );
  await client.query(
    `update plans.plan_days pd
     set block_index = (m.new_week - 1) * 7 + ((-pd.block_index - 1) % 7 + 1),
         block_order = (m.new_week - 1) * 7 + ((-pd.block_index - 1) % 7 + 1),
         block_name = 'Week ' || m.new_week || ' - Day ' || ((-pd.block_index - 1) % 7 + 1),
         updated_at = now()
     from jsonb_to_recordset($2::jsonb) as m(old_week int, new_week int)
     where pd.plan_id = $1 and pd.block_index < 0
       and ((-pd.block_index - 1) / 7 + 1) = m.old_week`,
    [planId, JSON.stringify(mapping)],
  );
}

// Copies the sessions of template days into weekly-plan days, with fresh
// logical ids (the column default), session_order after `orderOffset` of the
// target day, and their node / item trees. `pairs`: [{ sourceDayId,
// targetDayId, orderOffset }].
export async function copyTemplateDaySessions(client, pairs, copyLegacySession) {
  if (!pairs.length) return [];
  const bySource = new Map(pairs.map((p) => [String(p.sourceDayId), p]));
  const sessions = (await client.query(
    `select * from plans.plan_sessions where plan_day_id = any($1::uuid[]) order by plan_day_id, session_order, id`,
    [pairs.map((p) => p.sourceDayId)],
  )).rows;
  if (!sessions.length) return [];
  const values = [];
  const params = [];
  let column = 0;
  for (const session of sessions) {
    const pair = bySource.get(String(session.plan_day_id));
    const row = [pair.targetDayId, session.am_pm, session.bta, session.session_time,
      // After kept sessions (an offset): at least 1 before the offset, so a
      // template session never takes the order of a kept session it follows.
      // Without an offset the source's own order is copied as it is, so two
      // legacy sessions ordered NULL and 1 stay distinct (db review).
      Number(pair.orderOffset) > 0
        ? Math.max(Number(session.session_order) || 0, 1) + Number(pair.orderOffset)
        : session.session_order, session.name, session.rpe_enabled, session.training_load_enabled];
    values.push(`(${row.map(() => `$${++column}`).join(", ")})`);
    params.push(...row);
  }
  const created = (await client.query(
    `insert into plans.plan_sessions (plan_day_id, am_pm, bta, session_time, session_order, name, rpe_enabled, training_load_enabled)
     values ${values.join(", ")} returning id`,
    params,
  )).rows;
  await copyBuilderSessionContents(client, new Map(sessions.map((s, i) => [s.id, created[i].id])), copyLegacySession);
  return created.map((row) => row.id);
}
