import "dotenv/config";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import pg from "pg";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Historical record of the 29 migrations that built the schema up through
// the Strategy B cutover (see LEGACY_CUTOVER_KEY below). Kept exported and
// unchanged because backend/tests/migration-deploy-runner.test.mjs asserts
// on its contents/ordering, and because it documents how the current schema
// came to exist. As of this file's Strategy B rewrite, runMigrations() below
// no longer executes these paths on every startup - it verifies their
// cumulative effect (the "legacy fingerprint") instead. See MIGRATIONS_V2_ROOT
// and assertLegacyBaselinePresent() for the new, active mechanism.
export const migrationPaths = [
  path.resolve(__dirname, "../../create_access_schema.sql"),
  // Depends on users, clubs, and user_club_roles from create_access_schema.sql above.
  path.resolve(__dirname, "../../migrations/20260730_backfill_club_admin_scope.sql"),
  // Depends on athletes, clubs, teams, and users from create_access_schema.sql above.
  path.resolve(__dirname, "../../migrations/20260801_athlete_memberships.sql"),
  // Depends on users and athletes from create_access_schema.sql above.
  path.resolve(__dirname, "../../migrations/20260802_user_global_roles.sql"),
  // Depends on public.user_global_roles from the migration directly above.
  path.resolve(__dirname, "../../migrations/20260803_user_global_roles_audit.sql"),
  // Depends on public.user_club_roles/user_team_roles from create_access_schema.sql above.
  path.resolve(__dirname, "../../migrations/20260804_scoped_role_audit.sql"),
  // Depends on public.users from create_access_schema.sql above.
  path.resolve(__dirname, "../../migrations/20260805_user_workspace_preferences.sql"),
  // Depends on public.athlete_invites/users/clubs/teams from create_access_schema.sql above.
  path.resolve(__dirname, "../../migrations/20260806_athlete_invites_context.sql"),
  // Depends on public.users/clubs/teams/athletes from create_access_schema.sql above.
  // Independent of 20260806_athlete_invites_context.sql (a separate group-join
  // system, not an extension of athlete_invites) but ordered after it purely
  // to keep invite-lifecycle and join-link migrations chronologically grouped.
  path.resolve(__dirname, "../../migrations/20260807_athlete_join_links.sql"),
  // Depends on public.athletes from create_access_schema.sql above (reads its
  // existing rows to seed the sequence's starting value).
  path.resolve(__dirname, "../../migrations/20260808_athlete_id_sequence.sql"),
  // Depends on public.athlete_join_applications from
  // 20260807_athlete_join_links.sql above (its FK target).
  path.resolve(__dirname, "../../migrations/20260809_email_verification.sql"),
  // Depends on public.users from create_access_schema.sql above. A separate
  // table from email_verification_tokens right above (see this migration's
  // own header comment for why) - ordered after it purely to keep every
  // token-table migration chronologically grouped, not because of any real
  // dependency between them.
  path.resolve(__dirname, "../../migrations/20260810_password_reset.sql"),
  // Depends on public.users from create_access_schema.sql above. A separate
  // table from both password_reset_tokens and email_verification_tokens
  // right above (see this migration's own header comment for why) - ordered
  // after them purely to keep every token-table migration chronologically
  // grouped, not because of any real dependency between them.
  path.resolve(__dirname, "../../migrations/20260811_account_email_change.sql"),
  path.resolve(__dirname, "../../create_builder_schema.sql"),
  // Depends on library.exercises and exercise taxonomy from the base schema,
  // plus library.tags from create_builder_schema.sql directly above.
  path.resolve(__dirname, "../../migrations/20260818_seed_pankov_exercises.sql"),
  path.resolve(__dirname, "../../create_exercise_user_state.sql"),
  path.resolve(__dirname, "../../create_coach_profiles_schema.sql"),
  path.resolve(__dirname, "../../create_reviews_schema.sql"),
  path.resolve(__dirname, "../../migrations/20260818_seed_pankov_programs.sql"),
  path.resolve(__dirname, "../../migrations/20260818_seed_multi_athlete_01_custom_exercises.sql"),
  path.resolve(__dirname, "../../migrations/20260818_seed_multi_athlete_02_zija_murina.sql"),
  path.resolve(__dirname, "../../migrations/20260818_seed_multi_athlete_03_milos_milovic_programs.sql"),
  path.resolve(__dirname, "../../migrations/20260818_seed_multi_athlete_04_nikola_vujinivic_programs.sql"),
  path.resolve(__dirname, "../../migrations/20260818_seed_multi_athlete_05_nikola_petkovic_programs.sql"),
  path.resolve(__dirname, "../../migrations/20260818_seed_multi_athlete_06_zija_murina_programs.sql"),
  path.resolve(__dirname, "../../create_notifications_schema.sql"),
  path.resolve(__dirname, "../../create_messages_schema.sql"),
  path.resolve(__dirname, "../../alter_plan_sessions_schedule.sql"),
  path.resolve(__dirname, "../../create_plan_read_views.sql"),
];

