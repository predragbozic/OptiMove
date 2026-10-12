#!/usr/bin/env node
// OptiMove test runner (T1 test-infrastructure foundation).
//
// Runs every test file as its own `node` process with a time limit, ends a
// stuck file together with everything it spawned, tells pass / known-fail /
// fail / timeout / did-not-exit / crash apart, prints one line per file and a
// short summary, and keeps the full output of every file in a log directory.
//
// Database rules, by kind of file (see docs/ai/test-infrastructure-discovery.md):
//   unit          no database: DATABASE_URL is unset and backend/.env is not read.
//   disposable    the file creates and drops its own optimove_tests_* databases;
//                 it gets the local server's maintenance database "postgres" as
//                 DATABASE_URL, never the configured development database.
//   shared        the file writes fixtures into the local development database
//                 and cleans them up; it runs only when that database is named
//                 explicitly on the command line (--shared-db <name>); no
//                 environment variable is an opt-in.
//   schema-clone  the file clones the schema of LOCAL_OPTIMOVE_SCHEMA_SOURCE_URL
//                 into a disposable database; skipped when that is not set.
// Every database URL must point at a loopback host; anything naming a remote
// or persistent service is refused before a single file runs.
//
//   node scripts/test-runner.mjs --project backend --kind unit
//   node scripts/test-runner.mjs --preset pr
//   node scripts/test-runner.mjs --project backend --kind all --list
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, "..");
const REPORTER_URL = pathToFileURL(path.join(HERE, "test-runner-reporter.mjs")).href;
const EVENT_PREFIX = "@@optimove-test@@ ";

const PROJECTS = {
  backend: { dir: "backend", kinds: ["unit", "disposable", "shared", "schema-clone"] },
  frontend: { dir: "frontend", kinds: ["unit"] },
};

// Name families for --group. A group filters file names only; the kind of
// each file still decides which database rules apply to it.
const GROUPS = {
  gpexe: { backend: /^(gpexe-|source-)/, frontend: /^(gpexe-|source-connections|data-sources)/ },
};

// The standard commands (root package.json). `pr` runs everything that is
// safe by construction: no persistent database is ever opened.
const PRESETS = {
  "backend-fast": [{ project: "backend", kind: "unit" }],
  "frontend-fast": [{ project: "frontend", kind: "unit" }],
  gpexe: [
    { project: "backend", group: "gpexe", kind: "unit" },
    { project: "backend", group: "gpexe", kind: "disposable" },
  ],
  pr: [
    { project: "frontend", kind: "unit" },
    { project: "backend", kind: "unit" },
    { project: "backend", kind: "disposable" },
  ],
};

const DEFAULT_TIMEOUT_MS = { unit: 5 * 60_000, disposable: 15 * 60_000, shared: 15 * 60_000, "schema-clone": 15 * 60_000 };
const DEFAULT_KNOWN_NO_EXIT_IDLE_MS = 10_000;
// Kept identical to backend/tests/support/disposable-db.mjs (the runner's
// self-test compares the two): the runner cannot import that module without
// depending on backend's node_modules for a frontend-only run.
export const LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "::1"];
export const FORBIDDEN_URL_MARKERS = ["supabase", "render.com", "onrender", "pooler", "monitoring2"];
// pg-connection-string lets a query parameter override the host, port, user
// or password of the URL; only these two parameters are allowed through.
const ALLOWED_URL_PARAMS = new Set(["sslmode", "application_name"]);

// Variables a test process never inherits from the shell or from
// backend/.env: database targets (set again per kind), every credential or
// outbound-service setting the application reads, anything named like a
// secret, dotenv's own switches, and libpq's connection overrides.
const SCRUBBED_ENV = /^(DATABASE_URL|TEST_DATABASE_ADMIN_URL|LOCAL_OPTIMOVE_SCHEMA_SOURCE_URL|OPTIMOVE_TEST_SHARED_DB|DOTENV_.*|NODE_ENV|EMAIL_PROVIDER|GMAIL_.*|BREVO_.*|RESEND_.*|GPEXE_.*|SOURCE_CREDENTIAL_.*|RENDER.*|SUPABASE.*|.*(_TOKEN|_SECRET|_API_KEY|_PASSWORD|_PASSWD|_PRIVATE_KEY)|PG(HOST|HOSTADDR|PORT|USER|PASSWORD|DATABASE|SERVICE|SERVICEFILE|PASSFILE|SSLMODE|CONNECT_TIMEOUT|OPTIONS))$/i;

// Per run: a private directory holding an EMPTY .env that every test process
// is pointed at (DOTENV_CONFIG_PATH), so `import "dotenv/config"` loads
// nothing - an existing empty file, not a path that someone could create.
const runtime = { emptyEnvFile: null };

export class RunnerRefusal extends Error {}

// ---------------------------------------------------------------- arguments
export function parseArgs(argv) {
  const args = { filters: [], files: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new RunnerRefusal(`${a} needs a value`);
      return argv[++i];
    };
    if (a === "--project") args.project = next();
    else if (a === "--kind") args.kind = next();
    else if (a === "--group") args.group = next();
    else if (a === "--preset") args.preset = next();
    else if (a === "--filter") args.filters.push(next());
    else if (a === "--file") args.files.push(next());
    else if (a === "--timeout-ms") args.timeoutMs = Number(next());
    else if (a === "--shared-db") args.sharedDb = next();
    else if (a === "--json") args.json = next();
    else if (a === "--log-dir") args.logDir = next();
    else if (a === "--project-dir") args.projectDir = next();
    else if (a === "--list") args.list = true;
    else if (a === "--quiet") args.quiet = true;
    else if (a === "--help" || a === "-h") args.help = true;
    else throw new RunnerRefusal(`unknown option ${/:\/\/|@/.test(a) ? "(a value that looks like a URL or credential)" : a}`);
  }
  if (args.timeoutMs !== undefined && !(Number.isInteger(args.timeoutMs) && args.timeoutMs > 0)) throw new RunnerRefusal("--timeout-ms must be a positive integer");
  return args;
}

