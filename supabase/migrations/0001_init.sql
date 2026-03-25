-- Supabase initial schema for NCAA Player Pool
-- NOTE: This migration includes core tables + representative RLS policies.
-- Next step after first run is to refine RLS for commissioner-only writes
-- and add any remaining query-optimized constraints/indexes.

begin;

-- ========== ENUMS ==========

do $$ begin
  if not exists (select 1 from pg_type where typname = 'league_role') then
    create type public.league_role as enum ('owner', 'commissioner', 'co_commissioner', 'member', 'guest_readonly');
  end if;
  if not exists (select 1 from pg_type where typname = 'draft_status') then
    create type public.draft_status as enum ('pending', 'in_progress', 'completed');
  end if;
  if not exists (select 1 from pg_type where typname = 'scoring_state') then
    create type public.scoring_state as enum ('open', 'frozen');
  end if;
  if not exists (select 1 from pg_type where typname = 'season_mode') then
    create type public.season_mode as enum ('regular', 'test_power5');
  end if;
  if not exists (select 1 from pg_type where typname = 'badge_type') then
    create type public.badge_type as enum ('heat_check', 'best_pick', 'goat', 'clown', 'single_game_high');
  end if;
  if not exists (select 1 from pg_type where typname = 'feature_flag_scope') then
    create type public.feature_flag_scope as enum ('global', 'league');
  end if;
end $$;

-- ========== PROFILES ==========

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists profiles_display_name_idx on public.profiles (lower(display_name));

-- ========== LEAGUES ==========

create table if not exists public.leagues (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  season_year int not null,
  code text not null,
  owner_id uuid not null references public.profiles(id) on delete restrict,
  default_passcode text,
  guest_passcode text,
  test_mode season_mode not null default 'regular',
  rules_markdown text default '',
  scoring_state scoring_state not null default 'open',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (season_year, code)
);

create index if not exists leagues_code_idx on public.leagues (code);

