import process from "process";

import {
  assertLocalDatabase,
  Client,
  readEnvFile,
  safeDbLabel,
} from "./training_package_core.mjs";

const TARGET = {
  athleteId: "131",
  firstName: "Zija",
  lastName: "Murina",
  fullName: "Zija Murina",
  displayName: "Zija Murina",
  coachEmail: "predrag.bozic@rzsport.gov.rs",
};

function hasFlag(flag) {
  return process.argv.includes(flag);
}

function assertMatchingAthlete(row) {
  const mismatches = [];
  if (row.athlete_id !== TARGET.athleteId) mismatches.push(`athlete_id=${row.athlete_id}`);
  if (row.source_external_id !== TARGET.athleteId) mismatches.push(`source_external_id=${row.source_external_id}`);
  if (row.first_name !== TARGET.firstName) mismatches.push(`first_name=${row.first_name}`);
  if (row.last_name !== TARGET.lastName) mismatches.push(`last_name=${row.last_name}`);
  if (row.full_name !== TARGET.fullName) mismatches.push(`full_name=${row.full_name}`);
  if (row.display_name !== TARGET.displayName) mismatches.push(`display_name=${row.display_name}`);
  if (row.user_id !== null) mismatches.push("user_id is not null");
  if (row.is_active !== true) mismatches.push(`is_active=${row.is_active}`);
  if (mismatches.length) {
    throw new Error(`Existing athlete 131 does not match expected local import signature: ${mismatches.join(", ")}`);
  }
}

async function tableExists(client, schema, table) {
  const result = await client.query(
    `select to_regclass($1) as regclass`,
    [`${schema}.${table}`],
  );
  return Boolean(result.rows[0]?.regclass);
}

async function main() {
  const dryRun = hasFlag("--dry-run");
  const applyLocal = hasFlag("--apply-local");
  if (dryRun === applyLocal) throw new Error("Use exactly one mode: --dry-run or --apply-local.");

  const env = { ...readEnvFile("backend/.env"), ...process.env };
  const databaseUrl = process.env.LOCAL_DATABASE_URL || env.DATABASE_URL || "";
  assertLocalDatabase(databaseUrl);

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  const result = {
    mode: dryRun ? "dry-run" : "apply-local",
    db: safeDbLabel(databaseUrl),
    target: { athleteId: TARGET.athleteId, name: TARGET.displayName, coachEmail: TARGET.coachEmail },
    athleteCreated: false,
    athleteAlreadyExisted: false,
    coachRelationshipCreated: false,
    coachRelationshipReactivated: false,
  };

  try {
    await client.query("begin");
    await client.query("select pg_advisory_xact_lock(hashtext('create-local-zija-murina-131'))");

    const coach = await client.query(
      `select id, email, is_active
       from public.users
       where lower(email) = lower($1) and coalesce(is_active, true)
       for update`,
      [TARGET.coachEmail],
    );
    if (coach.rowCount !== 1) {
      throw new Error(`Expected exactly one active coach user for ${TARGET.coachEmail}; found ${coach.rowCount}.`);
    }
    result.coachUserId = coach.rows[0].id;

    const existing = await client.query(
      `select id, athlete_id, source_external_id, first_name, last_name, full_name, display_name, user_id, is_active
       from public.athletes
       where athlete_id = $1 or source_external_id = $1
       for update`,
      [TARGET.athleteId],
    );
    if (existing.rowCount > 1) {
      throw new Error(`Expected at most one athlete row with athlete_id/source_external_id ${TARGET.athleteId}; found ${existing.rowCount}.`);
    }

    let athleteId;
    if (existing.rowCount === 1) {
      assertMatchingAthlete(existing.rows[0]);
      athleteId = existing.rows[0].id;
      result.athleteAlreadyExisted = true;
    } else {
      const inserted = await client.query(
        `insert into public.athletes (
           athlete_id, source_external_id, first_name, last_name, full_name, display_name, user_id, created_by_user_id, is_active
         )
         values ($1, $1, $2, $3, $4, $5, null, $6, true)
         returning id`,
        [TARGET.athleteId, TARGET.firstName, TARGET.lastName, TARGET.fullName, TARGET.displayName, coach.rows[0].id],
      );
      athleteId = inserted.rows[0].id;
      result.athleteCreated = true;
    }
    result.athleteUuid = athleteId;

    const relationship = await client.query(
      `select is_active
       from public.user_athletes
       where user_id = $1 and athlete_id = $2 and relationship_type = 'coach'
       for update`,
      [coach.rows[0].id, athleteId],
    );
    if (relationship.rowCount === 0) {
      await client.query(
        `insert into public.user_athletes (user_id, athlete_id, relationship_type, is_active)
         values ($1, $2, 'coach', true)`,
        [coach.rows[0].id, athleteId],
      );
      result.coachRelationshipCreated = true;
    } else if (!relationship.rows[0].is_active) {
      await client.query(
        `update public.user_athletes
         set is_active = true, updated_at = now()
         where user_id = $1 and athlete_id = $2 and relationship_type = 'coach'`,
        [coach.rows[0].id, athleteId],
      );
      result.coachRelationshipReactivated = true;
    }

    const membershipsExist = await tableExists(client, "public", "athlete_memberships");
    if (membershipsExist) {
      const memberships = await client.query(
        `select count(*)::int as count
         from public.athlete_memberships
         where athlete_id = $1 and status = 'active'`,
        [athleteId],
      );
      result.activeClubTeamMemberships = memberships.rows[0].count;
      if (memberships.rows[0].count !== 0) {
        throw new Error(`Expected no active club/team memberships for local Zija athlete; found ${memberships.rows[0].count}.`);
      }
    }

    const finalAthlete = await client.query(
      `select count(*)::int as count
       from public.athletes
       where athlete_id = $1 or source_external_id = $1`,
      [TARGET.athleteId],
    );
    const finalRelation = await client.query(
      `select count(*)::int as count
       from public.user_athletes
       where user_id = $1 and athlete_id = $2 and relationship_type = 'coach' and is_active = true`,
      [coach.rows[0].id, athleteId],
    );
    result.finalCounts = {
      athleteRowsWithId131: finalAthlete.rows[0].count,
      activeCoachRelationships: finalRelation.rows[0].count,
    };
    if (result.finalCounts.athleteRowsWithId131 !== 1 || result.finalCounts.activeCoachRelationships !== 1) {
      throw new Error(`Final count validation failed: ${JSON.stringify(result.finalCounts)}`);
    }

    if (dryRun) await client.query("rollback");
    else await client.query("commit");
    result.committed = applyLocal;
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
