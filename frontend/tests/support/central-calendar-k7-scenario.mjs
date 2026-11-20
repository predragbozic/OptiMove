// K7's "unchanged" proof (docs/ai/central-calendar-k7-timegrid-contract.md section 6, DOM): one fixed calendar answer
// rendered in every layout and view K7 must not change - phone and medium in every view and mode, the wide week as
// a List and the wide Month. The snapshot `central-calendar-k7-unchanged.json` beside this file was made with this
// module on the main before K7 (de16eccf); the test renders the same with the head's code and compares byte for byte.
// The scenario is invented data only.

const TEAMS = [
  { teamId: "11111111-1111-4111-8111-111111111111", name: "U17", athleteCount: 12 },
  { teamId: "22222222-2222-4222-8222-222222222222", name: "U19", athleteCount: 14 },
];
const [U17, U19] = TEAMS.map((team) => team.teamId);
export const K7_TODAY = "2026-10-14";
const MONDAY = "2026-10-12";
const day = (n) => {
  const d = new Date(`${MONDAY}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

function event(key, date, fields = {}) {
  return {
    key, kind: "event", date, eventId: key.split(":")[1], eventKind: "training", eventTypeLabel: "Training", eventTypeId: null,
    eventTypeIconKey: null, eventTypeColorKey: null, title: "Team training", slot: null, startTime: "10:00", endTime: "11:00",
    startsAt: null, location: null, place: null, teamIds: [U17], athleteIds: [], athleteCount: 12, expects: [], status: "planned",
    rpe: null, attendance: null, results: null, cancelled: false, projected: false, span: { from: date, to: date }, gaps: [],
    scheduleFold: { external: null, test: null }, revision: 1, canManage: true, notes: null, details: null,
    links: { eventId: key.split(":")[1], planIds: [], logicalSessionIds: [], activityIds: [], externalScheduleId: null, testScheduleId: null },
    ...fields,
  };
}

function items() {
  return [
    // The owner's pair: two trainings that overlap.
    event("event:e1:a", day(0), { title: "Morning training", startTime: "00:00", endTime: "01:00" }),
    event("event:e2:a", day(0), { title: "Second group", startTime: "00:30", endTime: "01:29", teamIds: [U19] }),
    // Four at once.
    ...[1, 2, 3, 4].map((n) => event(`event:c${n}:a`, day(1), { title: `Cluster ${n}`, startTime: "10:00", endTime: "11:30" })),
    // A camp over three days.
    ...[2, 3, 4].map((n) => event(`event:camp:${n}`, day(n), { title: "Camp", startTime: "10:00", endTime: "16:00", span: { from: day(2), to: day(4) } })),
    // A planned training with only its slot, and one with a start.
    { ...event("planned:p1", day(2)), kind: "planned", title: "Gym", startTime: null, endTime: null, slot: { amPm: "AM", bta: "T", order: 1 } },
    { ...event("planned:p2", day(2)), kind: "planned", title: "Pitch", startTime: "17:30", endTime: null },
    // Chips: a test with a time, an RPE request without one, an imported activity.
    { ...event("test:t1:d", day(3)), kind: "test", title: "CMJ", startTime: "09:15", endTime: null },
    { ...event("external:x1:d", day(3)), kind: "external", title: "Away match", startTime: null, endTime: null },
    { ...event("activity:a1", day(5)), kind: "activity", title: "GPS session", origin: "api_import", startTime: "08:05", endTime: null },
  ];
}

function answer(from, to) {
  const all = items();
  const days = [];
  for (let n = 0, date = from; date <= to; n += 1, date = (() => { const d = new Date(`${date}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10); })()) {
    days.push({ date, items: all.filter((item) => item.date === date) });
  }
  return { from, to, today: K7_TODAY, workspace: { type: "team", scopeId: U17 }, teams: TEAMS, days };
}

// Every case K7 must leave byte for byte as it was.
export const K7_UNCHANGED_CASES = [
  ...["phone", "medium"].flatMap((layout) => ["week", "day", "month"].flatMap((view) => ["list", "grid"].map((mode) => ({ layout, view, mode })))),
  { layout: "wide", view: "week", mode: "list" },
  { layout: "wide", view: "month", mode: "list" },
  { layout: "wide", view: "month", mode: "grid" },
];

// The calendar state of a case: built on the app's own empty state, then the case's view, mode and answer.
export function k7CaseState(emptyState, { view, mode }) {
  const cal = emptyState();
  cal.view = view;
  cal.weekMode = mode;
  cal.anchor = view === "day" ? day(2) : MONDAY;
  cal.selectedDate = day(2);
  const from = view === "month" ? "2026-09-28" : view === "day" ? day(2) : MONDAY;
  const to = view === "month" ? "2026-11-08" : view === "day" ? day(2) : day(6);
  cal.data = answer(from, to);
  cal.range = { from, to };
  return cal;
}
