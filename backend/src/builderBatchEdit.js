// Builder: applying an edit of a published weekly batch to every athlete
// (docs/ai/builder-batch-edit-plan.md, accepted with section 10).
//
// "Apply the change, not the copy": Save compares the edit draft (after) with
// the source plan as it is now (before). Their sessions share logical ids
// (the edit draft is copied with preserveLogicalId), so before <-> after is
// matched exactly. A sibling's session is matched to a before session by its
// slot (weekday, am_pm, bta, session_order). Only what the coach changed in
// this edit is written to a sibling; everything else stays as that athlete
// has it, with its own row ids and logical ids.
//
// The caller (applyEditDraft) owns the transaction and the plan locks; this
// module never takes a plan lock of its own. It locks the sibling session
// rows it would remove or move FOR UPDATE, in ascending id, after the plan
// rows (plan 10.2.5: an athlete's RPE submit takes FOR KEY SHARE on that row
// through its foreign key, so "blocked" wins in both orders).
import { createHash } from "node:crypto";
import { copyBuilderSessionContents } from "./builderTreeBatch.js";

export const batchEditTestHooks = {
  // Condition 10.2.1: replaces the set of member plan ids whose athlete name
  // the coach already sees in the batch switcher. Tests only.
  visibleMemberIds: null,
  // Runs after the plan and session locks and the classification, before the token check and any write.
  afterLocks: null,
  // Task 5: runs after the source session rows are locked and their facts read, before any answer or write.
  afterSourceLocks: null,
};

const ITEM_CONTENT_FIELDS = [
  "video_source", "video_asset_id", "image_source", "image_asset_id",
  "item_type", "exercise_id", "title", "description", "short_note", "note", "image_url", "video_url",
  "sets", "reps", "load", "item_order", "exercise_order", "source_row_ref",
  "domain_name", "category_name", "section_name", "domain_color", "category_color", "section_color",
  "domain_icon_url", "category_icon_url", "section_icon_url", "domain_short_note", "category_short_note", "section_short_note",
  "domain_note", "category_note", "section_note", "domain_order", "category_order", "section_order",
];
const NODE_CONTENT_FIELDS = ["node_type", "name", "color", "icon_url", "short_note", "note", "node_order"];
export const SESSION_FIELDS = ["name", "session_time", "rpe_enabled", "training_load_enabled"];
export const DAY_FIELDS = ["day_note", "block_name"];
export const PLAN_FIELDS = ["name", "note", "icon_url", "color", "track_training_load_default", "request_rpe_default"];

// The four reasons a member is asked about, and the two it is skipped for.
export const ASK_REASONS = ["changed_separately", "has_results", "linked_to_event", "being_edited"];
export const SKIP_REASONS = ["archived", "not_editable"];

function normal(value) {
  if (value === undefined || value === null) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "number") return String(value);
  if (typeof value === "bigint") return String(value);
  return value;
}

// Copying a tree fills a missing library image of a plain exercise item
// (completeCopiedExerciseImages): that value is derived, not the coach's, so
// it never counts as a change.
function itemContent(item) {
  const derivedImage = item.item_type === "exercise" && item.exercise_id
    && (item.image_source || "legacy") === "legacy" && (item.video_source || "legacy") === "legacy";
  const out = {};
  for (const field of ITEM_CONTENT_FIELDS) {
    if (field === "image_url" && derivedImage) continue;
    let value = normal(item[field]);
    if (value === null && field.endsWith("_source")) value = "legacy";
    out[field] = value;
  }
  return out;
}

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

function sortCanonical(rows) {
  return rows.map((row) => ({ row, key: stable(row) })).sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)).map((x) => x.row);
}

