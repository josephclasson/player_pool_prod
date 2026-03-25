begin;

-- Upserts public.profiles for a row that must already exist in auth.users (FK profiles_id_fkey).
-- Called from the Next API with the service role so commissioner create-league does not depend on PostgREST
-- timing quirks between GoTrue and public.profiles.
create or replace function public.pool_upsert_profile_for_auth_user(p_user_id uuid, p_display_name text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (select 1 from auth.users au where au.id = p_user_id) then
    raise exception 'AUTH_USER_MISSING_FOR_PROFILE %', p_user_id
      using hint = 'No row in auth.users for this id; create-league cannot insert profiles yet.';
  end if;

  insert into public.profiles (id, display_name, updated_at)
  values (
    p_user_id,
    nullif(btrim(p_display_name), ''),
    now()
  )
  on conflict (id) do update
  set
    display_name = coalesce(
      nullif(excluded.display_name, ''),
      public.profiles.display_name
    ),
    updated_at = now();
end;
$$;

comment on function public.pool_upsert_profile_for_auth_user(uuid, text) is
  'Server-only: upsert profiles row when auth.users has p_user_id (create league / commissioner flows).';

revoke all on function public.pool_upsert_profile_for_auth_user(uuid, text) from public;
grant execute on function public.pool_upsert_profile_for_auth_user(uuid, text) to service_role;

commit;
