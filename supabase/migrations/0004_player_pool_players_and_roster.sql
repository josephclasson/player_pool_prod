begin;

-- Players table: static player info + season scoring inputs.
-- Designed to be extensible later (we can add more season stats columns or a
-- normalized player_season_stats table without changing draft semantics).

create table if not exists public.players (
  id serial primary key,
  external_player_id text unique,
  team_id int not null references public.teams(id) on delete cascade,
  name text not null,
  short_name text,
  position text,
  season_year int,
  season_ppg numeric(10,2),
  season_ppg_source text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (team_id, name, season_year)
);

create index if not exists players_team_idx on public.players (team_id);
create index if not exists players_season_year_idx on public.players (season_year);

-- Player-based roster slots: each owner drafts players; elimination is driven by
-- the player's team elimination in the tournament.

create table if not exists public.player_roster_slots (
  id uuid primary key default gen_random_uuid(),
  league_team_id uuid not null references public.league_teams(id) on delete cascade,
  player_id int not null references public.players(id) on delete cascade,
  team_id int not null references public.teams(id) on delete cascade,
  round_slot int not null,
  pick_overall int,
  eliminated boolean not null default false,
  first_four_team boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (league_team_id, player_id),
  unique (league_team_id, round_slot)
);

create index if not exists player_roster_slots_team_idx on public.player_roster_slots (team_id);
create index if not exists player_roster_slots_league_team_idx on public.player_roster_slots (league_team_id);

-- Player picks stored per draft room.

create table if not exists public.player_draft_picks (
  id bigserial primary key,
  draft_room_id uuid not null references public.draft_rooms(id) on delete cascade,
  league_team_id uuid not null references public.league_teams(id) on delete cascade,
  player_id int not null references public.players(id) on delete cascade,
  team_id int not null references public.teams(id) on delete cascade,
  round_number int not null,
  pick_number_in_round int not null,
  pick_overall int not null,
  is_autopick boolean not null default false,
  created_at timestamptz not null default now(),
  unique (draft_room_id, pick_overall),
  unique (draft_room_id, league_team_id, player_id)
);

create index if not exists player_draft_picks_draft_room_idx on public.player_draft_picks (draft_room_id);
create index if not exists player_draft_picks_league_team_idx on public.player_draft_picks (league_team_id);

-- Enable RLS (service-role admin endpoints bypass, but keeps the schema consistent).

alter table public.players enable row level security;
alter table public.player_roster_slots enable row level security;
alter table public.player_draft_picks enable row level security;

commit;

