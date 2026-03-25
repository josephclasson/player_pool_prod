begin;

-- Public image URLs (CDN, or Supabase Storage public object URL).
-- espn_athlete_id: best-effort match to ESPN men's college basketball player id for fallback CDN URLs.
alter table public.players
  add column if not exists headshot_url text,
  add column if not exists espn_athlete_id int;

comment on column public.players.headshot_url is 'HTTPS URL to headshot (vendor CDN, Storage public URL, etc.).';
comment on column public.players.espn_athlete_id is 'Optional ESPN NCAA MBK athlete id; used to build fallback headshot URL if headshot_url is null.';

alter table public.teams
  add column if not exists logo_url text;

comment on column public.teams.logo_url is 'HTTPS URL to team logo (CDN or Storage public URL).';

commit;
