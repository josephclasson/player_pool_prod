begin;

-- Extra roster fields for richer player cards/analytics.
alter table public.players
  add column if not exists jersey_number int,
  add column if not exists height text,
  add column if not exists height_inches int;

commit;

