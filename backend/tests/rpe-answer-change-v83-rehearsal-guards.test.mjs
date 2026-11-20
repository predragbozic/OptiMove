// The v83 rehearsal script's own guards (backend/scripts/rpe-answer-change-v83-rehearsal.mjs): it never takes a database
// name, refuses every non-loopback host, and drops only a database it named itself. No database is touched here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { assertOwnName, falseOkColumns, parseArgs, urlFor } from "../scripts/rpe-answer-change-v83-rehearsal.mjs";

test("1. the arguments: --host and --user required; a loopback host only; no database name; plain role names and port", () => {
  assert.deepEqual(parseArgs(["--host", "127.0.0.1", "--user", "postgres"]), { host: "127.0.0.1", port: "5432", user: "postgres", pgBin: null });
  assert.equal(parseArgs(["--host", "::1", "--user", "postgres", "--port", "5433", "--pg-bin", "/x"]).pgBin, "/x");
  for (const argv of [
    ["--user", "postgres"],
    ["--host", "127.0.0.1"],
    ["--host", "db.example.com", "--user", "postgres"],
    ["--host", "10.0.0.5", "--user", "postgres"],
    ["--host", "127.0.0.1", "--user", "postgres", "--database", "optimove"],
    ["--host", "127.0.0.1", "--user", "postgres", "--port", "54x"],
    ["--host", "127.0.0.1", "--user", "post gres"],
    ["--host", "127.0.0.1", "--user"],
  ]) assert.throws(() => parseArgs(argv), /refusing/, argv.join(" "));
});

test("2. only its own databases: optimove_tests_k4bv83rehearsal_<12 hex>", () => {
  assert.equal(assertOwnName("optimove_tests_k4bv83rehearsal_0123456789ab"), "optimove_tests_k4bv83rehearsal_0123456789ab");
  for (const name of ["optimove", "OPTIMOVE", "postgres", "optimove_tests_r2rehearsal_0123456789ab", "optimove_tests_k4bv83rehearsal_0123", "optimove_tests_k4bv83rehearsal_0123456789ab; drop"]) {
    assert.throws(() => assertOwnName(name), /refusing/, name);
  }
});

test("3. the URL never carries anything but the given parts; the ok columns are read, information columns ignored", () => {
  assert.equal(urlFor({ host: "::1", port: "5432", user: "postgres" }, "postgres", "p@ss"), "postgres://postgres:p%40ss@[::1]:5432/postgres");
  assert.deepEqual(falseOkColumns({ ok_a: true, ok_b: false, ok_c: null, server_version: "17.6", external_answers: 0 }), ["ok_b", "ok_c"]);
});
