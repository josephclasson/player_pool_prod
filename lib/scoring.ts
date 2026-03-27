import type { SupabaseClient } from "@supabase/supabase-js";
import {
  isFinalStatus,
  isLiveStatus,
  isPlausiblyLiveGameForUi,
  isLikelyInProgressByTipoffWindow
} from "@/lib/chalk-remaining-games";
import {
  buildEliminationRoundByCanonicalFromGames,
  fetchTeamRowsForCanonicalKeys,
  participationBucketFromDbRound,
  reconcileCanonicalTeamIdsFromRows,
  resolveCanonicalTeamKeyFromRow,
  stablePoolSlugForTeamContext,
  type TeamRowForCanonical
} from "@/lib/tournament-team-canonical";

export type LeagueLeaderboardTeamRow = {
  leagueTeamId: string;
  ownerName: string;
  totalScore: number;
  roundScores: Record<number, number>; // key: tournament round bucket (1..6)
  eliminatedSlots: number;
  rank?: number;
};

export type ScoringComputationResult = {
  /** Highest DB tournament round (1..6) among live/final games; 0 if none. */
  currentRound: number;
  lastSyncedAt: string | null;
  partialDataWarning: boolean;
  /** True when at least one tournament game row is `live` (used for adaptive polling / UI). */
  anyLiveGames: boolean;
  liveGamesCount: number;
  teams: LeagueLeaderboardTeamRow[];
};

function computeDisplayRound(currentRound: number) {
  if (currentRound <= 0) return 1;
  return currentRound;
}

function safeNum(x: unknown) {
  const n = typeof x === "number" ? x : Number(x);
  return Number.isFinite(n) ? n : 0;
}

/**
 * League roster label (`league_teams.team_name`) is what commissioners edit in Pre-season / roster sync.
 * Prefer it over `profiles.display_name` so renamed teams show everywhere (StatTracker, leaderboard).
 */
export function resolveLeagueOwnerDisplayName(opts: {
  teamName: string | null | undefined;
  profileDisplayName: string | null | undefined;
}): string {
  const tn = opts.teamName != null ? String(opts.teamName).trim() : "";
  if (tn) return tn;
  const dn = opts.profileDisplayName != null ? String(opts.profileDisplayName).trim() : "";
  if (dn) return dn;
  return "Team";
}

const GAMES_PAGE = 1000;

async function fetchAllR1ThroughR6GamesForScoring(supabase: SupabaseClient): Promise<Record<string, unknown>[]> {
  const all: Record<string, unknown>[] = [];
  for (let from = 0; ; from += GAMES_PAGE) {
    const { data, error } = await supabase
      .from("games")
      .select(
        "id, round, status, start_time, last_synced_at, team_a_id, team_b_id, team_a_score, team_b_score"
      )
      /* 0 = First Four (needed for participation / DNP zero-fill); 1–6 = R1–R6 */
      .in("round", [0, 1, 2, 3, 4, 5, 6])
      .order("id", { ascending: true })
      .range(from, from + GAMES_PAGE - 1);
    if (error) break;
    const chunk = data ?? [];
    all.push(...chunk);
    if (chunk.length < GAMES_PAGE) break;
  }
  return all;
}

/**
 * Map DB `games.round` → fantasy display bucket R1..R6. First Four (legacy `round` 0) is excluded — returns null.
 */
export function fantasyRoundBucketFromDbRound(gameRound: number): number | null {
  if (gameRound >= 1 && gameRound <= 6) return gameRound;
  return null;
}

type GameRow = {
  id: number;
  round: number;
  status: string;
  start_time: string;
  last_synced_at: string | null;
  team_a_id: number;
  team_b_id: number;
  team_a_score: number | null;
  team_b_score: number | null;
};

type PlayerGameStatRow = {
  game_id: number;
  player_id: number;
  points: number;
};

export type LeagueScoringSlotComputed = {
  teamTotal: number;
  pointsByRound: Record<number, number>;
  eliminated: boolean;
  /** Tournament display round where team was eliminated (1..6), else null. */
  eliminatedRound: number | null;
};

