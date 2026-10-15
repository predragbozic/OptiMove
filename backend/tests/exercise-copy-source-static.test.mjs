import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFile } from "node:fs/promises";
import { assertCanonicalUtf8, assertNoTransactionControl } from "../src/migrate.js";

test("original ownership migration remains byte-for-byte unchanged", async () => {
  const original = await readFile(new URL("../../migrations_v2/202610151200_exercise_library_ownership_and_collections.sql", import.meta.url));
  assert.equal(crypto.createHash("sha256").update(original).digest("hex"), "6b9d3b29bf9019ed25ab1a62f657c64334ef87977623c45b79723a1f9ee12b6a");
});

test("forward source guard meets runner file rules without executing SQL", async () => {
  const name = "202610151300_exercise_copy_source_integrity.sql";
  assert.match(name, /^\d{12}_[a-z0-9_]+\.sql$/);
  const content = await readFile(new URL(`../../migrations_v2/${name}`, import.meta.url));
  assertCanonicalUtf8(content, name);
  assertNoTransactionControl(content.toString("utf8"), name);
});
