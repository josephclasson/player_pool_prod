begin;

-- Box-score points by individual player per game.
-- Used for exact elimination-pool scoring and round-by-round breakdown.

create table if not exists public.player_game_stats (
  id bigserial primary key,
  game_id int not null references public.games(id) on delete cascade,
  player_id int not null references public.players(id) on delete cascade,
  points int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (game_id, player_id)
);

create index if not exists player_game_stats_game_idx on public.player_game_stats (game_id);
create index if not exists player_game_stats_player_idx on public.player_game_stats (player_id);

alter table public.player_game_stats enable row level security;

commit;

