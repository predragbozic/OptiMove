import "dotenv/config";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pool } from "./db.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationPaths = [
  path.resolve(__dirname, "../../create_access_schema.sql"),
  path.resolve(__dirname, "../../create_builder_schema.sql"),
  path.resolve(__dirname, "../../create_exercise_user_state.sql"),
  path.resolve(__dirname, "../../create_coach_profiles_schema.sql"),
  path.resolve(__dirname, "../../create_plan_read_views.sql"),
];

try {
  for (const migrationPath of migrationPaths) {
    const sql = await readFile(migrationPath, "utf8");
    await pool.query(sql);
  }
  console.log("Builder schema is ready.");
} finally {
  await pool.end();
}