const HELP = `OptiMove test runner

  node scripts/test-runner.mjs --project <backend|frontend> [--kind <kind>] [--group gpexe]
                                [--filter <substring>]... [--file <name>]... [--list]
  node scripts/test-runner.mjs --preset <backend-fast|frontend-fast|gpexe|pr>

Kinds (backend): unit, disposable, shared (needs --shared-db <name> naming the database of
DATABASE_URL, on every run), schema-clone (needs LOCAL_OPTIMOVE_SCHEMA_SOURCE_URL).
Frontend files are all unit. --kind all is accepted with --list only.

Options: --timeout-ms <n> (per file), --json <path> (machine-readable report),
--log-dir <dir> (where every file's full output is kept), --quiet (no per-file lines),
--project-dir <dir> (a throwaway project for the runner's own self-test).
`;

// ------------------------------------------------------------- env parsing
function readEnvFile(file) {
  const values = {};
  if (!fs.existsSync(file)) return values;
  for (const rawLine of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    values[key] = value;
  }
  return values;
}

// A database URL the runner accepts: loopback host only, no marker of a
// persistent or remote service, no libpq host override. Returns its parts.
// The password is never part of any message.
export function parseSafeLocalDatabaseUrl(raw, label) {
  if (!raw) throw new RunnerRefusal(`${label} is not set`);
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new RunnerRefusal(`${label} is not a valid URL`);
  }
  if (!/^postgres(ql)?:$/.test(url.protocol)) throw new RunnerRefusal(`${label} must be a postgres:// URL`);
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!LOOPBACK_HOSTS.includes(host)) {
    throw new RunnerRefusal(`${label} must point at a loopback host (localhost, 127.0.0.1 or ::1); it points at "${/^[a-z0-9.:[\]-]+$/i.test(host) ? host : "(an unreadable host)"}"`);
  }
  const lower = raw.toLowerCase();
  for (const marker of FORBIDDEN_URL_MARKERS) {
    if (lower.includes(marker)) throw new RunnerRefusal(`${label} contains "${marker}", which names a persistent or remote database`);
  }
  for (const key of url.searchParams.keys()) {
    if (!ALLOWED_URL_PARAMS.has(key.toLowerCase())) throw new RunnerRefusal(`${label} carries a "${key}" parameter; only sslmode and application_name are allowed (others can redirect the connection)`);
  }
  const dbName = decodeURIComponent(url.pathname.replace(/^\//, ""));
  if (!dbName || dbName.includes("/")) throw new RunnerRefusal(`${label} must name exactly one database`);
  return { url, host, port: url.port || "5432", dbName };
}

function withDatabase(parsed, dbName) {
  const copy = new URL(parsed.url);
  copy.pathname = `/${dbName}`;
  return copy.toString();
}

function describeTarget(parsed, dbName = parsed.dbName) {
  return `${parsed.host}:${parsed.port}/${dbName}`;
}

// ------------------------------------------------------------ classification
const IMPORT_RE = /\bimport\s*(?:[^'"]*?\sfrom\s*)?["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)|\bexport\s+(?:\*|\{[^}]*\})\s*from\s*["']([^"']+)["']/g;

function readText(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

function moduleClosure(entry, cache) {
  const seen = new Set();
  let barePg = false;
  const stack = [entry];
  while (stack.length) {
    const file = stack.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    let info = cache.get(file);
    if (!info) {
      const text = readText(file);
      const deps = [];
      let pg = false;
      let m;
      IMPORT_RE.lastIndex = 0;
      while ((m = IMPORT_RE.exec(text))) {
        const spec = m[1] || m[2] || m[3];
        if (spec === "pg") pg = true;
        if (!spec.startsWith("./") && !spec.startsWith("../")) continue;
        const resolved = path.resolve(path.dirname(file), spec);
        if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) deps.push(resolved);
      }
      info = { deps, text, pg };
      cache.set(file, info);
    }
    if (info.pg) barePg = true;
    for (const dep of info.deps) stack.push(dep);
  }
  return { files: seen, barePg };
}

export function classifyFile({ project, file, testsDirAbs, cache, manifest }) {
  const abs = path.join(testsDirAbs, file);
  const text = readText(abs);
  const closure = moduleClosure(abs, cache);
  const closureTexts = [...closure.files].map((f) => cache.get(f)?.text || "");
  const closureNames = [...closure.files].map((f) => path.relative(REPO_ROOT, f).replace(/\\/g, "/"));
  // A file that starts the real server or the migrator as a child process
  // needs a database target just like one that imports db.js.
  const spawnsServer = /\b(src\/server\.js|src\/migrate\.js|npm (run )?start)\b/.test(text);
  const needsDb = closure.barePg || spawnsServer || closureNames.some((n) => n === "backend/src/db.js" || n === "backend/src/migrate.js");
  const disposable = closureTexts.some((t) => /create\s+database/i.test(t));
  const schemaClone = /LOCAL_OPTIMOVE_SCHEMA_SOURCE_URL/.test(text);
  let kind = "unit";
  if (project === "backend") kind = schemaClone ? "schema-clone" : disposable ? "disposable" : needsDb ? "shared" : "unit";
  const override = manifest?.kindOverrides?.[file];
  if (override) kind = override;
  return {
    file,
    kind,
    detected: { needsDb, disposable, schemaClone },
    flags: {
      httpServer: /http\.createServer|\.listen\(/.test(text),
      spawns: /\bspawn(Sync)?\(|execFile(Sync)?\(/.test(text),
      fakeFetch: /globalThis\.fetch\s*=|fetchImpl|fetch:\s*\w|fakeFetch/.test(text),
      jsdom: /JSDOM/.test(text),
      lines: text.split(/\r?\n/).length,
    },
  };
}

// A known failure is identified by its whole fingerprint, never by the title
// alone: the file, the exact test title, node's failureType and a pattern
// over the first line of the failure message. A failure whose title is
// listed but whose type or message differs is a new failure. A test whose
// job is to find a credential or a secret can never be a known failure: the
// cause is fixed instead (the runner refuses such a manifest entry).
const KNOWN_FAILURE_TYPES = new Set(["testCodeFailure", "testTimeoutFailure", "cancelledByParent", "subtestsFailed", "hookFailed", "uncaughtException", "unhandledRejection", "callbackAndPromisePresent", "multipleCallbackInvocations", "testAborted"]);
const GUARDED_SCAN_FILES = new Set(["source-hosts-server3.test.mjs", "source-credential-crypto.test.mjs"]);
const GUARDED_SCAN_TITLE = /\b(secret|credential|token|password)s?\b.*\b(scan|in any file|never|not in|leak|ignored by git)\b/i;

function compileKnownFailure(entry, file) {
  const where = `${file}: knownFailures entry ${JSON.stringify({ file: entry?.file, test: entry?.test })}`;
  for (const key of ["file", "test", "failureType", "messagePattern"]) {
    if (typeof entry?.[key] !== "string" || !entry[key]) throw new RunnerRefusal(`${where} must carry "${key}" (a known failure is identified by file, title, failureType and a message pattern together)`);
  }
  if (!KNOWN_FAILURE_TYPES.has(entry.failureType)) throw new RunnerRefusal(`${where}: unknown failureType "${entry.failureType}" (node:test's types: ${[...KNOWN_FAILURE_TYPES].join(", ")})`);
  let pattern;
  try {
    pattern = new RegExp(entry.messagePattern);
  } catch (error) {
    throw new RunnerRefusal(`${where}: messagePattern is not a valid regular expression (${error.message})`);
  }
  // A fingerprint must say something: a pattern with fewer than 8 literal
  // characters (after the regex syntax is taken out) would match almost any
  // message.
  const literal = entry.messagePattern.replace(/\\[dDwWsSbB]/g, "x").replace(/\\(.)/g, "$1").replace(/[\^$.*+?()[\]{}|]/g, "");
  if (literal.length < 8) throw new RunnerRefusal(`${where}: messagePattern "${entry.messagePattern}" is too unspecific to be a fingerprint (fewer than 8 literal characters)`);
  if (GUARDED_SCAN_FILES.has(path.basename(entry.file)) || GUARDED_SCAN_TITLE.test(entry.test)) {
    throw new RunnerRefusal(`${where}: a secret / credential scan test is refused as a known failure (by file name or title); fix its cause instead`);
  }
  return { ...entry, pattern };
}

export function readManifest(projectDirAbs) {
  const file = path.join(projectDirAbs, "tests", "support", "test-manifest.json");
  if (!fs.existsSync(file)) return { kindOverrides: {}, fileOptions: {}, knownFailures: [], knownNoExit: [] };
  const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  const knownFailures = (parsed.knownFailures || []).map((e) => compileKnownFailure(e, path.relative(REPO_ROOT, file).replace(/\\/g, "/")));
  return { kindOverrides: parsed.kindOverrides || {}, fileOptions: parsed.fileOptions || {}, knownFailures, knownNoExit: parsed.knownNoExit || [] };
}

// node's own per-test limit for a file: a test that never finishes is
// cancelled by node (reported as a failure with failureType
// testTimeoutFailure), the file's remaining tests and hooks still run, and
// the process exits on its own - so a hung test does not cost the whole
// file limit and does not skip an after() that drops a database. The file
// limit (the tree kill) stays as the backstop for a test that never yields
// or a hook that never finishes.
function defaultTestTimeoutMs(fileTimeoutMs) {
  return fileTimeoutMs > 120_000 ? fileTimeoutMs - 60_000 : Math.ceil(fileTimeoutMs * 0.8);
}

// Every *.test.mjs under tests/, nested folders included (the same files
// `node --test tests/**/*.test.mjs` would run), as paths relative to tests/.
export function listTestFiles(testsDirAbs) {
  const found = [];
  const walk = (dir, rel) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules") continue;
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(path.join(dir, entry.name), relPath);
      else if (entry.isFile() && entry.name.endsWith(".test.mjs")) found.push(relPath);
    }
  };
  walk(testsDirAbs, "");
  return found.sort();
}

// The database audit (backend/tests/support/disposable-db-audit.mjs): every
// database on the local server except the templates and "postgres", and
// the number of user objects inside "postgres", so a database-kind step can
// report what it left behind and that nothing was written into its
// maintenance-database target. The audit also connects, so the server
// identity checks of the support module (a managed service, a public
// address behind a loopback tunnel) run before the first file.
function auditDatabases({ backendDirAbs, env }) {
  const script = path.join(backendDirAbs, "tests", "support", "disposable-db-audit.mjs");
  if (!fs.existsSync(script)) return { error: `${script} is missing` };
  const r = spawnSync(process.execPath, [script, "--json"], { cwd: backendDirAbs, env, encoding: "utf8", timeout: 30_000, windowsHide: true });
  if (r.status !== 0) return { error: (r.stderr || r.stdout || "").trim().split("\n").pop() || `exit ${r.status}` };
  try {
    return JSON.parse(r.stdout.trim().split("\n").pop());
  } catch {
    return { error: "the audit printed no JSON" };
  }
}

// ----------------------------------------------------------- event parsing
// One parser per test process. It consumes the reporter's lines (every
// other line of output is ignored here and kept in the log only).
// knownFailures: the compiled manifest entries for this file. A leaf failure
// is known only when an entry matches its title, its failureType and its
// first-line message; a parent (describe / subtests) failure is known only
// when every failed child is known.
export function createEventParser(knownFailures) {
  const running = []; // tests that started and did not finish yet, innermost last
  const state = { counts: { tests: 0, pass: 0, fail: 0, cancelled: 0, skipped: 0, todo: 0 }, summary: null, failures: [], passedTitles: new Set(), lastEventAt: Date.now(), resultsSeen: 0 };
  function matchKnown(event) {
    const sameTitle = knownFailures.filter((k) => k.test === event.name);
    if (!sameTitle.length) return { known: false, listed: false };
    const match = sameTitle.find((k) => k.failureType === event.failureType && k.pattern.test(event.message || ""));
    return { known: Boolean(match), listed: true, expected: match ? null : sameTitle.map((k) => `${k.failureType} /${k.messagePattern}/`) };
  }
  function finish(event, failed) {
    let entry = null;
    for (let i = running.length - 1; i >= 0; i--) {
      if (running[i].name === event.name && running[i].nesting === event.nesting) {
        entry = running.splice(i, 1)[0];
        break;
      }
    }
    const failedChildren = entry ? entry.failedChildren : [];
    if (failed) {
      let known;
      let listedButDifferent = null;
      if (failedChildren.length) known = failedChildren.every((c) => c.known);
      else {
        const m = matchKnown(event);
        known = m.known;
        if (m.listed && !m.known) listedButDifferent = m.expected;
      }
      const failure = { name: event.name, nesting: event.nesting, known, leaf: failedChildren.length === 0, failureType: event.failureType, message: event.message, listedButDifferent };
      state.failures.push(failure);
      const parent = running[running.length - 1];
      if (parent) parent.failedChildren.push(failure);
    }
  }
  function onLine(line) {
    if (!line.startsWith(EVENT_PREFIX)) return;
    let event;
    try {
      event = JSON.parse(line.slice(EVENT_PREFIX.length));
    } catch {
      return;
    }
    state.lastEventAt = Date.now();
    if (event.e === "start") {
      running.push({ name: event.name, nesting: event.nesting, failedChildren: [] });
    } else if (event.e === "pass") {
      state.resultsSeen++;
      state.counts.tests++;
      if (event.skip) state.counts.skipped++;
      else if (event.todo) state.counts.todo++;
      else {
        state.counts.pass++;
        state.passedTitles.add(event.name);
      }
      finish(event, false);
    } else if (event.e === "fail") {
      state.resultsSeen++;
      state.counts.tests++;
      if (event.todo) {
        state.counts.todo++;
        finish(event, false);
      } else {
        state.counts.fail++;
        if (event.failureType === "cancelledByParent" || event.failureType === "testTimeoutFailure") state.counts.cancelled++;
        finish(event, true);
      }
    } else if (event.e === "summary") {
      state.summary = { success: event.success, counts: event.counts || null, durationMs: event.durationMs };
    }
  }
  return { onLine, state, runningNames: () => running.map((r) => r.name) };
}

// ------------------------------------------------------------- processes
function isAlive(child) {
  return child.exitCode === null && child.signalCode === null;
}

function waitForExit(child, ms) {
  return new Promise((resolve) => {
    if (!isAlive(child)) return resolve(true);
    const timer = setTimeout(() => resolve(false), ms);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

// Ends the test process and every process it started. On Windows taskkill
// /T walks the process tree; elsewhere the child is its own process group
// (spawned detached) and the whole group is signalled.
export async function killProcessTree(child) {
  if (!isAlive(child)) return true;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  } else {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {}
    if (!(await waitForExit(child, 2_000))) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {}
    }
  }
  return waitForExit(child, 10_000);
}

async function runOneFile({ projectDirAbs, testsDirAbs, file, env, timeoutMs, testTimeoutMs, logDir, knownFailures, knownNoExit }) {
  const abs = path.join(testsDirAbs, file);
  const logPath = path.join(logDir, `${file.replace(/[\\/]/g, "__")}.log`);
  const log = fs.createWriteStream(logPath);
  const parser = createEventParser(knownFailures);
  const knownFailureTitles = new Set(knownFailures.map((k) => k.test));
  const startedAt = Date.now();
  const child = spawn(process.execPath, [`--test-reporter=${REPORTER_URL}`, "--test-reporter-destination=stdout", `--test-timeout=${testTimeoutMs}`, abs], {
    cwd: projectDirAbs,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
    windowsHide: true,
  });
  let buffered = "";
  let timedOut = false;
  let endedIdle = false;
  let runningAtEnd = [];
  let logError = null;
  log.on("error", (error) => {
    logError = error;
  });
  // The run is finished on 'close' (the stdio pipes drained and closed), not
  // on 'exit': the process can exit while its last output - the final
  // failure and the summary - is still in the pipe. 'exit' only starts a
  // bounded wait, in case a process the tree kill did not reach still holds
  // the pipe open.
  const done = new Promise((resolve) => {
    let exitInfo = null;
    let closeBound = null;
    const settle = (info) => {
      if (closeBound) clearTimeout(closeBound);
      resolve(info);
    };
    child.once("exit", (code, signal) => {
      exitInfo = { code, signal };
      closeBound = setTimeout(() => settle({ ...exitInfo, pipeHeldOpen: true }), 5_000);
    });
    child.once("close", (code, signal) => settle(exitInfo || { code, signal }));
    child.once("error", (error) => settle({ code: null, signal: null, spawnError: error }));
  });
  const onStdout = (chunk) => {
    if (!logError) log.write(chunk);
    buffered += chunk.toString("utf8");
    let nl;
    while ((nl = buffered.indexOf("\n")) >= 0) {
      parser.onLine(buffered.slice(0, nl).replace(/\r$/, ""));
      buffered = buffered.slice(nl + 1);
    }
  };
  const onStderr = (chunk) => {
    if (!logError) log.write(chunk);
  };
  child.stdout.on("data", onStdout);
  child.stderr.on("data", onStderr);
  const timeoutTimer = setTimeout(async () => {
    if (isAlive(child)) {
      timedOut = true;
      runningAtEnd = parser.runningNames();
      await killProcessTree(child);
    }
  }, timeoutMs);
  // A file listed in the manifest as "known not to exit" is ended once no
  // test is running and its reporter has been silent for idleMs, instead of
  // waiting for the whole time limit. Any other file waits the full limit:
  // ending early would risk cutting an after() hook that drops a database.
  const idleMs = knownNoExit ? knownNoExit.idleMs || DEFAULT_KNOWN_NO_EXIT_IDLE_MS : null;
  const idleTimer = idleMs
    ? setInterval(async () => {
        if (!isAlive(child) || endedIdle || timedOut) return;
        if (parser.state.resultsSeen > 0 && parser.runningNames().length === 0 && Date.now() - parser.state.lastEventAt >= idleMs) {
          endedIdle = true;
          await killProcessTree(child);
        }
      }, 250)
    : null;
  const exit = await done;
  clearTimeout(timeoutTimer);
  if (idleTimer) clearInterval(idleTimer);
  child.stdout.off("data", onStdout);
  child.stderr.off("data", onStderr);
  if (buffered) parser.onLine(buffered.replace(/\r$/, ""));
  await new Promise((resolve) => (logError ? resolve() : log.end(resolve)));
  const durationMs = Date.now() - startedAt;
  const { counts, summary, failures, resultsSeen, passedTitles } = parser.state;
  const unknownFailures = failures.filter((f) => !f.known).map((f) => f.name);
  const knownFailuresSeen = failures.filter((f) => f.known).map((f) => f.name);
  // A listed failure that passed, title by title: the manifest cannot rot
  // silently inside a file that still has other listed failures.
  const unexpectedPasses = [...knownFailureTitles].filter((t) => passedTitles.has(t));
  // Counts come from the pass / fail events themselves (exact, and present
  // even when the process never reached its summary); node's summary only
  // confirms them.
  const finalCounts = { ...counts };
  const anyFailure = finalCounts.fail > 0 || finalCounts.cancelled > 0 || failures.length > 0 || summary?.success === false;
  let status;
  let noExit = false;
  if (exit.spawnError || logError) status = "crash";
  else if (timedOut && runningAtEnd.length) status = "timeout";
  else if (timedOut || endedIdle) {
    // The process was ended by the runner while no test was running.
    noExit = true;
    status = resultsSeen === 0 ? "timeout" : anyFailure ? (unknownFailures.length === 0 ? "xfail" : "fail") : "pass";
  } else if (!summary && (exit.code ?? 1) !== 0 && resultsSeen === 0) status = "crash";
  else if (anyFailure) status = unknownFailures.length === 0 && failures.length > 0 ? "xfail" : "fail";
  else if (!summary && resultsSeen === 0) status = "crash";
  else status = "pass";
  const unexpectedPass = unexpectedPasses.length > 0;
  const noExitKnown = noExit && Boolean(knownNoExit);
  const ok = (status === "pass" || status === "xfail") && (!noExit || noExitKnown);
  return {
    file,
    status,
    ok,
    durationMs,
    tests: resultsSeen ? finalCounts.tests : null,
    pass: resultsSeen ? finalCounts.pass : null,
    fail: resultsSeen ? finalCounts.fail : null,
    cancelled: resultsSeen ? finalCounts.cancelled : null,
    skipped: resultsSeen ? finalCounts.skipped : null,
    summarySeen: Boolean(summary),
    exitCode: exit.code,
    signal: exit.signal,
    timedOut,
    running: runningAtEnd,
    noExit,
    noExitKnown,
    pipeHeldOpen: Boolean(exit.pipeHeldOpen),
    unexpectedPass,
    unexpectedPasses,
    unknownFailures,
    knownFailuresSeen,
    failureDetails: failures.filter((f) => f.leaf).map((f) => ({ name: f.name, failureType: f.failureType, message: f.message, known: f.known, listedButDifferent: f.listedButDifferent })),
    spawnError: exit.spawnError ? String(exit.spawnError.message || exit.spawnError) : logError ? `log file: ${logError.message}` : null,
    logPath,
  };
}

// --------------------------------------------------------------- planning
function buildChildEnv({ kind, db }) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (SCRUBBED_ENV.test(key)) continue;
    env[key] = value;
  }
  // `import "dotenv/config"` in a test file reads this empty file, so
  // backend/.env never reaches a test process: the runner is the only source
  // of the database target.
  env.DOTENV_CONFIG_PATH = runtime.emptyEnvFile;
  env.OPTIMOVE_TEST_RUNNER = "1";
  env.OPTIMOVE_TEST_KIND = kind;
  if (kind === "disposable" || kind === "schema-clone") {
    env.DATABASE_URL = db.adminUrl;
    env.TEST_DATABASE_ADMIN_URL = db.adminUrl;
  }
  if (kind === "shared") env.DATABASE_URL = db.sharedUrl;
  if (kind === "schema-clone") env.LOCAL_OPTIMOVE_SCHEMA_SOURCE_URL = db.schemaSourceUrl;
  return env;
}

export function resolveDatabaseTargets({ kind, sharedDbName, backendDirAbs, envValues = process.env }) {
  if (kind === "unit") return { description: "no database (DATABASE_URL unset, backend/.env not read)" };
  const fileEnv = readEnvFile(path.join(backendDirAbs, ".env"));
  const raw = envValues.DATABASE_URL || fileEnv.DATABASE_URL;
  const parsed = parseSafeLocalDatabaseUrl(raw, "DATABASE_URL");
  if (kind === "disposable") {
    const adminUrl = withDatabase(parsed, "postgres");
    return { adminUrl, description: `disposable databases on ${describeTarget(parsed, "postgres")} (each file creates and drops its own optimove_tests_* database; the configured database "${parsed.dbName}" is never opened)` };
  }
  if (kind === "shared") {
    // A per-run decision on the command line only; no ambient variable
    // makes a persistent development database the target.
    const name = sharedDbName;
    if (!name) {
      throw new RunnerRefusal(`kind "shared" writes to a persistent development database and runs only when that database is named explicitly on this run: pass --shared-db <name> naming the database of DATABASE_URL (${describeTarget(parsed)})`);
    }
    if (name !== parsed.dbName) throw new RunnerRefusal(`--shared-db names "${name}" but DATABASE_URL points at "${parsed.dbName}" (${describeTarget(parsed)}); nothing was run`);
    if (!/^optimove/i.test(name)) throw new RunnerRefusal(`"${name}" is not an OptiMove development database (the name must start with "optimove"); nothing was run`);
    return { sharedUrl: parsed.url.toString(), description: `SHARED development database ${describeTarget(parsed)} (test fixtures are written there and cleaned up by each file)` };
  }
  if (kind === "schema-clone") {
    const source = envValues.LOCAL_OPTIMOVE_SCHEMA_SOURCE_URL || fileEnv.LOCAL_OPTIMOVE_SCHEMA_SOURCE_URL;
    if (!source) return { adminUrl: withDatabase(parsed, "postgres"), skipReason: "LOCAL_OPTIMOVE_SCHEMA_SOURCE_URL is not set" };
    const sourceParsed = parseSafeLocalDatabaseUrl(source, "LOCAL_OPTIMOVE_SCHEMA_SOURCE_URL");
    return { adminUrl: withDatabase(parsed, "postgres"), schemaSourceUrl: source, description: `schema clone of ${describeTarget(sourceParsed)} into a disposable database on ${describeTarget(parsed, "postgres")}` };
  }
  throw new RunnerRefusal(`unknown kind "${kind}"`);
}

function selectFiles({ project, projectDirAbs, kind, group, filters, files }) {
  const testsDirAbs = path.join(projectDirAbs, "tests");
  const manifest = readManifest(projectDirAbs);
  const cache = new Map();
  const all = listTestFiles(testsDirAbs).map((file) => classifyFile({ project, file, testsDirAbs, cache, manifest }));
  let selected = all;
  if (kind && kind !== "all") selected = selected.filter((f) => f.kind === kind);
  if (group) {
    const re = GROUPS[group]?.[project];
    if (!re) throw new RunnerRefusal(`unknown group "${group}" for ${project}`);
    selected = selected.filter((f) => re.test(f.file));
  }
  if (filters.length) selected = selected.filter((f) => filters.some((s) => f.file.includes(s)));
  if (files.length) selected = selected.filter((f) => files.includes(f.file));
  return { all, selected, manifest, testsDirAbs };
}

function formatDuration(ms) {
  if (ms == null) return "-";
  return ms >= 10_000 ? `${(ms / 1000).toFixed(0)}s` : `${(ms / 1000).toFixed(1)}s`;
}

function statusLabel(r) {
  if (r.status === "skipped") return "SKIP";
  if (r.noExit && !r.noExitKnown && (r.status === "pass" || r.status === "xfail")) return "NOEXIT";
  if (r.status === "pass" && r.unexpectedPass) return "XPASS";
  if (r.noExit && r.noExitKnown) return `${r.status.toUpperCase()}*`;
  return r.status.toUpperCase();
}

async function runStep(step, args, io) {
  const projectCfg = PROJECTS[step.project];
  if (!projectCfg) throw new RunnerRefusal(`unknown project "${step.project}"`);
  // --project-dir is for the runner's own self-test (a throwaway project
  // with a tests/ folder); the database rules of the named project apply.
  const projectDirAbs = args.projectDir ? path.resolve(args.projectDir) : path.join(REPO_ROOT, projectCfg.dir);
  const kind = step.kind || (step.project === "frontend" ? "unit" : undefined);
  if (kind && kind !== "all" && !projectCfg.kinds.includes(kind)) throw new RunnerRefusal(`kind "${kind}" does not exist for ${step.project} (kinds: ${projectCfg.kinds.join(", ")})`);
  const { all, selected, manifest, testsDirAbs } = selectFiles({ project: step.project, projectDirAbs, kind, group: step.group, filters: args.filters, files: args.files });

  if (args.list) {
    io.out(`\n${step.project}: ${all.length} test files${kind && kind !== "all" ? `, ${selected.length} of kind ${kind}` : ""}${step.group ? `, group ${step.group}` : ""}`);
    io.out("  kind          flags                     lines  file");
    for (const f of selected) {
      const flags = [f.flags.httpServer ? "http" : "", f.flags.spawns ? "spawn" : "", f.flags.fakeFetch ? "fakefetch" : "", f.flags.jsdom ? "jsdom" : "", f.detected.needsDb ? "db" : "", f.detected.disposable ? "createdb" : ""].filter(Boolean).join(",");
      io.out(`  ${f.kind.padEnd(13)} ${flags.padEnd(25)} ${String(f.flags.lines).padStart(5)}  ${f.file}`);
    }
    return { project: step.project, kind, group: step.group, listed: selected, ok: true, results: [] };
  }

  if (kind === "all") throw new RunnerRefusal("--kind all is only for --list; run one kind at a time");
  const kinds = kind ? [kind] : projectCfg.kinds.filter((k) => k !== "shared" && k !== "schema-clone");
  const results = [];
  let ok = true;
  for (const k of kinds) {
    const filesOfKind = kind ? selected : selected.filter((f) => f.kind === k);
    // The database target is checked for every kind that was asked for,
    // before the file list is even looked at: an unsafe DATABASE_URL is
    // refused whether or not a file would have used it.
    const db = resolveDatabaseTargets({ kind: k, sharedDbName: args.sharedDb, backendDirAbs: path.join(REPO_ROOT, "backend") });
    if (!filesOfKind.length) {
      io.out(`\n${step.project} / ${k}: no test files of this kind${step.group ? ` in group ${step.group}` : ""}`);
      continue;
    }
    const timeoutMs = args.timeoutMs || DEFAULT_TIMEOUT_MS[k];
    const logDir = path.join(io.logRoot, step.project, k);
    await fsp.mkdir(logDir, { recursive: true });
    io.out(`\n${step.project} / ${k}${step.group ? ` / group ${step.group}` : ""}: ${filesOfKind.length} file(s), ${formatDuration(timeoutMs)} per file`);
    io.out(`  database: ${db.description || db.skipReason}`);
    if (db.skipReason) {
      for (const f of filesOfKind) results.push({ file: f.file, kind: k, status: "skipped", ok: true, durationMs: 0, reason: db.skipReason, noExit: false });
      io.out(`  skipped ${filesOfKind.length} file(s): ${db.skipReason}`);
      continue;
    }
    const env = buildChildEnv({ kind: k, db });
    const backendDirAbs = path.join(REPO_ROOT, "backend");
    // Every database kind is audited - the shared kind too, so its server
    // passes the connection-time identity checks before the first file.
    const audited = k !== "unit" && !args.projectDir;
    const auditBefore = audited ? auditDatabases({ backendDirAbs, env }) : null;
    if (auditBefore?.error) {
      // Fail closed: without the audit neither the server identity nor the
      // cleanup can be vouched for.
      io.out(`  database audit failed before the step: ${auditBefore.error}; the step is not run`);
      ok = false;
      for (const f of filesOfKind) results.push({ file: f.file, kind: k, status: "skipped", ok: false, durationMs: 0, reason: `audit failed: ${auditBefore.error}`, noExit: false });
      continue;
    }
    if (auditBefore) {
      const leftFromEarlier = auditBefore.databases.filter((d) => d.disposable).length;
      if (leftFromEarlier) io.out(`  note: ${leftFromEarlier} disposable test database(s) from earlier runs already on the server (node backend/tests/support/disposable-db-audit.mjs lists them)`);
    }
    for (const f of filesOfKind) {
      const knownFailures = manifest.knownFailures.filter((e) => e.file === f.file);
      const knownNoExit = manifest.knownNoExit.find((e) => e.file === f.file) || null;
      const fileOptions = manifest.fileOptions[f.file] || {};
      const testTimeoutMs = fileOptions.testTimeoutMs || defaultTestTimeoutMs(timeoutMs);
      const r = await runOneFile({ projectDirAbs, testsDirAbs, file: f.file, env, timeoutMs, testTimeoutMs, logDir, knownFailures, knownNoExit });
      r.kind = k;
      r.testTimeoutMs = testTimeoutMs;
      results.push(r);
      if (!r.ok) ok = false;
      if (!args.quiet) {
        const counts = r.tests == null ? "" : `${r.pass ?? 0}/${r.fail ?? 0}`;
        io.out(`  ${statusLabel(r).padEnd(7)} ${formatDuration(r.durationMs).padStart(6)}  ${counts.padStart(7)}  ${r.file}`);
        for (const t of r.unknownFailures.slice(0, 10)) io.out(`           not ok: ${t}`);
        if (r.unknownFailures.length > 10) io.out(`           ... ${r.unknownFailures.length - 10} more`);
        for (const d of r.failureDetails.filter((x) => x.listedButDifferent)) io.out(`           listed in test-manifest.json but the failure differs (got ${d.failureType}: ${JSON.stringify(d.message || "")}; expected ${d.listedButDifferent.join(" or ")}) - a new failure`);
        const hung = r.failureDetails.filter((d) => d.failureType === "testTimeoutFailure");
        if (hung.length) io.out(`           ${hung.length} test(s) never finished and were cancelled by the per-test limit of ${formatDuration(testTimeoutMs)}${hung.every((d) => d.known) ? " (known)" : ""}`);
        if (r.status === "xfail") io.out(`           known failure(s) only: ${r.knownFailuresSeen.length}`);
        for (const t of r.unexpectedPasses) io.out(`           listed in test-manifest.json but passed; remove its entry: ${t}`);
        if (r.status === "timeout") io.out(`           ended after ${formatDuration(timeoutMs)}${r.running.length ? ` while running: ${r.running.join(" > ")}` : " before any test reported"}`);
        if (r.noExit) io.out(`           ${r.tests ? "every test reported" : "the tests reported"} but the process stayed alive${r.noExitKnown ? " (known, ended after the idle period)" : ": a hook did not finish, a test never yielded, or a server, client or timer stayed open; the runner ended it"}`);
        if (r.status === "crash") io.out(`           no test ran to a result; exit ${r.exitCode ?? r.signal ?? r.spawnError}; see ${r.logPath}`);
      }
    }
    if (auditBefore) {
      const auditAfter = auditDatabases({ backendDirAbs, env });
      if (auditAfter.error) {
        ok = false;
        io.out(`  cleanup audit failed after the step: ${auditAfter.error}; the step is marked failed`);
        results.leftoverDatabases = null;
      } else {
        const before = new Set(auditBefore.databases.map((d) => d.name));
        const leftovers = auditAfter.databases.filter((d) => !before.has(d.name));
        const droppable = leftovers.filter((d) => d.disposable).map((d) => d.name);
        const manual = leftovers.filter((d) => !d.disposable).map((d) => d.name);
        if (leftovers.length) {
          ok = false;
          io.out(`  cleanup audit: ${leftovers.length} database(s) appeared during this step and are still there${droppable.length ? ` - droppable test databases: ${droppable.join(", ")}` : ""}${manual.length ? ` - other names (a manual decision): ${manual.join(", ")}` : ""} (a run in another checkout at the same time would also show here)`);
        } else {
          io.out("  cleanup audit: no database was left behind by this step");
        }
        if (auditAfter.maintenanceObjects !== auditBefore.maintenanceObjects) {
          ok = false;
          io.out(`  cleanup audit: the maintenance database "postgres" changed during this step (${auditBefore.maintenanceObjects} -> ${auditAfter.maintenanceObjects} user objects); a file wrote into the target instead of its own database`);
        } else {
          io.out('  cleanup audit: nothing was written into the maintenance database "postgres"');
        }
        results.leftoverDatabases = leftovers.map((d) => d.name);
      }
    }
  }
  return { project: step.project, kind, group: step.group, ok, results, leftoverDatabases: results.leftoverDatabases ?? null };
}

function summarize(stepResults, io) {
  const results = stepResults.flatMap((s) => s.results);
  const by = (pred) => results.filter(pred).length;
  const totals = {
    files: results.length,
    pass: by((r) => r.status === "pass" && !r.noExit),
    xfail: by((r) => r.status === "xfail" && !r.noExit),
    fail: by((r) => r.status === "fail" && !r.noExit),
    timeout: by((r) => r.status === "timeout"),
    crash: by((r) => r.status === "crash"),
    noExit: by((r) => r.noExit),
    skipped: by((r) => r.status === "skipped"),
    tests: results.reduce((n, r) => n + (r.tests || 0), 0),
    testsPassed: results.reduce((n, r) => n + (r.pass || 0), 0),
    testsFailed: results.reduce((n, r) => n + (r.fail || 0), 0),
    durationMs: results.reduce((n, r) => n + (r.durationMs || 0), 0),
  };
  const ok = stepResults.every((s) => s.ok);
  io.out(`\nFiles: ${totals.files} — pass ${totals.pass}, known-fail ${totals.xfail}, fail ${totals.fail}, timeout ${totals.timeout}, crash ${totals.crash}, did-not-exit ${totals.noExit}, skipped ${totals.skipped}`);
  io.out(`Tests: ${totals.testsPassed} passed, ${totals.testsFailed} failed of ${totals.tests}; ${formatDuration(totals.durationMs)} in total`);
  const bad = results.filter((r) => !r.ok);
  if (bad.length) {
    io.out("Not ok:");
    for (const r of bad) io.out(`  ${statusLabel(r)}  ${r.file}  (${r.logPath})`);
  }
  io.out(`Logs: ${io.logRoot}`);
  io.out(ok ? "RESULT: OK" : "RESULT: FAILED");
  return { ok, totals };
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write(HELP);
    return 0;
  }
  let steps;
  if (args.preset) {
    steps = PRESETS[args.preset];
    if (!steps) throw new RunnerRefusal(`unknown preset "${args.preset}" (presets: ${Object.keys(PRESETS).join(", ")})`);
  } else {
    if (!args.project) throw new RunnerRefusal("--project <backend|frontend> or --preset <name> is required");
    steps = [{ project: args.project, kind: args.kind, group: args.group }];
  }
  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const logRoot = args.logDir ? path.resolve(args.logDir) : path.join(os.tmpdir(), "optimove-test-runner", runId);
  await fsp.mkdir(logRoot, { recursive: true, mode: 0o700 });
  const privateDir = await fsp.mkdtemp(path.join(os.tmpdir(), "optimove-test-runner-env-"));
  runtime.emptyEnvFile = path.join(privateDir, "empty.env");
  await fsp.writeFile(runtime.emptyEnvFile, "", { mode: 0o600 });
  const io = { out: (line) => process.stdout.write(`${line}\n`), logRoot };
  io.out(`OptiMove test runner — ${args.preset ? `preset ${args.preset}` : `${args.project}${args.kind ? ` / ${args.kind}` : ""}`} — node ${process.version}`);
  const stepResults = [];
  try {
    for (const step of steps) stepResults.push(await runStep(step, args, io));
  } finally {
    await fsp.rm(privateDir, { recursive: true, force: true });
  }
  if (args.list) {
    if (args.json) await fsp.writeFile(args.json, JSON.stringify({ runId, steps: stepResults.map((s) => ({ project: s.project, kind: s.kind, group: s.group, files: s.listed })) }, null, 2));
    return 0;
  }
  const { ok, totals } = summarize(stepResults, io);
  if (args.json) {
    await fsp.writeFile(args.json, JSON.stringify({ runId, node: process.version, platform: process.platform, logRoot, ok, totals, steps: stepResults }, null, 2));
  }
  return ok ? 0 : 1;
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      if (error instanceof RunnerRefusal) {
        process.stderr.write(`test-runner refused: ${error.message}\n`);
        process.exitCode = 2;
      } else {
        process.stderr.write(`test-runner crashed: ${error?.stack || error}\n`);
        process.exitCode = 3;
      }
    },
  );
}
