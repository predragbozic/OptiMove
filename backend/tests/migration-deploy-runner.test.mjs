import { after, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import "dotenv/config";
import { pool } from "../src/db.js";
import { migrationPaths } from "../src/migrate.js";

// Proves the backfill migration is actually wired into the real deploy
// runner (backend/src/migrate.js, invoked by `npm start` as
// `node src/migrate.js && node src/server.js`) - not just that the SQL
// file works when a test loads it directly, which migration-backfill.test.mjs
// already covers separately.

after(async () => {
  await pool.end();
});

test("the club_admin backfill migration is registered in the deploy migration runner, after create_access_schema.sql", () => {
  const backfillIndex = migrationPaths.findIndex((p) => path.basename(p) === "20260730_backfill_club_admin_scope.sql");
  assert.notEqual(backfillIndex, -1, "migrationPaths must include the backfill migration file");

  const accessSchemaIndex = migrationPaths.findIndex((p) => path.basename(p) === "create_access_schema.sql");
  assert.notEqual(accessSchemaIndex, -1, "create_access_schema.sql must be present in migrationPaths");
  assert.equal(
    backfillIndex,
    accessSchemaIndex + 1,
    "the backfill migration depends on users/clubs/user_club_roles from create_access_schema.sql and must run immediately after it",
  );

  for (const migrationPath of migrationPaths) {
    assert.ok(existsSync(migrationPath), `migration path must resolve to a real file: ${migrationPath}`);
  }
});

test("the athlete_memberships migration is registered in the deploy migration runner, after create_access_schema.sql", () => {
  const membershipsIndex = migrationPaths.findIndex((p) => path.basename(p) === "20260801_athlete_memberships.sql");
  assert.notEqual(membershipsIndex, -1, "migrationPaths must include the athlete_memberships migration file");

  const accessSchemaIndex = migrationPaths.findIndex((p) => path.basename(p) === "create_access_schema.sql");
  assert.ok(
    membershipsIndex > accessSchemaIndex,
    "the athlete_memberships migration depends on athletes/clubs/teams/users from create_access_schema.sql and must run after it",
  );
});

test("the user_global_roles migration is registered in the deploy migration runner, after create_access_schema.sql", () => {
  const globalRolesIndex = migrationPaths.findIndex((p) => path.basename(p) === "20260802_user_global_roles.sql");
  assert.notEqual(globalRolesIndex, -1, "migrationPaths must include the user_global_roles migration file");

  const accessSchemaIndex = migrationPaths.findIndex((p) => path.basename(p) === "create_access_schema.sql");
  assert.ok(
    globalRolesIndex > accessSchemaIndex,
    "the user_global_roles migration depends on users/athletes from create_access_schema.sql and must run after it",
  );
});

test("the user_global_roles audit-columns migration is registered in the deploy migration runner, immediately after 20260802_user_global_roles.sql", () => {
  const auditIndex = migrationPaths.findIndex((p) => path.basename(p) === "20260803_user_global_roles_audit.sql");
  assert.notEqual(auditIndex, -1, "migrationPaths must include the user_global_roles audit-columns migration file");

  const globalRolesIndex = migrationPaths.findIndex((p) => path.basename(p) === "20260802_user_global_roles.sql");
  assert.equal(
    auditIndex,
    globalRolesIndex + 1,
    "the audit-columns migration alters public.user_global_roles and must run immediately after it's created",
  );

  for (const migrationPath of migrationPaths) {
    assert.ok(existsSync(migrationPath), `migration path must resolve to a real file: ${migrationPath}`);
  }
});

test("the scoped-role (user_club_roles/user_team_roles) audit-columns migration is registered in the deploy migration runner, after create_access_schema.sql", () => {
  const scopedAuditIndex = migrationPaths.findIndex((p) => path.basename(p) === "20260804_scoped_role_audit.sql");
  assert.notEqual(scopedAuditIndex, -1, "migrationPaths must include the scoped-role audit-columns migration file");

  const accessSchemaIndex = migrationPaths.findIndex((p) => path.basename(p) === "create_access_schema.sql");
  assert.ok(
    scopedAuditIndex > accessSchemaIndex,
    "the scoped-role audit-columns migration alters public.user_club_roles/user_team_roles and must run after create_access_schema.sql creates them",
  );

  for (const migrationPath of migrationPaths) {
    assert.ok(existsSync(migrationPath), `migration path must resolve to a real file: ${migrationPath}`);
  }
});

test("the user_workspace_preferences migration is registered in the deploy migration runner, after create_access_schema.sql", () => {
  const workspacePrefsIndex = migrationPaths.findIndex((p) => path.basename(p) === "20260805_user_workspace_preferences.sql");
  assert.notEqual(workspacePrefsIndex, -1, "migrationPaths must include the user_workspace_preferences migration file");

  const accessSchemaIndex = migrationPaths.findIndex((p) => path.basename(p) === "create_access_schema.sql");
  assert.ok(
    workspacePrefsIndex > accessSchemaIndex,
    "the user_workspace_preferences migration references public.users and must run after create_access_schema.sql creates it",
  );

  for (const migrationPath of migrationPaths) {
    assert.ok(existsSync(migrationPath), `migration path must resolve to a real file: ${migrationPath}`);
  }
});

test("the athlete_invites context migration is registered in the deploy migration runner, after create_access_schema.sql", () => {
  const inviteContextIndex = migrationPaths.findIndex((p) => path.basename(p) === "20260806_athlete_invites_context.sql");
  assert.notEqual(inviteContextIndex, -1, "migrationPaths must include the athlete_invites context migration file");

  const accessSchemaIndex = migrationPaths.findIndex((p) => path.basename(p) === "create_access_schema.sql");
  assert.ok(
    inviteContextIndex > accessSchemaIndex,
    "the athlete_invites context migration alters public.athlete_invites and must run after create_access_schema.sql creates it",
  );

  for (const migrationPath of migrationPaths) {
    assert.ok(existsSync(migrationPath), `migration path must resolve to a real file: ${migrationPath}`);
  }
});

test("the athlete_join_links group-invite migration is registered in the deploy migration runner, after create_access_schema.sql", () => {
  const joinLinksIndex = migrationPaths.findIndex((p) => path.basename(p) === "20260807_athlete_join_links.sql");
  assert.notEqual(joinLinksIndex, -1, "migrationPaths must include the athlete_join_links migration file");

  const accessSchemaIndex = migrationPaths.findIndex((p) => path.basename(p) === "create_access_schema.sql");
  assert.ok(
    joinLinksIndex > accessSchemaIndex,
    "the athlete_join_links migration references public.users/clubs/teams/athletes and must run after create_access_schema.sql creates them",
  );

  for (const migrationPath of migrationPaths) {
    assert.ok(existsSync(migrationPath), `migration path must resolve to a real file: ${migrationPath}`);
  }
});

test("the athlete_generated_id_seq migration is registered in the deploy migration runner, after create_access_schema.sql", () => {
  const seqIndex = migrationPaths.findIndex((p) => path.basename(p) === "20260808_athlete_id_sequence.sql");
  assert.notEqual(seqIndex, -1, "migrationPaths must include the athlete_generated_id_seq migration file");

  const accessSchemaIndex = migrationPaths.findIndex((p) => path.basename(p) === "create_access_schema.sql");
  assert.ok(
    seqIndex > accessSchemaIndex,
    "the athlete_generated_id_seq migration reads public.athletes' existing rows to seed its starting value and must run after create_access_schema.sql creates it",
  );

  for (const migrationPath of migrationPaths) {
    assert.ok(existsSync(migrationPath), `migration path must resolve to a real file: ${migrationPath}`);
  }
});

test("the email_verification_tokens migration is registered in the deploy migration runner, after 20260807_athlete_join_links.sql", () => {
  const emailVerificationIndex = migrationPaths.findIndex((p) => path.basename(p) === "20260809_email_verification.sql");
  assert.notEqual(emailVerificationIndex, -1, "migrationPaths must include the email_verification_tokens migration file");

  const joinLinksIndex = migrationPaths.findIndex((p) => path.basename(p) === "20260807_athlete_join_links.sql");
  assert.ok(
    emailVerificationIndex > joinLinksIndex,
    "the email_verification_tokens migration FKs to public.athlete_join_applications and must run after 20260807_athlete_join_links.sql creates it",
  );

  for (const migrationPath of migrationPaths) {
    assert.ok(existsSync(migrationPath), `migration path must resolve to a real file: ${migrationPath}`);
  }
});

test("the password_reset_tokens migration is registered in the deploy migration runner, immediately after 20260809_email_verification.sql", () => {
  const passwordResetIndex = migrationPaths.findIndex((p) => path.basename(p) === "20260810_password_reset.sql");
  assert.notEqual(passwordResetIndex, -1, "migrationPaths must include the password_reset_tokens migration file");

  const emailVerificationIndex = migrationPaths.findIndex((p) => path.basename(p) === "20260809_email_verification.sql");
  assert.equal(
    passwordResetIndex,
    emailVerificationIndex + 1,
    "password_reset_tokens is a deliberately separate table from email_verification_tokens (see the migration's own header comment) - ordered immediately after it purely to keep token-table migrations chronologically grouped",
  );

  for (const migrationPath of migrationPaths) {
    assert.ok(existsSync(migrationPath), `migration path must resolve to a real file: ${migrationPath}`);
  }
});

test("the password_reset_tokens migration file can be applied twice with no error, and produces the expected invariants", async () => {
  const migrationPath = migrationPaths.find((p) => path.basename(p) === "20260810_password_reset.sql");
  const sql = await (await import("node:fs/promises")).readFile(migrationPath, "utf8");
  await pool.query(sql);
  await pool.query(sql);

  const cols = await pool.query(
    `select column_name from information_schema.columns where table_schema = 'public' and table_name = 'password_reset_tokens'`,
  );
  const colNames = cols.rows.map((r) => r.column_name).sort();
  for (const expected of ["id", "user_id", "token_hash", "expires_at", "sent_at", "consumed_at", "revoked_at", "created_at", "updated_at"]) {
    assert.ok(colNames.includes(expected), `password_reset_tokens must have a ${expected} column`);
  }

  const indexes = await pool.query(`select indexname from pg_indexes where schemaname = 'public' and tablename = 'password_reset_tokens'`);
  const indexNames = indexes.rows.map((r) => r.indexname);
  assert.ok(indexNames.includes("password_reset_tokens_one_active_per_user_idx"), "the partial unique 'one active token per user' index must exist");
  assert.ok(indexNames.includes("password_reset_tokens_token_hash_key"), "token_hash must be unique");
});

test("the account_email_change_tokens migration is registered in the deploy migration runner, after 20260810_password_reset.sql", () => {
  const emailChangeIndex = migrationPaths.findIndex((p) => path.basename(p) === "20260811_account_email_change.sql");
  assert.notEqual(emailChangeIndex, -1, "migrationPaths must include the account_email_change_tokens migration file");

  const passwordResetIndex = migrationPaths.findIndex((p) => path.basename(p) === "20260810_password_reset.sql");
  assert.ok(
    emailChangeIndex > passwordResetIndex,
    "account_email_change_tokens is a deliberately separate table from both password_reset_tokens and email_verification_tokens (see the migration's own header comment) - ordered after password_reset_tokens purely to keep token-table migrations chronologically grouped",
  );

  for (const migrationPath of migrationPaths) {
    assert.ok(existsSync(migrationPath), `migration path must resolve to a real file: ${migrationPath}`);
  }
});

test("the account_email_change_tokens migration file can be applied twice with no error, and produces the expected invariants", async () => {
  const migrationPath = migrationPaths.find((p) => path.basename(p) === "20260811_account_email_change.sql");
  const sql = await (await import("node:fs/promises")).readFile(migrationPath, "utf8");
  await pool.query(sql);
  await pool.query(sql);

  const cols = await pool.query(
    `select column_name from information_schema.columns where table_schema = 'public' and table_name = 'account_email_change_tokens'`,
  );
  const colNames = cols.rows.map((r) => r.column_name).sort();
  for (const expected of ["id", "user_id", "new_email", "token_hash", "requested_by_user_id", "request_source", "expires_at", "sent_at", "consumed_at", "revoked_at", "created_at", "updated_at"]) {
    assert.ok(colNames.includes(expected), `account_email_change_tokens must have a ${expected} column`);
  }

  const indexes = await pool.query(`select indexname from pg_indexes where schemaname = 'public' and tablename = 'account_email_change_tokens'`);
  const indexNames = indexes.rows.map((r) => r.indexname);
  assert.ok(indexNames.includes("account_email_change_tokens_one_active_per_user_idx"), "the partial unique 'one active token per user' index must exist");
  assert.ok(indexNames.includes("account_email_change_tokens_token_hash_key"), "token_hash must be unique");

  const constraints = await pool.query(
    `select conname from pg_constraint where conrelid = 'public.account_email_change_tokens'::regclass`,
  );
  const constraintNames = constraints.rows.map((r) => r.conname);
  assert.ok(constraintNames.includes("account_email_change_tokens_request_source_check"), "request_source must be constrained to 'self'/'platform_admin'");
  assert.ok(constraintNames.includes("account_email_change_tokens_new_email_lower_check"), "new_email must be constrained to lowercase");
  assert.ok(constraintNames.includes("account_email_change_tokens_not_both_consumed_and_revoked_check"), "consumed_at and revoked_at must never both be set");
});