// An id-free fingerprint of one session's content (its node tree and items).
// Two trees that differ only in their row ids give the same value; a change of
// a dose, an order or an instruction gives another (condition 10.2.4).
export function sessionContentFingerprint(nodes, items) {
  const childrenOf = new Map();
  for (const node of nodes) {
    const key = node.parent_id || "root";
    if (!childrenOf.has(key)) childrenOf.set(key, []);
    childrenOf.get(key).push(node);
  }
  const itemsOf = new Map();
  const loose = [];
  for (const item of items) {
    if (item.plan_node_id) {
      if (!itemsOf.has(item.plan_node_id)) itemsOf.set(item.plan_node_id, []);
      itemsOf.get(item.plan_node_id).push(itemContent(item));
    } else {
      loose.push(itemContent(item));
    }
  }
  const build = (parentKey, depth) => {
    if (depth > 64) throw new Error("Builder tree too deep.");
    return sortCanonical((childrenOf.get(parentKey) || []).map((node) => {
      const out = {};
      for (const field of NODE_CONTENT_FIELDS) out[field] = normal(node[field]);
      out.items = sortCanonical(itemsOf.get(node.id) || []);
      out.children = build(node.id, depth + 1);
      return out;
    }));
  };
  const tree = { nodes: build("root", 0), items: sortCanonical(loose) };
  return createHash("sha256").update(stable(tree)).digest("hex");
}

function weekdayOf(dayOrder) {
  const raw = Number(dayOrder) || 0;
  return (((raw - 1) % 7 + 7) % 7) + 1;
}

export function slotKey(session) {
  return [session.weekday, session.am_pm ?? "", session.bta ?? "", String(Number(session.session_order ?? -1))].join("|");
}

// One weekly plan as the classification reads it.
export async function loadWeeklyTree(client, planId) {
  const plan = (await client.query(
    `select p.id, p.athlete_id, p.week_start, ${PLAN_FIELDS.map((f) => `p.${f}`).join(", ")},
            coalesce(a.is_active, true) as athlete_active
     from plans.plans p left join public.athletes a on a.id = p.athlete_id where p.id = $1`,
    [planId],
  )).rows[0];
  if (!plan) return null;
  const days = (await client.query(
    "select id, day_order, date, day_note, block_name from plans.plan_days where plan_id = $1 order by day_order, id",
    [planId],
  )).rows.map((day) => ({ ...day, weekday: weekdayOf(day.day_order) }));
  const dayById = new Map(days.map((day) => [String(day.id), day]));
  const sessions = (await client.query(
    `select ps.id, ps.plan_day_id, ps.am_pm, ps.bta, ps.session_time, ps.session_order, ps.name,
            ps.rpe_enabled, ps.training_load_enabled, ps.logical_session_id
     from plans.plan_sessions ps join plans.plan_days pd on pd.id = ps.plan_day_id
     where pd.plan_id = $1 order by ps.id`,
    [planId],
  )).rows.map((session) => {
    const day = dayById.get(String(session.plan_day_id));
    return { ...session, weekday: day.weekday, day_date: day.date };
  });
  const ids = sessions.map((s) => s.id);
  const nodes = ids.length ? (await client.query("select * from plans.plan_nodes where plan_session_id = any($1::uuid[])", [ids])).rows : [];
  const items = ids.length ? (await client.query("select * from plans.plan_items where plan_session_id = any($1::uuid[])", [ids])).rows : [];
  for (const session of sessions) {
    const key = String(session.id);
    session.fingerprint = sessionContentFingerprint(
      nodes.filter((n) => String(n.plan_session_id) === key),
      items.filter((i) => String(i.plan_session_id) === key),
    );
  }
  // Two days on one weekday make a weekday's slots ambiguous (condition 10.2.4).
  const weekdayCounts = new Map();
  for (const day of days) weekdayCounts.set(day.weekday, (weekdayCounts.get(day.weekday) || 0) + 1);
  const ambiguousWeekdays = new Set([...weekdayCounts].filter(([, n]) => n > 1).map(([weekday]) => weekday));
  return { plan, days, sessions, ambiguousWeekdays };
}

function sameField(a, b) {
  return stable(normal(a)) === stable(normal(b));
}

function fieldsChanged(before, after, fields) {
  return fields.filter((f) => !sameField(before[f], after[f]));
}

// Three-way, per field: the sibling takes after's value only where the coach
// changed it; where the sibling's own value also moved from before to
// something else, it is diverged.
function threeWay(before, after, sibling, fields) {
  const set = {};
  for (const field of fieldsChanged(before, after, fields)) {
    if (!sameField(sibling[field], before[field]) && !sameField(sibling[field], after[field])) return { diverged: true };
    if (!sameField(sibling[field], after[field])) set[field] = after[field];
  }
  return { diverged: false, set };
}

