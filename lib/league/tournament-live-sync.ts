import type { SupabaseClient } from "@supabase/supabase-js";
import { syncHenrygdMensD1ScoreboardToSupabase } from "@/lib/henrygd";
import { syncPlayerBoxscoresForSeasonGamesInDb } from "@/lib/henrygd-player-boxscore-backfill";
import {
  captureLeagueOriginalProjectionsIfNeeded,
  computeLeagueProjections,
  upsertLeagueProjectionChalkPreservingOriginals
} from "@/lib/projections";
import { persistLeagueLiveScoreboard } from "@/lib/scoring/persist-league-scoreboard";

const G = globalThis as unknown as {
  __leagueTournamentLiveSyncAt?: Map<string, number>;
};

function lastSyncMap() {
  if (!G.__leagueTournamentLiveSyncAt) G.__leagueTournamentLiveSyncAt = new Map();
  return G.__leagueTournamentLiveSyncAt;
}

export type TournamentLiveSyncResult = {
  /** False when skipped due to per-league rate limit (another tab/user synced recently). */
  ranHenrygdSync: boolean;
  syncSummary: unknown;
  backfillSummary: unknown;
};

/**
 * Pulls henrygd scoreboard + player box scores, then recomputes projections and cached leaderboard.
 * Rate-limited per `leagueId` so many open clients do not stampede the upstream API.
 */
export async function runTournamentLiveSyncForLeague(opts: {
  supabase: SupabaseClient;
  leagueId: string;
  seasonYear: number;
  /** Minimum ms since last successful sync for this league (default 25_000). */
  minIntervalMs?: number;
  excludeFirstFour?: boolean;
}): Promise<TournamentLiveSyncResult> {
  const minInterval = opts.minIntervalMs ?? 25_000;
  const map = lastSyncMap();
  const now = Date.now();
  const prev = map.get(opts.leagueId) ?? 0;

  if (now - prev < minInterval) {
    return {
      ranHenrygdSync: false,
      syncSummary: { skipped: true, reason: "rate_limited", minIntervalMs: minInterval },
      backfillSummary: { skipped: true }
    };
  }

  const date = new Date();
  const sync = await syncHenrygdMensD1ScoreboardToSupabase({
    supabase: opts.supabase,
    seasonYear: opts.seasonYear,
    date,
    excludeFirstFour: opts.excludeFirstFour !== false
  });

  const backfill = await syncPlayerBoxscoresForSeasonGamesInDb({
    supabase: opts.supabase,
    seasonYear: opts.seasonYear
  });

  const projections = await computeLeagueProjections(opts.supabase, opts.leagueId);

  if (projections.teams.length > 0) {
    await upsertLeagueProjectionChalkPreservingOriginals(
      opts.supabase,
      opts.leagueId,
      projections.teams.map((t) => ({
        leagueTeamId: t.leagueTeamId,
        projectionChalk: t.projectionChalk
      }))
    );
  }

  try {
    await captureLeagueOriginalProjectionsIfNeeded(opts.supabase, opts.leagueId);
  } catch {
    /* optional */
  }

  try {
    await persistLeagueLiveScoreboard(opts.supabase, opts.leagueId);
  } catch {
    /* migration 0008 optional */
  }

  map.set(opts.leagueId, Date.now());

  return {
    ranHenrygdSync: true,
    syncSummary: sync,
    backfillSummary: backfill
  };
}
