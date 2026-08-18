#!/usr/bin/env node
import fs from "fs";
import path from "path";
import process from "process";
import {
  assertLocalDatabase,
  buildAuditReport,
  connectReadOnly,
  DEFAULT_EXCEL_PATH,
  finishReadOnly,
  loadDbAuditIndex,
  parseArgs,
  printReport,
  readEnvFile,
  readWorkbook,
  workbookRows,
} from "./training_package_core.mjs";

function readManifest(filePath) {
  if (!filePath) throw new Error("--manifest <path> is required.");
  return JSON.parse(fs.readFileSync(path.resolve(filePath), "utf8"));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const manifest = readManifest(args.manifest);
  const workbookPath = path.resolve(manifest.excelPath || args.excel || args.workbook || DEFAULT_EXCEL_PATH);
  const env = readEnvFile();
  const databaseUrl = args.databaseUrl || process.env.LOCAL_DATABASE_URL || env.DATABASE_URL || "";

  if (args.applyLocal) {
    assertLocalDatabase(databaseUrl);
    throw new Error("--apply-local is intentionally disabled until the audited manifest is confirmed. No local data was changed.");
  }
  if (!args.dryRun) throw new Error("Use --dry-run for this phase. --apply-local is not enabled yet.");

  const sheets = readWorkbook(workbookPath);
  const { rows } = workbookRows(sheets);
  let client = null;
  try {
    client = await connectReadOnly(databaseUrl);
    const dbIndex = await loadDbAuditIndex(client);
    const report = buildAuditReport({ workbookPath, sheets, rows, dbIndex, ownerEmail: manifest.ownerCoach });
    const selected = report.players.filter((player) => (
      player.packageId === manifest.packageId
      || player.athleteIdFromExcel === String(manifest.sourceExternalId || manifest.athleteId || "")
      || player.excelName === manifest.expectedNameForAuditOnly
    ));
    const scopedReport = { ...report, players: selected };
    if (args.json) console.log(JSON.stringify({ ...scopedReport, connection: client.safeLabel }, null, 2));
    else printReport({ ...scopedReport, connection: client.safeLabel });
  } finally {
    await finishReadOnly(client);
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