// The pure part: what the change is for one sibling, or why it cannot be
// applied. `facts` holds, per sibling session id, `hasResults`; and, per
// sibling slot key, `linked`.
export function planSiblingChange(before, after, sibling, facts = { results: new Set(), linkedSlots: new Set() }) {
  const reasons = new Set();
  const ops = { plan: {}, days: [], update: [], content: [], move: [], remove: [], add: [] };
  const ambiguous = (weekday) => before.ambiguousWeekdays.has(weekday) || after.ambiguousWeekdays.has(weekday)
    || sibling.ambiguousWeekdays.has(weekday);

  const planMerge = threeWay(before.plan, after.plan, sibling.plan, PLAN_FIELDS);
  if (planMerge.diverged) reasons.add("changed_separately");
  else ops.plan = planMerge.set;

  // Days, per weekday.
  const dayByWeekday = (tree) => new Map(tree.days.map((day) => [day.weekday, day]));
  const bDays = dayByWeekday(before); const aDays = dayByWeekday(after); const sDays = dayByWeekday(sibling);
  for (const [weekday, aDay] of aDays) {
    const bDay = bDays.get(weekday); const sDay = sDays.get(weekday);
    if (!bDay || !sDay) { if (bDay && fieldsChanged(bDay, aDay, DAY_FIELDS).length) reasons.add("changed_separately"); continue; }
    if (!fieldsChanged(bDay, aDay, DAY_FIELDS).length) continue;
    if (ambiguous(weekday)) { reasons.add("changed_separately"); continue; }
    const merge = threeWay(bDay, aDay, sDay, DAY_FIELDS);
    if (merge.diverged) reasons.add("changed_separately");
    else if (Object.keys(merge.set).length) ops.days.push({ dayId: sDay.id, set: merge.set });
  }

  const bySlot = (tree) => {
    const map = new Map();
    for (const s of tree.sessions) map.set(slotKey(s), s);
    return map;
  };
  const sSlots = bySlot(sibling);
  const aByLogical = new Map(after.sessions.map((s) => [String(s.logical_session_id), s]));
  const bLogicals = new Set(before.sessions.map((s) => String(s.logical_session_id)));
  const occupied = new Set(sSlots.keys());
  const freed = new Set();
  const pendingTargets = [];

  for (const b of before.sessions) {
    const a = aByLogical.get(String(b.logical_session_id));
    const contentChanged = a && a.fingerprint !== b.fingerprint;
    const fieldDiff = a ? fieldsChanged(b, a, SESSION_FIELDS) : [];
    const moved = a && slotKey(a) !== slotKey(b);
    if (a && !contentChanged && !fieldDiff.length && !moved) continue;
    if (ambiguous(b.weekday) || (a && ambiguous(a.weekday))) { reasons.add("changed_separately"); continue; }
    const s = sSlots.get(slotKey(b));
    if (!s) { reasons.add("changed_separately"); continue; }
    const results = facts.results.has(String(s.id));
    const linked = facts.linkedSlots.has(slotKey(s));
    if (!a) {
      // Removed: only a session still as before, without results or a link.
      if (s.fingerprint !== b.fingerprint || fieldsChanged(b, s, SESSION_FIELDS).length) { reasons.add("changed_separately"); continue; }
      if (results) reasons.add("has_results");
      if (linked) reasons.add("linked_to_event");
      if (results || linked) continue;
      ops.remove.push({ sessionId: s.id });
      freed.add(slotKey(s));
      continue;
    }
    if (contentChanged) {
      if (s.fingerprint !== b.fingerprint) { reasons.add("changed_separately"); continue; }
      ops.content.push({ sessionId: s.id, fromSessionId: a.id });
    }
    if (fieldDiff.length) {
      const merge = threeWay(b, a, s, SESSION_FIELDS);
      if (merge.diverged) { reasons.add("changed_separately"); continue; }
      if (Object.keys(merge.set).length) ops.update.push({ sessionId: s.id, set: merge.set });
    }
    if (moved) {
      // A move carries the athlete's session only while it is still as before
      // (content and fields); a session tailored for this athlete is asked about.
      if (s.fingerprint !== b.fingerprint || fieldsChanged(b, s, SESSION_FIELDS).length) { reasons.add("changed_separately"); continue; }
      if (results) reasons.add("has_results");
      if (linked) reasons.add("linked_to_event");
      if (results || linked) continue;
      freed.add(slotKey(s));
      pendingTargets.push({ kind: "move", sessionId: s.id, target: a });
    }
  }
  for (const a of after.sessions) {
    if (bLogicals.has(String(a.logical_session_id))) continue;
    if (ambiguous(a.weekday)) { reasons.add("changed_separately"); continue; }
    pendingTargets.push({ kind: "add", fromSessionId: a.id, target: a });
  }
  // A target slot must be free in the sibling once its removals and moves
  // are taken out; two targets on one slot cannot happen (after is one plan).
  for (const t of pendingTargets) {
    const key = slotKey(t.target);
    if (occupied.has(key) && !freed.has(key)) { reasons.add("changed_separately"); continue; }
    const day = sDays.get(t.target.weekday);
    if (!day) { reasons.add("changed_separately"); continue; }
    const slot = { dayId: day.id, am_pm: t.target.am_pm, bta: t.target.bta, session_order: t.target.session_order };
    if (t.kind === "move") ops.move.push({ sessionId: t.sessionId, slot });
    else ops.add.push({ fromSessionId: t.fromSessionId, slot });
  }
  return { reasons: [...reasons].sort(), ops };
}