// Where new, flat-namespaced migrations live from now on. See
// migrations_v2/README.md for the naming convention.
export const MIGRATIONS_V2_ROOT = path.resolve(__dirname, "../../migrations_v2");

// =========================================================================
// Transaction-control lexer - rejects any migration file that tries to
// manage its own transaction (BEGIN/COMMIT/ROLLBACK/etc). Every migration
// runs inside a transaction the runner itself opens and controls, so one
// embedded in the file would either be a silent no-op or break the runner's
// own atomicity guarantees. ROLLBACK TO [SAVEPOINT] is exempt - it's a
// legitimate mid-transaction control-flow statement, not a transaction
// boundary.
// =========================================================================
export class LexError extends Error {}

export function stripToCodeTokens(sql) {
  let i = 0;
  const n = sql.length;
  const out = [];
  while (i < n) {
    const c = sql[i];
    if (c === "-" && sql[i + 1] === "-") {
      let j = sql.indexOf("\n", i);
      if (j === -1) j = n;
      out.push(" ".repeat(j - i));
      i = j;
      continue;
    }
    if (c === "/" && sql[i + 1] === "*") {
      let depth = 1;
      let j = i + 2;
      while (j < n && depth > 0) {
        if (sql[j] === "/" && sql[j + 1] === "*") {
          depth += 1;
          j += 2;
          continue;
        }
        if (sql[j] === "*" && sql[j + 1] === "/") {
          depth -= 1;
          j += 2;
          continue;
        }
        j += 1;
      }
      if (depth > 0) throw new LexError(`Unterminated block comment starting at offset ${i}`);
      out.push(" ".repeat(j - i));
      i = j;
      continue;
    }
    if ((c === "E" || c === "e") && sql[i + 1] === "'") {
      let j = i + 2;
      let closed = false;
      while (j < n) {
        if (sql[j] === "\\") {
          j += 2;
          continue;
        }
        if (sql[j] === "'") {
          if (sql[j + 1] === "'") {
            j += 2;
            continue;
          }
          j += 1;
          closed = true;
          break;
        }
        j += 1;
      }
      if (!closed) throw new LexError(`Unterminated E'...' string starting at offset ${i}`);
      out.push(" ".repeat(j - i));
      i = j;
      continue;
    }
    if (c === "'") {
      let j = i + 1;
      let closed = false;
      while (j < n) {
        if (sql[j] === "'") {
          if (sql[j + 1] === "'") {
            j += 2;
            continue;
          }
          j += 1;
          closed = true;
          break;
        }
        j += 1;
      }
      if (!closed) throw new LexError(`Unterminated '...' string starting at offset ${i}`);
      out.push(" ".repeat(j - i));
      i = j;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let closed = false;
      while (j < n) {
        if (sql[j] === '"') {
          if (sql[j + 1] === '"') {
            j += 2;
            continue;
          }
          j += 1;
          closed = true;
          break;
        }
        j += 1;
      }
      if (!closed) throw new LexError(`Unterminated "..." identifier starting at offset ${i}`);
      out.push(" ".repeat(j - i));
      i = j;
      continue;
    }
    if (c === "$") {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
      if (m) {
        const tag = m[0];
        const closeIdx = sql.indexOf(tag, i + tag.length);
        if (closeIdx === -1) throw new LexError(`Unterminated dollar-quoted block (tag "${tag}") starting at offset ${i}`);
        const j = closeIdx + tag.length;
        out.push(" ".repeat(j - i));
        i = j;
        continue;
      }
    }
    out.push(c);
    i += 1;
  }
  return out.join("");
}

export const FORBIDDEN = [
  { name: "BEGIN", re: /^\s*begin\b/i },
  { name: "START TRANSACTION", re: /^\s*start\s+transaction\b/i },
  { name: "COMMIT", re: /^\s*commit\b/i },
  { name: "ROLLBACK", re: /^\s*rollback\b(?!\s+to\b)/i },
  { name: "END", re: /^\s*end\b/i },
  { name: "ABORT", re: /^\s*abort\b/i },
  { name: "PREPARE TRANSACTION", re: /^\s*prepare\s+transaction\b/i },
];

export function findTransactionControl(sql) {
  const masked = stripToCodeTokens(sql);
  const statements = masked.split(";");
  const hits = [];
  for (const stmt of statements) {
    for (const f of FORBIDDEN) {
      if (f.re.test(stmt)) {
        hits.push({ keyword: f.name, statement: stmt.trim().slice(0, 60) });
        break;
      }
    }
  }
  return hits;
}

export function assertNoTransactionControl(sql, migrationName) {
  let hits;
  try {
    hits = findTransactionControl(sql);
  } catch (e) {
    if (e instanceof LexError) {
      throw new Error(`[migrate] LEXER ERROR in "${migrationName}": ${e.message} - refusing to execute.`);
    }
    throw e;
  }
  if (hits.length > 0) {
    throw new Error(
      `[migrate] "${migrationName}" contains transaction-control statement(s): ` +
        hits.map((h) => `${h.keyword} ("${h.statement}")`).join(", "),
    );
  }
}

