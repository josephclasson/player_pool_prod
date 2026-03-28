import type { SupabaseClient } from "@supabase/supabase-js";
import {
  allLeagueDraftedPlayers,
  topKAllTournamentPlayers,
  undraftedPoolPlayersForAllTournamentTeam
} from "@/lib/all-tournament-team";
import { computeLeagueProjections } from "@/lib/projections";
import { buildPlayerPoolRecordsForLeague } from "@/lib/players-pool-for-league";
import {
  aggregateLeaderboardFromEngineState,
  loadLeagueScoringEngineState
} from "@/lib/scoring";
import {
  buildLeaderboardRosterPlayersByLeagueTeam,
  type LeaderboardRosterPlayerApi
} from "@/lib/scoring/leaderboard-roster-detail";
import { computeRosterTqsAdjustmentsForLeague } from "@/lib/scoring/roster-tqs-adjustment";

export type { LeaderboardRosterPlayerApi };

/** Shape returned by GET /api/leaderboard/[leagueId] (also stored in league_live_scoreboard.payload). */
export type LeaderboardApiPayload = {
  currentRound: number;
  lastSyncedAt: string | null;
  partialDataWarning: boolean;
  anyLiveGames: boolean;
  liveGamesCount: number;
  /** League `season_year` when known (player pool / undrafted highlights). */
  seasonYear?: number | null;
  /** ISO time when this payload was built / written to cache */
  cacheUpdatedAt: string;
  teams: Array<{
    leagueTeamId: string;
    ownerName: string;
    rank: number;
    totalScore: number;
    roundScores: Record<number, number>;
    projection: number | null;
    /** Frozen at draft completion: PPG × expected chalk games played (bracket sim). */
    projectionOriginal?: number | null;
    badges: Array<{ badge: string; reason?: string }>;
    /** Roster rows in draft order; same media/stat shape as Player Statistics. */
    players?: LeaderboardRosterPlayerApi[];
    /**
     * Quality-adjustment points: `k * (league_avg_roster_tqs - roster_tqs)`.
     * Stronger (higher TQS) rosters get negative or smaller bumps; weaker rosters positive.
     */
    tqsAdjustment: number;
    /** `totalScore + tqsAdjustment` */
    adjustedTotalScore: number;
  }>;
  /**
   * Top 8 undrafted pool players by tournament points (same shape as roster rows).
   * Built with the leaderboard so the Leaders page does not need a second pool fetch.
   */
  undraftedAllTournamentTeamPlayers?: LeaderboardRosterPlayerApi[];
};

function safeNum(x: unknown): number {
  const n = typeof x === "number" ? x : Number(x);
  return Number.isFinite(n) ? n : 0;
}

function rosterPlayerNeedsPickOverall(p: LeaderboardRosterPlayerApi): boolean {
  const po = p.pickOverall;
  if (po != null && Number.isFinite(Number(po)) && Number(po) >= 1) return false;
  const snake = (p as { pick_overall?: unknown }).pick_overall;
  const s = typeof snake === "number" ? snake : Number(snake);
  return !(Number.isFinite(s) && s >= 1);
}

/**
 * Cached `league_live_scoreboard.payload` rows may predate `pickOverall` on roster objects.
 * Fills missing values from `player_draft_picks` and `player_roster_slots`.
 */
export async function enrichLeaderboardPayloadPickOverall(
  supabase: SupabaseClient,
  leagueId: string,
  payload: LeaderboardApiPayload
): Promise<LeaderboardApiPayload> {
  const teams = payload.teams;
  if (teams.length === 0) return payload;
  const anyNeed = teams.some((t) => (t.players ?? []).some(rosterPlayerNeedsPickOverall));
  if (!anyNeed) return payload;

  const ltIds = teams.map((t) => t.leagueTeamId);
  const pickBySlotId = new Map<string, number>();
  const pickByLtPlayer = new Map<string, number>();

  const { data: slotRows } = await supabase
    .from("player_roster_slots")
    .select("id, league_team_id, player_id, pick_overall")
    .in("league_team_id", ltIds);

  for (const s of slotRows ?? []) {
    const row = s as { id?: unknown; league_team_id?: unknown; player_id?: unknown; pick_overall?: unknown };
    const id = String(row.id ?? "");
    const lt = String(row.league_team_id ?? "");
    const pid = safeNum(row.player_id);
    const po = safeNum(row.pick_overall);
    if (po > 0 && id) pickBySlotId.set(id, po);
    if (po > 0 && lt && pid > 0) pickByLtPlayer.set(`${lt}:${pid}`, po);
  }

  const { data: draftRoom } = await supabase
    .from("draft_rooms")
    .select("id")
    .eq("league_id", leagueId)
    .maybeSingle();
  const roomId = (draftRoom as { id?: string } | null)?.id;
  if (roomId) {
    const { data: picks } = await supabase
      .from("player_draft_picks")
      .select("player_id, league_team_id, pick_overall")
      .eq("draft_room_id", roomId);
    for (const p of picks ?? []) {
      const row = p as { player_id?: unknown; league_team_id?: unknown; pick_overall?: unknown };
      const lt = String(row.league_team_id ?? "");
      const pid = safeNum(row.player_id);
      const po = safeNum(row.pick_overall);
      if (po > 0 && lt && pid > 0) pickByLtPlayer.set(`${lt}:${pid}`, po);
    }
  }

  return {
    ...payload,
    teams: teams.map((t) => {
      const ltKey = t.leagueTeamId;
      return {
        ...t,
        players: (t.players ?? []).map((p) => {
          if (!rosterPlayerNeedsPickOverall(p)) return p;
          const fromDraftOrSlot = pickByLtPlayer.get(`${ltKey}:${p.playerId}`) ?? 0;
          const fromSlotRow = pickBySlotId.get(String(p.rosterSlotId)) ?? 0;
          const po = fromDraftOrSlot > 0 ? fromDraftOrSlot : fromSlotRow;
          if (po > 0) return { ...p, pickOverall: po };
          return p;
        })
      };
    })
  };
}

