import fs from "fs";
import path from "path";
import process from "process";
import zlib from "zlib";
import { createHash } from "crypto";
import { createRequire } from "module";

const require = createRequire(new URL("../backend/package.json", import.meta.url));
export const { Client } = require("pg");

export const DEFAULT_OWNER_EMAIL = "predrag.bozic@rzsport.gov.rs";
export const DEFAULT_EXCEL_PATH = path.resolve("Program_cleaned.xlsx");
export const DEFAULT_PACKAGE_DATE = "2026-08-18";

export const BASE_HEADERS = [
  "date", "day_note", "am_pm", "bta", "athlete_id", "athlete", "athlete_image_url",
  "domain", "domain_color", "domain_icon_url", "domain_short_note", "domain_note",
  "category", "category_color", "category_icon_url", "category_short_note", "category_note",
  "section", "section_color", "section_icon_url", "section_short_note", "section_note",
  "title", "description", "image_url", "video", "sets", "reps", "load",
  "order", "program_order", "domain_order", "category_order", "section_order",
  "exercise_order", "plan_type", "program_name", "program_note", "program_icon_url",
  "program_start", "program_duration_days",
];
export const OPTIONAL_HEADERS = ["exercise_code", "code", "duration", "distance", "rest", "instruction"];
export const ALL_HEADERS = [...BASE_HEADERS, ...OPTIONAL_HEADERS];

