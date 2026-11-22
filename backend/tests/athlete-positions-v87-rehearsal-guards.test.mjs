// The guards of the v87 rehearsal tool (backend/scripts/athlete-positions-v87-rehearsal.mjs and its bash and PowerShell
// wrappers): loopback only, no database name taken, only its own databases dropped, the password never on the command
// line or in a printed URL. No database is reached here; the full rehearsal is run against a server by the runbook's
// command (docs/runbooks/athlete-positions-v87.md).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPTS = path.join(HERE, "..", "scripts");
const { assertOwnName, NAME_PREFIX, parseArgs, urlFor } = await import("../scripts/athlete-positions-v87-rehearsal.mjs");

test("G1. only a loopback host; --host and --user required; no other argument, a database name least of all", () => {
  for (const host of ["localhost", "127.0.0.1", "::1"]) assert.equal(parseArgs(["--host", host, "--user", "postgres"]).host, host);
  for (const host of ["10.0.0.5", "db.example.com", "aws-0-eu-west-1.pooler.supabase.com", "127.0.0.2", "localhost.evil", ""]) {
    assert.throws(() => parseArgs(["--host", host, "--user", "postgres"]), /refusing/, host);
  }
  assert.throws(() => parseArgs(["--user", "postgres"]), /--host and --user are required/);
  for (const extra of [["--dbname", "OPTIMOVE"], ["--database", "x"], ["postgres://u@127.0.0.1/OPTIMOVE"]]) {
    assert.throws(() => parseArgs(["--host", "127.0.0.1", "--user", "postgres", ...extra]), /refusing: unknown argument/);
  }
  assert.throws(() => parseArgs(["--host", "127.0.0.1", "--user", "postgres", "--port", "5432; drop"]), /--port must be a number/);
  assert.throws(() => parseArgs(["--host", "127.0.0.1", "--user", "x' or 1=1"]), /plain role name/);
});

test("G2. it drops only a database it created (optimove_tests_pos87rehearsal_ and 12 hex)", () => {
  assert.equal(NAME_PREFIX, "optimove_tests_pos87rehearsal_");
  assert.equal(assertOwnName(`${NAME_PREFIX}0123456789ab`), `${NAME_PREFIX}0123456789ab`);
  for (const name of ["OPTIMOVE", "postgres", "optimove_tests_other_0123456789ab", `${NAME_PREFIX}0123`, `${NAME_PREFIX}0123456789ab; drop database x`]) {
    assert.throws(() => assertOwnName(name), /refusing/, name);
  }
  assert.equal(urlFor({ host: "::1", port: "5433", user: "postgres" }, `${NAME_PREFIX}0123456789ab`, "p@ss"), `postgres://postgres:p%40ss@[::1]:5433/${NAME_PREFIX}0123456789ab`);
});

test("G4. every file the rehearsal reads keeps LF in every checkout (a CRLF rollback broke the owner's PG17 rehearsal, 2026-11-22): the migration and the runbook SQL are eol=lf", () => {
  const REPO = path.join(HERE, "..", "..");
  const files = [
    "migrations_v2/202611221200_athletes_v87_positions.sql",
    "docs/runbooks/athlete-positions-v87-preflight.sql",
    "docs/runbooks/athlete-positions-v87-postcheck.sql",
    "docs/runbooks/athlete-positions-v87-rollback.sql",
    "backend/tests/support/legacy-schema.sql",
  ];
  const out = execFileSync("git", ["-C", REPO, "check-attr", "eol", "--", ...files], { encoding: "utf8" });
  for (const f of files) assert.match(out, new RegExp(`^${f.replace(/[.*]/g, "\\$&")}: eol: lf$`, "m"), f);
});

test("G3. the wrappers refuse a non-loopback host before asking for a password and pass it only through the environment", () => {
  const sh = fs.readFileSync(path.join(SCRIPTS, "athlete-positions-v87-rehearsal.sh"), "utf8");
  const ps = fs.readFileSync(path.join(SCRIPTS, "athlete-positions-v87-rehearsal.ps1"), "utf8");
  assert.ok(sh.indexOf("is not a loopback host") < sh.indexOf("read -r -s"), "bash: the host check comes before the prompt");
  assert.ok(ps.indexOf("is not a loopback host") < ps.indexOf("Read-Host -AsSecureString"), "PowerShell: the host check comes before the prompt");
  assert.match(sh, /OPTIMOVE_REHEARSAL_PASSWORD="\$pw" PGPASSWORD="" node "\$here\/athlete-positions-v87-rehearsal\.mjs"/);
  assert.match(ps, /\$env:OPTIMOVE_REHEARSAL_PASSWORD = \$plain/);
  assert.match(ps, /Remove-Item Env:OPTIMOVE_REHEARSAL_PASSWORD/);
  assert.match(ps, /athlete-positions-v87-rehearsal\.mjs/);
  assert.ok(!/--password/.test(sh + ps), "no password argument");
  let failed = null;
  try {
    execFileSync("bash", [path.join(SCRIPTS, "athlete-positions-v87-rehearsal.sh"), "--host", "10.0.0.5", "--user", "x"], { input: "", stdio: ["pipe", "pipe", "pipe"], env: { PATH: process.env.PATH } });
  } catch (error) {
    failed = error;
  }
  assert.ok(failed, "the bash wrapper exits non-zero");
  assert.equal(failed.status, 2);
  assert.match(String(failed.stderr), /refusing: 10\.0\.0\.5 is not a loopback host/);
});
