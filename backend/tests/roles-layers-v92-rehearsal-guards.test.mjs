// The guards of the v92 rehearsal tool (backend/scripts/roles-layers-v92-rehearsal.mjs and its bash and PowerShell
// wrappers): loopback only, no database name taken, only its own databases dropped, the password never on the command
// line or in a printed URL. No database is reached here; the full rehearsal is run against a server by the runbook's
// command (docs/runbooks/roles-layers-v92.md).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPTS = path.join(HERE, "..", "scripts");
const { assertOwnName, NAME_PREFIX, parseArgs, urlFor } = await import("../scripts/roles-layers-v92-rehearsal.mjs");

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

test("G2. it drops only a database it created (optimove_tests_roles92rehearsal_ and 12 hex)", () => {
  assert.equal(NAME_PREFIX, "optimove_tests_roles92rehearsal_");
  assert.equal(assertOwnName(`${NAME_PREFIX}0123456789ab`), `${NAME_PREFIX}0123456789ab`);
  for (const name of ["OPTIMOVE", "postgres", "optimove_tests_other_0123456789ab", `${NAME_PREFIX}0123`, `${NAME_PREFIX}0123456789ab; drop database x`]) {
    assert.throws(() => assertOwnName(name), /refusing/, name);
  }
  assert.equal(urlFor({ host: "::1", port: "5433", user: "postgres" }, `${NAME_PREFIX}0123456789ab`, "p@ss"), `postgres://postgres:p%40ss@[::1]:5433/${NAME_PREFIX}0123456789ab`);
});

test("G4. every file the rehearsal reads keeps LF in every checkout (a CRLF rollback broke the owner's PG17 rehearsal, 2026-11-22): the migration and the runbook SQL are eol=lf", () => {
  const REPO = path.join(HERE, "..", "..");
  const files = [
    "migrations_v2/202611241000_roles_v92_layers_foundation.sql",
    "docs/runbooks/roles-layers-v92-preflight.sql",
    "docs/runbooks/roles-layers-v92-postcheck.sql",
    "docs/runbooks/roles-layers-v92-rollback.sql",
    "backend/tests/support/legacy-schema.sql",
    "backend/scripts/roles-layers-v92-rehearsal.sh",
  ];
  const out = execFileSync("git", ["-C", REPO, "check-attr", "eol", "--", ...files], { encoding: "utf8" });
  for (const f of files) assert.match(out, new RegExp(`^${f.replace(/[.*]/g, "\\$&")}: eol: lf$`, "m"), f);
});

test("G3. the wrappers refuse a non-loopback host before asking for a password and pass it only through the environment", () => {
  const sh = fs.readFileSync(path.join(SCRIPTS, "roles-layers-v92-rehearsal.sh"), "utf8");
  const ps = fs.readFileSync(path.join(SCRIPTS, "roles-layers-v92-rehearsal.ps1"), "utf8");
  assert.ok(sh.indexOf("is not a loopback host") < sh.indexOf("read -r -s"), "bash: the host check comes before the prompt");
  assert.ok(ps.indexOf("is not a loopback host") < ps.indexOf("Read-Host -AsSecureString"), "PowerShell: the host check comes before the prompt");
  assert.match(sh, /OPTIMOVE_REHEARSAL_PASSWORD="\$pw" PGPASSWORD="" node "\$here\/roles-layers-v92-rehearsal\.mjs"/);
  assert.match(ps, /\$env:OPTIMOVE_REHEARSAL_PASSWORD = \$plain/);
  assert.match(ps, /Remove-Item Env:OPTIMOVE_REHEARSAL_PASSWORD/);
  assert.match(ps, /roles-layers-v92-rehearsal\.mjs/);
  assert.ok(!/--password/.test(sh + ps), "no password argument");
  let failed = null;
  try {
    execFileSync("bash", [path.join(SCRIPTS, "roles-layers-v92-rehearsal.sh"), "--host", "10.0.0.5", "--user", "x"], { input: "", stdio: ["pipe", "pipe", "pipe"], env: { PATH: process.env.PATH } });
  } catch (error) {
    failed = error;
  }
  assert.ok(failed, "the bash wrapper exits non-zero");
  assert.equal(failed.status, 2);
  assert.match(String(failed.stderr), /refusing: 10\.0\.0\.5 is not a loopback host/);
});

test("G5. the rollback is the generator's output: v84's bodies verbatim, the v92 md5 list the preflight-free rollback checks", () => {
  const REPO = path.join(HERE, "..", "..");
  const before = fs.readFileSync(path.join(REPO, "docs", "runbooks", "roles-layers-v92-rollback.sql"), "utf8");
  execFileSync("python3", [path.join(REPO, "backend", "scripts", "roles-layers-v92-gen-rollback.py"), path.join(REPO, "backend", "scripts", "roles-layers-v92-md5.json")], { cwd: REPO });
  const after = fs.readFileSync(path.join(REPO, "docs", "runbooks", "roles-layers-v92-rollback.sql"), "utf8");
  assert.equal(after, before, "the committed rollback is exactly what the generator writes");
});

test("G6. Node 20 or later: the tool refuses an older Node before it reads anything", () => {
  const src = fs.readFileSync(path.join(SCRIPTS, "roles-layers-v92-rehearsal.mjs"), "utf8");
  assert.match(src, /Number\(process\.versions\.node\.split\("\."\)\[0\]\) < 20/);
});
