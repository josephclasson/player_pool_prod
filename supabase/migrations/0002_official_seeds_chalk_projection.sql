-- Official committee S-curve order (1 = best) for chalk projections and draft filters.
-- Regional `seed` (1–16) from scoreboard feeds stays separate.

begin;

alter table public.teams
  add column if not exists overall_seed int check (overall_seed is null or (overall_seed >= 1 and overall_seed <= 68)),
  add column if not exists seed_source text,
  add column if not exists seeds_updated_at timestamptz;

create index if not exists teams_overall_seed_idx on public.teams (overall_seed);

comment on column public.teams.overall_seed is 'NCAA committee 1–68 S-curve order; source of truth for chalk favorites (not bracket UI alone).';
comment on column public.teams.seed is 'Regional pod seed (1–16) from feed (e.g. henrygd); not the same as overall_seed.';

alter table public.projections
  add column if not exists projection_chalk numeric(12, 2);

comment on column public.projections.projection_chalk is 'Chalk projection: sum over roster of PPG × expected tournament games remaining if 1–68 favorites win.';

commit;
