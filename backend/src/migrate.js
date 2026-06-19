import "dotenv/config";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pool } from "./db.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationPath = path.resolve(__dirname, "../../create_builder_schema.sql");

try {
  const sql = await readFile(migrationPath, "utf8");
  await pool.query(sql);
  console.log("Builder schema is ready.");
} finally {
  await pool.end();
}