// Checksums and executed SQL must be over the exact same bytes. A file that
// isn't valid canonical UTF-8 (lone continuation bytes, incomplete
// sequences, overlong encodings) is rejected before any checksum or
// execution - no silent replacement-character substitution.
export function assertCanonicalUtf8(buffer, migrationName) {
  const str = buffer.toString("utf8");
  const roundTrip = Buffer.from(str, "utf8");
  if (!buffer.equals(roundTrip)) {
    throw new Error(
      `[migrate] ABORT: "${migrationName}" is not valid canonical UTF-8 (round-trip byte mismatch) - ` +
        `the file contains a byte sequence that is not valid UTF-8, so its checksum could not represent ` +
        `the same bytes that would actually be sent to PostgreSQL. Refusing to execute.`,
    );
  }
  return str;
}

// =========================================================================
// Advisory lock - serializes concurrent runMigrations() calls (e.g. two
// deploys racing) without holding a blocking query open. Polls
// pg_try_advisory_lock() rather than the blocking pg_advisory_lock(), so a
// waiting process is idle between attempts, not parked on an open query.
// Session-scoped: released automatically if the connection is terminated.
// =========================================================================
export const MIGRATION_LOCK_KEY = 822026n;
export const LOCK_POLL_INTERVAL_MS = 500;
export const LOCK_WAIT_TIMEOUT_MS = 5 * 60 * 1000;

export async function acquireAdvisoryLock(client) {
  const deadline = Date.now() + LOCK_WAIT_TIMEOUT_MS;
  for (;;) {
    const { rows } = await client.query("select pg_try_advisory_lock($1) as locked", [MIGRATION_LOCK_KEY]);
    if (rows[0].locked === true) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, LOCK_POLL_INTERVAL_MS));
  }
}

export async function withAdvisoryLock(client, fn) {
  const locked = await acquireAdvisoryLock(client);
  if (!locked) throw new Error(`[migrate] ABORT: could not acquire migration advisory lock within ${LOCK_WAIT_TIMEOUT_MS}ms.`);
  try {
    return await fn();
  } finally {
    await client.query("select pg_advisory_unlock($1)", [MIGRATION_LOCK_KEY]).catch(() => {});
  }
}

