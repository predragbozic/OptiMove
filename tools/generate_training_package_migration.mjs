#!/usr/bin/env node
import fs from "fs";
import path from "path";
import process from "process";
import { parseArgs } from "./training_package_core.mjs";

function readManifest(filePath) {
  if (!filePath) throw new Error("--manifest <path> is required.");
  return JSON.parse(fs.readFileSync(path.resolve(filePath), "utf8"));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const manifest = readManifest(args.manifest);
  if (!args.dryRun) {
    throw new Error("Production migration generation is intentionally disabled in this audit phase. Use --dry-run.");
  }
  const summary = {
    mode: "dry-run",
    message: "No SQL migration was generated. This phase only validates that a manifest can be read.",
    packageId: manifest.packageId,
    sourceExternalId: manifest.sourceExternalId || manifest.athleteId || null,
    expectedNameForAuditOnly: manifest.expectedNameForAuditOnly || null,
    requiredFutureGuards: [
      "resolve athlete by athlete_id/source_external_id only",
      "resolve owner by existing user identity",
      "no local UUIDs in production SQL",
      "one transaction per package",
      "JSONB backup before approved weekly replacement",
      "sequential integration test of real exercise/program migrations",
      "final count validation and idempotency",
    ],
  };
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
