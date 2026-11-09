// Step 0 of the test infrastructure (docs/ai/test-infrastructure-discovery.md):
// the generator that turns a schema-only dump into the legacy-schema snapshot.
// Everything here runs on a SYNTHETIC dump and a miniature migrations directory
// in tests/fixtures/legacy-schema; no database, no real dump, no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { splitStatements } from "../../tools/legacy-schema/sql-split.mjs";
import { describe } from "../../tools/legacy-schema/classify.mjs";
import { buildInventory } from "../../tools/legacy-schema/inventory.mjs";
import { generateSnapshot, GeneratorRefusal, stripAddedFromCreateTable } from "../../tools/legacy-schema/generate.mjs";
import { scanText, SCAN_RULES } from "../../tools/legacy-schema/scan.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const fixtures = path.join(here, "fixtures/legacy-schema");
const dumpText = fs.readFileSync(path.join(fixtures, "synthetic-dump.sql"), "utf8");
const miniMigrations = path.join(fixtures, "migrations");
const inventory = () => buildInventory(miniMigrations);
const generate = (text = dumpText) => generateSnapshot({ dumpText: text, inventory: inventory() });

test("1. the splitter keeps semicolons inside dollar quotes, strings and comments, and reports meta lines and data blocks", () => {
  const { statements, metaLines, dataBlocks } = splitStatements(
    "\\restrict KEY\n-- a; comment\nSELECT 'a;b''c';\n/* x; /* nested; */ y; */ CREATE FUNCTION f() RETURNS int AS $body$ select 1; select 2; $body$ LANGUAGE sql;\nCREATE TABLE \"we;ird\" (a int);\nCOPY public.t (a) FROM stdin;\n1\n2\n\\.\nSELECT 2;\n",
  );
  assert.equal(metaLines.length, 1);
  assert.equal(dataBlocks.length, 1);
  assert.deepEqual(statements.map((s) => s.text.slice(0, 18)), ["SELECT 'a;b''c';", "CREATE FUNCTION f(", 'CREATE TABLE "we;ir', "SELECT 2;"].map((x) => x.slice(0, 18)));
  assert.equal(statements.length, 4);
});

test("2. the classifier names the statements the generator decides on", () => {
  assert.deepEqual(describe("CREATE TABLE IF NOT EXISTS plans.plan_items (id int)"), { kind: "table", schema: "plans", name: "plan_items" });
  assert.equal(describe("ALTER TABLE ONLY public.users ADD CONSTRAINT users_pkey PRIMARY KEY (id)").constraint, "users_pkey");
  assert.deepEqual(describe("ALTER TABLE public.a ADD COLUMN IF NOT EXISTS x int, ADD COLUMN y text").columns, ["x", "y"]);
  assert.equal(describe("ALTER TABLE public.a OWNER TO postgres").action, "owner");
  assert.equal(describe("GRANT ALL ON TABLE public.a TO anon").kind, "acl");
  assert.equal(describe("CREATE INDEX i ON ONLY public.a USING btree (x)").table, "a");
  assert.equal(describe("WIBBLE the table").kind, "unknown");
});

test("3. the inventory of the miniature migrations: schemas, objects, added columns and constraints", () => {
  const inv = inventory();
  assert.deepEqual([...inv.schemas], ["training_load"]);
  assert.ok(inv.objects.has("table:training_load.items") && inv.objects.has("table:public.app_audit"));
  assert.ok(inv.indexes.has("training_load.items_team_idx") && inv.indexes.has("public.users_language_idx"));
  assert.deepEqual([...inv.addedColumns.get("public.users")], ["content_language"]);
  assert.deepEqual([...inv.addedConstraints.get("public.users")].sort(), ["users_language_check", "users_language_known"]);
});

