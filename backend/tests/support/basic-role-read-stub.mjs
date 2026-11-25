// Roles V-7: the role read (authz.js ROLE_PERMISSIONS_SQL) for a HAND-BUILT test schema that has no migrations, so no
// v84 / v92 role tables. Since V-7 the exercise library, the Builder and the Program Library ask can() in a club or team
// workspace (R4 section 6), and without the role tables can() fails closed (503 permissions_unavailable) for every
// account with an old role row. This stub answers only the BASIC roles of the old tables - an active `club_admin` row
// at its club, an active `team_coach` row at its team - each holding every storable word (v92 seeds the VIEW package
// into both basic roles), no custom role, no club version and no closed module. It is for suites that test something
// else (exercise mechanics, Builder copies) on a hand-built schema; a suite that tests roles uses the real migrations
// (createGpexeDisposableDb({ roleRead: true }) or support/permission-roles-world.mjs), never this.
//
// Call it AFTER the suite has set process.env.DATABASE_URL: the word list is read from permissions.js, whose import
// chain opens db.js.
export async function applyBasicRoleReadStub(client) {
  const { STORABLE_PERMISSIONS } = await import("../../src/permissions.js");
  const words = `array[${STORABLE_PERMISSIONS.map((w) => `'${w.replace(/'/g, "''")}'`).join(", ")}]::text[]`;
  await client.query(`
    create table if not exists public.permission_role_items (permission_word text);
    create table if not exists public.permission_club_role_version_items (permission_word text);
    create table if not exists public.permission_custom_role_items (permission_word text);
    create table if not exists public.club_permission_ceiling (club_id uuid, module text);
    create or replace function public.permission_club_closed_modules(p_club uuid) returns text[] as $$
      select '{}'::text[]
    $$ language sql stable;
    create or replace function public.permission_user_holdings(p_user uuid)
    returns table (scope_type text, scope_id uuid, role_id uuid, assignment_id uuid, expires_at timestamptz, club_id uuid,
                   custom_role_id uuid, words text[]) as $$
      select 'club'::text, r.club_id, null::uuid, null::uuid, null::timestamptz, r.club_id, null::uuid, ${words}
        from public.user_club_roles r where r.user_id = p_user and r.role = 'club_admin' and r.is_active = true
      union all
      select 'team'::text, r.team_id, null::uuid, null::uuid, null::timestamptz, t.club_id, null::uuid, ${words}
        from public.user_team_roles r join public.teams t on t.id = r.team_id
       where r.user_id = p_user and r.role = 'team_coach' and r.is_active = true
    $$ language sql stable;
  `);
}
