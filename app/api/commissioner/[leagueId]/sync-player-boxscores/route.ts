import { NextResponse } from "next/server";
import { createSupabaseAdminClientSafe } from "@/lib/supabase/admin";
import { resolveLeagueFromCommissionerParam } from "@/lib/commissioner/resolve-league";
import { requireLeagueOfficer } from "@/lib/commissioner/require-league-officer";
import { syncPlayerBoxscoresForSeasonGamesInDb } from "@/lib/henrygd-player-boxscore-backfill";

/**
 * Fills `player_game_stats` by fetching henrygd box scores for each R1–R6 row in `games`.
 * Run after tournament-day scoreboard sync if that path left per-player stats empty.
 */
export async function POST(req: Request, { params }: { params: Promise<{ leagueId: string }> }) {
  const { leagueId } = await params;
  if (!leagueId) {
    return NextResponse.json({ error: "leagueId required" }, { status: 400 });
  }

  const supabase = createSupabaseAdminClientSafe();
  if (!supabase) {
    return NextResponse.json({ error: "Supabase not configured" }, { status: 503 });
  }

  const resolved = await resolveLeagueFromCommissionerParam(supabase, leagueId);
  if (!resolved.ok) {
    return NextResponse.json({ error: resolved.error }, { status: resolved.status });
  }

  const officer = await requireLeagueOfficer(req, supabase, resolved.league.id);
  if (!officer.ok) {
    return NextResponse.json({ error: officer.error }, { status: officer.status });
  }

  const seasonYear = resolved.league.season_year;
  const backfill = await syncPlayerBoxscoresForSeasonGamesInDb({ supabase, seasonYear });

  return NextResponse.json({
    status: "ok",
    seasonYear,
    backfill
  });
}
