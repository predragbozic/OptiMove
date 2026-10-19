import { readFile, open } from "node:fs/promises";
import { createHash } from "node:crypto";
import pg from "pg";
import { lockExerciseReuse } from "../src/exerciseAccess.js";
import { applySnapshotImages, previewSnapshotImages } from "../src/exerciseSnapshotRepair.js";

const [mode, inputPath, outputPath, expectedCount] = process.argv.slice(2);
if (!["dry-run", "apply", "rollback"].includes(mode) || !inputPath || !outputPath
  || (mode !== "dry-run" && !/^\d+$/.test(expectedCount || ""))) {
  throw new Error("Usage: node scripts/repair-snapshot-images.mjs dry-run item-ids.json preview.json | apply preview.json journal.json EXPECTED_COUNT | rollback journal.json rollback.json EXPECTED_COUNT");
}
if (!process.env.DATABASE_URL) throw new Error("Set DATABASE_URL explicitly; no .env file is loaded.");
const url = new URL(process.env.DATABASE_URL);
const input = JSON.parse(await readFile(inputPath, "utf8"));
const client = new pg.Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 5000 });
let output;
try {
  await client.connect();
  await client.query(mode === "dry-run" ? "begin read only" : "begin isolation level read committed");
  await client.query("set local statement_timeout='15s'");
  await client.query("set local lock_timeout='2s'");
  const identity = (await client.query("select current_database() as database,inet_server_addr()::text as address,inet_server_port() as port")).rows[0];
  const target = createHash("sha256").update(JSON.stringify({ host: url.hostname, ...identity })).digest("hex");
  let entries;
  if (mode === "dry-run") {
    entries = await previewSnapshotImages(client, input);
  } else {
    if (input.version !== 1 || input.target !== target || !Array.isArray(input.entries)
      || input.entries.length !== Number(expectedCount) || !input.entries.length
      || (mode === "apply" ? input.mode !== "dry-run" : input.mode !== "apply")) {
      throw new Error("Wrong target, manifest mode or approved count.");
    }
    await lockExerciseReuse(client);
    entries = await applySnapshotImages(client, input.entries, { rollback: mode === "rollback" });
  }
  const report = { version: 1, target, mode, createdAt: new Date().toISOString(),
    approvedCount: mode === "dry-run" ? input.length : input.entries.length,
    changedCount: entries.length, skippedCount: mode === "dry-run" ? input.length - entries.length : input.entries.length - entries.length, entries };
  output = await open(outputPath, "wx", 0o600);
  await output.writeFile(`${JSON.stringify(report, null, 2)}\n`);
  await output.sync();
  await client.query("commit");
  console.log(JSON.stringify({ mode, count: entries.length, report: outputPath }));
} catch (error) {
  await client.query("rollback").catch(() => {});
  throw error;
} finally {
  await output?.close();
  await client.end();
}
