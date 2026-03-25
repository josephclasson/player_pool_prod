# NCAA men’s basketball: team logos & player photos

We want **databallr-style** rows: **team logo** + **headshot** left of the player name.

**Supabase columns + migration + Storage:** see [`supabase-headshots-setup.md`](./supabase-headshots-setup.md).

## What we use today (dev / MVP)

| Source | Use | Pros | Cons |
|--------|-----|------|------|
| **ESPN CDN** (`a.espncdn.com`) | Team `…/teamlogos/ncaa/500/{teamId}.png`, player `…/headshots/mens-college-basketball/players/full/{athleteId}.png` | No key, matches what many fans expect, easy to test | **Unofficial**; IDs/URLs can change; ToS unclear; no SLA |

Helpers live in `lib/espn-ncaam-assets.ts`. Always use **lazy loading**, **onError fallback**, and plan to **cache** images or store final URLs in your DB after validation.

## Strongest licensed options (production)

### 1. **Sportradar** (closest to “pro” datasets)

- **NCAA Images API** + **College Pressbox** partnership: large libraries of **player headshots** (multiple crops, some transparent PNG), mapped to Sportradar player/team IDs.
- Requires a **commercial agreement**; not a self-serve free tier.
- Changelog reference: [Sportradar Images API – NCAA headshot enhancements](https://developer.sportradar.com/sportradar-updates/changelog/images-api-ncaa-headshot-enhancements).

**Best when:** you need rights-cleared, consistent IDs across stats + images and can pay for data.

### 2. **SportsDataIO** (NCAA basketball API)

- Broad **NCAA basketball** stats/rosters; check their current schema for **image URL** fields on players/teams.
- Paid tiers; good if you already standardize on them for box scores and rosters.

**Best when:** you want one vendor for **stats + optional media** fields.

### 3. **STATS Perform / other league data partners**

- Similar to Sportradar: **enterprise** deals, stable IDs, legal clarity.

---

## Team logos (often easier than headshots)

- **ESPN-style logos** via public CDNs are common in hobby projects but are **not a contract**.
- Licensed feeds (Sportradar, SportsDataIO, etc.) often include **team logo URLs** or asset IDs.
- **Wikipedia / Wikimedia** logos exist but **licensing varies per logo**—not a blanket solution for a commercial app.

## Recommendation

1. **Now:** Keep ESPN CDN URLs behind a small resolver + **fallback UI**, and store `espnTeamId` / `espnAthleteId` (or final `logoUrl` / `headshotUrl`) per player in **your DB** when you ingest rosters.
2. **Ship:** Move to **Sportradar** or **SportsDataIO** (or your stats provider) for **rights-cleared** image URLs tied to the same player/team IDs you use for scoring.

## Databallr

Their site almost certainly uses a **commercial sports data + images** pipeline (or in-house licensing), not only public CDNs. Matching their *look* is fine; matching their *licensing* means using a proper provider.
