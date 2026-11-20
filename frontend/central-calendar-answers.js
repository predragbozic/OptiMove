// The event panel package (docs/ai/central-calendar-event-panel-contract.md):
// each athlete's RPE and duration in a manager's event panel, the summary
// "Answered 12/15 · average RPE 6.8", and the row's words. Pure functions over
// the event card (GET /api/calendar, with `athletes`) and one answer of
// GET /api/training-load/weekly for the panel's week; the reads and the
// rendering are central-calendar-actions.js / central-calendar-view.js.
//
// A UI rule, not an authorization rule (section 2): /weekly never reads event
// rights, and any coach already reads these values for the athletes of their
// active workspace. Only a manager's panel (item.canManage) shows them.

// The panel reads values only for a manager's event (a reader's panel is
// exactly today's, Q6).
export function ccAnswersWanted(item) {
  return Boolean(item && item.kind === "event" && item.canManage === true && /^\d{4}-\d{2}-\d{2}$/.test(String(item.date || "")));
}

export function ccMondayOf(iso) {
  const d = new Date(`${iso}T00:00:00Z`);
  const back = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - back);
  return d.toISOString().slice(0, 10);
}

// The read of the panel's day only (Q7): its Monday, the card's athletes.
export function ccAnswersPath(item) {
  const ids = [...new Set((item.athleteIds || []).map(String).filter(Boolean))];
  const params = new URLSearchParams({ weekStart: ccMondayOf(item.date) });
  if (ids.length) params.set("athleteIds", ids.join(","));
  return `/api/training-load/weekly?${params.toString()}`;
}

const AM_PM_RANK = { AM: 0, PM: 1 };
const BTA_RANK = { B: 0, T: 1, A: 2 };
const numberOr = (value, fallback) => (Number.isFinite(Number(value)) && value !== null && value !== "" ? Number(value) : fallback);

// An RPE request's row is closed once its window passed or its assignment
// is no longer open; a row not rated by then is missed (section 3).
function requestClosed(row, nowMs) {
  if (["missed", "expired", "closed"].includes(String(row.assignmentStatus || ""))) return true;
  const closes = Date.parse(row.closesAt || "");
  return Number.isFinite(closes) && closes <= nowMs;
}

function entryOf(row, kind, nowMs) {
  const rated = row.rated === true && row.feedback && Number.isFinite(Number(row.feedback.rpe));
  let asked;
  let state;
  if (kind === "session") {
    asked = row.rpeEnabled !== false && row.workspacePlannedRpeEnabled === true;
    state = rated ? "submitted" : "missing";
  } else {
    asked = String(row.assignmentStatus || "") !== "cancelled";
    state = rated ? "submitted" : requestClosed(row, nowMs) ? "missed" : "missing";
  }
  return {
    kind,
    label: kind === "session" ? String(row.sessionName || "").trim() || "Session" : "RPE request",
    asked,
    state,
    rpe: rated ? Number(row.feedback.rpe) : null,
    minutes: rated && Number.isFinite(Number(row.feedback.durationMinutes)) && row.feedback.durationMinutes !== null ? Number(row.feedback.durationMinutes) : null,
    rank: kind === "session"
      ? [0, AM_PM_RANK[row.amPm] ?? 2, BTA_RANK[row.bta] ?? 3, numberOr(row.sessionOrder, 0)]
      : [1, 0, 0, 0],
  };
}

const byRank = (a, b) => {
  for (let i = 0; i < a.rank.length; i += 1) if (a.rank[i] !== b.rank[i]) return a.rank[i] - b.rank[i];
  return a.label.localeCompare(b.label);
};

// Section 1.3: a linked session matches by logicalSessionId + athlete; an RPE
// request by scheduleId + day + athlete, only when the card folded that
// schedule (a "separate" request is not the event's). Only the panel's day.
// Returns a Map athleteId -> entries in slot order (requests last).
export function ccAnswerEntries(item, weekly, { now = Date.now() } = {}) {
  const out = new Map();
  if (!item || !weekly || !Array.isArray(weekly.days)) return out;
  const day = weekly.days.find((d) => d && d.date === item.date);
  if (!day || !Array.isArray(day.sessions)) return out;
  const sessionIds = new Set((item.links?.logicalSessionIds || []).map(String));
  const scheduleId = item.scheduleFold?.external === "folded" && item.links?.externalScheduleId ? String(item.links.externalScheduleId) : "";
  for (const row of day.sessions) {
    if (!row || !row.athleteId) continue;
    let kind = "";
    if (row.source === "planned" && row.logicalSessionId && sessionIds.has(String(row.logicalSessionId))) kind = "session";
    else if (row.source === "scheduled_external" && scheduleId && String(row.scheduleId || "") === scheduleId) kind = "request";
    if (!kind) continue;
    const id = String(row.athleteId);
    if (!out.has(id)) out.set(id, []);
    out.get(id).push(entryOf(row, kind, now));
  }
  for (const list of out.values()) list.sort(byRank);
  return out;
}

