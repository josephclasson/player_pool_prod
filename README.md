## Player Pool

Premium dark UI for a Men’s NCAA Tournament player pool: draft, **Scores** (Exp Pts / availability), live **Leaderboard**, commissioner sync, and Supabase-backed data.

### Supabase: `player_pool_dev` and `player_pool_prod`

Use two hosted projects:

| Project | Purpose |
|--------|---------|
| **player_pool_dev** | Local development (`npm run dev`). Keys go in **`.env.development.local`** (or `.env.local`). |
| **player_pool_prod** | Production site and real users. Set the same variables on your host (e.g. Vercel). For a local production build, use **`.env.production.local`**. |

The Supabase CLI **`supabase link`** targets one project at a time for this repo folder. Use the project’s **reference id** (Dashboard → **Project Settings** → **General**), not the display name. To push migrations to dev, link **player_pool_dev**’s ref, run **`npm run supabase -- db push`**, then link **player_pool_prod**’s ref and push again when you promote schema changes—or use a second checkout if you want both links handy without re-linking.

On Windows, install the CLI via **`npm install`** in this repo (it is a dev dependency), then use **`npm run supabase -- <command>`** (for example `npm run supabase -- login`). Alternatively install the CLI globally with [Scoop](https://supabase.com/docs/guides/cli/getting-started).

Helper scripts (after `npm install` and `npm run supabase -- login`):

- **`npm run instance:dev`** — scaffold `.env.development.local`, link + push to the ref you pass (intended for **player_pool_dev**).
- **`npm run instance:prod`** — scaffold `.env.production.local`, link + push to the ref you pass (intended for **player_pool_prod**).

Configure **Authentication → URL Configuration → Redirect URLs** separately on each project (localhost URLs on dev; your real domain on prod).

### Run locally

1. Copy `env.example` → **`.env.development.local`** (recommended) or `.env.local`, using API keys from Supabase project **player_pool_dev** (`NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`).
2. Apply migrations in `supabase/migrations/` to **player_pool_dev** (e.g. `npm run instance:dev` with that project’s ref, or run SQL from the dashboard).
3. `npm install` then `npm run dev` → [http://localhost:3000](http://localhost:3000)

### Live scoring

- **Leaderboard** reads a cached row in `league_live_scoreboard` when present (fast), or computes on the fly.
- After **Sync games**, **recompute**, **Apply seeds from CBS/SI article**, **player ingest/populate**, **draft pick**, or **draft room ensure**, the cache is refreshed so **Supabase Realtime** can push updates to signed-in league members.
- **Polling** speeds up to **~5s** when games are `live`, otherwise **~30s** (Leaderboard, Scores, Bracket).
- For Realtime in the browser you need **`NEXT_PUBLIC_SUPABASE_ANON_KEY`** and a user signed in as a **league member** (RLS allows `select` on `league_live_scoreboard`).

### Commissioner auth

Commissioner POST routes require one of:

- `ALLOW_COMMISSIONER_ROUTES_WITHOUT_AUTH=true` (local only), or  
- Header `x-player-pool-commissioner-secret` matching `COMMISSIONER_API_SECRET`, or  
- `Authorization: Bearer <supabase_access_token>` for a user whose `league_members.role` is `owner`, `commissioner`, or `co_commissioner`.

Use the **Commissioner Tools** auth fields to store token/secret in `sessionStorage`.

**Create league** (`POST /api/commissioner/leagues/create`): `profiles.id` references `auth.users`. With a valid commissioner password (or local dev bypass), the API **creates or reuses** a dedicated Auth user automatically — you do **not** need any users in the project first. Production uses **`pool-league-owner@player-pool.internal`** by default (override with **`COMMISSIONER_LEAGUE_OWNER_EMAIL`**). To record **your** account as `owner_id` instead, set **`COMMISSIONER_LEAGUE_OWNER_USER_ID`** to that user’s UUID. Local dev bypass uses **`dev-league-actor@player-pool.local`** when the UUID env var is unset.

**`profiles_id_fkey` / create league:** apply migration **`0013_profiles_drop_auth_users_fkey.sql`** (included in `supabase db push`). It removes the foreign key from `public.profiles.id` to `auth.users` so commissioner flows can upsert a profile row without Postgres blocking on Auth visibility. Keep using real Auth user ids for owners so sign-in still lines up.

### Auth routes (Supabase + PKCE)

- **`/auth/confirm`** is a **server route** (`@supabase/ssr`): exchanges magic-link `?code=` or runs **`verifyOtp`** using **cookies** (PKCE verifier is stored via `createBrowserClient`, not only `localStorage`). Commissioner “Email link” uses `?next=/commissioner`. Add **`/auth/confirm`** to Supabase **Redirect URLs**.
- Requires **`npm install`** so **`@supabase/ssr`** is present.
- **Yahoo / Gmail in-app browsers** often don’t share cookies with Chrome/Safari — use **“Open in browser”** or the **Password** tab if the link still fails.
- **`/join`** — owner invites. If you still see **PKCE** errors, prefer Supabase settings that return tokens in the **URL hash** for email, or open the invite in the same browser profile that matches your app.

### Owner invites (email + PIN)

- Commissioner Tools → **Send owner invites (email)** posts `{ owners: [{ fullName, username, email }] }` to the API; Supabase emails a magic link to **`/join`**, where the owner sets a **6-digit PIN** (`updateUser({ password })`).
- Set **`NEXT_PUBLIC_SITE_URL`** for production redirect targets on **player_pool_prod**; add **`/join`** and **`/auth/confirm`** to that project’s **Redirect URLs** (and matching localhost URLs on **player_pool_dev** for local testing). Ensure **minimum password length** in the Email provider is ≤ 6 so PINs are accepted (6 is often the default).

### Docs

- `docs/unified-pool-experience.md` — draft + scores + leaderboard in one session (`leagueId`).
