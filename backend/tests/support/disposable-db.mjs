// Disposable PostgreSQL databases for backend tests (T1 test-infrastructure
// foundation). One uniquely named database per test file (or per test),
// created on the local server behind DATABASE_URL, used, and dropped.
//
// This is the procedure 18 suites carried as their own `makeTempDb` /
// `dropTempDb` pair and `_gpexe-disposable-db.mjs` carried for the GPEXE
// suites, with the safety rules in one place:
//   - the server must be a loopback host and must not name a remote or
//     persistent service (Supabase, Render, a pooler, monitoring2); once
//     connected, a managed server (a Supabase / RDS / Azure / Cloud SQL
//     administration role exists) or a server listening on a public address
//     is refused as well, so a loopback tunnel to such a server is caught;
//   - a disposable name always matches optimove_tests_<prefix>_<label>_<hex>;
//     "optimove" and "monitoring2" are never accepted as a name;
//   - administration happens on the server's maintenance database "postgres",
//     and the connection is checked to be there before CREATE DATABASE;
//   - drop first ends every other session on that database, then drops it
//     WITH (FORCE).
//
// Usage (a test file):
//   import { createDisposableDatabase } from "./support/disposable-db.mjs";
//   const db = await createDisposableDatabase({ prefix: "exlib", label: "primary" });
//   ... connect to db.url, apply a scaffold or migrations, run the tests ...
//   await db.drop();
//
// Nothing here applies a scaffold or a migration: what a database holds is
// each suite's own decision (see _gpexe-disposable-db.mjs for the GPEXE
// scaffold and migrations).
import crypto from "node:crypto";
import pg from "pg";

export const DISPOSABLE_DATABASE_NAME_PATTERN = /^optimove_tests_[a-z0-9_]+$/;
// What the audit CLI may drop: a name this module (or one of the private
// pairs it replaces) generated - prefix, label and the 12-hex suffix.
export const DROPPABLE_DATABASE_NAME_PATTERN = /^optimove_tests_[a-z0-9_]+_[0-9a-f]{12}$/;
const NAME_PART_PATTERN = /^[a-z0-9_]+$/;
export const LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "::1"];
export const FORBIDDEN_URL_MARKERS = ["supabase", "render.com", "onrender", "pooler", "monitoring2"];
const MANAGED_SERVER_ROLES = ["supabase_admin", "rds_superuser", "azure_pg_admin", "cloudsqladmin", "cloudsqlsuperuser"];
// pg-connection-string lets a query parameter override the host, port, user
// or password of the URL; only these two are allowed through (the same
// rule as scripts/test-runner.mjs).
const ALLOWED_URL_PARAMS = new Set(["sslmode", "application_name"]);
const POSTGRES_IDENTIFIER_MAX = 63;

function safetyError(message) {
  return new Error(`SAFETY: ${message}`);
}

// The local server a disposable database is created on. Only the host, port
// and credentials of baseDatabaseUrl are used; its own database name is not.
export function parseServerUrl(baseDatabaseUrl = process.env.DATABASE_URL) {
  if (!baseDatabaseUrl) throw new Error("DATABASE_URL (or baseDatabaseUrl) is required to reach the local PostgreSQL server that hosts disposable test databases.");
  let url;
  try {
    url = new URL(baseDatabaseUrl);
  } catch {
    throw safetyError("the database URL is not a valid URL");
  }
  if (!/^postgres(ql)?:$/.test(url.protocol)) throw safetyError("the database URL must be a postgres:// URL");
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!LOOPBACK_HOSTS.includes(host)) throw safetyError(`disposable test databases are created on a loopback host only, not on "${host}"`);
  const lower = baseDatabaseUrl.toLowerCase();
  for (const marker of FORBIDDEN_URL_MARKERS) {
    if (lower.includes(marker)) throw safetyError(`the database URL names "${marker}", which is a persistent or remote database`);
  }
  for (const key of url.searchParams.keys()) {
    if (!ALLOWED_URL_PARAMS.has(key.toLowerCase())) throw safetyError(`the database URL carries a "${key}" parameter; only sslmode and application_name are allowed (others can redirect the connection)`);
  }
  return url;
}

export function assertDisposableDatabaseName(name) {
  if (typeof name !== "string" || !DISPOSABLE_DATABASE_NAME_PATTERN.test(name)) {
    throw safetyError(`"${name}" is not a disposable test database name (optimove_tests_<prefix>_<label>_<hex>)`);
  }
  if (name.length > POSTGRES_IDENTIFIER_MAX) throw safetyError(`"${name}" is longer than PostgreSQL allows for a database name (${POSTGRES_IDENTIFIER_MAX})`);
  if (name.toLowerCase() === "optimove" || /monitoring2/i.test(name)) throw safetyError(`refusing the database name "${name}"`);
  return name;
}

export function disposableDatabaseName(prefix, label) {
  if (typeof prefix !== "string" || !NAME_PART_PATTERN.test(prefix)) throw new Error(`prefix must match ${NAME_PART_PATTERN} (got ${JSON.stringify(prefix)})`);
  if (typeof label !== "string" || !NAME_PART_PATTERN.test(label)) throw new Error(`label must match ${NAME_PART_PATTERN} (got ${JSON.stringify(label)})`);
  return assertDisposableDatabaseName(`optimove_tests_${prefix}_${label}_${crypto.randomBytes(6).toString("hex")}`);
}