export function parseAndValidateDatabaseUrl(raw) {
  if (!raw || raw.trim() === "") throw new Error("[migrate] ABORT: DATABASE_URL is missing or empty.");
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw new Error("[migrate] ABORT: DATABASE_URL is not a valid URL.");
  }
  if (u.protocol !== "postgres:" && u.protocol !== "postgresql:") {
    throw new Error(`[migrate] ABORT: DATABASE_URL protocol must be postgres:// or postgresql:// (got "${u.protocol}").`);
  }
  const dbName = decodeURIComponent(u.pathname.replace(/^\//, ""));
  if (!dbName) throw new Error("[migrate] ABORT: DATABASE_URL has no database name in its path.");
  if (dbName.toLowerCase() === "monitoring2") {
    throw new Error("[migrate] ABORT: DATABASE_URL names monitoring2 - refusing to run migrations against the read-only legacy source.");
  }
  return dbName;
}

// =========================================================================
// pg_catalog (OID-based) helpers - schema-unambiguous, unlike name-only
// information_schema joins.
// =========================================================================
export async function tableExists(client, schema, table) {
  // "exists as an ordinary or partitioned table" - used for legacy-fingerprint
  // checks against real, already-established OptiMove objects, where a
  // relkind collision isn't a realistic risk. Metadata object names
  // (schema_migrations/migration_cutovers) do NOT use this for their
  // create/validate decisions - they use the stricter getRelationKind() /
  // assertMetadataNameAvailableOrTable() below, so a pre-existing VIEW or
  // SEQUENCE on those names is never silently ignored.
  const r = await client.query(
    `select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname=$1 and c.relname=$2 and c.relkind in ('r','p')`,
    [schema, table],
  );
  return r.rowCount > 0;
}

// Returns the actual pg_class.relkind for schema+name, or null if nothing
// exists there at all.
export async function getRelationKind(client, schema, objectName) {
  const r = await client.query(
    `select c.relkind from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname=$1 and c.relname=$2`,
    [schema, objectName],
  );
  return r.rowCount > 0 ? r.rows[0].relkind : null;
}

const RELKIND_LABELS = {
  r: "ordinary table",
  p: "partitioned table",
  v: "view",
  m: "materialized view",
  S: "sequence",
  f: "foreign table",
  i: "index",
  I: "partitioned index",
  c: "composite type",
  t: "TOAST table",
};
function relkindLabel(k) {
  return RELKIND_LABELS[k] || `unknown relkind '${k}'`;
}

// Metadata objects (schema_migrations/migration_cutovers) accept ONLY
// relkind='r' (an ordinary table) - not even 'p' (partitioned), since a
// metadata table has no reason to be partitioned and the shape validators
// don't check partition configuration. Returns "absent" (nothing exists,
// safe to create), "table" (an ordinary table already exists, safe to
// validate), or throws if the name is occupied by anything else.
export async function assertMetadataNameAvailableOrTable(client, schema, objectName) {
  const kind = await getRelationKind(client, schema, objectName);
  if (kind === null) return "absent";
  if (kind === "r") return "table";
  throw new Error(
    `[migrate] ABORT: ${schema}.${objectName} is occupied by a non-table object ` +
      `(relkind='${kind}', ${relkindLabel(kind)}) - refusing to create or validate. ` +
      `Expected: absent, or an ordinary table.`,
  );
}

export async function getColumns(client, schema, table) {
  const r = await client.query(
    `select a.attname as column_name, format_type(a.atttypid, a.atttypmod) as data_type, a.attnotnull
     from pg_attribute a
     join pg_class c on c.oid = a.attrelid
     join pg_namespace n on n.oid = c.relnamespace
     where n.nspname=$1 and c.relname=$2 and a.attnum > 0 and not a.attisdropped
     order by a.attnum`,
    [schema, table],
  );
  return r.rows;
}

export async function getPrimaryKeyColumns(client, schema, table) {
  const r = await client.query(
    `select a.attname as column_name
     from pg_constraint con
     join pg_class c on c.oid = con.conrelid
     join pg_namespace n on n.oid = c.relnamespace
     join pg_attribute a on a.attrelid = c.oid and a.attnum = any(con.conkey)
     where n.nspname=$1 and c.relname=$2 and con.contype='p'
     order by array_position(con.conkey, a.attnum)`,
    [schema, table],
  );
  return r.rows.map((x) => x.column_name);
}

export async function getNamedCheckConstraintDef(client, schema, table, constraintName) {
  const r = await client.query(
    `select pg_get_constraintdef(con.oid) as def
     from pg_constraint con
     join pg_class c on c.oid = con.conrelid
     join pg_namespace n on n.oid = c.relnamespace
     where n.nspname=$1 and c.relname=$2 and con.conname=$3 and con.contype='c'`,
    [schema, table, constraintName],
  );
  return r.rowCount > 0 ? r.rows[0].def : null;
}

export function normalizeDef(s) {
  return s.replace(/\s+/g, " ").trim().toLowerCase();
}

export const SCHEMA_MIGRATIONS_CHECKSUM_CHECK = "schema_migrations_checksum_format_check";
export const SCHEMA_MIGRATIONS_EXEC_TIME_CHECK = "schema_migrations_execution_time_check";
export const CUTOVERS_CHECKSUM_CHECK = "migration_cutovers_fingerprint_checksum_format_check";
export const EXPECTED_CHECKSUM_DEF = "check ((checksum ~ '^[0-9a-f]{64}$'::text))";
export const EXPECTED_EXEC_TIME_DEF = "check (((execution_time_ms is null) or (execution_time_ms >= 0)))";
export const EXPECTED_CUTOVER_CHECKSUM_DEF = "check ((fingerprint_checksum ~ '^[0-9a-f]{64}$'::text))";

export async function createSchemaMigrationsTable(client) {
  const state = await assertMetadataNameAvailableOrTable(client, "public", "schema_migrations");
  if (state === "table") return;
  await client.query(`
    create table public.schema_migrations (
      migration_name    text primary key,
      checksum          text not null constraint ${SCHEMA_MIGRATIONS_CHECKSUM_CHECK} check (checksum ~ '^[0-9a-f]{64}$'),
      applied_at        timestamptz not null default now(),
      execution_time_ms integer constraint ${SCHEMA_MIGRATIONS_EXEC_TIME_CHECK} check (execution_time_ms is null or execution_time_ms >= 0),
      runner_version    text not null
    )
  `);
}

export async function assertSchemaMigrationsShape(client) {
  const state = await assertMetadataNameAvailableOrTable(client, "public", "schema_migrations");
  if (state === "absent") return;
  const cols = await getColumns(client, "public", "schema_migrations");
  const byName = Object.fromEntries(cols.map((c) => [c.column_name, c]));
  const expected = {
    migration_name: { data_type: "text", attnotnull: true },
    checksum: { data_type: "text", attnotnull: true },
    applied_at: { data_type: "timestamp with time zone", attnotnull: true },
    execution_time_ms: { data_type: "integer", attnotnull: false },
    runner_version: { data_type: "text", attnotnull: true },
  };
  for (const [name, exp] of Object.entries(expected)) {
    const act = byName[name];
    if (!act) throw new Error(`[migrate] ABORT: public.schema_migrations exists but is missing column "${name}".`);
    if (act.data_type !== exp.data_type || act.attnotnull !== exp.attnotnull) {
      throw new Error(`[migrate] ABORT: public.schema_migrations.${name} has unexpected shape (got type=${act.data_type} notnull=${act.attnotnull}).`);
    }
  }
  const pk = await getPrimaryKeyColumns(client, "public", "schema_migrations");
  if (pk.length !== 1 || pk[0] !== "migration_name") {
    throw new Error(`[migrate] ABORT: public.schema_migrations must have PRIMARY KEY on exactly migration_name (got: ${pk.join(",")}).`);
  }
  const checksumDef = await getNamedCheckConstraintDef(client, "public", "schema_migrations", SCHEMA_MIGRATIONS_CHECKSUM_CHECK);
  if (!checksumDef || normalizeDef(checksumDef) !== normalizeDef(EXPECTED_CHECKSUM_DEF)) {
    throw new Error(`[migrate] ABORT: public.schema_migrations is missing or has a mismatched "${SCHEMA_MIGRATIONS_CHECKSUM_CHECK}" constraint (got: ${checksumDef}).`);
  }
  const execDef = await getNamedCheckConstraintDef(client, "public", "schema_migrations", SCHEMA_MIGRATIONS_EXEC_TIME_CHECK);
  if (!execDef || normalizeDef(execDef) !== normalizeDef(EXPECTED_EXEC_TIME_DEF)) {
    throw new Error(`[migrate] ABORT: public.schema_migrations is missing or has a mismatched "${SCHEMA_MIGRATIONS_EXEC_TIME_CHECK}" constraint (got: ${execDef}).`);
  }
}

export async function createMigrationCutoversTable(client) {
  const state = await assertMetadataNameAvailableOrTable(client, "public", "migration_cutovers");
  if (state === "table") return;
  await client.query(`
    create table public.migration_cutovers (
      cutover_key           text primary key,
      fingerprint_version   text not null,
      fingerprint_checksum  text not null constraint ${CUTOVERS_CHECKSUM_CHECK} check (fingerprint_checksum ~ '^[0-9a-f]{64}$'),
      accepted_at           timestamptz not null default now(),
      runner_version        text not null
    )
  `);
}

export async function assertMigrationCutoversShape(client) {
  const state = await assertMetadataNameAvailableOrTable(client, "public", "migration_cutovers");
  if (state === "absent") return;
  const cols = await getColumns(client, "public", "migration_cutovers");
  const byName = Object.fromEntries(cols.map((c) => [c.column_name, c]));
  const expected = {
    cutover_key: { data_type: "text", attnotnull: true },
    fingerprint_version: { data_type: "text", attnotnull: true },
    fingerprint_checksum: { data_type: "text", attnotnull: true },
    accepted_at: { data_type: "timestamp with time zone", attnotnull: true },
    runner_version: { data_type: "text", attnotnull: true },
  };
  for (const [name, exp] of Object.entries(expected)) {
    const act = byName[name];
    if (!act) throw new Error(`[migrate] ABORT: public.migration_cutovers exists but is missing column "${name}".`);
    if (act.data_type !== exp.data_type || act.attnotnull !== exp.attnotnull) {
      throw new Error(`[migrate] ABORT: public.migration_cutovers.${name} has unexpected shape (got type=${act.data_type} notnull=${act.attnotnull}).`);
    }
  }
  const pk = await getPrimaryKeyColumns(client, "public", "migration_cutovers");
  if (pk.length !== 1 || pk[0] !== "cutover_key") {
    throw new Error(`[migrate] ABORT: public.migration_cutovers must have PRIMARY KEY on exactly cutover_key (got: ${pk.join(",")}).`);
  }
  const checksumDef = await getNamedCheckConstraintDef(client, "public", "migration_cutovers", CUTOVERS_CHECKSUM_CHECK);
  if (!checksumDef || normalizeDef(checksumDef) !== normalizeDef(EXPECTED_CUTOVER_CHECKSUM_DEF)) {
    throw new Error(`[migrate] ABORT: public.migration_cutovers is missing or has a mismatched "${CUTOVERS_CHECKSUM_CHECK}" constraint (got: ${checksumDef}).`);
  }
}

// =========================================================================
// Timeouts. MIGRATION_LOCK_TIMEOUT_MS/MIGRATION_STATEMENT_TIMEOUT_MS are the
// single validated source of truth, reused at three points:
//   1. applyPreflightSessionTimeouts() - session-level, applied right after
//      the advisory lock is acquired and before the very first read-only
//      preflight query in assertLegacyBaselinePresent(). Safe to leave at
//      session scope because this runner always uses its own dedicated
//      pg.Client (never the app's pool) and closes it when done - a
//      session-level SET here can never leak into a pooled connection
//      reused by the app.
//   2. applyTransactionTimeouts() - SET LOCAL inside the short infra-setup
//      transaction (runInShortInfraTransaction) and inside each per-migration
//      transaction (applyNewMigration). Auto-resets on COMMIT/ROLLBACK.
// =========================================================================
function readPositiveIntEnv(name, fallback, min, max) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`[migrate] ABORT: invalid ${name}="${raw}" - must be an integer between ${min} and ${max}.`);
  }
  return n;
}
export const MIGRATION_LOCK_TIMEOUT_MS = readPositiveIntEnv("MIGRATION_LOCK_TIMEOUT_MS", 30_000, 1, 600_000);
export const MIGRATION_STATEMENT_TIMEOUT_MS = readPositiveIntEnv("MIGRATION_STATEMENT_TIMEOUT_MS", 120_000, 1, 3_600_000);

