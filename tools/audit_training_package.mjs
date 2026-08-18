#!/usr/bin/env node
import path from "path";
import process from "process";
import {
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

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const workbookPath = path.resolve(args.excel || args.workbook || DEFAULT_EXCEL_PATH);
  const sheets = readWorkbook(workbookPath);
  const { rows } = workbookRows(sheets);
  const env = readEnvFile();
  const databaseUrl = args.databaseUrl || process.env.LOCAL_DATABASE_URL || env.DATABASE_URL || "";
  let client = null;
  let dbIndex = null;
  try {
    if (databaseUrl) {
      client = await connectReadOnly(databaseUrl);
      dbIndex = await loadDbAuditIndex(client);
    }
    const report = buildAuditReport({ workbookPath, sheets, rows, dbIndex });
    if (args.output) {
      throw new Error("Refusing to write audit output in this phase; rerun with --json and redirect manually if needed.");
    }
    if (args.json) console.log(JSON.stringify({ ...report, connection: client?.safeLabel || { available: false } }, null, 2));
    else printReport({ ...report, connection: client?.safeLabel || { available: false } });
  } finally {
    await finishReadOnly(client);
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
