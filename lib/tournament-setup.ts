import type { SupabaseClient } from "@supabase/supabase-js";
import { syncHenrygdMensD1ScoreboardToSupabase } from "@/lib/henrygd";
import { applyHenrygdBracketOfficialSeeds } from "@/lib/henrygd-bracket-seeds";
import { populatePoolPlayersFromEspn } from "@/lib/populate-pool-espn";
import { computeLeagueLeaderboardAndRoundScores } from "@/lib/scoring";
import {
  captureLeagueOriginalProjectionsIfNeeded,
  computeLeagueProjections,
  upsertLeagueProjectionChalkPreservingOriginals
} from "@/lib/projections";
import { persistLeagueLiveScoreboard } from "@/lib/scoring/persist-league-scoreboard";

export type TournamentSetupResult = {
  sync: Awaited<ReturnType<typeof syncHenrygdMensD1ScoreboardToSupabase>>;
  seeds: Awaited<ReturnType<typeof applyHenrygdBracketOfficialSeeds>>;
  populate: Awaited<ReturnType<typeof populatePoolPlayersFromEspn>> | null;
  populateSkippedReason?: string;
  recompute: { currentRound: number; teamsUpdated: number };
};

/**
 * One-shot commissioner path: official NCAA bracket JSON (committee field + 1–68) → henrygd scoreboard
 * for that date → optional ESPN roster + season PPG import → scoring snapshot + projection upserts for this league.
 *
 * Daily scoreboard sync never writes `teams.overall_seed`; only regional `seed` (1–16) comes from live feeds.
 */
export async function runTournamentSetup(opts: {
  supabase: SupabaseClient;
  canonicalLeagueId: string;
  seasonYear: number;
  date: Date;
  populatePlayers: boolean;
  replacePlayers: boolean;
}): Promise<TournamentSetupResult> {
  const seeds = await applyHenrygdBracketOfficialSeeds({
    supabase: opts.supabase,
    seasonYear: opts.seasonYear
  });

  const sync = await syncHenrygdMensD1ScoreboardToSupabase({
    supabase: opts.supabase,
    seasonYear: opts.seasonYear,
    date: opts.date
  });

  let populate: Awaited<ReturnType<typeof populatePoolPlayersFromEspn>> | null = null;
  let populateSkippedReason: string | undefined;
  if (opts.populatePlayers) {
    try {
      populate = await populatePoolPlayersFromEspn({
        supabase: opts.supabase,
        seasonYear: opts.seasonYear,
        replace: opts.replacePlayers
      });
    } catch (e: unknown) {
      populateSkippedReason = e instanceof Error ? e.message : String(e);
    }
  }

  const scoring = await computeLeagueLeaderboardAndRoundScores(opts.supabase, opts.canonicalLeagueId);
  const projections = await computeLeagueProjections(opts.supabase, opts.canonicalLeagueId);

  await opts.supabase.from("scoring_snapshots").insert({
    league_id: opts.canonicalLeagueId,
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
      opts.supabase,
      opts.canonicalLeagueId,
      projections.teams.map((t) => ({
        leagueTeamId: t.leagueTeamId,
        projectionChalk: t.projectionChalk
      }))
    );
  }
  try {
    await captureLeagueOriginalProjectionsIfNeeded(opts.supabase, opts.canonicalLeagueId);
  } catch {
    /* optional */
  }

  await persistLeagueLiveScoreboard(opts.supabase, opts.canonicalLeagueId);

  return {
    sync,
    seeds,
    populate,
    populateSkippedReason,
    recompute: {
      currentRound: scoring.currentRound,
      teamsUpdated: projections.teams.length
    }
  };
}
