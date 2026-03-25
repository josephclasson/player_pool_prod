import { NextResponse } from "next/server";
import { z } from "zod";
import { createSupabaseAdminClientSafe } from "@/lib/supabase/admin";
import { resolveLeagueFromCommissionerParam } from "@/lib/commissioner/resolve-league";
import { requireLeagueOfficer } from "@/lib/commissioner/require-league-officer";
import { computeLeagueLeaderboardAndRoundScores } from "@/lib/scoring";
import {
  captureLeagueOriginalProjectionsIfNeeded,
  computeLeagueProjections,
  upsertLeagueProjectionChalkPreservingOriginals
} from "@/lib/projections";
import { persistLeagueLiveScoreboard } from "@/lib/scoring/persist-league-scoreboard";

const bodySchema = z.object({
  reason: z.string().optional()
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

  const resolved = await resolveLeagueFromCommissionerParam(supabase, leagueId);
  if (!resolved.ok) {
    return NextResponse.json({ error: resolved.error }, { status: resolved.status });
  }
  const canonicalLeagueId = resolved.league.id;

  const officer = await requireLeagueOfficer(req, supabase, canonicalLeagueId);
  if (!officer.ok) {
    return NextResponse.json({ error: officer.error }, { status: officer.status });
  }

  const scoring = await computeLeagueLeaderboardAndRoundScores(supabase, canonicalLeagueId);
  const projections = await computeLeagueProjections(supabase, canonicalLeagueId);

  // Persist a scoring snapshot for the current round bucket.
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

  // In production you’d also recompute badges and store badge rows.

  return NextResponse.json({
    status: "ok",
    reason: parsed.data.reason ?? "manual_recompute",
    teamsUpdated: projections.teams.length,
    currentRound: scoring.currentRound
  });
}