export async function applyTransactionTimeouts(client) {
  await client.query(`select set_config('lock_timeout', $1, true)`, [`${MIGRATION_LOCK_TIMEOUT_MS}ms`]);
  await client.query(`select set_config('statement_timeout', $1, true)`, [`${MIGRATION_STATEMENT_TIMEOUT_MS}ms`]);
}

// Session-level (is_local=false) counterpart, applied once per connection
// right after the advisory lock is acquired. Closes the gap where the
// read-only preflight queries at the top of assertLegacyBaselinePresent()
// (tableExists/assertMigrationCutoversShape/the existing-cutover-row SELECT)
// ran with no timeout at all, since they execute before any transaction
// (and therefore before any SET LOCAL) exists.
export async function applyPreflightSessionTimeouts(client) {
  await client.query(`select set_config('lock_timeout', $1, false)`, [`${MIGRATION_LOCK_TIMEOUT_MS}ms`]);
  await client.query(`select set_config('statement_timeout', $1, false)`, [`${MIGRATION_STATEMENT_TIMEOUT_MS}ms`]);
}

// =========================================================================
// Strategy B: legacy fingerprint + cutover. Verifies the database already
// has the structural shape produced by the 29 legacy migrations (without
// re-running them), records that acceptance once, and from then on only
// processes migrations_v2/. A fresh/empty database does NOT pass this
// preflight - see migrations_v2/README.md.
// =========================================================================
export const FINGERPRINT_VERSION = "2026-08-20.v1";
export const RUNNER_VERSION = "2026-08-21.v3.2";
export const LEGACY_CUTOVER_KEY = "legacy-29-migrations-2026-08-20";

