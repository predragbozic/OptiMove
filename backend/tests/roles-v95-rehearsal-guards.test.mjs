// The guards of the v95 rehearsal tool (backend/scripts/roles-closed-module-dominance-v95-rehearsal.mjs and its bash and
// PowerShell wrappers): loopback only, no database name taken, only its own databases dropped, the password never on the
// command line or in a printed URL, Node 20 or later; and the rollback carrying v92's four bodies verbatim. No database
// is reached here; the full rehearsal is run against a server by the runbook's command
// (docs/runbooks/roles-closed-module-dominance-v95.md).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, "..", "..");
const SCRIPTS = path.join(HERE, "..", "scripts");
const TOOL = "roles-closed-module-dominance-v95-rehearsal";
const { assertOwnName, NAME_PREFIX, nodeMajorOk, parseArgs, urlFor } = await import(`../scripts/${TOOL}.mjs`);

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

test("G2. it drops only a database it created (optimove_tests_v95rehearsal_ and 12 hex)", () => {
  assert.equal(NAME_PREFIX, "optimove_tests_v95rehearsal_");
  assert.equal(assertOwnName(`${NAME_PREFIX}0123456789ab`), `${NAME_PREFIX}0123456789ab`);
  for (const name of ["OPTIMOVE", "postgres", "optimove_tests_other_0123456789ab", `${NAME_PREFIX}0123`, `${NAME_PREFIX}0123456789ab; drop database x`]) {
    assert.throws(() => assertOwnName(name), /refusing/, name);
  }
  assert.equal(urlFor({ host: "::1", port: "5433", user: "postgres" }, `${NAME_PREFIX}0123456789ab`, "p@ss"), `postgres://postgres:p%40ss@[::1]:5433/${NAME_PREFIX}0123456789ab`);
});

test("G3. the wrappers check Node and the host before asking for a password and pass it only through the environment", () => {
  const sh = fs.readFileSync(path.join(SCRIPTS, `${TOOL}.sh`), "utf8");
  const ps = fs.readFileSync(path.join(SCRIPTS, `${TOOL}.ps1`), "utf8");
  assert.ok(sh.indexOf("is not a loopback host") < sh.indexOf("read -r -s"), "bash: the host check comes before the prompt");
  assert.ok(sh.indexOf("Node 20 or later") < sh.indexOf("read -r -s"), "bash: the Node check comes before the prompt");
  assert.ok(ps.indexOf("is not a loopback host") < ps.indexOf("Read-Host -AsSecureString"), "PowerShell: the host check comes before the prompt");
  assert.ok(ps.indexOf("Node 20 or later") < ps.indexOf("Read-Host -AsSecureString"), "PowerShell: the Node check comes before the prompt");
  assert.match(sh, new RegExp(`OPTIMOVE_REHEARSAL_PASSWORD="\\$pw" PGPASSWORD="" node "\\$here/${TOOL}\\.mjs"`));
  assert.match(ps, /\$env:OPTIMOVE_REHEARSAL_PASSWORD = \$plain/);
  assert.match(ps, /Remove-Item Env:OPTIMOVE_REHEARSAL_PASSWORD/);
  assert.match(ps, /ZeroFreeBSTR/);
  assert.ok(!/--password/.test(sh + ps), "no password argument");
  let failed = null;
  try {
    execFileSync("bash", [path.join(SCRIPTS, `${TOOL}.sh`), "--host", "10.0.0.5", "--user", "x"], { input: "", stdio: ["pipe", "pipe", "pipe"], env: { PATH: process.env.PATH } });
  } catch (error) {
    failed = error;
  }
  assert.ok(failed, "the bash wrapper exits non-zero");
  assert.equal(failed.status, 2);
  assert.match(String(failed.stderr), /refusing: 10\.0\.0\.5 is not a loopback host/);
});

test("G4. every file the rehearsal reads or runs keeps LF in every checkout: the migration, the runbook SQL and the wrappers are eol=lf", () => {
  const files = [
    "migrations_v2/202611271000_roles_v95_closed_module_dominance.sql",
    "docs/runbooks/roles-closed-module-dominance-v95-preflight.sql",
    "docs/runbooks/roles-closed-module-dominance-v95-postcheck.sql",
    "docs/runbooks/roles-closed-module-dominance-v95-rollback.sql",
    "backend/tests/support/legacy-schema.sql",
    `backend/scripts/${TOOL}.sh`,
    `backend/scripts/${TOOL}.ps1`,
    `backend/scripts/${TOOL}.mjs`,
  ];
  const out = execFileSync("git", ["-C", REPO, "check-attr", "eol", "--", ...files], { encoding: "utf8" });
  for (const f of files) assert.match(out, new RegExp(`^${f.replace(/[.*]/g, "\\$&")}: eol: lf$`, "m"), f);
});

test("G5. the rollback restores v92's four bodies verbatim (the text between the dollar quotes of each is v92's)", () => {
  const v92 = fs.readFileSync(path.join(REPO, "migrations_v2", "202611241000_roles_v92_layers_foundation.sql"), "utf8");
  const rollback = fs.readFileSync(path.join(REPO, "docs", "runbooks", "roles-closed-module-dominance-v95-rollback.sql"), "utf8");
  const bodyOf = (text, prefix, name) => {
    const head = `${prefix} public.${name}() returns trigger as $$`;
    const start = text.indexOf(head);
    assert.ok(start >= 0, `${name} in the file`);
    return text.slice(start + head.length, text.indexOf("$$ language plpgsql", start));
  };
  for (const name of ["permission_club_role_version_items_guard", "permission_club_role_versions_complete",
    "permission_custom_role_items_guard", "permission_custom_roles_complete"]) {
    assert.equal(bodyOf(rollback, "create or replace function", name), bodyOf(v92, "create function", name), name);
  }
});

test("G6. Node 20 or later: the tool refuses an older Node before it reads anything", () => {
  assert.equal(nodeMajorOk("18.20.4"), false);
  assert.equal(nodeMajorOk("19.9.0"), false);
  assert.equal(nodeMajorOk("20.0.0"), true);
  assert.equal(nodeMajorOk("22.23.5"), true);
  const src = fs.readFileSync(path.join(SCRIPTS, `${TOOL}.mjs`), "utf8");
  assert.ok(src.indexOf("if (!nodeMajorOk())") < src.indexOf("parseArgs(process.argv.slice(2))"), "checked before the arguments and the password");
});
