import { NextResponse } from "next/server";
import { createSupabaseAdminClientSafe } from "@/lib/supabase/admin";
import { resolveLeagueFromCommissionerParam } from "@/lib/commissioner/resolve-league";
import { requireLeagueParticipant } from "@/lib/league/require-league-participant";
import { runTournamentLiveSyncForLeague } from "@/lib/league/tournament-live-sync";
import { buildStatTrackerApiResponse } from "@/lib/stat-tracker/build-stat-tracker-response";

export const dynamic = "force-dynamic";

/**
 * Ad-hoc tournament data pull (henrygd scoreboard + player box scores) for any league participant.
 * Rate-limited per league server-side so open tabs do not hammer the feed.
 */
export async function POST(
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

  const resolved = await resolveLeagueFromCommissionerParam(supabase, leagueId);
  if (!resolved.ok) {
    return NextResponse.json({ error: resolved.error }, { status: resolved.status });
  }

  const canonicalId = resolved.league.id;
  const seasonYear = resolved.league.season_year;

  const who = await requireLeagueParticipant(req, supabase, canonicalId);
  if (!who.ok) {
    return NextResponse.json({ error: who.error }, { status: who.status });
  }

  const url = new URL(req.url);
  const force = url.searchParams.get("force") === "1";
  /** Full R1–R6 box-score sweep (heavy); default is incremental (live/scheduled + finals missing stats). */
  const full = url.searchParams.get("full") === "1";

  try {
    const syncResult = await runTournamentLiveSyncForLeague({
      supabase,
      leagueId: canonicalId,
      seasonYear,
      minIntervalMs: force ? 0 : undefined,
      boxscoresFullBackfill: full
    });
    const body = await buildStatTrackerApiResponse(supabase, canonicalId);
    return NextResponse.json({
      ...body,
      liveSync: {
        ranHenrygdSync: syncResult.ranHenrygdSync,
        syncSummary: syncResult.syncSummary,
        backfillSummary: syncResult.backfillSummary
      }
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