export function adminUrlFor(baseDatabaseUrl) {
  const url = parseServerUrl(baseDatabaseUrl);
  url.pathname = "/postgres";
  return url.toString();
}

export function databaseUrlFor(name, baseDatabaseUrl) {
  assertDisposableDatabaseName(name);
  const url = parseServerUrl(baseDatabaseUrl);
  url.pathname = `/${name}`;
  return url.toString();
}

// The address a connected server reports for itself (inet_server_addr()):
// loopback, the private ranges, link-local and a Unix socket (null) are a
// local or a CI-container server; anything else is a remote server reached
// through a tunnel. Exported for its table test only.
export function isPrivateOrLoopbackAddress(addr) {
  if (!addr) return true; // a Unix-socket connection reports no address
  const a = addr.replace(/\/\d+$/, "").toLowerCase();
  if (a === "::1" || a.startsWith("127.") || a.startsWith("10.") || a.startsWith("192.168.")) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(a)) return true;
  if (a.startsWith("::ffff:")) return isPrivateOrLoopbackAddress(a.slice(7));
  if (/^f[cd][0-9a-f]{2}:/.test(a) || a.startsWith("fe80:")) return true;
  return false;
}

// Every administration step goes through here: the URL is re-validated
// (callers may pass an adminUrl of their own), the session must have landed
// on "postgres", and the server must not be a managed or publicly reachable
// one behind a loopback tunnel.
async function withAdminClient(adminUrl, fn) {
  parseServerUrl(adminUrl);
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    const current = await admin.query("select current_database() as db, inet_server_addr()::text as addr");
    if (current.rows[0].db !== "postgres") throw safetyError(`the administration connection must be on the maintenance database "postgres", not on "${current.rows[0].db}"`);
    if (!isPrivateOrLoopbackAddress(current.rows[0].addr)) throw safetyError("the server behind this loopback address listens on a public address; it is not a local test server");
    const managed = await admin.query("select rolname from pg_roles where rolname = any($1::text[]) limit 1", [MANAGED_SERVER_ROLES]);
    if (managed.rowCount) throw safetyError(`the server carries the administration role "${managed.rows[0].rolname}" of a managed database service; it is not a local test server`);
    return await fn(admin);
  } finally {
    await admin.end();
  }
}

export async function dropDisposableDatabase({ name, adminUrl, baseDatabaseUrl } = {}) {
  assertDisposableDatabaseName(name);
  await withAdminClient(adminUrl || adminUrlFor(baseDatabaseUrl), async (admin) => {
    await admin.query("select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()", [name]);
    await admin.query(`drop database if exists "${name}" with (force)`);
  });
}

export async function createDisposableDatabase({ prefix, label, baseDatabaseUrl } = {}) {
  const name = disposableDatabaseName(prefix, label);
  const adminUrl = adminUrlFor(baseDatabaseUrl);
  const url = databaseUrlFor(name, baseDatabaseUrl);
  await withAdminClient(adminUrl, async (admin) => {
    await admin.query(`create database "${name}"`);
  });
  return {
    name,
    url,
    adminUrl,
    drop: () => dropDisposableDatabase({ name, adminUrl }),
  };
}

// For a client a test opened on db.url: the database it actually landed on.
export async function assertConnectedTo(client, name) {
  const own = await client.query("select current_database() as db");
  if (own.rows[0].db !== name) throw safetyError(`the connection landed on "${own.rows[0].db}" instead of "${name}"`);
}

// Every database on the server except the templates and "postgres", for the
// cleanup audit: a test file that creates a database under any name (some
// files still use their own optimove_<module>_* names) is visible here, and
// `disposable` says whether the audit's --drop may touch it. `sessions` is
// the number of other connections currently open on it.
export async function listDatabases({ adminUrl, baseDatabaseUrl } = {}) {
  return withAdminClient(adminUrl || adminUrlFor(baseDatabaseUrl), async (admin) => {
    const result = await admin.query(
      `select d.datname as name, count(a.pid)::int as sessions
       from pg_database d
       left join pg_stat_activity a on a.datname = d.datname and a.pid <> pg_backend_pid()
       where d.datistemplate = false and d.datname <> 'postgres'
       group by d.datname
       order by d.datname`,
    );
    return result.rows.map((r) => ({ name: r.name, sessions: r.sessions, disposable: DROPPABLE_DATABASE_NAME_PATTERN.test(r.name) }));
  });
}

// The number of user objects inside the maintenance database "postgres" -
// the runner gives disposable-kind files that database as their target and
// checks before and after a step that nothing was written there.
export async function countMaintenanceObjects({ adminUrl, baseDatabaseUrl } = {}) {
  return withAdminClient(adminUrl || adminUrlFor(baseDatabaseUrl), async (admin) => {
    const result = await admin.query(
      `select count(*)::int as n
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname not in ('pg_catalog', 'information_schema') and n.nspname not like 'pg_toast%'`,
    );
    return result.rows[0].n;
  });
}