async function columnExists(client, schema, table, column) {
  const cols = await getColumns(client, schema, table);
  return cols.some((c) => c.column_name === column);
}
async function viewExists(client, schema, view) {
  const r = await client.query(
    `select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname=$1 and c.relname=$2 and c.relkind='v'`,
    [schema, view],
  );
  return r.rowCount > 0;
}

export async function computeLegacyFingerprint(client) {
  const checks = [];

  for (const t of ["users", "clubs", "teams", "athletes", "user_global_roles", "athlete_memberships"]) {
    checks.push([`public.${t} exists`, await tableExists(client, "public", t)]);
  }
  checks.push(["library.exercises exists", await tableExists(client, "library", "exercises")]);
  checks.push(["plans schema exists", (await client.query(`select 1 from pg_namespace where nspname='plans'`)).rowCount > 0]);
  for (const t of ["plans", "plan_days", "plan_sessions", "plan_items", "plan_nodes"]) {
    checks.push([`plans.${t} exists`, await tableExists(client, "plans", t)]);
  }
  for (const v of ["v_plan_summary", "v_plan_item_node_ancestry", "v_weekly_plan_items", "v_program_plan_items"]) {
    checks.push([`plans.${v} view exists`, await viewExists(client, "plans", v)]);
  }

  const constraintDef = await client.query(
    `select pg_get_constraintdef(con.oid) as def
     from pg_constraint con join pg_class c on c.oid=con.conrelid join pg_namespace n on n.oid=c.relnamespace
     where n.nspname='public' and c.relname='teams' and con.conname='teams_id_club_id_unique'`,
  );
  checks.push(["teams_id_club_id_unique has exact definition UNIQUE (id, club_id)", constraintDef.rowCount === 1 && /UNIQUE \(id, club_id\)/.test(constraintDef.rows[0].def)]);

  checks.push(["user_global_roles.revoked_at exists", await columnExists(client, "public", "user_global_roles", "revoked_at")]);
  checks.push(["athlete_invites.context_type exists", await columnExists(client, "public", "athlete_invites", "context_type")]);
  checks.push(["plan_sessions.session_time exists", await columnExists(client, "plans", "plan_sessions", "session_time")]);
  checks.push(["account_email_change_tokens exists", await tableExists(client, "public", "account_email_change_tokens")]);
  checks.push(["athletes.source_external_id exists", await columnExists(client, "public", "athletes", "source_external_id")]);

  const failed = checks.filter(([, ok]) => !ok).map(([name]) => name);
  const fingerprintChecksum = crypto.createHash("sha256").update(JSON.stringify(checks)).digest("hex");
  return { ok: failed.length === 0, failed, checks, fingerprintChecksum };
}

// Shared, error-handling-aware wrapper for any short infra-setup
// transaction: BEGIN -> applyTransactionTimeouts -> fn() -> COMMIT, with
// ROLLBACK and a preserved SQLSTATE/cause on failure.
export async function runInShortInfraTransaction(client, label, fn) {
  await client.query("begin");
  try {
    await applyTransactionTimeouts(client);
    await fn();
    await client.query("commit");
  } catch (originalErr) {
    const sqlState = originalErr.code;
    try {
      await client.query("rollback");
    } catch (rollbackErr) {
      console.error(`[migrate] additionally, ROLLBACK failed for infra step "${label}": ${rollbackErr.message}`);
    }
    throw new Error(`[migrate] ABORT: ${label} failed and was rolled back (SQLSTATE ${sqlState || "?"}) - no partial metadata state left.`, {
      cause: originalErr,
    });
  }
}

