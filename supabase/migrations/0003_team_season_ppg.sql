begin;

alter table public.teams
  add column if not exists season_ppg numeric(10,2);

comment on column public.teams.season_ppg is
  'Season points-per-game average (used for Projection PPG). Separate from tournament game points.';

commit;