// The athletes the summary counts (section 3): the card's targets whose state
// is asked, each once.
export const ccCountedAthlete = (athlete) => athlete?.targeted !== false && athlete?.rpe != null && athlete.rpe !== "not_asked";

// One decimal, rounded half up on the value x 10 (6.75 -> 6.8, 6.85 -> 6.9).
export function ccRoundAverage(sum, n) {
  return Math.round((sum * 10) / n) / 10;
}

// The summary (section 3), or null when nobody is counted. `entries` null:
// the weekly read has no answer (yet), so there is no average.
export function ccAnswersSummary(athletes, entries) {
  const counted = (athletes || []).filter(ccCountedAthlete);
  if (!counted.length) return null;
  const answered = counted.filter((a) => a.rpe === "submitted").length;
  let sum = 0;
  let n = 0;
  let unread = false;
  for (const athlete of counted) {
    const list = entries?.get(String(athlete.athleteId)) || [];
    const values = list.filter((e) => e.asked && e.state === "submitted" && e.rpe != null);
    for (const e of values) {
      sum += e.rpe;
      n += 1;
    }
    // Answered on the card, but no value read (section 1.2's membership gap).
    if (entries && athlete.rpe === "submitted" && !values.length) unread = true;
  }
  return { answered, total: counted.length, average: n ? ccRoundAverage(sum, n) : null, values: n, partial: unread && n > 0 };
}

export function ccAnswersSummaryText(summary) {
  if (!summary) return "";
  const head = `Answered ${summary.answered}/${summary.total}`;
  if (summary.average == null) return head;
  const of = summary.partial ? ` of ${summary.values} ${summary.values === 1 ? "answer" : "answers"}` : "";
  return `${head} · average RPE ${summary.average.toFixed(1)}${of}`;
}

function entryWords(entry) {
  if (!entry.asked) return entry.state === "submitted" ? `Not asked (RPE ${entry.rpe})` : "";
  if (entry.state === "submitted") return `RPE ${entry.rpe}${entry.minutes != null ? ` · ${entry.minutes} min` : ""}`;
  if (entry.state === "missed") return "RPE missed";
  return "RPE missing";
}

// The row's words (section 4.1): one entry bare, several each named by its
// session (or "RPE request"); "" when the read gave nothing to say.
export function ccAthleteAnswerText(list) {
  const shown = (list || []).map((entry) => ({ entry, words: entryWords(entry) })).filter((x) => x.words);
  if (!shown.length) return "";
  if (shown.length === 1) return shown[0].words;
  return shown.map(({ entry, words }) => `${entry.label} ${words}`).join(" · ");
}

// "Changed HH:MM" comes from the questions read only (section 4.1): the
// latest change of that athlete's answer to the event's RPE question.
export function ccChangedAtOf(questionsRead, athleteId) {
  let latest = null;
  for (const question of questionsRead?.questions || []) {
    if (question?.kind !== "rpe") continue;
    for (const person of question.answered || []) {
      if (String(person?.athleteId) !== String(athleteId) || !person.changed || !person.lastChangedAt) continue;
      const at = Date.parse(person.lastChangedAt);
      if (Number.isFinite(at) && (latest == null || at > latest)) latest = at;
    }
  }
  return latest == null ? null : new Date(latest);
}

export function ccChangedText(at) {
  if (!(at instanceof Date) || Number.isNaN(at.getTime())) return "";
  return `Changed ${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
}

// The same words for a screen reader: "·" as commas, "min" as "minutes".
export function ccSpokenAnswerText(text) {
  return String(text || "").replace(/ · /g, ", ").replace(/(\d+) min\b/g, (_, n) => `${n} ${n === "1" ? "minute" : "minutes"}`);
}
