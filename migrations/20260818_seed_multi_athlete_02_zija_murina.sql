-- Ensure Zija Murina athlete 131 and Predrag private coach relationship exist.
-- Generated for multi-athlete package prerequisites. Do not run manually outside the deploy migration runner.

begin;

create extension if not exists pgcrypto;

do $$
declare
  v_owner_email constant text := 'predrag.bozic@rzsport.gov.rs';
  v_owner_id uuid;
  v_athlete_id uuid;
  v_count integer;
begin
  select id into v_owner_id from public.users where lower(email) = lower(v_owner_email) and coalesce(is_active, true) limit 2;
  if v_owner_id is null or (select count(*) from public.users where lower(email) = lower(v_owner_email) and coalesce(is_active, true)) <> 1 then
    raise exception 'Zija Murina seed: expected exactly one active owner user %', v_owner_email;
  end if;

  select count(*) into v_count from public.athletes where athlete_id = '131' or source_external_id = '131';
  if v_count > 1 then
    raise exception 'Zija Murina seed: expected at most one athlete row with athlete_id/source_external_id 131, found %', v_count;
  end if;

  if v_count = 0 then
    insert into public.athletes (athlete_id, source_external_id, first_name, last_name, full_name, display_name, image_url, user_id, club_id, team_id, is_active)
    values ('131', '131', 'Zija', 'Murina', 'Zija Murina', 'Zija Murina', null, null, null, null, true)
    returning id into v_athlete_id;
  else
    select id into v_athlete_id from public.athletes where athlete_id = '131' or source_external_id = '131' for update;
    if not exists (
      select 1 from public.athletes
      where id = v_athlete_id and coalesce(is_active, true)
        and coalesce(first_name, split_part(coalesce(display_name, full_name, ''), ' ', 1), '') = 'Zija'
        and coalesce(last_name, regexp_replace(coalesce(display_name, full_name, ''), '^\S+\s*', ''), '') = 'Murina'
    ) then
      raise exception 'Zija Murina seed: existing athlete 131 does not represent Zija Murina';
    end if;
  end if;

  insert into public.user_athletes (user_id, athlete_id, relationship_type, is_active)
  values (v_owner_id, v_athlete_id, 'coach', true)
  on conflict (user_id, athlete_id, relationship_type) do update set is_active = true, updated_at = now();
end $$;

commit;
