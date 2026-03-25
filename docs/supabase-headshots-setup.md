# Supabase: player headshots (and team logos)

This app stores **headshot URLs** and an optional **ESPN athlete id** on `public.players`, and **logo URLs** on `public.teams`.

Repeat storage and SQL steps on each hosted project you use: **`player_pool_dev`** (local dev) and **`player_pool_prod`** (production), unless you only need assets in one environment.

## 1. Apply the migration

From the project root (with [Supabase CLI](https://supabase.com/docs/guides/cli) linked to **player_pool_dev** or **player_pool_prod**, depending on which database you are updating):

```bash
supabase db push
```

Or run the SQL in the Supabase dashboard → **SQL Editor** → paste contents of:

`supabase/migrations/0007_player_headshot_team_logo.sql`

New columns:

| Table    | Column             | Purpose |
|----------|--------------------|---------|
| `players` | `headshot_url`     | Full `https://...` to the image (CDN or Storage). |
| `players` | `espn_athlete_id`  | Integer used to build ESPN CDN fallback if `headshot_url` is empty. |
| `teams`   | `logo_url`         | Full `https://...` to team logo. |

## 2. Automatic fill (recommended first step)

If you use **ESPN** roster populate:

- Call **`POST /api/commissioner/[leagueId]/players/populate-cbb`** (legacy path name; no API key).

That route sets:

- `espn_athlete_id` from the ESPN roster athlete id.
- `headshot_url` from ESPN’s roster headshot URL when present (best-effort; some URLs may 404 — UI falls back to a placeholder).

Re-run populate after schema migration so rows get the new fields.

## 3. Manual / correction in SQL

Override a broken CDN link with your own URL:

```sql
update public.players
set headshot_url = 'https://your-cdn.com/players/cooper-flagg.png',
    espn_athlete_id = null
where external_player_id = '2026:espn:...';
```

Clear stored URL and rely only on ESPN id:

```sql
update public.players
set headshot_url = null,
    espn_athlete_id = 5041939
where id = 123;
```

Team logos:

```sql
update public.teams
set logo_url = 'https://a.espncdn.com/i/teamlogos/ncaa/500/150.png'
where short_name = 'Duke';
```

## 4. Optional: Supabase Storage

Use this if you host images yourself (licensed assets, cropped files, etc.).

1. Dashboard → **Storage** → **New bucket**  
   - Name: `player-headshots` (example)  
   - **Public bucket** if the app loads images without auth.

2. **Policies** (SQL example for public read):

```sql
-- Allow anonymous read of public headshots
create policy "Public read player headshots"
on storage.objects for select
to public
using (bucket_id = 'player-headshots');
```

3. Upload files, e.g. `players/12345.jpg`.

4. Public URL format:

   `https://<PROJECT_REF>.supabase.co/storage/v1/object/public/player-headshots/players/12345.jpg`

5. Save that URL in `players.headshot_url` (via SQL, script, or a future admin UI).

**Service role** uploads (server-side) bypass RLS; use `SUPABASE_SERVICE_ROLE_KEY` only on the server.

## 5. App code

- Resolve display URL: `resolvePlayerHeadshotUrl()` in `lib/player-media.ts`.
- Draft pool API returns `headshot_url` and `espn_athlete_id` on each player for client UIs.
- Stat Tracker dummy page still uses local/demo URLs until you wire it to this API + DB.

## 6. Env vars (unchanged)

You already need:

- `NEXT_PUBLIC_SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY` (server)

No extra env vars are required for ESPN CDN URLs. Storage uploads may use the same service role on the server.

## 7. RLS note

`players` already has RLS enabled. Your app mostly uses the **service role** in API routes (bypasses RLS). If you add a **browser Supabase client** to read `players`, add a `SELECT` policy for league members or `authenticated` as needed.