export async function assertLegacyBaselinePresent(client) {
  const cutoverTableAlreadyExists = await tableExists(client, "public", "migration_cutovers");
  let existingCutover = null;
  if (cutoverTableAlreadyExists) {
    await assertMigrationCutoversShape(client);
    const r = await client.query(`select fingerprint_version, fingerprint_checksum from public.migration_cutovers where cutover_key = $1`, [
      LEGACY_CUTOVER_KEY,
    ]);
    if (r.rowCount > 0) existingCutover = r.rows[0];
  }

  const fp = await computeLegacyFingerprint(client);

  if (existingCutover) {
    if (existingCutover.fingerprint_version !== FINGERPRINT_VERSION) {
      throw new Error(
        `[migrate] ABORT: recorded legacy cutover uses fingerprint_version "${existingCutover.fingerprint_version}" ` +
          `but runner supports "${FINGERPRINT_VERSION}" - manual review required.`,
      );
    }
    if (existingCutover.fingerprint_checksum !== fp.fingerprintChecksum) {
      throw new Error(
        `[migrate] ABORT: recorded legacy cutover fingerprint_checksum does not match the currently computed value` +
          (fp.failed.length ? ` (currently failing checks: ${fp.failed.join(", ")})` : " (database structure has changed since cutover was accepted)") +
          ` - refusing to proceed automatically.`,
      );
    }
    if (!fp.ok) {
      throw new Error(`[migrate] ABORT: legacy fingerprint currently fails (${fp.failed.join(", ")}) despite a matching recorded checksum - investigate immediately.`);
    }

    // Existing, valid cutover: only schema_migrations needs to be
    // established (or just validated, if already there).
    const smKind = await getRelationKind(client, "public", "schema_migrations");
    if (smKind === "r") {
      await assertSchemaMigrationsShape(client);
      return;
    }
    if (smKind === null) {
      await runInShortInfraTransaction(client, "schema_migrations setup (existing-cutover branch)", async () => {
        const recheck = await getRelationKind(client, "public", "schema_migrations");
        if (recheck !== null) {
          throw new Error(`public.schema_migrations became occupied (relkind='${recheck}', ${relkindLabel(recheck)}) between initial check and transaction start.`);
        }
        await createSchemaMigrationsTable(client);
        await assertSchemaMigrationsShape(client);
      });
      return;
    }
    throw new Error(
      `[migrate] ABORT: public.schema_migrations is occupied by a non-table object ` +
        `(relkind='${smKind}', ${relkindLabel(smKind)}) - refusing to create. Existing legacy cutover left untouched.`,
    );
  }

  // First time: no schema objects may be created until the fingerprint passes.
  if (!fp.ok) {
    throw new Error(
      `[migrate] ABORT: database does not match the expected legacy OptiMove fingerprint ` +
        `(failed: ${fp.failed.join(", ")}). No schema objects were created. This looks like a fresh/incomplete ` +
        `database - it needs a legacy bootstrap or manual review, not automatic legacy-migration replay.`,
    );
  }

  await runInShortInfraTransaction(client, "infrastructure setup (migration_cutovers/schema_migrations)", async () => {
    await createMigrationCutoversTable(client);
    await assertMigrationCutoversShape(client);
    await client.query(`insert into public.migration_cutovers (cutover_key, fingerprint_version, fingerprint_checksum, runner_version) values ($1,$2,$3,$4)`, [
      LEGACY_CUTOVER_KEY,
      FINGERPRINT_VERSION,
      fp.fingerprintChecksum,
      RUNNER_VERSION,
    ]);
    await createSchemaMigrationsTable(client);
    await assertSchemaMigrationsShape(client);
  });
  console.log(`[migrate] legacy cutover accepted and recorded (fingerprint ${FINGERPRINT_VERSION}).`);
}

// =========================================================================
// migrations_v2/ - flat directory, YYYYMMDDHHMM_description.sql naming.
// =========================================================================
const MIGRATION_NAME_RE = /^(\d{12})_[a-z0-9_]+\.sql$/;

export async function listFlatMigrationFiles(migrationsRoot) {
  const entries = await readdir(migrationsRoot, { withFileTypes: true });
  const subdirs = entries.filter((e) => e.isDirectory());
  if (subdirs.length > 0) {
    throw new Error(`[migrate] ABORT: ${migrationsRoot} must be flat - found subdirectories: ${subdirs.map((d) => d.name).join(", ")}.`);
  }
  const files = entries.filter((e) => e.isFile() && e.name.endsWith(".sql")).map((e) => e.name);
  const byPrefix = new Map();
  for (const name of files) {
    const m = MIGRATION_NAME_RE.exec(name);
    if (!m) throw new Error(`[migrate] ABORT: "${name}" does not follow YYYYMMDDHHMM_description.sql.`);
    const prefix = m[1];
    if (!byPrefix.has(prefix)) byPrefix.set(prefix, []);
    byPrefix.get(prefix).push(name);
  }
  for (const [prefix, names] of byPrefix) {
    if (names.length > 1) throw new Error(`[migrate] ABORT: ambiguous order - timestamp prefix "${prefix}" shared by: ${names.join(", ")}.`);
  }
  files.sort();
  return files.map((f) => path.join(migrationsRoot, f));
}

