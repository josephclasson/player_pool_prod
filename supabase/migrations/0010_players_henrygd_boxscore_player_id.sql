begin;

-- henrygd game boxscore `playerStats[].id` — stable per player within NCAA feed.
-- Populated on scoreboard sync when we merge box scores onto CBB-populated pool rows.
alter table public.players
  add column if not exists henrygd_boxscore_player_id text;

comment on column public.players.henrygd_boxscore_player_id is
  'henrygd NCAA box score player id (teamBoxscore.playerStats[].id). Links CBB `external_player_id` rows to henrygd stats.';

-- At most one pool row per team/season may claim a given henrygd id.
create unique index if not exists players_team_season_henrygd_boxscore_uidx
  on public.players (team_id, season_year, henrygd_boxscore_player_id)
  where henrygd_boxscore_player_id is not null and season_year is not null;

-- Backfill from legacy henrygd-style external_player_id: `{year}:{seoname}:{henrygdId}` (not `:cbbd:`).
update public.players p
set henrygd_boxscore_player_id = split_part(p.external_player_id, ':', 3)
where p.henrygd_boxscore_player_id is null
  and p.external_player_id is not null
  and (length(p.external_player_id) - length(replace(p.external_player_id, ':', ''))) = 2
  and split_part(p.external_player_id, ':', 2) <> 'cbbd';

commit;