test("4. the snapshot keeps exactly the legacy objects and drops everything else, with the reason counted", () => {
  const { sql, report } = generate();
  for (const keep of ["CREATE TABLE public.users", "CREATE TABLE public.teams", "CREATE TABLE plans.plan_items", "CREATE SEQUENCE plans.plan_items_id_seq",
    "CREATE FUNCTION public.touch_updated_at()", "CREATE SCHEMA plans", "CREATE TRIGGER users_touch", "CREATE INDEX teams_owner_idx",
    "ADD CONSTRAINT users_pkey", "ADD CONSTRAINT users_email_key", "ADD CONSTRAINT teams_owner_fk", "OWNED BY plans.plan_items.id", "users_email_check",
    "a comment; with a semicolon"]) assert.ok(sql.includes(keep), `kept: ${keep}`);
  for (const gone of ["auth", "training_load", "app_audit", "OWNER TO", "GRANT", "ROW LEVEL SECURITY", "POLICY", "PUBLICATION", "EXTENSION", "restrict",
    "COMMENT ON", "people who sign in", "items_touch", "items_team_idx", "content_language", "users_language", "supabase_admin", "anon"]) {
    assert.ok(!sql.includes(gone), `dropped: ${gone}`);
  }
  assert.deepEqual(report.strippedColumns, ["public.users.content_language"]);
  assert.deepEqual(report.legacyTables, ["plans.plan_items", "public.teams", "public.users"]);
  assert.deepEqual(report.dropped, {
    acl: 2, comment: 1, extension: 1, "migration-object": 4, "migration-schema": 6, "other-alter": 1, "other-create": 1, owner: 10,
    "platform-schema": 2, policy: 1, "row-level-security": 1, session: 8,
  });
  assert.equal(report.metaLinesDropped, 2);
  assert.deepEqual(report.warnings, [], "every statement kind of the synthetic dump is handled on purpose, none by the catch-all");
});