// The sibling sessions a change would remove or move: the rows an RPE submit
// can race (plan 10.2.5).
export function sessionsAtRisk(before, after, sibling) {
  const aLogicals = new Map(after.sessions.map((s) => [String(s.logical_session_id), s]));
  const sSlots = new Map(sibling.sessions.map((s) => [slotKey(s), s]));
  const ids = [];
  for (const b of before.sessions) {
    const a = aLogicals.get(String(b.logical_session_id));
    if (a && slotKey(a) === slotKey(b)) continue;
    const s = sSlots.get(slotKey(b));
    if (s) ids.push(String(s.id));
  }
  return ids.sort();
}

function dateString(value) {
  if (value instanceof Date) {
    const y = value.getFullYear(); const m = String(value.getMonth() + 1).padStart(2, "0"); const d = String(value.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
  return String(value).slice(0, 10);
}

// Under the caller's plan locks: lock the at-risk session rows, then read
// results, live calendar links and other open edit drafts.
export async function readSiblingFacts(client, before, after, sibling) {
  const risky = sessionsAtRisk(before, after, sibling);
  if (risky.length) {
    await client.query("select id from plans.plan_sessions where id = any($1::uuid[]) order by id for update", [risky]);
  }
  const results = await sessionIdsWithResults(client, sibling.plan.athlete_id, sibling.sessions);
  const linkedSlots = new Set();
  const links = (await client.query(
    `select day, am_pm, bta, session_order from calendar.event_session_links
     where plan_id = $1 and ended_at is null`,
    [sibling.plan.id],
  )).rows;
  const dayWeekday = new Map(sibling.days.map((d) => [dateString(d.date), d.weekday]));
  for (const link of links) {
    const weekday = dayWeekday.get(dateString(link.day));
    if (weekday) linkedSlots.add(slotKey({ weekday, am_pm: link.am_pm, bta: link.bta, session_order: link.session_order }));
  }
  const openDraft = (await client.query(
    `select 1 from plans.plans where edit_source_plan_id = $1 and is_edit_draft = true limit 1`,
    [sibling.plan.id],
  )).rowCount > 0;
  return { results, linkedSlots, openDraft };
}

// The ids of `sessions` (one plan's, its athlete `athleteId`) that have
// results, fail-closed: see the comment inside.
async function sessionIdsWithResults(client, athleteId, sessions) {
  const logicals = sessions.map((s) => s.logical_session_id).filter(Boolean);
  const results = new Set();
  if (logicals.length) {
    // has_results, fail-closed (the manager's ruling on #673): a session counts
    // as having results - never removed, never moved - when anything recorded
    // names its logical id:
    //   - the athlete's RPE (training_load.session_feedback);
    //   - an activity linked to it: a recorded, materialised or imported
    //     activity's participant link (training.activity_participant_session_links),
    //     confirmed or still suggested, whatever the participant's merge state -
    //     a participant merged into an imported GPEXE activity keeps its link
    //     row (training.merge_activity_participants does not move it);
    //   - a metric event (training_load.metric_event_participants; the event
    //     table itself holds no logical id).
    // A logical id is one plan session's, so the link tables are matched by it
    // alone, not narrowed by athlete.
    const rows = (await client.query(
      `select logical_session_id from training_load.session_feedback
        where athlete_id = $1 and logical_session_id = any($2::uuid[])
       union
       select logical_session_id from training.activity_participant_session_links
        where logical_session_id = any($2::uuid[]) and link_status in ('confirmed', 'suggested')
       union
       select logical_session_id from training_load.metric_event_participants
        where logical_session_id = any($2::uuid[])`,
      [athleteId || null, logicals],
    )).rows;
    const withResults = new Set(rows.map((r) => String(r.logical_session_id)));
    for (const s of sessions) if (withResults.has(String(s.logical_session_id))) results.add(String(s.id));
  }
  return results;
}

// Task 5 (docs/ai/builder-batch-edit-plan.md section 12): the source plan's
// own slot - its day's date, not the weekday (the edit draft keeps the
// source's dates).
function sourceSlotKey(session) {
  return [dateString(session.day_date), session.am_pm ?? "", session.bta ?? "", String(Number(session.session_order ?? -1))].join("|");
}

// The source sessions the edit draft removes or moves, each with how.
export function sourceSessionChanges(before, after) {
  const aByLogical = new Map(after.sessions.map((s) => [String(s.logical_session_id), s]));
  const changes = [];
  for (const b of before.sessions) {
    const a = aByLogical.get(String(b.logical_session_id));
    if (!a) changes.push({ session: b, change: "removed" });
    else if (sourceSlotKey(a) !== sourceSlotKey(b)) changes.push({ session: b, change: "moved" });
  }
  return changes.sort((x, y) => (String(x.session.id) < String(y.session.id) ? -1 : 1));
}

// Under the Save's plan locks: lock the source session rows the draft removes
// or moves (ascending id, plan 12.4), then answer which of them may not go.
// A session is blocked by its results (the same fail-closed reading as the
// siblings) or by a live event link made for it: the link on its slot whose
// logical_session_id_at_link is its own (an orphaned link names another
// session and blocks nothing - the link identity guard's rule).
export async function blockedSourceSessions(client, before, after) {
  const changes = sourceSessionChanges(before, after);
  if (!changes.length) return [];
  await client.query(
    "select id from plans.plan_sessions where id = any($1::uuid[]) order by id for update",
    [changes.map((c) => String(c.session.id))],
  );
  const results = await sessionIdsWithResults(client, before.plan.athlete_id, changes.map((c) => c.session));
  const links = (await client.query(
    `select day, am_pm, bta, session_order, logical_session_id_at_link from calendar.event_session_links
     where plan_id = $1 and ended_at is null`,
    [before.plan.id],
  )).rows;
  const linked = new Set(links.map((l) => [
    sourceSlotKey({ day_date: l.day, am_pm: l.am_pm, bta: l.bta, session_order: l.session_order }),
    String(l.logical_session_id_at_link),
  ].join("#")));
  const blocked = [];
  for (const { session, change } of changes) {
    const reasons = [];
    if (results.has(String(session.id))) reasons.push("has_results");
    if (linked.has([sourceSlotKey(session), String(session.logical_session_id)].join("#"))) reasons.push("linked_to_event");
    if (reasons.length) {
      blocked.push({ name: session.name || "", day: dateString(session.day_date), amPm: session.am_pm || "", bta: session.bta || "", change, reasons });
    }
  }
  if (batchEditTestHooks.afterSourceLocks) await batchEditTestHooks.afterSourceLocks({ client, blocked });
  return blocked;
}

// The token a 409 hands out: the classification of every member. A resend
// is honoured only while it is the same (condition 10.2.2).
export function choiceTokenOf(members) {
  const shape = members.map((m) => ({ planId: String(m.planId), outcome: m.outcome, reasons: [...(m.reasons || [])].sort() }))
    .sort((a, b) => (a.planId < b.planId ? -1 : a.planId > b.planId ? 1 : 0));
  return createHash("sha256").update(stable(shape)).digest("hex");
}

async function retainedExerciseUses(client, planId) {
  return (await client.query(`select item.exercise_id, count(*)::integer as uses
    from plans.plan_items item join plans.plan_sessions session on session.id = item.plan_session_id
    join plans.plan_days day on day.id = session.plan_day_id
    where day.plan_id = $1 and item.exercise_id is not null group by item.exercise_id`, [planId])).rows;
}

async function deleteSessionContent(client, sessionIds) {
  if (!sessionIds.length) return;
  await client.query("delete from plans.plan_items where plan_session_id = any($1::uuid[])", [sessionIds]);
  await client.query("delete from plans.plan_nodes where plan_session_id = any($1::uuid[])", [sessionIds]);
}

// Writes one sibling's change. Every check was made before; this only writes.
export async function writeSiblingChange(client, siblingPlanId, ops, { assertReuse, copyLegacySession }) {
  const retained = await retainedExerciseUses(client, siblingPlanId);
  if (Object.keys(ops.plan).length) {
    const fields = Object.keys(ops.plan);
    await client.query(
      `update plans.plans set ${fields.map((f, i) => `${f} = $${i + 2}`).join(", ")}, updated_at = clock_timestamp() where id = $1`,
      [siblingPlanId, ...fields.map((f) => ops.plan[f])],
    );
  }
  for (const day of ops.days) {
    const fields = Object.keys(day.set);
    await client.query(
      `update plans.plan_days set ${fields.map((f, i) => `${f} = $${i + 2}`).join(", ")}, updated_at = now() where id = $1`,
      [day.dayId, ...fields.map((f) => day.set[f])],
    );
  }
  // Removals first, then moves through a parked slot, so the slot index never
  // sees two rows on one slot.
  const removeIds = ops.remove.map((r) => r.sessionId);
  await deleteSessionContent(client, removeIds);
  if (removeIds.length) await client.query("delete from plans.plan_sessions where id = any($1::uuid[])", [removeIds]);
  for (const [index, move] of ops.move.entries()) {
    await client.query("update plans.plan_sessions set session_order = $2, updated_at = now() where id = $1", [move.sessionId, 1000000 + index]);
  }
  for (const move of ops.move) {
    await client.query(
      "update plans.plan_sessions set plan_day_id = $2, am_pm = $3, bta = $4, session_order = $5, updated_at = now() where id = $1",
      [move.sessionId, move.slot.dayId, move.slot.am_pm, move.slot.bta, move.slot.session_order],
    );
  }
  for (const update of ops.update) {
    const fields = Object.keys(update.set);
    await client.query(
      `update plans.plan_sessions set ${fields.map((f, i) => `${f} = $${i + 2}`).join(", ")}, updated_at = now() where id = $1`,
      [update.sessionId, ...fields.map((f) => update.set[f])],
    );
  }
  // Content in place: the session row (its id and logical id) stays.
  const contentMap = new Map();
  await deleteSessionContent(client, ops.content.map((c) => c.sessionId));
  for (const content of ops.content) contentMap.set(content.fromSessionId, content.sessionId);
  // Added sessions: a new row with a fresh logical id (the column default).
  for (const add of ops.add) {
    const from = (await client.query(
      "select name, session_time, rpe_enabled, training_load_enabled from plans.plan_sessions where id = $1",
      [add.fromSessionId],
    )).rows[0];
    const created = await client.query(
      `insert into plans.plan_sessions (plan_day_id, am_pm, bta, session_time, session_order, name, rpe_enabled, training_load_enabled)
       values ($1, $2, $3, $4, $5, $6, $7, $8) returning id`,
      [add.slot.dayId, add.slot.am_pm, add.slot.bta, from.session_time, add.slot.session_order, from.name, from.rpe_enabled, from.training_load_enabled],
    );
    contentMap.set(add.fromSessionId, created.rows[0].id);
  }
  await copyBuilderSessionContents(client, contentMap, copyLegacySession);
  await assertReuse(client, siblingPlanId, retained);
}
