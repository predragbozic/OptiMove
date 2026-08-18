import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assertLocalDatabase,
  buildAuditReport,
  buildPlayerPackages,
  packageIdForPlayer,
  parseDate,
  toIsoDate,
  weekStart,
} from "../../tools/training_package_core.mjs";

function row(overrides = {}) {
  const date = overrides.date || "2026-08-03";
  const parsed = parseDate(date);
  return {
    sheet: overrides.sheet || "Sheet1",
    sourceRow: overrides.sourceRow || 2,
    raw: overrides.raw || { date, athlete_id: overrides.athleteId || "201", athlete: overrides.athlete || "Player One" },
    athleteId: overrides.athleteId ?? "201",
    athlete: overrides.athlete ?? "Player One",
    date: parsed ? toIsoDate(parsed) : "",
    dateText: date,
    weekStart: parsed ? toIsoDate(weekStart(parsed)) : "",
    dayNote: overrides.dayNote || "",
    amPm: overrides.amPm || "AM",
    bta: overrides.bta || "T",
    planType: "weekly",
    programName: overrides.programName || "",
    programStart: "",
    programDurationDays: null,
    domain: overrides.domain || "",
    category: overrides.category || "Prep",
    section: overrides.section || "Warm up",
    title: Object.hasOwn(overrides, "title") ? overrides.title : "Known by code",
    description: overrides.description || "",
    imageUrl: "",
    videoUrl: "",
    sets: overrides.sets || "1",
    reps: overrides.reps || "5",
    load: overrides.load || "",
    duration: "",
    distance: "",
    rest: "",
    instruction: overrides.instruction || "",
    exerciseCode: overrides.exerciseCode || "",
    order: overrides.order ?? 1,
    programOrder: null,
    domainOrder: null,
    categoryOrder: 1,
    sectionOrder: 1,
    exerciseOrder: overrides.exerciseOrder ?? 1,
  };
}

function fakeSheets(names = ["Sheet1"]) {
  return names.map((name) => ({
    name,
    state: "visible",
    rows: [{ rowNumber: 1, values: ["date", "athlete_id", "athlete", "title"] }],
    nonemptyRows: [{ rowNumber: 1, values: ["date", "athlete_id", "athlete", "title"] }],
    headers: ["date", "athlete_id", "athlete", "title"],
    hiddenColumns: [],
    hiddenRows: [],
    mergedRanges: [],
    formulas: [],
    commentsCount: 0,
    maxColumn: 4,
  }));
}

function fakeDbIndex() {
  const athlete = (id, name, uuid = `ath-${id}`) => ({
    id: uuid,
    athlete_id: id,
    source_external_id: id,
    full_name: name,
    display_name: name,
    has_user: true,
    user_id: `user-${id}`,
    is_active: true,
  });
  const exerciseByCode = new Map([
    ["10", { id: "ex-code-10", exercise_code: "10", name: "Known by code" }],
  ]);
  const exercisesByName = new Map([
    ["unique title", [{ id: "ex-title-1", exercise_code: null, name: "Unique title" }]],
    ["ambiguous title", [
      { id: "ex-amb-1", exercise_code: null, name: "Ambiguous title" },
      { id: "ex-amb-2", exercise_code: null, name: "Ambiguous title" },
    ]],
  ]);
  return {
    athletes: [
      athlete("201", "Player One"),
      athlete("202", "Player Two"),
      athlete("203", "Player Three"),
      athlete("204", "Player Four"),
      athlete("999", "Ambiguous Person", "ath-999-a"),
      athlete("998", "Ambiguous Person", "ath-999-b"),
    ],
    exerciseByCode,
    exercisesByName,
    exercises: [...exerciseByCode.values(), ...[...exercisesByName.values()].flat()],
    plans: [
      { id: "plan-1", athlete_id: "ath-201", created_by_user_id: "coach-1", name: "Existing week", week_start: "2026-08-03", status: "active", source_type: "builder", source_ref: null, days: 7, sessions: 1, items: 2 },
    ],
    relationships: [],
  };
}

test("generic audit supports four players in one sheet and reconciles counts", () => {
  const rows = [
    row({ athlete: "Player One", athleteId: "201", sourceRow: 2, exerciseCode: "10" }),
    row({ athlete: "Player Two", athleteId: "202", sourceRow: 3, title: "Unique title" }),
    row({ athlete: "Player Three", athleteId: "203", sourceRow: 4, title: "Missing custom" }),
    row({ athlete: "Player Four", athleteId: "204", sourceRow: 5, title: null, description: "Team meeting" }),
  ];
  const report = buildAuditReport({ workbookPath: "fixture.xlsx", sheets: fakeSheets(), rows, dbIndex: fakeDbIndex() });
  assert.equal(report.players.length, 4);
  assert.equal(report.reconciliation.matches, true);
  assert.equal(report.players.reduce((sum, player) => sum + player.rows, 0), 4);
});

