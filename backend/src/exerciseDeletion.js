const metadataTables = new Set([
  "exercise_tags", "exercise_domains", "exercise_categories", "exercise_sections",
  "exercise_body_parts", "exercise_movement_patterns", "exercise_favorites",
  "exercise_personal_tags", "exercise_classifications",
]);

function identifier(value) {
  return `"${value.replaceAll('"', '""')}"`;
}

export async function deleteUnreferencedExercise(client, exerciseId) {
  const dependencies = await client.query(`select namespace.nspname as schema_name,relation.relname as table_name,
    attribute.attname as column_name,referenced.attname as referenced_column,
    cardinality(constraint_row.conkey) as column_count
    from pg_constraint constraint_row join pg_class relation on relation.oid=constraint_row.conrelid
    join pg_namespace namespace on namespace.oid=relation.relnamespace
    join pg_attribute attribute on attribute.attrelid=relation.oid and attribute.attnum=constraint_row.conkey[1]
    join pg_attribute referenced on referenced.attrelid=constraint_row.confrelid and referenced.attnum=constraint_row.confkey[1]
    where constraint_row.contype='f' and constraint_row.confrelid='library.exercises'::regclass`);
  const metadata = new Set();
  for (const dependency of dependencies.rows) {
    if (dependency.column_count !== 1 || dependency.referenced_column !== "id") {
      return { deleted: false, reason: "Unsupported exercise dependency. Archive this exercise instead." };
    }
    const table = `${identifier(dependency.schema_name)}.${identifier(dependency.table_name)}`;
    if (dependency.schema_name === "library" && metadataTables.has(dependency.table_name) && dependency.column_name === "exercise_id") {
      metadata.add(table);
      continue;
    }
    const used = await client.query(`select 1 from ${table} where ${identifier(dependency.column_name)}=$1 limit 1`, [exerciseId]);
    if (used.rowCount) return { deleted: false, reason: "This exercise is referenced by a program, activity, collection or another copy. Archive it instead." };
  }
  for (const table of metadata) await client.query(`delete from ${table} where exercise_id=$1`, [exerciseId]);
  await client.query("delete from library.filter_hidden where kind='exercise' and item_id=$1", [exerciseId]);
  await client.query("delete from library.exercises where id=$1", [exerciseId]);
  return { deleted: true };
}