create table if not exists public.league_members (
  id uuid primary key default gen_random_uuid(),
  league_id uuid not null references public.leagues(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  role league_role not null default 'member',
  personal_passcode text,
  is_autodraft boolean not null default false,
  created_at timestamptz not null default now(),
  unique (league_id, user_id)
);

create index if not exists league_members_league_idx on public.league_members (league_id);
create index if not exists league_members_user_idx on public.league_members (user_id);

-- ========== TEAMS / GAMES ==========

create table if not exists public.teams (
  id serial primary key,
  external_team_id text not null unique,
  name text not null,
  short_name text,
  seed int,
  region text,
  conference text,
  is_power5 boolean not null default false
);

create table if not exists public.games (
  id serial primary key,
  external_game_id text not null unique,
  round int not null,                 -- 0=First Four, 1..6=R1..R6
  start_time timestamptz not null,
  team_a_id int not null references public.teams(id),
  team_b_id int not null references public.teams(id),
  team_a_score int default 0,
  team_b_score int default 0,
  status text not null default 'scheduled', -- scheduled | live | final
  last_synced_at timestamptz,
  unique (external_game_id)
);

create index if not exists games_round_idx on public.games (round);
create index if not exists games_status_idx on public.games (status);

create table if not exists public.team_game_stats (
  id bigserial primary key,
  game_id int not null references public.games(id) on delete cascade,
  team_id int not null references public.teams(id) on delete cascade,
  points int not null default 0,
  unique (game_id, team_id)
);

create index if not exists team_game_stats_team_idx on public.team_game_stats (team_id);

-- ========== LEAGUE TEAMS / ROSTERS ==========

create table if not exists public.league_teams (
  id uuid primary key default gen_random_uuid(),
  league_id uuid not null references public.leagues(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  team_name text not null,
  draft_position int,
  created_at timestamptz not null default now(),
  unique (league_id, user_id)
);

create index if not exists league_teams_league_idx on public.league_teams (league_id);

create table if not exists public.roster_slots (
  id uuid primary key default gen_random_uuid(),
  league_team_id uuid not null references public.league_teams(id) on delete cascade,
  team_id int not null references public.teams(id),
  round_slot int not null,            -- 1..6
  pick_overall int,
  eliminated boolean not null default false,
  first_four_team boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (league_team_id, team_id),
  unique (league_team_id, round_slot)
);

create index if not exists roster_slots_team_idx on public.roster_slots (team_id);
create index if not exists roster_slots_league_team_idx on public.roster_slots (league_team_id);

-- ========== DRAFT ==========

create table if not exists public.draft_rooms (
  id uuid primary key default gen_random_uuid(),
  league_id uuid not null references public.leagues(id) on delete cascade,
  status draft_status not null default 'pending',
  total_rounds int not null default 6,
  roster_size int not null default 6,
  pick_timer_seconds int not null default 90,
  current_pick_overall int default 1,
  draft_order jsonb,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (league_id)
);

create table if not exists public.draft_picks (
  id bigserial primary key,
  draft_room_id uuid not null references public.draft_rooms(id) on delete cascade,
  league_team_id uuid not null references public.league_teams(id) on delete cascade,
  team_id int not null references public.teams(id),
  round_number int not null,
  pick_number_in_round int not null,
  pick_overall int not null,
  is_autopick boolean not null default false,
  created_at timestamptz not null default now(),
  unique (draft_room_id, pick_overall),
  unique (draft_room_id, league_team_id, team_id)
);

create index if not exists draft_picks_draft_room_idx on public.draft_picks (draft_room_id);
create index if not exists draft_picks_league_team_idx on public.draft_picks (league_team_id);

create table if not exists public.draft_queues (
  id bigserial primary key,
  draft_room_id uuid not null references public.draft_rooms(id) on delete cascade,
  league_team_id uuid not null references public.league_teams(id) on delete cascade,
  team_id int not null references public.teams(id),
  rank int not null,
  created_at timestamptz not null default now(),
  unique (draft_room_id, league_team_id, team_id),
  unique (draft_room_id, league_team_id, rank)
);

-- ========== NOTES ==========

create table if not exists public.draft_notes (
  id bigserial primary key,
  league_id uuid not null references public.leagues(id) on delete cascade,
  league_team_id uuid not null references public.league_teams(id) on delete cascade,
  notes text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ========== SCORING / PROJECTIONS ==========

create table if not exists public.scoring_snapshots (
  id bigserial primary key,
  league_id uuid not null references public.leagues(id) on delete cascade,
  round int not null,
  as_of timestamptz not null default now(),
  data jsonb not null,
  is_official boolean not null default false
);

create index if not exists scoring_snapshots_league_round_idx
  on public.scoring_snapshots (league_id, round, as_of desc);

create table if not exists public.projections (
  id bigserial primary key,
  league_id uuid not null references public.leagues(id) on delete cascade,
  league_team_id uuid not null references public.league_teams(id) on delete cascade,
  win_chance numeric(5,2),
  pool_odds_label text,
  round_outcome jsonb,
  as_of timestamptz not null default now(),
  unique (league_id, league_team_id)
);

create index if not exists projections_league_idx on public.projections (league_id);

create table if not exists public.badges (
  id bigserial primary key,
  league_id uuid not null references public.leagues(id) on delete cascade,
  league_team_id uuid not null references public.league_teams(id) on delete cascade,
  badge public.badge_type not null,
  round int,
  reason text,
  created_at timestamptz not null default now()
);

create index if not exists badges_league_team_idx on public.badges (league_id, league_team_id);

-- ========== COMMISSIONER / EXPORTS / EMAILS ==========

create table if not exists public.replacements (
  id bigserial primary key,
  league_id uuid not null references public.leagues(id) on delete cascade,
  league_team_id uuid not null references public.league_teams(id) on delete cascade,
  removed_team_id int not null references public.teams(id),
  added_team_id int not null references public.teams(id),
  approved_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now()
);

create index if not exists replacements_league_team_idx on public.replacements (league_id, league_team_id);

create table if not exists public.commissioner_actions (
  id bigserial primary key,
  league_id uuid not null references public.leagues(id) on delete cascade,
  performed_by uuid not null references public.profiles(id),
  action_type text not null,
  payload jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.feature_flags (
  id bigserial primary key,
  name text not null,
  description text,
  enabled boolean not null default false,
  scope public.feature_flag_scope not null default 'global',
  league_id uuid references public.leagues(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (name, scope, league_id)
);

create table if not exists public.exports (
  id uuid primary key default gen_random_uuid(),
  league_id uuid not null references public.leagues(id) on delete cascade,
  type text not null, -- csv | pdf_combined
  storage_path text not null,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now()
);

create table if not exists public.email_log (
  id bigserial primary key,
  league_id uuid not null references public.leagues(id) on delete cascade,
  triggered_by uuid references public.profiles(id),
  round int not null,
  subject text not null,
  recipients_count int not null default 0,
  created_at timestamptz not null default now(),
  provider_message_id text
);

-- ========== RLS ==========

alter table public.profiles enable row level security;
alter table public.leagues enable row level security;
alter table public.league_members enable row level security;
alter table public.league_teams enable row level security;
alter table public.roster_slots enable row level security;
alter table public.draft_rooms enable row level security;
alter table public.draft_picks enable row level security;
alter table public.draft_queues enable row level security;
alter table public.draft_notes enable row level security;
alter table public.scoring_snapshots enable row level security;
alter table public.projections enable row level security;
alter table public.badges enable row level security;
alter table public.replacements enable row level security;
alter table public.commissioner_actions enable row level security;
alter table public.feature_flags enable row level security;
alter table public.exports enable row level security;
alter table public.email_log enable row level security;

-- Profiles: user can read/update their own row
drop policy if exists "profiles_select_own" on public.profiles;
create policy "profiles_select_own" on public.profiles
  for select using (id = auth.uid());
drop policy if exists "profiles_update_own" on public.profiles;
create policy "profiles_update_own" on public.profiles
  for update using (id = auth.uid());

-- Leagues: members can select
drop policy if exists "leagues_select_member" on public.leagues;
create policy "leagues_select_member" on public.leagues
  for select using (
    exists (
      select 1 from public.league_members lm
      where lm.league_id = leagues.id and lm.user_id = auth.uid()
    )
  );

-- League members: allow insert/update for commissioner/owner (service role recommended)
drop policy if exists "league_members_write_commish" on public.league_members;
create policy "league_members_write_commish" on public.league_members
  for all using (exists (
    select 1 from public.leagues l
    join public.league_members lm on lm.league_id = l.id
    where l.id = league_members.league_id
      and lm.user_id = auth.uid()
      and lm.role in ('owner','commissioner','co_commissioner')
  )) with check (true);

-- Read-only visibility for league teams/roster/picks in a member league
drop policy if exists "league_teams_select_member" on public.league_teams;
create policy "league_teams_select_member" on public.league_teams
  for select using (
    exists (
      select 1 from public.league_members lm
      where lm.league_id = league_teams.league_id and lm.user_id = auth.uid()
    )
  );

drop policy if exists "draft_rooms_select_member" on public.draft_rooms;
create policy "draft_rooms_select_member" on public.draft_rooms
  for select using (
    exists (
      select 1 from public.league_members lm
      where lm.league_id = draft_rooms.league_id and lm.user_id = auth.uid()
    )
  );

commit;

