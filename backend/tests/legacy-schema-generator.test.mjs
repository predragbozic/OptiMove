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
import { generateSnapshot, GeneratorRefusal } from "../../tools/legacy-schema/generate.mjs";
import { scanText, SCAN_RULES } from "../../tools/legacy-schema/scan.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const fixtures = path.join(here, "fixtures/legacy-schema");
const dumpText = fs.readFileSync(path.join(fixtures, "synthetic-dump.sql"), "utf8");
const miniMigrations = path.join(fixtures, "migrations");
const inventory = () => buildInventory(miniMigrations);
const LAST = "001_mini_a.sql";
const generate = (text = dumpText, lastMigration = LAST) => generateSnapshot({ dumpText: text, inventory: inventory(), lastMigration });

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

test("3. the inventory of the miniature migrations: per file tables, schemas, added columns and constraints", () => {
  const inv = inventory();
  assert.deepEqual([...inv.schemas], ["training_load"]);
  assert.deepEqual(inv.perFile.map((p) => [p.file, p.tables]), [["001_mini_a.sql", ["training_load.items", "public.app_audit"]], ["002_mini_b.sql", ["public.newer_table"]], ["003_mini_c.sql", []]]);
  assert.equal(inv.alterations.length, 1, "a migration that changes a legacy definition in place is listed");
  assert.equal(inv.unanalysed.length, 1, "a DO block is listed");
  assert.deepEqual([...inv.addedColumns.get("public.users")], ["content_language"]);
});

test("4. the snapshot is the WHOLE application schema of the dump; only the platform's and the environment's parts are dropped, each counted", () => {
  const { sql, report } = generate();
  for (const keep of ["CREATE TABLE public.users", "CREATE TABLE public.teams", "CREATE TABLE plans.plan_items", "CREATE TABLE training_load.items", "CREATE TABLE public.app_audit",
    "CREATE SEQUENCE plans.plan_items_id_seq", "CREATE FUNCTION public.touch_updated_at()", "CREATE SCHEMA plans", "CREATE SCHEMA training_load", "CREATE TRIGGER users_touch",
    "CREATE TRIGGER items_touch", "CREATE INDEX teams_owner_idx", "CREATE INDEX items_team_idx", "CREATE INDEX users_language_idx", "ADD CONSTRAINT users_pkey", "ADD CONSTRAINT users_language_known",
    "ADD CONSTRAINT teams_owner_fk", "OWNED BY plans.plan_items.id", "users_email_check", "users_language_check", "content_language", "ENABLE ROW LEVEL SECURITY",
    "CREATE EXTENSION IF NOT EXISTS pgcrypto", "CREATE SCHEMA IF NOT EXISTS extensions", "a comment; with a semicolon"]) assert.ok(sql.includes(keep), `kept: ${keep}`);
  for (const gone of ["CREATE SCHEMA auth", "auth.uid", "OWNER TO", "GRANT", "POLICY users_self", "PUBLICATION", "restrict", "COMMENT ON", "people who sign in", "supabase_admin", "anon", "pg_graphql"]) {
    assert.ok(!sql.includes(gone), `dropped: ${gone}`);
  }
  assert.deepEqual(report.tables, ["plans.plan_items", "public.app_audit", "public.teams", "public.users", "training_load.items"]);
  assert.deepEqual(report.keptExtensions, ["pgcrypto"]);
  assert.deepEqual(report.droppedExtensions, ["pg_graphql"]);
  assert.deepEqual(report.dropped, {
    acl: 2, comment: 1, environment: 2, extension: 1, "extensions-schema": 1, owner: 11, "platform-schema": 2, "policy-on-platform-function": 1, session: 8,
  });
  assert.equal(report.metaLinesDropped, 2);
  assert.equal(report.lastMigration, LAST);
  assert.equal(report.migrationsInDump, 1);
  assert.equal(report.warnings.length, 3, `only the inventory's two notes and the dropped extension are reported: ${report.warnings.join(" / ")}`);
  assert.ok(report.warnings.some((w) => /alter column/i.test(w)) && report.warnings.some((w) => /DO block/.test(w)) && report.warnings.some((w) => /pg_graphql/.test(w)));
  assert.ok(sql.includes(`Last migration contained in the dump: ${LAST}`));
});

test("4a. warnings really appear: an unrecognised statement, a kept statement that depends on a platform schema, a dropped rule, a kept disabled trigger; and CRLF input gives the same bytes", () => {
  const extra = [
    "WIBBLE the table;",
    "CREATE TABLE public.dep (id uuid DEFAULT extensions.uuid_generate_v4(), u uuid REFERENCES auth.users(id));",
    "CREATE RULE r1 AS ON INSERT TO public.teams DO INSTEAD NOTHING;",
    "ALTER TABLE public.users DISABLE TRIGGER users_touch;",
  ].join("\n\n");
  const { report } = generate(`${dumpText}\n${extra}\n`);
  const text = report.warnings.join("\n");
  assert.match(text, /not recognised/);
  assert.match(text, /refers to auth, extensions/);
  assert.match(text, /kind other-create was dropped/);
  assert.match(text, /trigger enable\/disable state/);
  assert.equal(generate(dumpText.replace(/\n/g, "\r\n")).sql, generate().sql);
});

