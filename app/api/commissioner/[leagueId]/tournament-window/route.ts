import { NextResponse } from "next/server";
import { createSupabaseAdminClientSafe } from "@/lib/supabase/admin";
import { resolveLeagueFromCommissionerParam } from "@/lib/commissioner/resolve-league";
import { requireLeagueOfficer } from "@/lib/commissioner/require-league-officer";
import {
  checkChampionshipFinalForSeason,
  firstRoundThursdayISOForSeason,
  TOURNAMENT_SYNC_MAX_CALENDAR_DAYS,
  utcDateISOsFromStart
} from "@/lib/ncaa-tournament-calendar";

export const runtime = "nodejs";

export async function GET(req: Request, { params }: { params: Promise<{ leagueId: string }> }) {
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

  const resolved = await resolveLeagueFromCommissionerParam(supabase, leagueId);
  if (!resolved.ok) {
    return NextResponse.json({ error: resolved.error }, { status: resolved.status });
  }
  const canonicalLeagueId = resolved.league.id;
  const seasonYear = resolved.league.season_year;

  const officer = await requireLeagueOfficer(req, supabase, canonicalLeagueId);
  if (!officer.ok) {
    return NextResponse.json({ error: officer.error }, { status: officer.status });
  }

  const firstRoundThursday = firstRoundThursdayISOForSeason(seasonYear);
  const championshipComplete = await checkChampionshipFinalForSeason(supabase, seasonYear);
  const dateISOs =
    firstRoundThursday ?
      utcDateISOsFromStart(firstRoundThursday, TOURNAMENT_SYNC_MAX_CALENDAR_DAYS)
    : [];

  return NextResponse.json({
    status: "ok" as const,
    seasonYear,
    firstRoundThursday,
    maxCalendarDays: TOURNAMENT_SYNC_MAX_CALENDAR_DAYS,
    dateISOs,
    championshipComplete,
    envHint:
      firstRoundThursday == null ?
        `Set TOURNAMENT_FIRST_ROUND_THURSDAY_${seasonYear}=YYYY-MM-DD (First Round Thursday) or add the year to lib/ncaa-tournament-calendar.ts.`
      : null
  });
}
