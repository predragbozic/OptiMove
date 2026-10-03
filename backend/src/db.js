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

// An idle pooled client, or one destroyed while a late socket error is still
// on its way, reports that error on the pool. Without a listener the emit
// would be an uncaught exception and take the whole server down (found in the
// F3c2d security review). Only the code is logged, never the message.
pool.on("error", (error) => {
  console.error(`[db] idle client error: ${error?.code ?? ""}`);
});

export async function query(text, params = []) {
  const result = await pool.query(text, params);
  return result;
}