test("4b. a wrong last migration is refused, both ways: a migration table missing from the dump, and a table of a LATER migration present", () => {
  assert.throws(() => generate(dumpText, "002_mini_b.sql"), (e) => e instanceof GeneratorRefusal && /public\.newer_table/.test(e.message) && e.findings[0].rule === "migration-missing-from-dump");
  const withNewer = `${dumpText}\nCREATE TABLE public.newer_table (id uuid, note text);\n`;
  assert.throws(() => generate(withNewer, LAST), (e) => e instanceof GeneratorRefusal && e.findings[0].rule === "migration-newer-than-last");
  assert.throws(() => generate(dumpText, "nope.sql"), GeneratorRefusal);
  assert.throws(() => generateSnapshot({ dumpText, inventory: inventory() }), GeneratorRefusal);
  assert.doesNotThrow(() => generate(withNewer, "002_mini_b.sql"));
});

test("5. the output is deterministic and carries the hash of its input and its own sha256", () => {
  const a = generate();
  const b = generate();
  assert.equal(a.sql, b.sql);
  assert.equal(a.sha256, b.sha256);
  assert.ok(a.sql.includes(a.report.inputSha256));
  assert.match(a.sql, /^-- OptiMove legacy schema snapshot \(GENERATED/);
});

test("4c. the last migration is proved by indexes and triggers too, not only by tables", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-mini-"));
  try {
    for (const f of fs.readdirSync(miniMigrations)) fs.copyFileSync(path.join(miniMigrations, f), path.join(tmp, f));
    fs.writeFileSync(path.join(tmp, "004_mini_d.sql"), "create index items_extra_idx on training_load.items (team_id);\n");
    const inv = buildInventory(tmp);
    assert.throws(() => generateSnapshot({ dumpText, inventory: inv, lastMigration: "004_mini_d.sql" }), (e) => e instanceof GeneratorRefusal && e.findings.some((f) => f.rule === "migration-missing-from-dump" && /items_extra_idx/.test(f.detail)));
    const withIdx = `${dumpText}\nCREATE INDEX items_extra_idx ON training_load.items USING btree (team_id);\n`;
    assert.throws(() => generateSnapshot({ dumpText: withIdx, inventory: inv, lastMigration: LAST }), (e) => e instanceof GeneratorRefusal && e.findings.some((f) => f.rule === "migration-newer-than-last" && /items_extra_idx/.test(f.detail)));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("6b. secret assignments are caught in the other spellings: a type with parentheses, other names, dollar quotes and concatenation", () => {
  const bad = [
    "CREATE FUNCTION public.f() RETURNS text LANGUAGE plpgsql AS $$ declare v_signing_key varchar(64) := 'abcd1234'; begin return 1; end $$;\n",
    "CREATE FUNCTION public.f() RETURNS text LANGUAGE plpgsql AS $$ declare salt text := 'abcd1234'; begin return 1; end $$;\n",
    "CREATE TABLE public.t (a text DEFAULT $$hunter2secret$$ || 'x', secret_x text DEFAULT 'ab' || 'cd1234');\n",
  ];
  for (const injected of bad) assert.throws(() => generate(`${dumpText}\n${injected}`), (e) => e instanceof GeneratorRefusal && e.findings.length > 0, injected.slice(0, 60));
  generate(`${dumpText}\nCREATE TABLE public.ok1 (a uuid DEFAULT '00000000-0000-0000-0000-000000000000');\n`);
});

test("6. the scanner refuses data and every secret-shaped text, names rule and line, and never repeats the text", () => {
  const cases = {
    "data-block": "COPY public.users (id) FROM stdin;\n1\n\\.\n",
    "data-statement": "INSERT INTO public.users VALUES (1);\n",
    jwt: "COMMENT_FREE;\nCREATE TABLE public.t (a text DEFAULT 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0');\n",
    "connection-string-with-password": "CREATE TABLE public.t (a text DEFAULT 'postgres://user:hunter2@host/db');\n",
    "private-key": "CREATE TABLE public.t (a text DEFAULT '-----BEGIN PRIVATE KEY-----');\n",
    "aws-access-key": "CREATE TABLE public.t (a text DEFAULT 'AKIAABCDEFGHIJKLMNOP');\n",
    "email-address": "CREATE TABLE public.t (a text DEFAULT 'someone@example.com');\n",
    "literal-secret-assignment": "CREATE FUNCTION public.f() RETURNS text LANGUAGE plpgsql AS $$ declare v_jwt_secret text := 'abcd1234'; begin return v_jwt_secret; end $$;\n",
    "secret-function-argument": "CREATE FUNCTION public.g() RETURNS text LANGUAGE sql AS 'select hmac(x, ''abcd1234'', ''sha256'')';\n",
    "uuid-literal": "CREATE TABLE public.t (a uuid DEFAULT '3f2b8c1e-1a2b-4c3d-8e9f-0a1b2c3d4e5f');\n",
    "long-random-literal": "CREATE TABLE public.t (a text DEFAULT 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8');\n",
    "hash-shape": "CREATE TABLE public.t (a text DEFAULT '$2b$12$abcdefghijklmnopqrstuv');\n",
    url: "CREATE TABLE public.t (a text DEFAULT 'https://hooks.example/path/abc');\n",
    "ipv4-address": "CREATE TABLE public.t (a text DEFAULT '10.12.13.14');\n",
    "line-too-long": `CREATE TABLE public.t (a text DEFAULT '${"x".repeat(20050)}');\n`,
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
    for (const secret of ["hunter2", "abcd1234", "someone@example.com", "AKIAABCDEFGHIJKLMNOP", "eyJhbGci", "BEGIN PRIVATE"]) assert.ok(!shown.includes(secret), `${rule}: the text is not repeated`);
  }
  assert.ok(Object.keys(cases).every((r) => SCAN_RULES.includes(r) || r.startsWith("data-")), "every case names a real rule");
  assert.deepEqual(scanText(generate().sql), [], "the clean synthetic snapshot has no finding");
});

test("7. the command writes the snapshot and its sha256, refuses without writing anything, and --check compares", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-schema-"));
  try {
    const dumpFile = path.join(dir, "schema.sql");
    const out = path.join(dir, "out", "legacy-schema.sql");
    fs.writeFileSync(dumpFile, dumpText);
    const run = (...args) => spawnSync(process.execPath, [path.join(root, "tools/legacy-schema-from-dump.mjs"), ...args], { encoding: "utf8", env: { PATH: process.env.PATH } });
    const ok = run(dumpFile, "--last-migration", LAST, "--migrations-dir", miniMigrations, "--out", out);
    assert.equal(ok.status, 0, ok.stderr);
    assert.equal(fs.readFileSync(out, "utf8"), generate().sql);
    assert.equal(fs.readFileSync(`${out}.sha256`, "utf8"), `${generate().sha256}  legacy-schema.sql\n`);
    assert.equal(run(dumpFile, "--last-migration", LAST, "--migrations-dir", miniMigrations, "--out", out, "--check").status, 0);
    fs.writeFileSync(out, "changed");
    assert.equal(run(dumpFile, "--last-migration", LAST, "--migrations-dir", miniMigrations, "--out", out, "--check").status, 1);
    // A dump with a secret: exit 1, nothing written.
    const dirty = path.join(dir, "dirty.sql");
    const out2 = path.join(dir, "out2", "x.sql");
    fs.writeFileSync(dirty, `${dumpText}\nCREATE TABLE public.t (a text DEFAULT 'someone@example.com');\n`);
    const refused = run(dirty, "--last-migration", LAST, "--migrations-dir", miniMigrations, "--out", out2);
    assert.equal(refused.status, 1);
    assert.ok(!fs.existsSync(out2) && !fs.existsSync(path.dirname(out2)), "nothing was written");
    assert.ok(!refused.stderr.includes("someone@example.com") && refused.stderr.includes("email-address"));
    assert.equal(run().status, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("8. the tool is offline by construction: no database, network or process module is imported by any of its files", () => {
  const files = [path.join(root, "tools/legacy-schema-from-dump.mjs"), ...fs.readdirSync(path.join(root, "tools/legacy-schema")).map((f) => path.join(root, "tools/legacy-schema", f))];
  assert.ok(files.length >= 6);
  for (const f of files) {
    const text = fs.readFileSync(f, "utf8");
    const imports = [...text.matchAll(/^import\s[\s\S]*?from\s+["']([^"']+)["']/gm)].map((m) => m[1]);
    assert.ok(!/\bimport\(/.test(text), `${path.basename(f)} has no dynamic import`);
    for (const spec of imports) {
      assert.ok(spec.startsWith("./") || spec.startsWith("../") || ["node:fs", "node:path", "node:url", "node:crypto"].includes(spec), `${path.basename(f)} imports ${spec}`);
    }
    assert.ok(!/\b(fetch|XMLHttpRequest|child_process|require\()/.test(text.replace(/\/\/.*$/gm, "")), `${path.basename(f)} uses no network or process API`);
  }
});

test("9. the real migrations_v2 directory is read without error (smoke): schemas, objects and the changes it cannot undo are reported", () => {
  const inv = buildInventory(path.join(root, "migrations_v2"));
  assert.ok(inv.files > 50);
  for (const s of ["training_load", "training", "calendar", "media", "tests"]) assert.ok(inv.schemas.has(s), s);
  assert.ok(inv.objects.size > 300);
  assert.ok(inv.addedColumns.has("public.users") && inv.addedColumns.get("public.users").has("content_language"));
});
