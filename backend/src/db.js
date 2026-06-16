import pg from "pg";

const { Pool } = pg;

pg.types.setTypeParser(1082, (value) => value);

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is required. Create backend/.env from .env.example.");
}

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL.includes("supabase.com")
    ? { rejectUnauthorized: false }
    : undefined,
});

export async function query(text, params = []) {
  const result = await pool.query(text, params);
  return result;
}
