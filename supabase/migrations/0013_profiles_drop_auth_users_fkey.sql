begin;

-- `profiles.id` no longer references `auth.users(id)`.
-- Rationale: commissioner flows create Auth users via the API while inserts into `public.profiles` were still
-- failing with `profiles_id_fkey` on some hosts (timing / pool / config). League rows only require a matching
-- `profiles.id`; that id should still be the same as `auth.users.id` whenever a real login exists.
-- Tradeoff: deleting an Auth user no longer CASCADE-deletes the profile row — occasional orphans; clean manually if needed.
alter table public.profiles drop constraint if exists profiles_id_fkey;

commit;
