import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { gzipSync, deflateSync } from "node:zlib";
assert.equal(process.env.DATABASE_URL, undefined, "Run through the unit test runner, which scrubs database targets");
// db.js requires a URL even to construct its lazy pool. This unreachable
// loopback placeholder is never connected to; replace query before app import.
process.env.DATABASE_URL = "postgresql://parser_fixture@127.0.0.1:1/parser_no_database";
const { pool } = await import("../src/db.js");

// Actual application middleware/routes, loopback only, no database or mail.
// A database access here is a test failure, including an attempted session read
// before a malformed/oversized body has been refused.
let server, port, databaseAttempts = 0;
const originalQuery = pool.query;
pool.query = async () => { databaseAttempts++; throw new Error("Unexpected database access in parser test"); };
const { app } = await import("../src/server.js");
const originalError = console.error;
const diagnostics = [];
const marker = "parser-fixture-secret-never-echo";
before(async () => {
  console.error = (...args) => diagnostics.push(args.map(String).join(" "));
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = server.address().port;
});
after(async () => {
  try {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    assert.equal(databaseAttempts, 0, "body rejection and unauthenticated routes must not read sessions");
    assert.ok(!diagnostics.join("\n").includes(marker), "request contents must not be logged");
  } finally {
    pool.query = originalQuery;
    console.error = originalError;
    await pool.end();
    delete process.env.DATABASE_URL;
  }
});
function request(body, headers = {}, route = "/api/training-load/dashboards/not-an-id/query") {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: route, method: "POST", headers: { "content-type": "application/json", "content-length": body.length, ...headers } }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString() }));
    });
    req.setTimeout(3000, () => req.destroy(new Error("Loopback parser request timed out")));
    req.on("error", reject);
    req.end(body);
  });
}
const session = { cookie: "optimove_session=fixture-no-database-access" };
const json = Buffer.from(JSON.stringify({ value: marker }));
const large = Buffer.from(JSON.stringify({ value: marker + "x".repeat(110 * 1024) }));

for (const [encoding, compress] of [["identity", (x) => x], ["gzip", gzipSync], ["deflate", deflateSync]]) {
  test(`valid ${encoding} JSON retains the unauthenticated API gate`, async () => {
    const result = await request(compress(json), { "content-encoding": encoding });
    assert.equal(result.status, 401);
    assert.deepEqual(JSON.parse(result.text), { error: "Unauthorized" });
  });
  test(`${encoding} payload over the existing decoded100KiB bound is refused before session lookup`, async () => {
    const body = compress(large);
    if (encoding !== "identity") assert.ok(body.length < 1024, "compressed bomb fixture is small on the wire");
    const result = await request(body, { ...session, "content-encoding": encoding });
    assert.equal(result.status, 413);
    assert.equal(JSON.parse(result.text).error, "body_too_large");
    assert.ok(!result.text.includes(marker));
  });
}
test("malformed JSON is rejected with a stable body and no payload reflection before authentication", async () => {
  const result = await request(Buffer.from(`{"password":"${marker}",`), session);
  assert.equal(result.status, 400);
  assert.equal(JSON.parse(result.text).error, "invalid_json");
  assert.ok(!result.text.includes(marker));
});
test("malformed compressed content is refused and the next request still works", async () => {
  const result = await request(Buffer.from(marker), { ...session, "content-encoding": "gzip" });
  assert.equal(result.status, 400);
  assert.ok(!result.text.includes(marker));
  assert.equal((await request(json)).status, 401);
});
test("unsupported content encoding and charset are refused before session lookup", async () => {
  const encoding = await request(json, { ...session, "content-encoding": "unsupported-fixture" });
  assert.equal(encoding.status, 415);
  const charset = await request(gzipSync(json), { ...session, "content-type": "application/json; charset=iso-8859-1", "content-encoding": "gzip" });
  assert.equal(charset.status, 415);
});
test("trailing bytes after a compressed frame cannot crash the process or bypass authentication", async () => {
  for (let i = 0; i < 4; i++) {
    const body = Buffer.concat([gzipSync(json), Buffer.from(marker)]);
    const result = await request(body, { "content-encoding": "gzip" });
    // Decoder timing may reject at400 or complete the valid frame at401;
    // neither outcome may reach a protected route or crash on a later error.
    assert.ok([400, 401].includes(result.status));
    await new Promise(setImmediate);
    assert.equal((await request(json)).status, 401);
  }
});
