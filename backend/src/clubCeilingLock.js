// The per-club ceiling lock (roles R4 contract 7.6, place 0): a transaction-scoped advisory lock keyed
// (public.permission_club_lock_namespace(), hashtext(clubId)), taken by EVERY writer of roles, club versions, custom
// roles and the ceiling in that club, and by every guarded write that calls public.lock_permission_actor for a club
// or team scope - as the first statement after the Roles API's request-key lock, before any rights check or row
// lock. public.lock_permission_actor and the v92 table guards only CHECK it (55000 when it is missing).
//
// Mode: "shared" (a guarded write, a custom role write, a club role or assignment write) or "exclusive" (a ceiling
// change and every club version write). One mode per transaction: asking for the other mode later is refused by the
// database (55000), never an upgrade. Several clubs: the database takes them in club id order.
const MODES = new Set(["shared", "exclusive"]);
export const LOCK_CLUB_CEILING_SQL = "select public.lock_club_ceiling($1::uuid[], $2)";

export async function lockClubCeiling(client, clubIds, mode) {
  if (!MODES.has(mode)) throw new Error(`Unknown club lock mode: ${String(mode)}`);
  const ids = [...new Set((clubIds || []).filter(Boolean).map((id) => String(id).toLowerCase()))].sort();
  if (!ids.length) return [];
  await client.query(LOCK_CLUB_CEILING_SQL, [ids, mode]);
  return ids;
}

// The club of a club or team scope, read without a lock (a team never moves club, D43); null otherwise.
export async function clubOfScope(client, scopeType, scopeId) {
  if (scopeType === "club") return scopeId ?? null;
  if (scopeType !== "team" || !scopeId) return null;
  return (await client.query("select club_id from public.teams where id = $1", [scopeId])).rows[0]?.club_id ?? null;
}