export async function buildLeaderboardApiPayload(
  supabase: SupabaseClient,
  leagueId: string
): Promise<LeaderboardApiPayload> {
  const [{ data: leagueRowEarly }, state] = await Promise.all([
    supabase.from("leagues").select("season_year").eq("id", leagueId).maybeSingle(),
    loadLeagueScoringEngineState(supabase, leagueId)
  ]);
  const seasonYearEarly =
    (leagueRowEarly as { season_year?: unknown } | null)?.season_year != null
      ? safeNum((leagueRowEarly as { season_year: unknown }).season_year)
      : null;
  const seasonYearResolved =
    seasonYearEarly != null && seasonYearEarly > 0 ? seasonYearEarly : null;

  const cacheUpdatedAt = new Date().toISOString();

  if (!state) {
    return {
      currentRound: 0,
      lastSyncedAt: null,
      partialDataWarning: false,
      anyLiveGames: false,
      liveGamesCount: 0,
      seasonYear: seasonYearResolved,
      cacheUpdatedAt,
      teams: []
    };
  }

  const seasonYearForPayload =
    seasonYearResolved ??
    (state.seasonYear != null && state.seasonYear > 0 ? state.seasonYear : null);

  const scoring = aggregateLeaderboardFromEngineState(state);
  const projections = await computeLeagueProjections(supabase, leagueId);
  const projByLt = new Map(
    projections.teams.map((t) => [t.leagueTeamId, t.projectionChalk])
  );

  let playersByLt: Record<string, LeaderboardRosterPlayerApi[]> = {};
  let poolRecords: Record<string, unknown>[] = [];
  if (seasonYearForPayload != null) {
    const poolPromise =
      scoring.teams.length > 0
        ? buildPlayerPoolRecordsForLeague(supabase, {
            seasonYear: seasonYearForPayload,
            leagueId,
            limit: 8000
          })
        : Promise.resolve({ players: [] as Record<string, unknown>[], hasLiveGames: false });

    const [byLt, poolPack] = await Promise.all([
      buildLeaderboardRosterPlayersByLeagueTeam(
        supabase,
        leagueId,
        seasonYearForPayload,
        state,
        scoring.teams,
        projections.slotProjectionByRosterSlotId
      ),
      poolPromise
    ]);
    playersByLt = byLt;
    poolRecords = poolPack.players;
  }

  const { data: projRows } = await supabase
    .from("projections")
    .select("league_team_id, projection_chalk_original")
    .eq("league_id", leagueId);

  const origByLt = new Map<string, number | null>(
    (projRows ?? []).map((r: { league_team_id: string; projection_chalk_original: unknown }) => [
      String(r.league_team_id),
      r.projection_chalk_original != null ? Number(r.projection_chalk_original) : null
    ])
  );

  const teamsBase = scoring.teams.map((t) => ({
    leagueTeamId: t.leagueTeamId,
    ownerName: t.ownerName,
    rank: t.rank ?? 0,
    totalScore: t.totalScore,
    roundScores: t.roundScores,
    projection: projByLt.get(t.leagueTeamId) ?? null,
    projectionOriginal: origByLt.get(t.leagueTeamId) ?? null,
    badges: [] as Array<{ badge: string; reason?: string }>,
    players: playersByLt[t.leagueTeamId] ?? []
  }));

  const tqsByLt = computeRosterTqsAdjustmentsForLeague(teamsBase);
  const teams = teamsBase.map((t) => {
    const row = tqsByLt.get(t.leagueTeamId);
    return {
      ...t,
      tqsAdjustment: row?.tqsAdjustment ?? 0,
      adjustedTotalScore: row?.adjustedTotalScore ?? t.totalScore
    };
  });

  let undraftedAllTournamentTeamPlayers: LeaderboardRosterPlayerApi[] = [];
  if (seasonYearForPayload != null && teams.length > 0) {
    const drafted = allLeagueDraftedPlayers(teams);
    const draftedIds = new Set(drafted.map((p) => p.playerId));
    const undraftedApi = undraftedPoolPlayersForAllTournamentTeam(poolRecords, draftedIds);
    undraftedAllTournamentTeamPlayers = topKAllTournamentPlayers(undraftedApi, 8);
  }

  return {
    currentRound: scoring.currentRound,
    lastSyncedAt: scoring.lastSyncedAt,
    partialDataWarning: scoring.partialDataWarning,
    anyLiveGames: scoring.anyLiveGames,
    liveGamesCount: scoring.liveGamesCount,
    seasonYear: seasonYearForPayload,
    cacheUpdatedAt,
    teams,
    undraftedAllTournamentTeamPlayers
  };
}

