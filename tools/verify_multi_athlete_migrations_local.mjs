#!/usr/bin/env node
import fs from "fs";
import path from "path";
import process from "process";
import { Client, readEnvFile, safeDbLabel } from "./training_package_core.mjs";

const migrationFiles = [
  "20260818_seed_multi_athlete_01_custom_exercises.sql",
  "20260818_seed_multi_athlete_02_zija_murina.sql",
  "20260818_seed_multi_athlete_03_milos_milovic_programs.sql",
  "20260818_seed_multi_athlete_04_nikola_vujinivic_programs.sql",
  "20260818_seed_multi_athlete_05_nikola_petkovic_programs.sql",
  "20260818_seed_multi_athlete_06_zija_murina_programs.sql",
];

async function packageCounts(client) {
  const result = await client.query(`
    select
      count(distinct p.id)::int as plans,
      count(distinct pd.id)::int as days,
      count(distinct ps.id)::int as sessions,
      count(distinct pn.id) filter (where pn.node_type = 'section')::int as section_nodes,
      count(distinct pi.id) filter (where pi.item_type = 'exercise')::int as exercise_items,
      count(distinct pi.id) filter (where pi.item_type = 'note')::int as note_items,
      count(distinct pi.id) filter (where pi.item_type = 'exercise' and pi.exercise_id is null)::int as invalid_exercise_refs,
      (select coalesce(sum(ref_count - 1), 0)::int
       from (
         select source_ref, count(*)::int as ref_count
         from plans.plans
         where source_type = 'multi_athlete_cleaned_import'
         group by source_ref
         having count(*) > 1
       ) duplicates) as duplicate_source_refs
    from plans.plans p
    left join plans.plan_days pd on pd.plan_id = p.id
    left join plans.plan_sessions ps on ps.plan_day_id = pd.id
    left join plans.plan_nodes pn on pn.plan_session_id = ps.id
    left join plans.plan_items pi on pi.plan_session_id = ps.id
    where p.source_type = 'multi_athlete_cleaned_import'
  `);
  return result.rows[0];
}

async function main() {
  const databaseUrl = process.env.LOCAL_DATABASE_URL || readEnvFile(path.resolve("backend/.env")).DATABASE_URL || "";
  const label = safeDbLabel(databaseUrl);
  if (!label.appearsLocal) throw new Error("Refusing verification: database is not local.");
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const before = await packageCounts(client);
    for (const file of migrationFiles) {
      await client.query(fs.readFileSync(path.join("migrations", file), "utf8"));
    }
    const afterFirst = await packageCounts(client);
    for (const file of migrationFiles) {
      await client.query(fs.readFileSync(path.join("migrations", file), "utf8"));
    }
    const afterSecond = await packageCounts(client);
    console.log(JSON.stringify({ before, afterFirst, afterSecond, unchangedOnSecond: JSON.stringify(afterFirst) === JSON.stringify(afterSecond) }, null, 2));
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
