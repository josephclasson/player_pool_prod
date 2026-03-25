# Unified pool experience (#7)

The reference “March Madness Draft” product keeps **draft**, **live state**, and **scores** in **one continuous session**: same league context, same navigation, and data that updates together so owners never wonder which tab is “the source of truth.”

## What that means for this app

1. **Stable league context**  
   Use a single `leagueId` (UUID) across Draft, Leaderboard, Scores, and Bracket—e.g. `?leagueId=…` or the league id saved from the top bar.

2. **Cross-links**  
   From Draft, deep-link to **Leaderboard**, **Scores**, and **Commissioner** with the same `leagueId` so users don’t re-enter IDs.

3. **Aligned data**  
   **Scores** (player grid) uses the same **chalk “Exp Pts”** model as the draft board ordering (`season PPG × expected chalk games`). **Leaderboard** aggregates **live/final box scores** from sync + roster slots. After a **Sync games** or **pick**, the cached `league_live_scoreboard` row updates so **Realtime** can push leaderboard-style updates to clients.

4. **One mental model**  
   Commissioners run **Sync** / **recompute** once; owners see **Scores** (who’s left + expectations) and **Leaderboard** (what’s actually scored) without switching products.

## Roles (commissioner / co-commissioner)

`league_members.role` already supports `commissioner` and `co_commissioner`. Commissioner **API** routes require either:

- A valid **Supabase access token** (`Authorization: Bearer …`) for a user with one of those roles (or `owner`), or  
- `COMMISSIONER_API_SECRET` + header `x-player-pool-commissioner-secret`, or  
- `ALLOW_COMMISSIONER_ROUTES_WITHOUT_AUTH=true` for local dev only.

Assign roles in Supabase Table Editor on `league_members` for the right `user_id` + `league_id`.
