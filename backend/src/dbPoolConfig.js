// How many PostgreSQL connections one server process may hold at once.
// Every server process (each Render service, and both instances of one
// service for the minute a deploy overlaps them) shares the database's own
// connection limit - on Supabase the pooler's Pool Size, 15 in session mode
// (owner, 2026-10-17: two services hit it). PG_POOL_MAX sets the size per
// process; without it the pool keeps pg's own default of 10.
export const DEFAULT_POOL_MAX = 10;

export function poolMaxFromEnv(env = process.env) {
  const raw = env.PG_POOL_MAX;
  const value = raw === undefined || raw === "" ? DEFAULT_POOL_MAX : Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 50) {
    throw new Error("PG_POOL_MAX must be an integer between 1 and 50.");
  }
  return value;
}
