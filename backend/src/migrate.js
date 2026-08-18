import "dotenv/config";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { pool } from "./db.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
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

export async function runMigrations() {
  try {
    for (const migrationPath of migrationPaths) {
      const sql = await readFile(migrationPath, "utf8");
      await pool.query(sql);
    }
    console.log("Builder schema is ready.");
  } finally {
    await pool.end();
  }
}

const isMainModule = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  await runMigrations();
}