export function migrationIdentity(migrationsRoot, absolutePath) {
  const rel = path.relative(migrationsRoot, absolutePath).split(path.sep).join("/");
  return path.basename(migrationsRoot) + "/" + rel;
}
export function assertNoDuplicateIdentities(identities) {
  const seen = new Set();
  for (const id of identities) {
    if (seen.has(id)) throw new Error(`[migrate] ABORT: duplicate migration identity "${id}".`);
    seen.add(id);
  }
}

export function sha256OfBuffer(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

export async function applyNewMigration(client, migrationsRoot, migrationPath) {
  const migrationName = migrationIdentity(migrationsRoot, migrationPath);
  const buffer = await readFile(migrationPath);
  const content = assertCanonicalUtf8(buffer, migrationName);
  const checksum = sha256OfBuffer(buffer);

  const existing = await client.query("select checksum from public.schema_migrations where migration_name = $1", [migrationName]);
  if (existing.rowCount > 0) {
    if (existing.rows[0].checksum === checksum) {
      console.log(`[migrate] skip (already applied, checksum matches): ${migrationName}`);
      return;
    }
    throw new Error(`[migrate] ABORT: "${migrationName}" recorded checksum differs from the file on disk now.`);
  }

  assertNoTransactionControl(content, migrationName);

  const startedAt = Date.now();
  await client.query("begin");
  try {
    await applyTransactionTimeouts(client);
    await client.query(content);
    const executionTimeMs = Date.now() - startedAt;
    await client.query(`insert into public.schema_migrations (migration_name, checksum, execution_time_ms, runner_version) values ($1,$2,$3,$4)`, [
      migrationName,
      checksum,
      executionTimeMs,
      RUNNER_VERSION,
    ]);
    await client.query("commit");
    console.log(`[migrate] applied: ${migrationName} (${executionTimeMs}ms)`);
  } catch (originalErr) {
    const sqlState = originalErr.code;
    try {
      await client.query("rollback");
    } catch (rollbackErr) {
      console.error(`[migrate] additionally, ROLLBACK failed for "${migrationName}": ${rollbackErr.message}`);
    }
    console.error(`[migrate] ABORT applying "${migrationName}": SQLSTATE=${sqlState || "?"} ${originalErr.message}`);
    throw new Error(`[migrate] ABORT while applying "${migrationName}" (SQLSTATE ${sqlState || "?"})`, { cause: originalErr });
  }
}

// Mirrors backend/src/db.js's pool ssl option exactly (Supabase requires
// TLS but its certificate chain isn't in Node's default trust store) - this
// runner uses its own dedicated pg.Client instead of that pool (see the
// timeout comments above), so it has to carry the same rule itself rather
// than inheriting it. Keyed off the actual databaseUrl being connected to
// (not process.env.DATABASE_URL directly) so it stays correct when
// runMigrations() is called with an overridden databaseUrl, e.g. in tests.
export function buildPgClientConfig(databaseUrl) {
  return {
    connectionString: databaseUrl,
    ssl: databaseUrl.includes("supabase.com") ? { rejectUnauthorized: false } : undefined,
  };
}

// =========================================================================
// Main entry point.
// =========================================================================
export async function runMigrations({ databaseUrl = process.env.DATABASE_URL, migrationsRoot = MIGRATIONS_V2_ROOT } = {}) {
  const expectedDbName = parseAndValidateDatabaseUrl(databaseUrl);

  const client = new pg.Client(buildPgClientConfig(databaseUrl));
  await client.connect();

  try {
    const { rows } = await client.query("select current_database() as db");
    const actualDbName = rows[0].db;
    if (actualDbName.toLowerCase() === "monitoring2") throw new Error("[migrate] ABORT: refusing to run against monitoring2.");
    if (actualDbName !== expectedDbName) throw new Error(`[migrate] ABORT: current_database() = "${actualDbName}" does not match DATABASE_URL.`);
    console.log(`[migrate] target database: ${actualDbName}`);

    await withAdvisoryLock(client, async () => {
      await applyPreflightSessionTimeouts(client);
      await assertLegacyBaselinePresent(client);
      const absolutePaths = await listFlatMigrationFiles(migrationsRoot);
      const identities = absolutePaths.map((p) => migrationIdentity(migrationsRoot, p));
      assertNoDuplicateIdentities(identities);
      for (const p of absolutePaths) {
        await applyNewMigration(client, migrationsRoot, p);
      }
    });

    console.log("[migrate] all migrations up to date.");
  } finally {
    await client.end();
  }
}

const isMainModule = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  await runMigrations();
}
