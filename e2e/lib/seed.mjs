// Synthetic data for the e2e world: two clubs, three teams, 12 athletes in the first team and one
// demo account per role, each with a throwaway random password and a ready session token.
// Every name is invented; nothing here is a real person.
import crypto from "node:crypto";
import pg from "pg";
import { createSession, hashPassword } from "../../backend/src/auth.js";

const NAMES = ["Ana", "Bojan", "Cara", "Dario", "Ema", "Filip", "Gaia", "Hugo", "Iva", "Jan", "Kira", "Luka"].map((n) => `${n} Example`);
const password = () => `Demo-${crypto.randomBytes(9).toString("base64url")}`;

export async function seedWorld(databaseUrl) {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const clubA = (await client.query(`insert into public.clubs (name) values ('Example Club') returning id`)).rows[0].id;
    const clubB = (await client.query(`insert into public.clubs (name) values ('Other Club') returning id`)).rows[0].id;
    const teamA = (await client.query(`insert into public.teams (club_id, name) values ($1,'First team') returning id`, [clubA])).rows[0].id;
    const teamA2 = (await client.query(`insert into public.teams (club_id, name) values ($1,'U19 team') returning id`, [clubA])).rows[0].id;
    const teamB = (await client.query(`insert into public.teams (club_id, name) values ($1,'Other team') returning id`, [clubB])).rows[0].id;

    const athleteIds = [];
    for (const name of NAMES) {
      const [first, last] = name.split(" ");
      const id = (await client.query(
        `insert into public.athletes (athlete_id, first_name, last_name, full_name, display_name, device_timezone) values (nextval('public.athlete_generated_id_seq')::text, $1, $2, $3, $3, 'Europe/Sarajevo') returning id`,
        [first, last, name])).rows[0].id;
      await client.query(`insert into public.athlete_memberships (athlete_id, club_id, team_id, membership_type, status, starts_at) values ($1,$2,$3,'team','active','2026-01-01T00:00:00Z')`, [id, clubA, teamA]);
      athleteIds.push(id);
    }

    const setWorkspace = (userId, type, scope) => client.query(
      `insert into public.user_workspace_preferences (user_id, workspace_type, scope_id) values ($1,$2,$3)
       on conflict (user_id) do update set workspace_type = excluded.workspace_type, scope_id = excluded.scope_id`, [userId, type, scope]);
    const account = async (role, label, email) => {
      const pw = password();
      const [first, ...rest] = label.split(" ");
      const id = (await client.query(
        `insert into public.users (email, first_name, last_name, full_name, display_name, password_hash) values ($1,$2,$3,$4,$4,$5) returning id`,
        [email, first, rest.join(" ") || "Example", label, hashPassword(pw)])).rows[0].id;
      const token = await createSession(id, client);
      return { role, id, email, label, password: pw, sessionToken: token };
    };

    const platformAdmin = await account("platform_admin", "Platform Admin Example", "platform.admin@example.invalid");
    await client.query(`insert into public.user_global_roles (user_id, role, is_active) values ($1,'platform_admin',true)`, [platformAdmin.id]);
    await setWorkspace(platformAdmin.id, "platform", null);

    const clubAdmin = await account("club_admin", "Club Admin Example", "club.admin@example.invalid");
    await client.query(`insert into public.user_club_roles (user_id, club_id, role, is_active) values ($1,$2,'club_admin',true)`, [clubAdmin.id, clubA]);
    await setWorkspace(clubAdmin.id, "club", clubA);

    const coach = await account("team_coach", "Coach Example", "coach@example.invalid");
    await client.query(`insert into public.user_team_roles (user_id, team_id, role, is_active) values ($1,$2,'team_coach',true)`, [coach.id, teamA]);
    await setWorkspace(coach.id, "team", teamA);

    const otherCoach = await account("other_team_coach", "Other Coach Example", "other.coach@example.invalid");
    await client.query(`insert into public.user_team_roles (user_id, team_id, role, is_active) values ($1,$2,'team_coach',true)`, [otherCoach.id, teamB]);
    await setWorkspace(otherCoach.id, "team", teamB);

    const otherClubAdmin = await account("other_club_admin", "Other Club Admin Example", "other.club.admin@example.invalid");
    await client.query(`insert into public.user_club_roles (user_id, club_id, role, is_active) values ($1,$2,'club_admin',true)`, [otherClubAdmin.id, clubB]);
    await setWorkspace(otherClubAdmin.id, "club", clubB);

    const athlete = await account("athlete", "Ana Example", "athlete@example.invalid");
    await client.query(`update public.athletes set user_id = $1 where id = $2`, [athlete.id, athleteIds[0]]);
    await setWorkspace(athlete.id, "athlete", null);

    return {
      accounts: [platformAdmin, clubAdmin, coach, otherCoach, otherClubAdmin, athlete],
      ids: { clubA, clubB, teamA, teamA2, teamB, athleteIds },
    };
  } finally {
    await client.end();
  }
}