export type LeagueScoringEngineState = {
  currentRound: number;
  lastSyncedAt: string | null;
  partialDataWarning: boolean;
  anyLiveGames: boolean;
  liveGamesCount: number;
  /** NCAA `teams.id` values with at least one tournament game currently in `live` status. */
  teamIdsInLiveGame: Set<number>;
  leagueTeamRows: Array<{
    id: string;
    user_id: string;
    team_name?: string | null;
    draft_position?: number | null;
  }>;
  slots: Array<Record<string, unknown>>;
  slotsByLeagueTeam: Map<string, Array<Record<string, unknown>>>;
  slotComputed: Map<string, LeagueScoringSlotComputed>;
  profileById: Map<string, { display_name?: string | null }>;
};

/**
 * Shared scoring load: games, player_game_stats, per-roster-slot round buckets.
 * Used by leaderboard aggregation and StatTracker detail rows.
 */
export async function loadLeagueScoringEngineState(
  supabase: SupabaseClient,
  leagueId: string
): Promise<LeagueScoringEngineState | null> {
  const { data: leagueRow } = await supabase
    .from("leagues")
    .select("season_year")
    .eq("id", leagueId)
    .maybeSingle();
  const seasonYear =
    leagueRow && (leagueRow as { season_year?: unknown }).season_year != null
      ? safeNum((leagueRow as { season_year?: unknown }).season_year)
      : 0;

  const { data: leagueTeams } = await supabase
    .from("league_teams")
    .select("id, user_id, team_name, draft_position")
    .eq("league_id", leagueId);

  const leagueTeamRows = (leagueTeams ?? []) as LeagueScoringEngineState["leagueTeamRows"];
  if (leagueTeamRows.length === 0) return null;

  const leagueTeamIds = leagueTeamRows.map((t) => t.id);

  const { data: rosterSlots } = await supabase
    .from("player_roster_slots")
    .select("id, league_team_id, player_id, team_id, round_slot, pick_overall, eliminated")
    .in("league_team_id", leagueTeamIds);

  const slots = rosterSlots ?? [];
  const rosterPlayerIds = Array.from(new Set(slots.map((s: any) => safeNum(s.player_id)))).filter(
    (id) => id > 0
  );
  const { data: rosterPlayers } =
    rosterPlayerIds.length > 0
      ? await supabase
          .from("players")
          .select("id, team_id")
          .in("id", rosterPlayerIds)
      : { data: [] as any[] };
  const playerTeamIdByPlayerId = new Map<number, number>();
  for (const p of rosterPlayers ?? []) {
    const pid = safeNum((p as { id?: unknown }).id);
    const tid = safeNum((p as { team_id?: unknown }).team_id);
    if (pid > 0 && tid > 0) playerTeamIdByPlayerId.set(pid, tid);
  }
  const rosterTeamIds = Array.from(new Set(slots.map((s: any) => safeNum(s.team_id)))).filter(
    (id) => id > 0
  );

  const { data: seasonTeams } =
    seasonYear > 0
      ? await supabase.from("teams").select("id").ilike("external_team_id", `%-${seasonYear}`)
      : { data: [] as Array<{ id?: unknown }> };
  const seasonTeamIdSet = new Set<number>();
  for (const t of seasonTeams ?? []) {
    const tid = safeNum((t as { id?: unknown }).id);
    if (tid > 0) seasonTeamIdSet.add(tid);
  }

  // Tournament bracket games for the active league season only.
  //
  // Troubleshooting notes (Mar 2026):
  // - We saw "no E values" for BYU / North Carolina / Wisconsin / St. Mary's when
  //   external-team aliases mapped correctly but season scoping excluded the game rows.
  // - Root causes included duplicate/misaligned `teams.id` rows for the same school and
  //   provider rows where the season label/team linkage did not match local season filters.
  // - Keep this filter permissive: include by season date window OR season team-id membership.
  // - If this becomes over-restrictive again, elimination can silently disappear for whole teams.
  const gamesAll = await fetchAllR1ThroughR6GamesForScoring(supabase);
  const seasonStartMs = seasonYear > 0 ? Date.UTC(seasonYear, 0, 1, 0, 0, 0, 0) : 0;
  const seasonEndMs = seasonYear > 0 ? Date.UTC(seasonYear + 1, 0, 1, 0, 0, 0, 0) : 0;
  const seasonScopedGames =
    seasonYear > 0 || seasonTeamIdSet.size > 0
      ? gamesAll.filter((g) => {
          const ta = safeNum((g as { team_a_id?: unknown }).team_a_id);
          const tb = safeNum((g as { team_b_id?: unknown }).team_b_id);
          const inSeasonTeams = seasonTeamIdSet.has(ta) || seasonTeamIdSet.has(tb);
          const atMs = new Date(String((g as { start_time?: unknown }).start_time ?? "")).getTime();
          const inSeasonWindow =
            seasonYear > 0 && Number.isFinite(atMs) ? atMs >= seasonStartMs && atMs < seasonEndMs : false;
          return inSeasonWindow || inSeasonTeams;
        })
      : gamesAll;
  // Guardrail: if season scoping is misaligned (e.g. league season label mismatch),
  // never drop elimination entirely; fall back to the full synced tournament game set.
  // This specifically protects mapping-heavy schools that had split team rows during imports.
  const games = seasonScopedGames.length >= 8 ? seasonScopedGames : gamesAll;

  const gameRows: GameRow[] = games.map((g: any) => ({
    id: safeNum(g.id),
    round: safeNum(g.round),
    status: String(g.status ?? ""),
    start_time: String(g.start_time ?? ""),
    last_synced_at: g.last_synced_at ?? null,
    team_a_id: safeNum(g.team_a_id),
    team_b_id: safeNum(g.team_b_id),
    team_a_score: g.team_a_score != null ? safeNum(g.team_a_score) : null,
    team_b_score: g.team_b_score != null ? safeNum(g.team_b_score) : null
  }));

  const gameIdSet = new Set(gameRows.map((g) => g.id));

  const { data: playerGameStats } = await supabase
    .from("player_game_stats")
    .select("game_id, player_id, points")
    .in("player_id", rosterPlayerIds)
    .in("game_id", Array.from(gameIdSet));

  const statsRows: PlayerGameStatRow[] = (playerGameStats ?? []) as any;

  const gameById = new Map<number, GameRow>();
  for (const g of gameRows) gameById.set(g.id, g);

  const statsByPlayer = new Map<number, PlayerGameStatRow[]>();
  for (const st of statsRows) {
    const pid = safeNum(st.player_id);
    const arr = statsByPlayer.get(pid) ?? [];
    arr.push(st);
    statsByPlayer.set(pid, arr);
  }

  // Determine current round + partial warning.
  const liveOrFinalGames = gameRows.filter((g) => isLiveStatus(g.status) || isFinalStatus(g.status));
  const currentRound = liveOrFinalGames.length
    ? Math.max(...liveOrFinalGames.map((g) => safeNum(g.round)))
    : 0;
  const displayCurrentRound = computeDisplayRound(currentRound);
  void displayCurrentRound; // keep for future use if needed by caller

  const lastSyncedAt = (() => {
    const syn = gamesAll
      .map((g) => g.last_synced_at)
      .filter(Boolean) as string[];
    if (syn.length === 0) return null;
    return new Date(Math.max(...syn.map((d) => new Date(d).getTime()))).toISOString();
  })();

  const allGameRowsForLive: GameRow[] = gamesAll.map((g: any) => ({
    id: safeNum(g.id),
    round: safeNum(g.round),
    status: String(g.status ?? ""),
    start_time: String(g.start_time ?? ""),
    last_synced_at: g.last_synced_at ?? null,
    team_a_id: safeNum(g.team_a_id),
    team_b_id: safeNum(g.team_b_id),
    team_a_score: g.team_a_score != null ? safeNum(g.team_a_score) : null,
    team_b_score: g.team_b_score != null ? safeNum(g.team_b_score) : null
  }));
  const nowMs = Date.now();
  const liveGames = allGameRowsForLive.filter((g) =>
    isPlausiblyLiveGameForUi(
      {
        status: g.status,
        start_time: g.start_time,
        team_a_score: g.team_a_score,
        team_b_score: g.team_b_score
      },
      nowMs
    )
  );
  const liveGamesEffective =
    liveGames.length > 0
      ? liveGames
      : allGameRowsForLive.filter((g) =>
          isLikelyInProgressByTipoffWindow(
            {
              status: g.status,
              start_time: g.start_time
            },
            nowMs
          )
        );
  const anyLiveGames = liveGamesEffective.length > 0;
  const liveGamesCount = liveGamesEffective.length;

  const partialDataWarning = (() => {
    if (liveGamesEffective.length === 0) return false;
    const latestSync = liveGamesEffective
      .map((g) => g.last_synced_at ? new Date(g.last_synced_at).getTime() : 0)
      .reduce((a, b) => Math.max(a, b), 0);
    if (!latestSync) return true;
    return Date.now() - latestSync > 120_000;
  })();

  const teamIdsInLiveGame = new Set<number>();
  for (const g of liveGamesEffective) {
    if (g.team_a_id > 0) teamIdsInLiveGame.add(g.team_a_id);
    if (g.team_b_id > 0) teamIdsInLiveGame.add(g.team_b_id);
  }

  // Preload profiles to map ownerName.
  const userIds = leagueTeamRows.map((t: any) => t.user_id as string);
  const { data: profiles } = await supabase
    .from("profiles")
    .select("id, display_name")
    .in("id", userIds);
  const profileById = new Map<string, any>(
    (profiles ?? []).map((p: any) => [p.id, p])
  );

  // Compute per roster slot:
  // - total points for the player across all games we have box-score stats for
  // - points grouped by tournament round bucket
  // - eliminated status from last final team game
  const slotComputed = new Map<string, LeagueScoringSlotComputed>();

  /* Participation for DNP / 0-pt games: match teams by canonical SEO (strip `-YYYY`)
   * so `games.team_*_id` rows align with `players.team_id` / roster `team_id` even when
   * they point at different `teams.id` for the same school. */
  const gameSideTeamIds = new Set<number>();
  for (const g of gameRows) {
    if (g.team_a_id > 0) gameSideTeamIds.add(g.team_a_id);
    if (g.team_b_id > 0) gameSideTeamIds.add(g.team_b_id);
  }
  for (const tid of teamIdsInLiveGame) {
    if (tid > 0) gameSideTeamIds.add(tid);
  }
  const rosterSideTeamIds = new Set<number>(rosterTeamIds);
  for (const slot of slots as any[]) {
    const tid = safeNum(slot.team_id);
    if (tid > 0) rosterSideTeamIds.add(tid);
  }
  for (const tid of playerTeamIdByPlayerId.values()) {
    if (tid > 0) rosterSideTeamIds.add(tid);
  }
  const allTeamIdsForCanonical = [...new Set([...gameSideTeamIds, ...rosterSideTeamIds])];
  const teamRowsForCanon = await fetchTeamRowsForCanonicalKeys(supabase, allTeamIdsForCanonical);
  const canonRowById = new Map<number, TeamRowForCanonical>();
  for (const row of teamRowsForCanon) {
    const id = safeNum(row.id);
    if (id > 0) canonRowById.set(id, row);
  }
  const canonicalByInternalTeamId = new Map<number, string>();
  for (const id of allTeamIdsForCanonical) {
    const row = canonRowById.get(id);
    canonicalByInternalTeamId.set(id, row ? resolveCanonicalTeamKeyFromRow(row) : `__id_${id}`);
  }
  reconcileCanonicalTeamIdsFromRows(teamRowsForCanon, canonicalByInternalTeamId);

  /* Live highlight / "Live only": roster `team_id` and `players.team_id` may reference a different
   * `teams.id` than `games.team_*_id` for the same school — mirror participation logic. */
  if (teamIdsInLiveGame.size > 0) {
    const liveCanonKeys = new Set<string>();
    for (const tid of teamIdsInLiveGame) {
      const k = canonicalByInternalTeamId.get(tid);
      if (k) liveCanonKeys.add(k);
    }
    for (const id of allTeamIdsForCanonical) {
      const k = canonicalByInternalTeamId.get(id);
      if (k && liveCanonKeys.has(k)) teamIdsInLiveGame.add(id);
    }
  }

  const eliminationRoundByCanonical = buildEliminationRoundByCanonicalFromGames(
    gameRows.map((g) => ({
      round: g.round,
      status: g.status,
      start_time: g.start_time,
      team_a_id: g.team_a_id,
      team_b_id: g.team_b_id,
      team_a_score: g.team_a_score,
      team_b_score: g.team_b_score
    })),
    canonicalByInternalTeamId,
    canonRowById
  );

  const participatedDisplayRoundsByCanonical = new Map<string, Set<number>>();
  for (const g of gameRows) {
    const gameRound = safeNum(g.round);
    const countsAsParticipated =
      isFinalStatus(g.status) ||
      isLiveStatus(g.status) ||
      // Fallback for stale providers: any game in a past round must have been played.
      (currentRound > 0 && gameRound > 0 && gameRound < currentRound);
    if (!countsAsParticipated) continue;
    const bucket = participationBucketFromDbRound(gameRound);
    if (bucket == null) continue;
    for (const tid of [g.team_a_id, g.team_b_id]) {
      if (tid <= 0) continue;
      const canon = stablePoolSlugForTeamContext(tid, canonicalByInternalTeamId, canonRowById);
      if (!canon) continue;
      if (!participatedDisplayRoundsByCanonical.has(canon)) {
        participatedDisplayRoundsByCanonical.set(canon, new Set());
      }
      participatedDisplayRoundsByCanonical.get(canon)!.add(bucket);
    }
  }

  // Important: only mark elimination from explicit final losses.
  // Do not infer elimination from participation gaps; that can false-positive when provider
  // statuses/scores lag and incorrectly show players as "E".

  for (const slot of slots as any[]) {
    const slotId = slot.id as string;
    const playerId = safeNum(slot.player_id);
    const teamId = safeNum(slot.team_id);
    const effectiveTeamId = playerTeamIdByPlayerId.get(playerId) ?? teamId;
    const playerStats = statsByPlayer.get(playerId) ?? [];

    let totalScore = 0;
    const pointsByRound: Record<number, number> = {};

    for (const st of playerStats) {
      const g = gameById.get(st.game_id);
      if (!g) continue;
      const pts = safeNum(st.points);
      totalScore += pts;

      const bucket = fantasyRoundBucketFromDbRound(safeNum(g.round));
      if (bucket == null) continue;
      pointsByRound[bucket] = (pointsByRound[bucket] ?? 0) + pts;
    }

    const roundsToFill = new Set<number>();
    const canonPlayer = stablePoolSlugForTeamContext(effectiveTeamId, canonicalByInternalTeamId, canonRowById);
    if (canonPlayer) {
      const s = participatedDisplayRoundsByCanonical.get(canonPlayer);
      if (s) for (const r of s) roundsToFill.add(r);
    }
    const canonSlot = stablePoolSlugForTeamContext(teamId, canonicalByInternalTeamId, canonRowById);
    if (canonSlot && canonSlot !== canonPlayer) {
      const s = participatedDisplayRoundsByCanonical.get(canonSlot);
      if (s) for (const r of s) roundsToFill.add(r);
    }
    for (const r of roundsToFill) {
      if (!Object.prototype.hasOwnProperty.call(pointsByRound, r)) pointsByRound[r] = 0;
    }

    const elimRounds: number[] = [];
    if (canonPlayer) {
      const er = eliminationRoundByCanonical.get(canonPlayer);
      if (er != null) elimRounds.push(er);
    }
    if (canonSlot && canonSlot !== canonPlayer) {
      const er = eliminationRoundByCanonical.get(canonSlot);
      if (er != null) elimRounds.push(er);
    }
    const eliminatedRound = elimRounds.length > 0 ? Math.max(...elimRounds) : null;
    const eliminated = eliminatedRound != null;

    if (eliminatedRound != null) {
      for (let r = eliminatedRound + 1; r <= 6; r++) {
        const v = pointsByRound[r];
        if (v === undefined || v === 0) delete pointsByRound[r];
      }
    }

    slotComputed.set(slotId, {
      teamTotal: totalScore,
      pointsByRound,
      eliminated,
      eliminatedRound
    });
  }

  const slotsByLeagueTeam = new Map<string, Array<Record<string, unknown>>>();
  for (const slot of slots as any[]) {
    const lid = slot.league_team_id as string;
    const arr = slotsByLeagueTeam.get(lid) ?? [];
    arr.push(slot as Record<string, unknown>);
    slotsByLeagueTeam.set(lid, arr);
  }

  return {
    currentRound,
    lastSyncedAt,
    partialDataWarning,
    anyLiveGames,
    liveGamesCount,
    teamIdsInLiveGame,
    leagueTeamRows,
    slots: slots as Array<Record<string, unknown>>,
    slotsByLeagueTeam,
    slotComputed,
    profileById
  };
}

