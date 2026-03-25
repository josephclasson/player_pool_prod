begin;

-- Cached leaderboard JSON per league: updated whenever scores/projections change.
-- Enables fast GET /api/leaderboard reads + Supabase Realtime push to clients (RLS: members read).

create table if not exists public.league_live_scoreboard (
  league_id uuid primary key references public.leagues (id) on delete cascade,
  payload jsonb not null,
  updated_at timestamptz not null default now()
);

create index if not exists league_live_scoreboard_updated_at_idx
  on public.league_live_scoreboard (updated_at desc);

alter table public.league_live_scoreboard enable row level security;

drop policy if exists "league_live_scoreboard_select_member" on public.league_live_scoreboard;
create policy "league_live_scoreboard_select_member" on public.league_live_scoreboard
  for select using (
    exists (
      select 1 from public.league_members lm
      where lm.league_id = league_live_scoreboard.league_id
        and lm.user_id = auth.uid()
    )
  );

-- Service role bypasses RLS for upserts from API routes.

-- Supabase Realtime (hosted). Ignore errors on fresh/local DBs without this publication.
do $$
begin
  alter publication supabase_realtime add table public.league_live_scoreboard;
exception
  when undefined_object then
    null;
  when duplicate_object then
    null;
end $$;

commit;