test("5. the output is deterministic and carries the hash of its input and its own sha256", () => {
  const a = generate();
  const b = generate();
  assert.equal(a.sql, b.sql);
  assert.equal(a.sha256, b.sha256);
  assert.ok(a.sql.includes(a.report.inputSha256));
  assert.match(a.sql, /^-- OptiMove legacy schema snapshot \(GENERATED/);
});

test("6. stripping a CREATE TABLE removes an added column and an inline added constraint and nothing else", () => {
  const stmt = "CREATE TABLE public.t (\n  a int NOT NULL,\n  b text DEFAULT 'x,y(z)',\n  CONSTRAINT keep_me CHECK ((a > 0)),\n  CONSTRAINT drop_me CHECK ((b <> '')),\n  c numeric(10,2)\n);";
  const r = stripAddedFromCreateTable(stmt, { columns: new Set(["b"]), constraints: new Set(["drop_me"]) });
  assert.deepEqual(r.removedColumns, ["b"]);
  assert.deepEqual(r.removedConstraints, ["drop_me"]);
  assert.ok(r.text.includes("a int NOT NULL") && r.text.includes("keep_me") && r.text.includes("numeric(10,2)"));
  assert.ok(!r.text.includes("drop_me") && !r.text.includes("'x,y(z)'"));
});

test("7. the scanner refuses data and every secret-shaped text, names rule and line, and never repeats the text", () => {
  const cases = {
    "data-block": "COPY public.users (id) FROM stdin;\n1\n\\.\n",
    "data-statement": "INSERT INTO public.users VALUES (1);\n",
    jwt: "COMMENT_FREE;\nCREATE TABLE public.t (a text DEFAULT 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0');\n",
    "connection-string-with-password": "CREATE TABLE public.t (a text DEFAULT 'postgres://user:hunter2@host/db');\n",
    "private-key": "CREATE TABLE public.t (a text DEFAULT '-----BEGIN PRIVATE KEY-----');\n",
    "aws-access-key": "CREATE TABLE public.t (a text DEFAULT 'AKIAABCDEFGHIJKLMNOP');\n",
    "email-address": "CREATE TABLE public.t (a text DEFAULT 'someone@example.com');\n",
    "literal-secret-assignment": "CREATE TABLE public.t (a text DEFAULT 'x', password = 'hunter22');\n",
    "long-random-literal": "CREATE TABLE public.t (a text DEFAULT 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8');\n",
    "hash-shape": "CREATE TABLE public.t (a text DEFAULT '$2b$12$abcdefghijklmnopqrstuv');\n",
  };
  for (const [rule, injected] of Object.entries(cases)) {
    let refusal;
    try {
      generate(`${dumpText}\n${injected}`);
    } catch (error) {
      refusal = error;
    }
    assert.ok(refusal instanceof GeneratorRefusal, `${rule}: refused`);
    assert.ok(refusal.findings.some((f) => f.rule === rule), `${rule}: named (${JSON.stringify(refusal.findings)})`);
    assert.ok(refusal.findings.every((f) => Number.isInteger(f.line) && f.line > 0));
    const shown = `${refusal.message} ${JSON.stringify(refusal.findings)}`;
    for (const secret of ["hunter2", "hunter22", "someone@example.com", "AKIAABCDEFGHIJKLMNOP", "eyJhbGci", "BEGIN PRIVATE"]) assert.ok(!shown.includes(secret), `${rule}: the text is not repeated`);
  }
  assert.ok(Object.keys(cases).every((r) => SCAN_RULES.includes(r) || r.startsWith("data-")), "every case names a real rule");
  assert.deepEqual(scanText(generate().sql), [], "the clean synthetic snapshot has no finding");
});

test("8. the command writes the snapshot and its sha256, refuses without writing anything, and --check compares", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-schema-"));
  try {
    const dumpFile = path.join(dir, "schema.sql");
    const out = path.join(dir, "out", "legacy-schema.sql");
    fs.writeFileSync(dumpFile, dumpText);
    const run = (...args) => spawnSync(process.execPath, [path.join(root, "tools/legacy-schema-from-dump.mjs"), ...args], { encoding: "utf8", env: { PATH: process.env.PATH } });
    const ok = run(dumpFile, "--migrations-dir", miniMigrations, "--out", out);
    assert.equal(ok.status, 0, ok.stderr);
    assert.equal(fs.readFileSync(out, "utf8"), generate().sql);
    assert.equal(fs.readFileSync(`${out}.sha256`, "utf8"), `${generate().sha256}  legacy-schema.sql\n`);
    assert.equal(run(dumpFile, "--migrations-dir", miniMigrations, "--out", out, "--check").status, 0);
    fs.writeFileSync(out, "changed");
    assert.equal(run(dumpFile, "--migrations-dir", miniMigrations, "--out", out, "--check").status, 1);
    // A dump with a secret: exit 1, nothing written.
    const dirty = path.join(dir, "dirty.sql");
    const out2 = path.join(dir, "out2", "x.sql");
    fs.writeFileSync(dirty, `${dumpText}\nCREATE TABLE public.t (a text DEFAULT 'someone@example.com');\n`);
    const refused = run(dirty, "--migrations-dir", miniMigrations, "--out", out2);
    assert.equal(refused.status, 1);
    assert.ok(!fs.existsSync(out2) && !fs.existsSync(path.dirname(out2)), "nothing was written");
    assert.ok(!refused.stderr.includes("someone@example.com") && refused.stderr.includes("email-address"));
    assert.equal(run().status, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("9. the tool is offline by construction: no database, network or process module is imported by any of its files", () => {
  const files = [path.join(root, "tools/legacy-schema-from-dump.mjs"), ...fs.readdirSync(path.join(root, "tools/legacy-schema")).map((f) => path.join(root, "tools/legacy-schema", f))];
  assert.ok(files.length >= 6);
  for (const f of files) {
    const text = fs.readFileSync(f, "utf8");
    const imports = [...text.matchAll(/^import\s.*?from\s+["']([^"']+)["']/gm)].map((m) => m[1]);
    for (const spec of imports) {
      assert.ok(spec.startsWith("./") || spec.startsWith("../") || ["node:fs", "node:path", "node:url", "node:crypto"].includes(spec), `${path.basename(f)} imports ${spec}`);
    }
    assert.ok(!/\b(fetch|XMLHttpRequest|child_process|require\()/.test(text.replace(/\/\/.*$/gm, "")), `${path.basename(f)} uses no network or process API`);
  }
});

test("10. the real migrations_v2 directory is read without error (smoke): schemas, objects and the changes it cannot undo are reported", () => {
  const inv = buildInventory(path.join(root, "migrations_v2"));
  assert.ok(inv.files > 50);
  for (const s of ["training_load", "training", "calendar", "media", "tests"]) assert.ok(inv.schemas.has(s), s);
  assert.ok(inv.objects.size > 300);
  assert.ok(inv.addedColumns.has("public.users") && inv.addedColumns.get("public.users").has("content_language"));
});
