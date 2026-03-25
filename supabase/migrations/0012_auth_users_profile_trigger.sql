begin;

-- Harden RPC: ensure RLS never blocks the insert inside SECURITY DEFINER (some hosted configs differ).
create or replace function public.pool_upsert_profile_for_auth_user(p_user_id uuid, p_display_name text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform set_config('row_security', 'off', true);

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

-- Create profiles in the SAME transaction as auth.users insert (standard Supabase pattern).
-- Eliminates races where the app inserts into public.profiles before the Auth row is visible to FK checks.
create or replace function public.handle_new_user_profile_pool()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform set_config('row_security', 'off', true);

  insert into public.profiles (id, display_name, updated_at)
  values (
    new.id,
    coalesce(
      nullif(btrim(new.raw_user_meta_data ->> 'display_name'), ''),
      nullif(split_part(coalesce(new.email, ''), '@', 1), ''),
      'Player'
    ),
    now()
  )
  on conflict (id) do update
  set
    display_name = coalesce(
      nullif(excluded.display_name, ''),
      public.profiles.display_name
    ),
    updated_at = now();

  return new;
end;
$$;

drop trigger if exists on_auth_user_created_profile_pool on auth.users;
create trigger on_auth_user_created_profile_pool
  after insert on auth.users
  for each row
  execute function public.handle_new_user_profile_pool();

comment on function public.handle_new_user_profile_pool() is
  'Player Pool: auto-create public.profiles when Auth inserts auth.users (satisfies profiles_id_fkey).';

revoke all on function public.handle_new_user_profile_pool() from public;

commit;
