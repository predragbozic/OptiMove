// The e2e "world": a disposable database built from the committed legacy-schema snapshot
// plus the real migration runner, seeded with synthetic data and one demo account per role,
// and the REAL server started on a free port against it.
//
// Nothing here touches a persistent database: the database is an optimove_tests_* one created
// by backend/tests/support/disposable-db.mjs on the local loopback Postgres behind DATABASE_URL
// (the same safety rules as every backend test), and it is dropped by stop().
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { generateKeyEntry } from "../../backend/src/sourceCredentialCrypto.js";
import { createDisposableDatabase, dropDisposableDatabase } from "../../backend/tests/support/disposable-db.mjs";
import { bootstrapLegacySnapshot } from "../../backend/tests/support/legacy-bootstrap.mjs";
import { runMigrations } from "../../backend/src/migrate.js";
import { seedWorld } from "./seed.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "../..");
const MIGRATIONS = path.join(ROOT, "migrations_v2");
const SNAPSHOT = path.join(ROOT, "backend/tests/support/legacy-schema.sql");

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function waitForHealth(baseUrl, child, timeoutMs = 60_000) {
  const until = Date.now() + timeoutMs;
  let exited = null;
  child.once("exit", (code) => { exited = code; });
  while (Date.now() < until) {
    if (exited !== null) throw new Error(`the server exited with code ${exited} before it was healthy`);
    try {
      const r = await fetch(`${baseUrl}/api/health`);
      if (r.ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("the server did not become healthy in time");
}

export async function startWorld({ log = false, fakeSource = null } = {}) {
  const baseDatabaseUrl = process.env.DATABASE_URL;
  if (!baseDatabaseUrl) throw new Error("DATABASE_URL must point at a local PostgreSQL server (it is only used to create a disposable optimove_tests_* database; see backend/.env.example)");
  const snapshotSql = fs.readFileSync(SNAPSHOT, "utf8");
  const last = snapshotSql.match(/^-- Last migration contained in the dump: (\S+)\.$/m)?.[1];
  if (!last) throw new Error("the legacy-schema snapshot header does not name its last migration");

  const db = await createDisposableDatabase({ prefix: "e2e", label: "world", baseDatabaseUrl });
  let child = null;
  const stop = async () => {
    if (child && child.exitCode === null) {
      child.kill("SIGTERM");
      await new Promise((r) => { const t = setTimeout(() => { child.kill("SIGKILL"); r(); }, 3000); child.once("exit", () => { clearTimeout(t); r(); }); });
    }
    await dropDisposableDatabase({ name: db.name, adminUrl: db.adminUrl, baseDatabaseUrl }).catch(() => {});
  };
  try {
    await bootstrapLegacySnapshot({ databaseUrl: db.url, snapshotSql, migrationsRoot: MIGRATIONS, lastMigration: last });
    await runMigrations({ databaseUrl: db.url, migrationsRoot: MIGRATIONS });
    const seeded = await seedWorld(db.url);

    const port = await freePort();
    const baseUrl = `http://localhost:${port}`;
    const env = { ...process.env, DATABASE_URL: db.url, PORT: String(port), NODE_ENV: "development" };
    for (const key of Object.keys(env)) if (/^(SUPABASE|RENDER|GPEXE_API_TOKEN|SOURCE_CREDENTIAL_)/.test(key)) delete env[key];
    // A throwaway key for the stored source credential (never a real one) and, on request, the fake GPEXE source.
    env.SOURCE_CREDENTIAL_KEYS = generateKeyEntry(1);
    if (fakeSource) {
      env.NODE_OPTIONS = `${env.NODE_OPTIONS || ""} --import=${pathToFileURL(path.join(here, "fake-source-preload.mjs")).href}`.trim();
      env.E2E_FAKE_VISIBLE_TEAMS = (fakeSource.visibleTeams || []).join(",");
    }
    child = spawn(process.execPath, ["src/server.js"], { cwd: path.join(ROOT, "backend"), env, stdio: log ? "inherit" : "ignore" });
    await waitForHealth(baseUrl, child);
    return { baseUrl, databaseName: db.name, accounts: seeded.accounts, ids: seeded.ids, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}
