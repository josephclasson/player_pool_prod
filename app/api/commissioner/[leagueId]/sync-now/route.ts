import { NextResponse } from "next/server";
import { z } from "zod";
import { createSupabaseAdminClientSafe } from "@/lib/supabase/admin";
import { resolveLeagueFromCommissionerParam } from "@/lib/commissioner/resolve-league";
import { requireLeagueOfficer } from "@/lib/commissioner/require-league-officer";
import { syncHenrygdMensD1ScoreboardToSupabase } from "@/lib/henrygd";
import { computeLeagueLeaderboardAndRoundScores } from "@/lib/scoring";
import {
  captureLeagueOriginalProjectionsIfNeeded,
  computeLeagueProjections,
  upsertLeagueProjectionChalkPreservingOriginals
} from "@/lib/projections";
import { persistLeagueLiveScoreboard } from "@/lib/scoring/persist-league-scoreboard";
import { checkChampionshipFinalForSeason } from "@/lib/ncaa-tournament-calendar";

const bodySchema = z.object({
  dateISO: z.string().optional(),
  /** Default true: do not sync NCAA First Four (henrygd round 1) into `games` / box scores. */
  excludeFirstFour: z.boolean().optional()
});

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
  const canonicalLeagueId = resolved.league.id;

  const officer = await requireLeagueOfficer(req, supabase, canonicalLeagueId);
  if (!officer.ok) {
    return NextResponse.json({ error: officer.error }, { status: officer.status });
  }

  let body: unknown = null;
  try {
    body = await req.json();
  } catch {
    body = {};
  }
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const seasonYear = resolved.league.season_year;

  const date =
    parsed.data.dateISO ? new Date(parsed.data.dateISO + "T00:00:00Z") : new Date();

  // Live scores + regional seeds only — does not change committee `overall_seed` (1–68).
  const sync = await syncHenrygdMensD1ScoreboardToSupabase({
    supabase,
    seasonYear,
    date,
    excludeFirstFour: parsed.data.excludeFirstFour !== false
  });

  const scoring = await computeLeagueLeaderboardAndRoundScores(supabase, canonicalLeagueId);
  const projections = await computeLeagueProjections(supabase, canonicalLeagueId);

  await supabase.from("scoring_snapshots").insert({
    league_id: canonicalLeagueId,
    round: scoring.currentRound,
    data: {
      currentRound: scoring.currentRound,
      lastSyncedAt: scoring.lastSyncedAt,
      partialDataWarning: scoring.partialDataWarning,
      teams: scoring.teams
    },
    is_official: true
  });

  if (projections.teams.length > 0) {
    await upsertLeagueProjectionChalkPreservingOriginals(
      supabase,
      canonicalLeagueId,
      projections.teams.map((t) => ({
        leagueTeamId: t.leagueTeamId,
        projectionChalk: t.projectionChalk
      }))
    );
  }
  try {
    await captureLeagueOriginalProjectionsIfNeeded(supabase, canonicalLeagueId);
  } catch {
    /* optional */
  }

  await persistLeagueLiveScoreboard(supabase, canonicalLeagueId);

  const championshipComplete = await checkChampionshipFinalForSeason(supabase, seasonYear);

  return NextResponse.json({
    status: "ok",
    sync,
    recompute: {
      ok: true,
      currentRound: scoring.currentRound,
      teamsUpdated: projections.teams.length
    },
    tournamentSync: {
      championshipComplete,
      dateISO: parsed.data.dateISO ?? null
    }
  });
}