export function readEnvFile(filePath = path.resolve("backend/.env")) {
  if (!fs.existsSync(filePath)) return {};
  return Object.fromEntries(
    fs.readFileSync(filePath, "utf8")
      .split(/\r?\n/)
      .map((line) => line.match(/^([^#=]+)=(.*)$/))
      .filter(Boolean)
      .map((match) => [match[1].trim(), match[2].trim()]),
  );
}

export function parseArgs(argv) {
  const args = { _: [], dryRun: false, applyLocal: false, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--apply-local") args.applyLocal = true;
    else if (arg === "--json") args.json = true;
    else if (arg.startsWith("--")) {
      const key = arg.slice(2).replace(/-([a-z])/g, (_m, ch) => ch.toUpperCase());
      args[key] = argv[++index] || "";
    } else {
      args._.push(arg);
    }
  }
  return args;
}

export function safeDbLabel(connectionString) {
  if (!connectionString) return { available: false };
  try {
    const parsed = new URL(connectionString);
    return {
      available: true,
      parseable: true,
      protocol: parsed.protocol.replace(":", ""),
      host: parsed.hostname,
      port: parsed.port || "",
      database: parsed.pathname.replace(/^\//, ""),
      appearsLocal: /^(localhost|127\.0\.0\.1|::1)$/i.test(parsed.hostname),
      appearsSupabase: /supabase\.com/i.test(parsed.hostname),
    };
  } catch {
    return { available: true, parseable: false };
  }
}

export function assertLocalDatabase(connectionString) {
  const label = safeDbLabel(connectionString);
  if (!label.appearsLocal || /supabase\.com|render|prod|production/i.test(connectionString)) {
    throw new Error("Refusing --apply-local: target database is not clearly localhost/dev.");
  }
}

export async function connectReadOnly(connectionString) {
  const client = new Client({ connectionString });
  await client.connect();
  await client.query("begin transaction read only");
  client.safeLabel = safeDbLabel(connectionString);
  return client;
}

export async function finishReadOnly(client) {
  if (!client) return;
  try {
    await client.query("rollback");
  } finally {
    await client.end();
  }
}

export function cleanText(value) {
  return String(value ?? "").trim();
}

export function normalize(value) {
  return cleanText(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\u0111/g, "dj")
    .replace(/\u0110/g, "dj")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function slugify(value) {
  return normalize(value).replace(/\s+/g, "-").replace(/^-+|-+$/g, "").slice(0, 90) || "item";
}

export function packageIdForPlayer(name, date = DEFAULT_PACKAGE_DATE, sourceId = "") {
  const athletePart = normalizeSourceId(sourceId) ? `-${slugify(normalizeSourceId(sourceId))}` : "";
  return `${slugify(name)}${athletePart}-cleaned-${date}`;
}

export function packageExerciseSlug(packageId, name) {
  const hash = createHash("sha1").update(`${packageId}:${name}`, "utf8").digest("hex").slice(0, 10);
  return `${packageId}:custom:${slugify(name).slice(0, 72)}:${hash}`;
}

export function normalizeSourceId(value) {
  return cleanText(value).replace(/\.0$/, "");
}

function excelDate(serial) {
  return new Date(Date.UTC(1899, 11, 30 + Number(serial)));
}

export function toIsoDate(date) {
  return date.toISOString().slice(0, 10);
}

export function parseDate(value) {
  if (value instanceof Date && !Number.isNaN(value.valueOf())) return value;
  const raw = cleanText(value);
  if (!raw) return null;
  let match = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (match) {
    const [, day, month, year] = match.map(Number);
    return new Date(Date.UTC(year, month - 1, day));
  }
  match = raw.match(/^(\d{2})(\d{2})\/(\d{4})$/);
  if (match) {
    const [, day, month, year] = match.map(Number);
    return new Date(Date.UTC(year, month - 1, day));
  }
  match = raw.match(/^(\d{4})-(\d{2})-(\d{2})(?:\s|T|$)/);
  if (match) {
    const [, year, month, day] = match.map(Number);
    return new Date(Date.UTC(year, month - 1, day));
  }
  if (/^\d+(\.0)?$/.test(raw)) return excelDate(raw);
  return null;
}

export function weekStart(date) {
  const copy = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = copy.getUTCDay() || 7;
  copy.setUTCDate(copy.getUTCDate() - day + 1);
  return copy;
}

function numberOrNull(value) {
  const raw = cleanText(value).replace(",", ".");
  if (!raw) return null;
  const number = Number(raw);
  return Number.isFinite(number) ? number : null;
}

function intOrNull(value) {
  const number = numberOrNull(value);
  return number === null ? null : Math.trunc(number);
}

function parseZipEntries(buffer) {
  const entries = new Map();
  let eocdOffset = -1;
  for (let offset = buffer.length - 22; offset >= 0; offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) {
      eocdOffset = offset;
      break;
    }
  }
  if (eocdOffset < 0) throw new Error("Could not find XLSX ZIP central directory.");
  const centralSize = buffer.readUInt32LE(eocdOffset + 12);
  const centralOffset = buffer.readUInt32LE(eocdOffset + 16);
  let offset = centralOffset;
  const centralEnd = centralOffset + centralSize;
  while (offset < centralEnd && buffer.readUInt32LE(offset) === 0x02014b50) {
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const fileNameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localHeaderOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.slice(offset + 46, offset + 46 + fileNameLength).toString("utf8");
    const localFileNameLength = buffer.readUInt16LE(localHeaderOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localHeaderOffset + 28);
    const dataStart = localHeaderOffset + 30 + localFileNameLength + localExtraLength;
    const data = buffer.slice(dataStart, dataStart + compressedSize);
    if (method === 0) entries.set(name, data);
    else if (method === 8) entries.set(name, zlib.inflateRawSync(data));
    offset += 46 + fileNameLength + extraLength + commentLength;
  }
  return entries;
}

function decodeXml(value) {
  return String(value || "")
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_match, number) => String.fromCodePoint(Number(number)))
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function attrs(xmlTag) {
  const result = {};
  for (const match of xmlTag.matchAll(/\s([^=\s]+)="([^"]*)"/g)) result[match[1]] = decodeXml(match[2]);
  return result;
}

function colIndex(cellRef) {
  const letters = (cellRef.match(/[A-Z]+/i) || [""])[0].toUpperCase();
  let number = 0;
  for (const letter of letters) number = number * 26 + letter.charCodeAt(0) - 64;
  return number - 1;
}

export function readWorkbook(filePath) {
  const entries = parseZipEntries(fs.readFileSync(filePath));
  const sharedXml = entries.get("xl/sharedStrings.xml")?.toString("utf8") || "";
  const sharedStrings = [...sharedXml.matchAll(/<si\b[\s\S]*?<\/si>/g)].map((match) => (
    [...match[0].matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((part) => decodeXml(part[1])).join("")
  ));
  const workbookXml = entries.get("xl/workbook.xml").toString("utf8");
  const relsXml = entries.get("xl/_rels/workbook.xml.rels").toString("utf8");
  const rels = new Map([...relsXml.matchAll(/<Relationship\b[^>]*\/>/g)].map((match) => {
    const attr = attrs(match[0]);
    return [attr.Id, attr.Target];
  }));
  const sheets = [];
  for (const match of workbookXml.matchAll(/<sheet\b[^>]*\/>/g)) {
    const attr = attrs(match[0]);
    const target = rels.get(attr["r:id"]);
    const cleanTarget = target.replace(/^\//, "");
    const sheetPath = cleanTarget.startsWith("xl/") ? cleanTarget : `xl/${cleanTarget}`;
    const xml = entries.get(sheetPath).toString("utf8");
    const rows = [];
    const hiddenColumns = [...xml.matchAll(/<col\b[^>]*hidden="1"[^>]*\/>/g)].map((m) => attrs(m[0]));
    const mergedRanges = [...xml.matchAll(/<mergeCell\b[^>]*ref="([^"]+)"[^>]*\/>/g)].map((m) => decodeXml(m[1]));
    const formulas = [];
    for (const rowMatch of xml.matchAll(/<row\b[^>]*(?:\/>|>[\s\S]*?<\/row>)/g)) {
      const rowTag = rowMatch[0].match(/<row\b[^>]*>/)?.[0] || rowMatch[0];
      const rowAttr = attrs(rowTag);
      const values = [];
      for (const cellMatch of rowMatch[0].matchAll(/<c\b[^>]*\/>|<c\b[^>]*>[\s\S]*?<\/c>/g)) {
        const cell = cellMatch[0];
        const cellAttr = attrs(cell.match(/<c\b[^>]*>/)?.[0] || cell);
        const index = colIndex(cellAttr.r || "");
        while (values.length <= index) values.push("");
        const formula = cell.match(/<f\b[^>]*>([\s\S]*?)<\/f>/)?.[1];
        if (formula) formulas.push({ cell: cellAttr.r, formula: decodeXml(formula) });
        if (cellAttr.t === "inlineStr") {
          values[index] = [...cell.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((part) => decodeXml(part[1])).join("");
        } else {
          const raw = (cell.match(/<v>([\s\S]*?)<\/v>/) || [null, ""])[1];
          values[index] = cellAttr.t === "s" ? sharedStrings[Number(raw)] || "" : decodeXml(raw);
        }
      }
      rows.push({ rowNumber: Number(rowAttr.r), hidden: rowAttr.hidden === "1", values });
    }
    const nonemptyRows = rows.filter((row) => row.values.some((value) => cleanText(value)));
    const headers = nonemptyRows[0]?.values.map(cleanText) || [];
    const commentsCount = [...entries.keys()].filter((key) => key.startsWith("xl/comments")).length;
    sheets.push({
      name: attr.name,
      state: attr.state || "visible",
      path: sheetPath,
      rows,
      nonemptyRows,
      headers,
      hiddenColumns,
      hiddenRows: rows.filter((row) => row.hidden).map((row) => row.rowNumber),
      mergedRanges,
      formulas,
      commentsCount,
      maxColumn: Math.max(headers.length, ...rows.map((row) => row.values.length)),
    });
  }
  return sheets;
}

function rowGetter(headers, row) {
  const index = new Map(headers.map((header, idx) => [header, idx]).filter(([header]) => header));
  return (name) => {
    const idx = index.get(name);
    return idx === undefined || idx >= row.values.length ? "" : cleanText(row.values[idx]);
  };
}

export function workbookRows(sheets) {
  const rows = [];
  const sheetReports = [];
  for (const sheet of sheets) {
    const usedColumnIndexes = new Set();
    for (const row of sheet.rows) {
      row.values.forEach((value, index) => {
        if (cleanText(value)) usedColumnIndexes.add(index + 1);
      });
    }
    sheetReports.push({
      sheet: sheet.name,
      state: sheet.state,
      rowsPhysical: sheet.rows.length,
      rowsNonEmpty: sheet.nonemptyRows.length,
      headerRow: sheet.nonemptyRows[0]?.rowNumber || null,
      maxColumn: sheet.maxColumn,
      columns: sheet.headers.map((name, index) => ({ index: index + 1, name: name || null })),
      usedColumnIndexes: [...usedColumnIndexes].sort((a, b) => a - b),
      hiddenColumns: sheet.hiddenColumns,
      hiddenRowsCount: sheet.hiddenRows.length,
      formulasCount: sheet.formulas.length,
      formulasSample: sheet.formulas.slice(0, 20),
      mergedRangesCount: sheet.mergedRanges.length,
      mergedRangesSample: sheet.mergedRanges.slice(0, 20),
      commentsFilesCount: sheet.commentsCount,
      missingExpectedColumns: BASE_HEADERS.filter((header) => !sheet.headers.includes(header)),
      optionalColumnsPresent: OPTIONAL_HEADERS.filter((header) => sheet.headers.includes(header)),
    });
    for (const row of sheet.rows.slice(1)) {
      const get = rowGetter(sheet.headers, row);
      const hasContent = sheet.headers.some((header) => cleanText(get(header)));
      if (!hasContent) continue;
      const date = parseDate(get("date"));
      const start = date ? weekStart(date) : null;
      const raw = Object.fromEntries(sheet.headers.map((header, idx) => [header || `__col_${idx + 1}`, row.values[idx] ?? ""]).filter(([, value]) => cleanText(value)));
      rows.push({
        sheet: sheet.name,
        sourceRow: row.rowNumber,
        raw,
        athleteId: normalizeSourceId(get("athlete_id")),
        athlete: get("athlete"),
        date: date ? toIsoDate(date) : "",
        dateText: get("date"),
        weekStart: start ? toIsoDate(start) : "",
        dayNote: get("day_note"),
        amPm: get("am_pm").toUpperCase(),
        bta: get("bta").toUpperCase(),
        planType: get("plan_type").toLowerCase() || "weekly",
        programName: get("program_name"),
        programStart: parseDate(get("program_start")) ? toIsoDate(parseDate(get("program_start"))) : "",
        programDurationDays: intOrNull(get("program_duration_days")),
        domain: get("domain"),
        category: get("category"),
        section: get("section"),
        title: get("title").replace(/\s+/g, " ").trim(),
        description: get("description"),
        imageUrl: get("image_url"),
        videoUrl: get("video"),
        sets: get("sets"),
        reps: get("reps"),
        load: get("load"),
        duration: get("duration"),
        distance: get("distance"),
        rest: get("rest"),
        instruction: get("instruction"),
        exerciseCode: normalizeSourceId(get("exercise_code") || get("code")),
        order: numberOrNull(get("order")),
        programOrder: numberOrNull(get("program_order")),
        domainOrder: numberOrNull(get("domain_order")),
        categoryOrder: numberOrNull(get("category_order")),
        sectionOrder: numberOrNull(get("section_order")),
        exerciseOrder: numberOrNull(get("exercise_order")),
      });
    }
  }
  return { sheetReports, rows };
}

export function groupRowsByPlayer(rows) {
  const byPlayer = new Map();
  const ambiguousRows = [];
  for (const row of rows) {
    const nameKey = normalize(row.athlete);
    const idKey = row.athleteId;
    if (!nameKey && !idKey) {
      ambiguousRows.push({ row: row.sourceRow, sheet: row.sheet, reason: "missing athlete and athlete_id" });
      continue;
    }
    const key = `${nameKey}|${idKey}`;
    if (!byPlayer.has(key)) byPlayer.set(key, { key, athlete: row.athlete, athleteId: row.athleteId, rows: [] });
    byPlayer.get(key).rows.push(row);
  }
  return { players: [...byPlayer.values()], ambiguousRows };
}

export function detectPlayerStructure(sheets, rows) {
  const sheetNames = new Set(rows.map((row) => row.sheet));
  const athleteNames = new Set(rows.map((row) => row.athlete).filter(Boolean));
  const athleteIds = new Set(rows.map((row) => row.athleteId).filter(Boolean));
  return {
    mode: sheetNames.size > 1 && athleteNames.size === sheetNames.size ? "likely-player-per-sheet" : "single-sheet-athlete-columns",
    sheetCount: sheets.length,
    athleteColumnPresent: sheets.some((sheet) => sheet.headers.includes("athlete")),
    athleteIdColumnPresent: sheets.some((sheet) => sheet.headers.includes("athlete_id")),
    athleteNames: [...athleteNames].sort(),
    athleteIds: [...athleteIds].sort(),
  };
}

export function summarizePlayerRows(player, packageDate = DEFAULT_PACKAGE_DATE) {
  const rows = player.rows;
  const exerciseRows = rows.filter((row) => row.title);
  const noteRows = rows.filter((row) => !row.title);
  const dates = rows.map((row) => row.date).filter(Boolean).sort();
  const weekStarts = [...new Set(rows.map((row) => row.weekStart).filter(Boolean))].sort();
  const sessions = new Set(rows.filter((row) => row.date).map((row) => `${row.date}|${row.amPm}|${row.bta}|${row.dayNote}`));
  const dayKeys = new Set(rows.map((row) => row.date).filter(Boolean));
  const categories = new Set(rows.map((row) => row.category).filter(Boolean));
  const sections = new Set(rows.map((row) => `${row.category}|${row.section}`).filter((value) => value !== "|"));
  const badDates = rows.filter((row) => row.dateText && !row.date).map((row) => ({ row: row.sourceRow, dateText: row.dateText }));
  const partialRows = rows.filter((row) => !row.date || !row.athlete || !row.athleteId || (!row.title && !row.description && !row.section && !row.category))
    .map((row) => ({ row: row.sourceRow, dateText: row.dateText, athlete: row.athlete, athleteId: row.athleteId, title: row.title || null, nonemptyFields: Object.keys(row.raw).length }));
  const duplicateCounter = new Map();
  for (const row of rows) {
    const key = JSON.stringify([row.date, row.athleteId, row.athlete, row.category, row.section, row.title, row.description, row.sets, row.reps, row.load, row.order]);
    duplicateCounter.set(key, (duplicateCounter.get(key) || 0) + 1);
  }
  const duplicateRows = [...duplicateCounter.values()].filter((count) => count > 1).reduce((sum, count) => sum + count - 1, 0);
  const packageId = packageIdForPlayer(player.athlete || `athlete-${player.athleteId}`, packageDate, player.athleteId);
  return {
    excelName: player.athlete,
    athleteIdFromExcel: player.athleteId,
    packageId,
    packageSlugPrefix: `${packageId}:custom:`,
    rows: rows.length,
    populatedRows: rows.length,
    weeks: weekStarts.length,
    weekStarts,
    days: dayKeys.size,
    sessions: sessions.size,
    categories: categories.size,
    sections: sections.size,
    exerciseItems: exerciseRows.length,
    noteItems: noteRows.length,
    period: { start: dates[0] || null, end: dates[dates.length - 1] || null },
    unparsedRows: badDates,
    partialRows,
    duplicateRows,
    inconsistentDateRows: badDates,
  };
}

export function buildPlayerPackages(rows) {
  const { players, ambiguousRows } = groupRowsByPlayer(rows);
  const nameToIds = new Map();
  for (const player of players) {
    const nameKey = normalize(player.athlete);
    if (!nameKey) continue;
    if (!nameToIds.has(nameKey)) nameToIds.set(nameKey, new Set());
    nameToIds.get(nameKey).add(player.athleteId || "");
  }
  const duplicateNameWarnings = players
    .filter((player) => {
      const ids = nameToIds.get(normalize(player.athlete));
      return ids && ids.size > 1;
    })
    .map((player) => ({
      athlete: player.athlete,
      athleteId: player.athleteId,
      reason: "same normalized athlete name appears with multiple athlete_id values",
      rowCount: player.rows.length,
    }));
  return { players: players.map((player) => ({ ...player, summary: summarizePlayerRows(player) })), ambiguousRows, duplicateNameWarnings };
}

export async function loadDbAuditIndex(client) {
  const athletes = await client.query(
    `select a.id, a.athlete_id, a.source_external_id, a.full_name, a.display_name, a.user_id, a.is_active,
            (u.id is not null) as has_user
     from public.athletes a
     left join public.users u on u.id = a.user_id`,
  );
  const exercises = await client.query(
    `select id, exercise_code, slug, name, owner_scope, owner_user_id, is_active
     from library.exercises
     where coalesce(is_active, true)`,
  );
  const plans = await client.query(
    `select p.id, p.athlete_id, p.created_by_user_id, p.name, p.plan_type, p.week_start, p.status, p.source_type, p.source_ref,
            (select count(*)::int from plans.plan_days pd where pd.plan_id = p.id) as days,
            (select count(*)::int from plans.plan_sessions ps join plans.plan_days pd on pd.id = ps.plan_day_id where pd.plan_id = p.id) as sessions,
            (select count(*)::int from plans.plan_items pi join plans.plan_sessions ps on ps.id = pi.plan_session_id join plans.plan_days pd on pd.id = ps.plan_day_id where pd.plan_id = p.id) as items
     from plans.plans p
     where p.plan_type = 'weekly' and coalesce(p.is_active, true)`,
  );
  const relationships = await client.query(
    `select 'private_coach' as kind, coach_user_id::text as owner_id, athlete_id::text, is_active from public.coach_athletes
     union all
     select 'club' as kind, club_id::text as owner_id, athlete_id::text, is_active from public.athlete_club_memberships
     union all
     select 'team' as kind, team_id::text as owner_id, athlete_id::text, is_active from public.athlete_team_memberships`,
  ).catch(() => ({ rows: [] }));
  const exerciseByCode = new Map();
  const exercisesByName = new Map();
  for (const row of exercises.rows) {
    if (row.exercise_code) exerciseByCode.set(String(row.exercise_code), row);
    const key = normalize(row.name);
    if (!exercisesByName.has(key)) exercisesByName.set(key, []);
    exercisesByName.get(key).push(row);
  }
  return { athletes: athletes.rows, exercises: exercises.rows, exerciseByCode, exercisesByName, plans: plans.rows, relationships: relationships.rows };
}

export function resolveAthleteCandidates(player, dbIndex) {
  const id = player.athleteId;
  let candidates = [];
  let strategy = "";
  let nameMismatch = false;
  if (id) {
    candidates = dbIndex.athletes.filter((row) => String(row.athlete_id || "") === id || String(row.source_external_id || "") === id);
    strategy = "athlete_id/source_external_id";
    if (candidates.length === 1 && normalize(player.athlete) && normalize(candidates[0].display_name || candidates[0].full_name) !== normalize(player.athlete)) {
      nameMismatch = true;
    }
  }
  if (!candidates.length) {
    candidates = dbIndex.athletes.filter((row) => normalize(row.display_name || row.full_name) === normalize(player.athlete));
    strategy = "exact_normalized_name";
  }
  return {
    strategy,
    status: candidates.length === 1 && !nameMismatch ? "confirmed" : "requires confirmation",
    nameMismatch,
    candidates: candidates.map((row) => ({
      athleteUuid: row.id,
      athleteId: row.athlete_id,
      sourceExternalId: row.source_external_id,
      fullName: row.full_name,
      displayName: row.display_name,
      hasUser: row.has_user,
      isActive: row.is_active,
    })),
  };
}

export function resolveExercise(row, dbIndex, packageId) {
  if (!row.title) return { status: "note" };
  if (row.exerciseCode) {
    const match = dbIndex.exerciseByCode.get(row.exerciseCode);
    if (!match) return { status: "missing-code", exerciseCode: row.exerciseCode, title: row.title };
    return { status: "code", exerciseId: match.id, exerciseCode: match.exercise_code, exerciseName: match.name };
  }
  const exact = dbIndex.exercisesByName.get(normalize(row.title)) || [];
  if (exact.length === 1) return { status: "unique-title", exerciseId: exact[0].id, exerciseName: exact[0].name, exerciseCode: exact[0].exercise_code };
  const slug = packageExerciseSlug(packageId, row.title);
  return {
    status: exact.length ? "new-custom-ambiguous" : "new-custom-missing",
    customSlug: slug,
    title: row.title,
    existingCandidates: exact.map((match) => ({ id: match.id, exerciseCode: match.exercise_code, name: match.name })),
  };
}

export function buildExerciseMapping(player, dbIndex) {
  const packageId = player.summary.packageId;
  const counts = { code: 0, "unique-title": 0, "new-custom-missing": 0, "new-custom-ambiguous": 0, note: 0, "missing-code": 0 };
  const custom = new Map();
  const missingCodes = new Map();
  for (const row of player.rows) {
    const resolved = resolveExercise(row, dbIndex, packageId);
    counts[resolved.status] = (counts[resolved.status] || 0) + 1;
    if (resolved.status === "missing-code") missingCodes.set(resolved.exerciseCode, { exerciseCode: resolved.exerciseCode, rows: [...(missingCodes.get(resolved.exerciseCode)?.rows || []), row.sourceRow], titles: [...new Set([...(missingCodes.get(resolved.exerciseCode)?.titles || []), row.title])] });
    if (resolved.status === "new-custom-missing" || resolved.status === "new-custom-ambiguous") {
      const key = normalize(row.title);
      if (!custom.has(key)) custom.set(key, { name: row.title, slug: resolved.customSlug, reason: resolved.status, rows: [], existingCandidates: resolved.existingCandidates || [] });
      custom.get(key).rows.push(row.sourceRow);
    }
  }
  return {
    counts,
    customCandidates: [...custom.values()].sort((a, b) => a.name.localeCompare(b.name)),
    missingCodes: [...missingCodes.values()].sort((a, b) => String(a.exerciseCode).localeCompare(String(b.exerciseCode))),
    totalExerciseItems: player.summary.exerciseItems,
    reconciles: counts.code + counts["unique-title"] + counts["new-custom-missing"] + counts["new-custom-ambiguous"] + counts["missing-code"] === player.summary.exerciseItems,
  };
}

export function findWeeklyConflicts(player, athleteResolution, dbIndex) {
  if (athleteResolution.status !== "confirmed") return [];
  const athleteUuid = athleteResolution.candidates[0].athleteUuid;
  const weeks = new Set(player.summary.weekStarts);
  return dbIndex.plans
    .filter((plan) => plan.athlete_id === athleteUuid && weeks.has(String(plan.week_start).slice(0, 10)))
    .map((plan) => ({
      athlete: player.athlete,
      weekStart: String(plan.week_start).slice(0, 10),
      planId: plan.id,
      name: plan.name,
      status: plan.status,
      sourceType: plan.source_type,
      sourceRef: plan.source_ref,
      createdBy: plan.created_by_user_id,
      days: plan.days,
      sessions: plan.sessions,
      items: plan.items,
      recommendation: "requires manual review",
    }));
}

export function proposeManifest(player, athleteResolution, ownerEmail = DEFAULT_OWNER_EMAIL) {
  const confirmed = athleteResolution.status === "confirmed";
  return {
    packageId: player.summary.packageId,
    excelPath: DEFAULT_EXCEL_PATH,
    rowSelection: { sheet: player.rows[0]?.sheet || "Sheet1", athlete: player.athlete, athleteId: player.athleteId },
    athleteId: confirmed ? athleteResolution.candidates[0].athleteId : null,
    sourceExternalId: confirmed ? athleteResolution.candidates[0].sourceExternalId : player.athleteId || null,
    expectedNameForAuditOnly: player.athlete,
    ownerCoach: ownerEmail,
    expectedPeriod: player.summary.period,
    defaultStatus: "draft",
    weeklyConflictRule: "skip/replace only after JSON backup and explicit confirmed plan id",
    packageSlugPrefix: player.summary.packageSlugPrefix,
    status: confirmed ? "proposed" : "requires athlete confirmation before final manifest",
  };
}

export function buildAuditReport({ workbookPath, sheets, rows, dbIndex = null, ownerEmail = DEFAULT_OWNER_EMAIL }) {
  const { players, ambiguousRows, duplicateNameWarnings } = buildPlayerPackages(rows);
  const structure = detectPlayerStructure(sheets, rows);
  const playerReports = players.map((player) => {
    const athleteResolution = dbIndex ? resolveAthleteCandidates(player, dbIndex) : { status: "not checked", candidates: [] };
    const exerciseMapping = dbIndex ? buildExerciseMapping(player, dbIndex) : null;
    const conflicts = dbIndex ? findWeeklyConflicts(player, athleteResolution, dbIndex) : [];
    return {
      ...player.summary,
      athleteResolution,
      exerciseMapping,
      weeklyConflicts: conflicts,
      manifestProposal: proposeManifest(player, athleteResolution, ownerEmail),
    };
  });
  return {
    mode: "dry-run",
    workbookPath,
    workbook: {
      sheets: sheets.map((sheet) => sheet.name),
      sheetReports: workbookRows(sheets).sheetReports,
      structure,
      totalRowsPhysical: sheets.reduce((sum, sheet) => sum + sheet.rows.length, 0),
      totalRowsNonEmpty: sheets.reduce((sum, sheet) => sum + sheet.nonemptyRows.length, 0),
      dataRows: rows.length,
      ambiguousRows,
      duplicateNameWarnings,
    },
    players: playerReports,
    reconciliation: {
      playerRows: playerReports.reduce((sum, player) => sum + player.rows, 0),
      workbookDataRows: rows.length,
      matches: playerReports.reduce((sum, player) => sum + player.rows, 0) + ambiguousRows.length === rows.length,
    },
    allMissingCodes: playerReports.flatMap((player) => player.exerciseMapping?.missingCodes || []),
    allCustomCandidates: playerReports.flatMap((player) => (player.exerciseMapping?.customCandidates || []).map((candidate) => ({ athlete: player.excelName, ...candidate }))),
    allWeeklyConflicts: playerReports.flatMap((player) => player.weeklyConflicts),
    requiresConfirmation: playerReports.filter((player) => player.athleteResolution.status !== "confirmed").map((player) => ({ athlete: player.excelName, athleteId: player.athleteIdFromExcel, candidates: player.athleteResolution.candidates })),
  };
}

export function printReport(report) {
  const table = report.players.map((player) => ({
    name: player.excelName,
    rows: player.rows,
    excelAthleteId: player.athleteIdFromExcel,
    dbCandidate: player.athleteResolution.candidates.map((c) => c.athleteId || c.sourceExternalId || c.athleteUuid).join(", ") || "",
    mapping: player.athleteResolution.status,
    period: `${player.period.start || "?"}..${player.period.end || "?"}`,
    weeks: player.weeks,
    days: player.days,
    sessions: player.sessions,
    sections: player.sections,
    exerciseItems: player.exerciseItems,
    noteItems: player.noteItems,
    code: player.exerciseMapping?.counts.code ?? "",
    uniqueTitle: player.exerciseMapping?.counts["unique-title"] ?? "",
    custom: (player.exerciseMapping?.counts["new-custom-missing"] ?? 0) + (player.exerciseMapping?.counts["new-custom-ambiguous"] ?? 0),
    conflicts: player.weeklyConflicts.length,
    unparsed: player.unparsedRows.length,
  }));
  console.table(table);
  console.log(JSON.stringify({
    workbook: report.workbook,
    packageIds: report.players.map((player) => player.packageId),
    duplicateNameWarnings: report.workbook.duplicateNameWarnings,
    requiresConfirmation: report.requiresConfirmation,
    missingCodes: report.allMissingCodes,
    customCandidates: report.allCustomCandidates,
    weeklyConflicts: report.allWeeklyConflicts,
    reconciliation: report.reconciliation,
  }, null, 2));
}
