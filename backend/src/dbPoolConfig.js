// How many PostgreSQL connections one server process may hold at once.
// Every server process (each Render service, and both instances of one
// service for the minute a deploy overlaps them) shares the database's own
// connection limit - on Supabase the pooler's Pool Size, 15 in session mode
// (owner, 2026-10-17: two services hit it). PG_POOL_MAX sets the size per
// process; without it the pool keeps pg's own default of 10.
//
// At least 3: the Builder admits floor((max - 1) / 2) group-plan writes at
// once (routes/builder.js, each holds two connections and one stays spare),
// so 1 or 2 would refuse every such write as builderBusy. Each admitted one
// more needs two more connections: 3-4 admit one, 5-6 two, 10 four.
export const DEFAULT_POOL_MAX = 10;
export const MIN_POOL_MAX = 3;
export const MAX_POOL_MAX = 50;

export function poolMaxFromEnv(env = process.env) {
  const raw = env.PG_POOL_MAX;
  if (raw === undefined || raw === "") return DEFAULT_POOL_MAX;
  // Digits only: no sign, space, exponent or hex spelling.
  const value = /^[0-9]{1,2}$/.test(raw) ? Number(raw) : NaN;
  if (!(value >= MIN_POOL_MAX && value <= MAX_POOL_MAX)) {
    throw new Error("PG_POOL_MAX must be an integer between 3 and 50.");
  }
  return value;
}
