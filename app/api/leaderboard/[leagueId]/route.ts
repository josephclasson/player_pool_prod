import { NextResponse } from "next/server";
import { createSupabaseAdminClientSafe } from "@/lib/supabase/admin";
import {
  buildLeaderboardApiPayload,
  enrichLeaderboardPayloadPickOverall,
  mergeLeaderboardProjectionOriginalsFromDb,
  persistLeagueLiveScoreboard,
  type LeaderboardApiPayload
} from "@/lib/scoring/persist-league-scoreboard";

function jsonWithCache(payload: unknown, noCache: boolean) {
  return NextResponse.json(payload, {
    headers: noCache
      ? { "Cache-Control": "no-store" }
      : { "Cache-Control": "private, max-age=10, stale-while-revalidate=30" }
  });
}

function buildEtag(parts: Array<string | number | null | undefined>): string {
  const raw = parts.map((p) => String(p ?? "")).join("|");
  return `W/"${Buffer.from(raw).toString("base64url")}"`;
}

function isCompletePayload(p: unknown): p is LeaderboardApiPayload {
  if (!p || typeof p !== "object") return false;
  const o = p as Record<string, unknown>;
  return (
    typeof o.currentRound === "number" &&
    typeof o.partialDataWarning === "boolean" &&
    typeof o.anyLiveGames === "boolean" &&
    typeof o.liveGamesCount === "number" &&
    Array.isArray(o.teams)
  );
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ leagueId: string }> }
) {
  const { leagueId } = await params;
  if (!leagueId) {
    return NextResponse.json({ error: "leagueId required" }, { status: 400 });
  }

  const supabase = createSupabaseAdminClientSafe();
  if (!supabase) {
    return NextResponse.json(
      {
        error: "Supabase not configured",
        missing: [
          !process.env.NEXT_PUBLIC_SUPABASE_URL ? "NEXT_PUBLIC_SUPABASE_URL" : null,
          !process.env.SUPABASE_SERVICE_ROLE_KEY ? "SUPABASE_SERVICE_ROLE_KEY" : null
        ].filter(Boolean)
      },
      { status: 503 }
    );
  }

  const url = new URL(req.url);
  const nocache =
    url.searchParams.get("nocache") === "1" || url.searchParams.get("refresh") === "1";
  const ifNoneMatch = req.headers.get("if-none-match");

  if (!nocache) {
    const { data: row, error: cacheErr } = await supabase
      .from("league_live_scoreboard")
      .select("payload, updated_at")
      .eq("league_id", leagueId)
      .maybeSingle();

    if (!cacheErr && row?.payload && isCompletePayload(row.payload)) {
      const etag = buildEtag(["leaderboard", leagueId, row.updated_at ?? ""]);
      if (ifNoneMatch && ifNoneMatch === etag) {
        return new NextResponse(null, {
          status: 304,
          headers: {
            ETag: etag,
            "Cache-Control": "private, max-age=10, stale-while-revalidate=30"
          }
        });
      }
      const payload = row.payload as LeaderboardApiPayload;
      const mergedBase: LeaderboardApiPayload = {
        ...payload,
        cacheUpdatedAt:
          typeof row.updated_at === "string" ? row.updated_at : payload.cacheUpdatedAt
      };
      const merged = await mergeLeaderboardProjectionOriginalsFromDb(supabase, leagueId, mergedBase);
      return NextResponse.json(merged, {
        headers: {
          ETag: etag,
          "Cache-Control": "private, max-age=10, stale-while-revalidate=30"
        }
      });
    }
  }

  try {
    const payload = await persistLeagueLiveScoreboard(supabase, leagueId);
    const filled = await enrichLeaderboardPayloadPickOverall(supabase, leagueId, payload);
    const etag = buildEtag(["leaderboard", leagueId, filled.cacheUpdatedAt ?? filled.lastSyncedAt ?? ""]);
    if (ifNoneMatch && ifNoneMatch === etag) {
      return new NextResponse(null, {
        status: 304,
        headers: { ETag: etag, "Cache-Control": nocache ? "no-store" : "private, max-age=10, stale-while-revalidate=30" }
      });
    }
    return NextResponse.json(filled, {
      headers: {
        ETag: etag,
        "Cache-Control": nocache ? "no-store" : "private, max-age=10, stale-while-revalidate=30"
      }
    });
  } catch {
    // e.g. migration 0008 not applied yet — still return a fresh computed payload.
    const payload = await buildLeaderboardApiPayload(supabase, leagueId);
    const filled = await enrichLeaderboardPayloadPickOverall(supabase, leagueId, payload);
    const etag = buildEtag(["leaderboard", leagueId, filled.cacheUpdatedAt ?? filled.lastSyncedAt ?? ""]);
    if (ifNoneMatch && ifNoneMatch === etag) {
      return new NextResponse(null, {
        status: 304,
        headers: { ETag: etag, "Cache-Control": nocache ? "no-store" : "private, max-age=10, stale-while-revalidate=30" }
      });
    }
    return NextResponse.json(filled, {
      headers: {
        ETag: etag,
        "Cache-Control": nocache ? "no-store" : "private, max-age=10, stale-while-revalidate=30"
      }
    });
  }
}
