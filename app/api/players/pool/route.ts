import { NextResponse } from "next/server";
import { z } from "zod";
import { createSupabaseAdminClientSafe } from "@/lib/supabase/admin";
import { buildPlayerPoolRecordsForLeague } from "@/lib/players-pool-for-league";

const querySchema = z.object({
  seasonYear: z.coerce.number().int().min(2000).max(3000),
  q: z.string().max(80).optional(),
  /** Large default so all ~68-team pools appear (was 500; alphabetical cut hid whole teams). */
  limit: z.coerce.number().int().min(1).max(8000).optional(),
  /** When set, each player includes `ownerTeamName` (roster/draft) or null → show "Undrafted" in UI. */
  leagueId: z.preprocess(
    (v) => (v === "" || v === null || v === undefined ? undefined : v),
    z.string().uuid().optional()
  )
});

function buildEtag(parts: Array<string | number | null | undefined>): string {
  const raw = parts.map((p) => String(p ?? "")).join("|");
  return `W/"${Buffer.from(raw).toString("base64url")}"`;
}

/**
 * Read-only player pool for a tournament season (teams + seeds + PPG).
 * Used by the Players tab to verify commissioner data loads.
 */
export async function GET(req: Request) {
  const supabase = createSupabaseAdminClientSafe();
  if (!supabase) {
    return NextResponse.json({ error: "Supabase not configured" }, { status: 503 });
  }

  const url = new URL(req.url);
  const noCache =
    url.searchParams.get("nocache") === "1" ||
    url.searchParams.get("refresh") === "1";
  const parsed = querySchema.safeParse(Object.fromEntries(url.searchParams.entries()));
  if (!parsed.success) {
    const msg = parsed.error.issues
      .map((i) => `${i.path.length ? i.path.join(".") : "query"}: ${i.message}`)
      .join("; ");
    return NextResponse.json({ error: msg || "Invalid query parameters" }, { status: 400 });
  }

  const { seasonYear, q, limit, leagueId } = parsed.data;
  const take = limit ?? 4000;
  const ifNoneMatch = req.headers.get("if-none-match");

  const seasonStartIso = `${seasonYear}-01-01T00:00:00.000Z`;
  const seasonEndIso = `${seasonYear + 1}-01-01T00:00:00.000Z`;
  const { data: latestGame } = await supabase
    .from("games")
    .select("last_synced_at")
    .gte("start_time", seasonStartIso)
    .lt("start_time", seasonEndIso)
    .not("last_synced_at", "is", null)
    .order("last_synced_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const lastSyncedAt =
    typeof (latestGame as { last_synced_at?: unknown } | null)?.last_synced_at === "string"
      ? String((latestGame as { last_synced_at: string }).last_synced_at)
      : null;
  const { data: latestPlayerStatsRow } = await supabase
    .from("player_game_stats")
    .select("updated_at, games!inner(start_time)")
    .gte("games.start_time", seasonStartIso)
    .lt("games.start_time", seasonEndIso)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const playerStatsUpdatedAt =
    typeof (latestPlayerStatsRow as { updated_at?: unknown } | null)?.updated_at === "string"
      ? String((latestPlayerStatsRow as { updated_at: string }).updated_at)
      : null;
  const etag = buildEtag([
    "players-pool",
    seasonYear,
    q?.trim() ?? "",
    take,
    leagueId ?? "",
    lastSyncedAt ?? "",
    playerStatsUpdatedAt ?? ""
  ]);
  if (ifNoneMatch && ifNoneMatch === etag) {
    return new NextResponse(null, {
      status: 304,
      headers: {
        ETag: etag,
        "Cache-Control": noCache ? "no-store" : "private, max-age=10, stale-while-revalidate=30"
      }
    });
  }

  let built;
  try {
    built = await buildPlayerPoolRecordsForLeague(supabase, {
      seasonYear,
      leagueId: leagueId ?? null,
      limit: take,
      searchQuery: q ?? null
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Pool query failed";
    return NextResponse.json({ error: msg }, { status: 500 });
  }

  const players = built.players;

  return NextResponse.json(
    {
      seasonYear,
      count: players.length,
      limit: take,
      leagueId: leagueId ?? null,
      lastSyncedAt,
      hasLiveGames: built.hasLiveGames,
      players
    },
    {
      headers: noCache
        ? { "Cache-Control": "no-store", ETag: etag }
        : { "Cache-Control": "private, max-age=10, stale-while-revalidate=30", ETag: etag }
    }
  );
}