/** Cached payloads from before `undraftedAllTournamentTeamPlayers` existed. */
export async function ensureUndraftedAllTournamentOnLeaderboardPayload(
  supabase: SupabaseClient,
  leagueId: string,
  payload: LeaderboardApiPayload
): Promise<LeaderboardApiPayload> {
  if (Array.isArray(payload.undraftedAllTournamentTeamPlayers)) return payload;
  if (payload.teams.length === 0 || payload.seasonYear == null || payload.seasonYear <= 0) {
    return { ...payload, undraftedAllTournamentTeamPlayers: [] };
  }
  try {
    const { players: rows } = await buildPlayerPoolRecordsForLeague(supabase, {
      seasonYear: payload.seasonYear,
      leagueId,
      limit: 8000
    });
    const drafted = allLeagueDraftedPlayers(payload.teams);
    const draftedIds = new Set(drafted.map((p) => p.playerId));
    const undraftedApi = undraftedPoolPlayersForAllTournamentTeam(rows, draftedIds);
    return {
      ...payload,
      undraftedAllTournamentTeamPlayers: topKAllTournamentPlayers(undraftedApi, 8)
    };
  } catch {
    return { ...payload, undraftedAllTournamentTeamPlayers: [] };
  }
}

/** Attach latest `projectionOriginal` from `projections` (e.g. when serving cached leaderboard JSON). */
export async function mergeLeaderboardProjectionOriginalsFromDb(
  supabase: SupabaseClient,
  leagueId: string,
  payload: LeaderboardApiPayload
): Promise<LeaderboardApiPayload> {
  const [payloadWithPicks, projRes] = await Promise.all([
    enrichLeaderboardPayloadPickOverall(supabase, leagueId, payload),
    supabase
      .from("projections")
      .select("league_team_id, projection_chalk_original")
      .eq("league_id", leagueId)
  ]);

  const projRows = projRes.data;

  const origByLt = new Map<string, number | null>(
    (projRows ?? []).map((r: { league_team_id: string; projection_chalk_original: unknown }) => [
      String(r.league_team_id),
      r.projection_chalk_original != null ? Number(r.projection_chalk_original) : null
    ])
  );

  const needsTqs = payloadWithPicks.teams.some((t) => typeof t.tqsAdjustment !== "number");
  const tqsByLt = needsTqs
    ? computeRosterTqsAdjustmentsForLeague(
        payloadWithPicks.teams.map((t) => ({
          leagueTeamId: t.leagueTeamId,
          totalScore: t.totalScore,
          players: t.players
        }))
      )
    : null;

  const baseMerged: LeaderboardApiPayload = {
    ...payloadWithPicks,
    teams: payloadWithPicks.teams.map((t) => {
      const projectionOriginal = origByLt.has(t.leagueTeamId)
        ? (origByLt.get(t.leagueTeamId) ?? null)
        : (t.projectionOriginal ?? null);
      const row = tqsByLt?.get(t.leagueTeamId);
      const tqsAdjustment =
        typeof t.tqsAdjustment === "number" ? t.tqsAdjustment : (row?.tqsAdjustment ?? 0);
      const adjustedTotalScore =
        typeof t.adjustedTotalScore === "number"
          ? t.adjustedTotalScore
          : (row?.adjustedTotalScore ?? t.totalScore);
      return {
        ...t,
        projectionOriginal,
        tqsAdjustment,
        adjustedTotalScore
      };
    })
  };

  return ensureUndraftedAllTournamentOnLeaderboardPayload(supabase, leagueId, baseMerged);
}


export async function persistLeagueLiveScoreboard(
  supabase: SupabaseClient,
  leagueId: string
): Promise<LeaderboardApiPayload> {
  const payload = await buildLeaderboardApiPayload(supabase, leagueId);
  const { error } = await supabase.from("league_live_scoreboard").upsert(
    {
      league_id: leagueId,
      payload,
      updated_at: payload.cacheUpdatedAt
    },
    { onConflict: "league_id" }
  );
  if (error) throw error;
  return payload;
}