export async function computeLeagueLeaderboardAndRoundScores(
  supabase: SupabaseClient,
  leagueId: string
): Promise<ScoringComputationResult> {
  const state = await loadLeagueScoringEngineState(supabase, leagueId);
  if (!state) {
    return {
      currentRound: 0,
      lastSyncedAt: null,
      partialDataWarning: false,
      anyLiveGames: false,
      liveGamesCount: 0,
      teams: []
    };
  }
  return aggregateLeaderboardFromEngineState(state);
}

export function aggregateLeaderboardFromEngineState(state: LeagueScoringEngineState): ScoringComputationResult {
  const {
    currentRound,
    lastSyncedAt,
    partialDataWarning,
    anyLiveGames,
    liveGamesCount,
    leagueTeamRows,
    slotsByLeagueTeam,
    slotComputed,
    profileById
  } = state;

  const leaderboardTeams: LeagueLeaderboardTeamRow[] = [];
  for (const lt of leagueTeamRows) {
    const ltId = lt.id;
    const profile = profileById.get(lt.user_id);
    const ownerName = resolveLeagueOwnerDisplayName({
      teamName: lt.team_name,
      profileDisplayName: profile?.display_name
    });

    const ltSlots = slotsByLeagueTeam.get(ltId) ?? [];
    let totalScore = 0;
    let eliminatedSlots = 0;
    const roundScores: Record<number, number> = {};

    for (const slot of ltSlots) {
      const c = slotComputed.get(String(slot.id));
      if (!c) continue;
      totalScore += c.teamTotal;
      if (c.eliminated) eliminatedSlots += 1;
      for (const [bucketStr, pts] of Object.entries(c.pointsByRound)) {
        const bucket = Number(bucketStr);
        roundScores[bucket] = (roundScores[bucket] ?? 0) + pts;
      }
    }

    leaderboardTeams.push({
      leagueTeamId: ltId,
      ownerName,
      totalScore,
      roundScores,
      eliminatedSlots
    });
  }

  leaderboardTeams.sort((a, b) => {
    if (b.totalScore !== a.totalScore) return b.totalScore - a.totalScore;
    if (a.eliminatedSlots !== b.eliminatedSlots) return a.eliminatedSlots - b.eliminatedSlots;
    return a.ownerName.localeCompare(b.ownerName);
  });

  leaderboardTeams.forEach((t, i) => {
    t.rank = i + 1;
  });

  return {
    currentRound,
    lastSyncedAt,
    partialDataWarning,
    anyLiveGames,
    liveGamesCount,
    teams: leaderboardTeams
  };
}

