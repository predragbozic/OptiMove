// The pool size per server process (PG_POOL_MAX, owner 2026-10-17): two
// Render services and a deploy's overlap share Supabase's 15 pooler
// connections, so each process's pool must be configurable.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DEFAULT_POOL_MAX, MIN_POOL_MAX, poolMaxFromEnv } from "../src/dbPoolConfig.js";

test("1. without PG_POOL_MAX the pool keeps pg's default of 10; a set value is used as it is", () => {
  assert.equal(DEFAULT_POOL_MAX, 10);
  assert.equal(poolMaxFromEnv({}), 10);
  assert.equal(poolMaxFromEnv({ PG_POOL_MAX: "" }), 10);
  assert.equal(poolMaxFromEnv({ PG_POOL_MAX: "4" }), 4);
  assert.equal(poolMaxFromEnv({ PG_POOL_MAX: "3" }), 3);
  assert.equal(poolMaxFromEnv({ PG_POOL_MAX: "50" }), 50);
});

test("2. a value that is not a whole number from 3 to 50, written in digits, stops the server at start", () => {
  for (const value of ["0", "1", "2", "51", "100", "-3", "+4", " 4 ", "4.5", "1e1", "0x4", "four", " ", "1e1x"]) {
    assert.throws(() => poolMaxFromEnv({ PG_POOL_MAX: value }), /PG_POOL_MAX must be an integer between 3 and 50\./, value);
  }
});

test("2b. the smallest size still lets the Builder take a group-plan write", async () => {
  // routes/builder.js admits floor((max - 1) / 2) batch writes at once.
  const builder = await readFile(new URL("../src/routes/builder.js", import.meta.url), "utf8");
  assert.match(builder, /const capacity = Math\.floor\(\(pool\.options\.max - 1\) \/ 2\);/);
  assert.equal(MIN_POOL_MAX, 3);
  assert.ok(Math.floor((poolMaxFromEnv({ PG_POOL_MAX: String(MIN_POOL_MAX) }) - 1) / 2) >= 1);
});

test("3. the app's one pool takes its size from it", async () => {
  const db = await readFile(new URL("../src/db.js", import.meta.url), "utf8");
  assert.match(db, /import \{ poolMaxFromEnv \} from "\.\/dbPoolConfig\.js";/);
  assert.match(db, /export const POOL_MAX = poolMaxFromEnv\(\);/);
  assert.match(db, /export const pool = new Pool\(\{[\s\S]*?connectionTimeoutMillis: POOL_CHECKOUT_TIMEOUT_MS,\s*max: POOL_MAX,\s*\}\);/);
  assert.equal(db.match(/new Pool\(/g).length, 1, "one pool for the server");
});
