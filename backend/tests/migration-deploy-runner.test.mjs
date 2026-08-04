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