test("generic audit supports player-per-sheet fixtures", () => {
  const rows = [
    row({ sheet: "Player A", athlete: "Player One", athleteId: "201", sourceRow: 2 }),
    row({ sheet: "Player B", athlete: "Player Two", athleteId: "202", sourceRow: 2 }),
  ];
  const report = buildAuditReport({ workbookPath: "fixture.xlsx", sheets: fakeSheets(["Player A", "Player B"]), rows, dbIndex: fakeDbIndex() });
  assert.equal(report.workbook.structure.sheetCount, 2);
  assert.equal(report.players.length, 2);
});

test("generic audit supports player-by-column/block and flags missing athlete ID", () => {
  const rows = [
    row({ athlete: "Player One", athleteId: "201", sourceRow: 2 }),
    row({ athlete: "No Id Player", athleteId: "", sourceRow: 3 }),
  ];
  const packages = buildPlayerPackages(rows);
  assert.equal(packages.players.length, 2);
  const report = buildAuditReport({ workbookPath: "fixture.xlsx", sheets: fakeSheets(), rows, dbIndex: fakeDbIndex() });
  assert.equal(report.players.find((player) => player.excelName === "No Id Player").athleteResolution.status, "requires confirmation");
});

test("generic audit flags ambiguous athlete mapping", () => {
  const rows = [row({ athlete: "Ambiguous Person", athleteId: "", sourceRow: 2 })];
  const report = buildAuditReport({ workbookPath: "fixture.xlsx", sheets: fakeSheets(), rows, dbIndex: fakeDbIndex() });
  assert.equal(report.players[0].athleteResolution.status, "requires confirmation");
  assert.equal(report.players[0].athleteResolution.candidates.length, 2);
});

test("generic audit flags athlete id and name mismatches", () => {
  const rows = [row({ athlete: "Wrong Display", athleteId: "201", sourceRow: 2 })];
  const report = buildAuditReport({ workbookPath: "fixture.xlsx", sheets: fakeSheets(), rows, dbIndex: fakeDbIndex() });
  assert.equal(report.players[0].athleteResolution.strategy, "athlete_id/source_external_id");
  assert.equal(report.players[0].athleteResolution.status, "requires confirmation");
  assert.equal(report.players[0].athleteResolution.nameMismatch, true);
});

test("generic audit detects duplicate Excel rows and missing exercise codes", () => {
  const rows = [
    row({ sourceRow: 2, exerciseCode: "404", title: "Missing code" }),
    row({ sourceRow: 3, exerciseCode: "404", title: "Missing code" }),
  ];
  const report = buildAuditReport({ workbookPath: "fixture.xlsx", sheets: fakeSheets(), rows, dbIndex: fakeDbIndex() });
  assert.equal(report.players[0].duplicateRows, 1);
  assert.equal(report.players[0].exerciseMapping.counts["missing-code"], 2);
  assert.equal(report.players[0].exerciseMapping.missingCodes[0].exerciseCode, "404");
});

test("generic audit resolves unique exact-title and proposes custom for ambiguous title", () => {
  const rows = [
    row({ sourceRow: 2, title: "Unique title" }),
    row({ sourceRow: 3, title: "Ambiguous title" }),
  ];
  const report = buildAuditReport({ workbookPath: "fixture.xlsx", sheets: fakeSheets(), rows, dbIndex: fakeDbIndex() });
  assert.equal(report.players[0].exerciseMapping.counts["unique-title"], 1);
  assert.equal(report.players[0].exerciseMapping.counts["new-custom-ambiguous"], 1);
  assert.match(report.players[0].exerciseMapping.customCandidates[0].slug, /^player-one-201-cleaned-2026-08-18:custom:/);
});

test("generic audit preserves note items and weekly conflicts", () => {
  const rows = [row({ sourceRow: 2, title: null, description: "Travel note" })];
  const report = buildAuditReport({ workbookPath: "fixture.xlsx", sheets: fakeSheets(), rows, dbIndex: fakeDbIndex() });
  assert.equal(report.players[0].noteItems, 1);
  assert.equal(report.players[0].exerciseMapping.counts.note, 1);
  assert.equal(report.players[0].weeklyConflicts.length, 1);
  assert.equal(report.players[0].weeklyConflicts[0].recommendation, "requires manual review");
});

test("generic audit is stable across repeated dry-run calls", () => {
  const rows = [row({ sourceRow: 2, title: "Missing custom" })];
  const first = buildAuditReport({ workbookPath: "fixture.xlsx", sheets: fakeSheets(), rows, dbIndex: fakeDbIndex() });
  const second = buildAuditReport({ workbookPath: "fixture.xlsx", sheets: fakeSheets(), rows, dbIndex: fakeDbIndex() });
  assert.deepEqual(first.players[0].exerciseMapping, second.players[0].exerciseMapping);
  assert.equal(first.players[0].packageId, packageIdForPlayer("Player One", "2026-08-18", "201"));
});

test("apply-local guard rejects non-local targets", () => {
  assert.throws(() => assertLocalDatabase("postgresql://user:secret@example.supabase.com/postgres"), /Refusing --apply-local/);
});
