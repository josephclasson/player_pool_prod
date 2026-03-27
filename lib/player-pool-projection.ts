import type { SupabaseClient } from "@supabase/supabase-js";
import { isPlausiblyLiveGameForUi } from "@/lib/chalk-remaining-games";
import {
  computeExpectedChalkGamesPlayedFromBracket,
  type ChalkTeamMeta
} from "@/lib/chalk-bracket-sim";
import { normalizePlayerNameForMatch } from "@/lib/espn-mbb-directory";
import { parseHenrygdBoxscorePlayerIdFromExternal } from "@/lib/player-henrygd-link";
import { fantasyRoundBucketFromDbRound } from "@/lib/scoring";
import {
  applyDnpZerosForFinalFantasyBuckets,
  buildFinalFantasyRoundBucketsByCanonicalTeam,
  includePlayerGameStatInFantasyTotals,
  maxDbRoundAmongLiveOrFinal
} from "@/lib/tournament-fantasy-round-scoring";
import {
  buildBracketStateFromHenrygdAndDb,
  calculatePlayerProjectionInt,
  countPlayedTournamentGamesForTeam,
  sumPointsFromPlayerGameStats,
  type BracketState,
  type DbTournamentGameRow
} from "@/lib/tournament-projection";
import { fetchTournamentSeasonTeamsMerged } from "@/lib/tournament-season-teams";
import {
  buildEliminationRoundByCanonicalFromGames,
  fetchTeamRowsForCanonicalKeys,
  reconcileCanonicalTeamIdsFromRows,
  resolveCanonicalTeamKeyFromRow,
  stablePoolSlugForTeamContext,
  type TeamRowForCanonical
} from "@/lib/tournament-team-canonical";

function safeNum(x: unknown): number {
  const n = typeof x === "number" ? x : Number(x);
  return Number.isFinite(n) ? n : 0;
}

/** PostgREST often caps responses (~1000 rows); keep each query result under that. */
const GAMES_SELECT_PAGE_SIZE = 1000;
const PLAYER_GAME_STATS_GAME_ID_CHUNK = 20;
const PLAYER_GAME_STATS_PLAYER_ID_CHUNK = 50;
const POOL_PLAYERS_IN_CHUNK = 120;

function chunkIds(ids: number[], size: number): number[][] {
  const out: number[][] = [];
  for (let i = 0; i < ids.length; i += size) out.push(ids.slice(i, i + size));
  return out;
}

type PgsRow = {
  player_id: unknown;
  points: unknown;
  game_id: unknown;
  games?: { round?: unknown } | null;
};

async function fetchPgsByGameIds(supabase: SupabaseClient, idChunk: number[]): Promise<PgsRow[]> {
  const j = await supabase
    .from("player_game_stats")
    .select("player_id, points, game_id, games(round)")
    .in("game_id", idChunk);
  if (!j.error) return (j.data ?? []) as PgsRow[];
  const p = await supabase.from("player_game_stats").select("player_id, points, game_id").in("game_id", idChunk);
  return (p.data ?? []) as PgsRow[];
}

async function fetchPgsByPlayerIds(supabase: SupabaseClient, idChunk: number[]): Promise<PgsRow[]> {
  const j = await supabase
    .from("player_game_stats")
    .select("player_id, points, game_id, games(round)")
    .in("player_id", idChunk);
  if (!j.error) return (j.data ?? []) as PgsRow[];
  const p = await supabase.from("player_game_stats").select("player_id, points, game_id").in("player_id", idChunk);
  return (p.data ?? []) as PgsRow[];
}

/** Dedupe (player_id, game_id). Round comes from embedded `games.round` when present, else `gameIdToRound`. */
function mergeDedupedPlayerGameStats(
  into: PgsRow[],
  seen: Set<string>,
  rows: PgsRow[] | null | undefined,
  gameIdToRound: ReadonlyMap<number, number>
) {
  for (const row of rows ?? []) {
    const pid = safeNum(row.player_id);
    const gid = safeNum(row.game_id);
    if (pid <= 0 || gid <= 0) continue;
    const embedded = row.games?.round;
    const r =
      embedded != null && embedded !== ""
        ? safeNum(embedded)
        : (gameIdToRound.get(gid) ?? -1);
    if (r < 1 || r > 6) continue;
    const k = `${pid}:${gid}`;
    if (seen.has(k)) continue;
    seen.add(k);
    into.push(row);
  }
}

function seasonPpgOrDefault(x: unknown) {
  const n = typeof x === "number" ? x : Number(x);
  if (!Number.isFinite(n) || n <= 0) return 68;
  return n;
}

/** Load every R1–R6 row; a single `.select()` without range is capped (~1000) and drops newer `games.id`s. */
async function fetchAllTournamentGamesForProjection(
  supabase: SupabaseClient
): Promise<Record<string, unknown>[]> {
  const all: Record<string, unknown>[] = [];
  for (let from = 0; ; from += GAMES_SELECT_PAGE_SIZE) {
    const to = from + GAMES_SELECT_PAGE_SIZE - 1;
    const { data, error } = await supabase
      .from("games")
      .select("id, round, status, start_time, team_a_id, team_b_id, team_a_score, team_b_score")
      .in("round", [0, 1, 2, 3, 4, 5, 6])
      .order("id", { ascending: true })
      .range(from, to);
    if (error) break;
    const chunk = data ?? [];
    all.push(...chunk);
    if (chunk.length < GAMES_SELECT_PAGE_SIZE) break;
  }
  return all;
}

export type SeasonProjectionBundle = {
  bracketState: BracketState;
  /** `teams.id` string → rank + elimination */
  allTeams: Map<string, { overallRank: number; isActive: boolean }>;
  /** `player_id` → stats rows for final/live games only */
  statsByPlayer: Map<number, Array<{ points: unknown }>>;
  /** `player_id` → fantasy points by display round R1..R6 (First Four excluded). */
  pointsByDisplayRoundByPlayer: Map<number, Record<number, number>>;
  /** At least one tournament game is live (for client polling). */
  hasLiveGames: boolean;
  /**
   * Internal `teams.id` values for schools currently in a live game (canonical-expanded, same idea as scoring).
   */
  teamIdsInLiveGame: Set<number>;
  /** Full bracket chalk: total R1–R6+ path games this team would play if all favorites win (from NCAA bracket JSON). */
  expectedChalkGamesTotalByTeamId: Map<number, number>;
  /** R1–R6 games already underway for projection: decisive finals + live (same game set as stats). */
  completedTournamentGamesByTeamId: Map<number, number>;
  /**
   * Distinct R1–R6 `games.id` that contributed to this pool player’s tournament fantasy totals (via box scores).
   * When `games.team_*_id` is wrong, team-based counts can stay low while actuals already include those games;
   * projections use max(team count, this set’s size) per player.
   */
  tournamentStatGameIdsByPlayerId: Map<number, Set<number>>;
};

export type PlayerTournamentProjectionDetail = {
  /** Pre-tournament: season PPG × expected chalk games for the full run. */
  originalProjection: number;
  /** Actual fantasy points so far + PPG × (expected chalk games − games played: decisive finals + live), 0 remaining if eliminated. */
  liveProjection: number;
  expectedChalkGamesTotal: number;
  /** Decisive finals + live R1–R6 games for this team (matches chalk slots subtracted from expected). */
  completedTournamentGames: number;
  liveExpectedChalkGamesRemaining: number;
};

function fallbackOriginalGamesFromOverallRank(rank: number | null | undefined): number {
  // Pre-tournament no-upset baseline using NCAA committee overall ranks (1..68),
  // excluding First Four from game counts.
  //
  // This reproduces the requested 2026 chalk distribution and stays repeatable:
  // 1-2 -> 6 games (title game), 3-4 -> 5 (Final Four), 5-8 -> 4 (Elite Eight),
  // 9-16 -> 3 (Sweet 16), 17-32 -> 2 (Round of 32), 33-68 -> 1 (Round of 64 loss).
  if (rank == null || !Number.isFinite(rank) || rank <= 0) return 1;
  if (rank <= 2) return 6;
  if (rank <= 4) return 5;
  if (rank <= 8) return 4;
  if (rank <= 16) return 3;
  if (rank <= 32) return 2;
  return 1;
}

/**
 * Shared bracket + elimination + box scores for player pool / draft ordering (one henrygd fetch per request).
 */
export async function loadSeasonProjectionBundle(
  supabase: SupabaseClient,
  seasonYear: number,
  playerIds: number[]
): Promise<SeasonProjectionBundle> {
  const games = await fetchAllTournamentGamesForProjection(supabase);

  const dbGameRows: DbTournamentGameRow[] = games.map((g: Record<string, unknown>) => ({
    id: safeNum(g.id),
    round: safeNum(g.round),
    status: String(g.status ?? ""),
    team_a_id: safeNum(g.team_a_id),
    team_b_id: safeNum(g.team_b_id),
    team_a_score: g.team_a_score != null ? safeNum(g.team_a_score) : null,
    team_b_score: g.team_b_score != null ? safeNum(g.team_b_score) : null
  }));

  const gameRowsWithTime = games.map((g: Record<string, unknown>) => ({
    id: safeNum(g.id),
    round: safeNum(g.round),
    status: String(g.status ?? ""),
    start_time: String(g.start_time ?? ""),
    team_a_id: safeNum(g.team_a_id),
    team_b_id: safeNum(g.team_b_id),
    team_a_score: g.team_a_score != null ? safeNum(g.team_a_score) : null,
    team_b_score: g.team_b_score != null ? safeNum(g.team_b_score) : null
  }));

  const poolIdSetForTeams = new Set(playerIds.filter((id) => id > 0));
  const extraTeamIdsForMerge: number[] = [];
  if (poolIdSetForTeams.size > 0) {
    for (const idChunk of chunkIds([...poolIdSetForTeams], POOL_PLAYERS_IN_CHUNK)) {
      const { data: pt } = await supabase
        .from("players")
        .select("team_id")
        .eq("season_year", seasonYear)
        .in("id", idChunk);
      for (const row of pt ?? []) {
        const tid = safeNum((row as { team_id?: unknown }).team_id);
        if (tid > 0) extraTeamIdsForMerge.push(tid);
      }
    }
  }

  const teamsRows = await fetchTournamentSeasonTeamsMerged(
    supabase,
    seasonYear,
    extraTeamIdsForMerge,
    "id, overall_seed, external_team_id, seed"
  );

  const teamIdByExternalTeamId = new Map<string, number>(
    teamsRows.map((t) => [
      String((t as Record<string, unknown>).external_team_id ?? ""),
      safeNum((t as Record<string, unknown>).id)
    ])
  );

  const overallRankByTeamId = new Map<number, number | null>(
    teamsRows.map((t) => {
      const tr = t as Record<string, unknown>;
      return [
        safeNum(tr.id),
        tr.overall_seed != null ? safeNum(tr.overall_seed) : null
      ] as const;
    })
  );

  const teamIds = Array.from(new Set(teamsRows.map((t) => safeNum((t as Record<string, unknown>).id)))).filter(
    (id) => id > 0
  );
  const seasonTeamIdSet = new Set(teamIds);

  const dbGameRowsSeason = dbGameRows.filter(
    (g) => seasonTeamIdSet.has(g.team_a_id) || seasonTeamIdSet.has(g.team_b_id)
  );
  const gameRowsWithTimeSeason = gameRowsWithTime.filter(
    (g) => seasonTeamIdSet.has(g.team_a_id) || seasonTeamIdSet.has(g.team_b_id)
  );

  // Live UI should consider all synced tournament rows; season/team linkage can drift in production.
  const gameRowsWithTimeForLiveUi = gameRowsWithTime;

  let bracketState: BracketState = { seasonYear, games: [] };
  try {
    bracketState = await buildBracketStateFromHenrygdAndDb({
      seasonYear,
      teamIdByExternalTeamId,
      dbGames: dbGameRowsSeason,
      overallRankByTeamId
    });
  } catch {
    bracketState = { seasonYear, games: [] };
  }

  const gameSideTeamIds = new Set<number>();
  for (const g of gameRowsWithTime) {
    if (g.team_a_id > 0) gameSideTeamIds.add(g.team_a_id);
    if (g.team_b_id > 0) gameSideTeamIds.add(g.team_b_id);
  }
  const allCanonTeamIds = [...new Set<number>([...teamIds, ...gameSideTeamIds])];
  const canonRows = await fetchTeamRowsForCanonicalKeys(supabase, allCanonTeamIds);
  const canonRowById = new Map<number, TeamRowForCanonical>();
  for (const row of canonRows) {
    const id = safeNum(row.id);
    if (id > 0) canonRowById.set(id, row);
  }
  const canonicalByInternalTeamId = new Map<number, string>();
  for (const id of allCanonTeamIds) {
    const row = canonRowById.get(id);
    canonicalByInternalTeamId.set(id, row ? resolveCanonicalTeamKeyFromRow(row) : `__id_${id}`);
  }
  reconcileCanonicalTeamIdsFromRows(canonRows, canonicalByInternalTeamId);

  const nowMs = Date.now();
  const liveGameRows = gameRowsWithTimeForLiveUi.filter((g) =>
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
  const teamIdsInLiveGame = new Set<number>();
  for (const g of liveGameRows) {
    if (g.team_a_id > 0) teamIdsInLiveGame.add(g.team_a_id);
    if (g.team_b_id > 0) teamIdsInLiveGame.add(g.team_b_id);
  }
  if (teamIdsInLiveGame.size > 0) {
    const liveCanonKeys = new Set<string>();
    for (const tid of teamIdsInLiveGame) {
      const k = canonicalByInternalTeamId.get(tid);
      if (k) liveCanonKeys.add(k);
    }
    for (const id of allCanonTeamIds) {
      const k = canonicalByInternalTeamId.get(id);
      if (k && liveCanonKeys.has(k)) teamIdsInLiveGame.add(id);
    }
  }

  const eliminationRoundByCanonical = buildEliminationRoundByCanonicalFromGames(
    gameRowsWithTime,
    canonicalByInternalTeamId,
    canonRowById
  );

  function isInternalTeamIdEliminated(tid: number): boolean {
    const slug = stablePoolSlugForTeamContext(tid, canonicalByInternalTeamId, canonRowById);
    return slug != null && eliminationRoundByCanonical.has(slug);
  }

  const allTeams = new Map<string, { overallRank: number; isActive: boolean }>();
  for (const teamId of teamIds) {
    const os = overallRankByTeamId.get(teamId);
    const rank = os != null && os > 0 ? os : 999;
    allTeams.set(String(teamId), {
      overallRank: rank,
      isActive: !isInternalTeamIdEliminated(teamId)
    });
  }

  // R1–R6 game id → round for all tournament rows in DB (not season-filtered). Season-scoped game sets often
  // ended up empty when `games.team_*_id` did not overlap `teams` rows for `%-{seasonYear}` (import/sync drift),
  // which skipped stats entirely. Chunked queries avoid PostgREST row caps.
  const gameIdToRound = new Map<number, number>();
  for (const g of dbGameRows) {
    gameIdToRound.set(g.id, g.round);
  }
  const tournamentGameIdSet = new Set(gameIdToRound.keys());
  const gameTeamByGameId = new Map<number, { a: number; b: number }>();
  for (const g of dbGameRows) {
    gameTeamByGameId.set(g.id, { a: g.team_a_id, b: g.team_b_id });
  }

  const maxLiveOrFinalDbRound = maxDbRoundAmongLiveOrFinal(dbGameRows);
  const finalFantasyRoundBucketsByCanonical = buildFinalFantasyRoundBucketsByCanonicalTeam({
    games: dbGameRows,
    canonForTeamId: (tid) => stablePoolSlugForTeamContext(tid, canonicalByInternalTeamId, canonRowById)
  });
  const gameIdToScoringMeta = new Map<number, { status: string; round: number }>();
  for (const g of dbGameRows) {
    gameIdToScoringMeta.set(g.id, { status: g.status, round: g.round });
  }

  const statsByPlayer = new Map<number, Array<{ points: unknown }>>();
  const pointsByDisplayRoundByPlayer = new Map<number, Record<number, number>>();
  const tournamentStatGameIdsByPlayerId = new Map<number, Set<number>>();
  const poolIdSet = new Set(playerIds.filter((id) => id > 0));

  if (poolIdSet.size > 0) {
    const poolRows: {
      id: number;
      team_id: number;
      name: string;
      henrygd_boxscore_player_id?: string | null;
      external_player_id?: string | null;
    }[] = [];
    for (const idChunk of chunkIds([...poolIdSet], POOL_PLAYERS_IN_CHUNK)) {
      const { data: poolPlayerRows } = await supabase
        .from("players")
        .select("id, team_id, name, henrygd_boxscore_player_id, external_player_id")
        .eq("season_year", seasonYear)
        .in("id", idChunk);
      poolRows.push(...((poolPlayerRows ?? []) as typeof poolRows));
    }

    const pgs: PgsRow[] = [];
    const seenPgs = new Set<string>();
    const allGameIds = [...tournamentGameIdSet];
    if (allGameIds.length > 0) {
      for (const idChunk of chunkIds(allGameIds, PLAYER_GAME_STATS_GAME_ID_CHUNK)) {
        const part = await fetchPgsByGameIds(supabase, idChunk);
        mergeDedupedPlayerGameStats(pgs, seenPgs, part, gameIdToRound);
      }
    }
    for (const pidChunk of chunkIds([...poolIdSet], PLAYER_GAME_STATS_PLAYER_ID_CHUNK)) {
      const part = await fetchPgsByPlayerIds(supabase, pidChunk);
      mergeDedupedPlayerGameStats(pgs, seenPgs, part, gameIdToRound);
    }

    const statPlayerIds = [
      ...new Set((pgs ?? []).map((r) => safeNum((r as { player_id: unknown }).player_id)).filter((id) => id > 0))
    ];

    /** `${team_id}:${henrygdBoxscorePlayerId}` → canonical pool `players.id` */
    const henrygdKeyToPoolId = new Map<string, number>();
    /** `${canonicalSlug}:${normalizedName}` → canonical pool `players.id` */
    const canonicalNameToPoolId = new Map<string, number>();
    for (const pp of poolRows) {
      const tid = safeNum(pp.team_id);
      const pid = safeNum(pp.id);
      const nk = normalizePlayerNameForMatch(String(pp.name ?? ""));
      if (tid > 0 && pid > 0 && nk) {
        const canon = stablePoolSlugForTeamContext(tid, canonicalByInternalTeamId, canonRowById);
        if (canon) canonicalNameToPoolId.set(`${canon}:${nk}`, pid);
      }
      const hid =
        pp.henrygd_boxscore_player_id?.trim() ||
        parseHenrygdBoxscorePlayerIdFromExternal(pp.external_player_id ?? null);
      if (tid != null && tid > 0 && pid != null && pid > 0 && hid) {
        henrygdKeyToPoolId.set(`${tid}:${hid}`, pid);
      }
    }

    let statPlayerRows: {
      id: number;
      team_id: number;
      name: string;
      henrygd_boxscore_player_id?: string | null;
      external_player_id?: string | null;
    }[] = [];
    if (statPlayerIds.length > 0) {
      for (const idChunk of chunkIds(statPlayerIds, 120)) {
        const { data: spr } = await supabase
          .from("players")
          .select("id, team_id, name, henrygd_boxscore_player_id, external_player_id")
          .in("id", idChunk);
        statPlayerRows.push(...((spr ?? []) as typeof statPlayerRows));
      }
    }

    /** Map box-score `players.id` → canonical pool row `id` (roster import / henrygd link). */
    const statPlayerToPoolId = new Map<number, number>();
    for (const sp of statPlayerRows) {
      const sid = safeNum(sp.id);
      if (sid <= 0) continue;
      if (poolIdSet.has(sid)) {
        statPlayerToPoolId.set(sid, sid);
        continue;
      }
      const tid = safeNum(sp.team_id);
      const hgRaw =
        sp.henrygd_boxscore_player_id?.trim() ||
        parseHenrygdBoxscorePlayerIdFromExternal(sp.external_player_id ?? null);
      if (hgRaw && tid > 0) {
        const canon = henrygdKeyToPoolId.get(`${tid}:${hgRaw}`);
        if (canon != null && canon > 0) {
          statPlayerToPoolId.set(sid, canon);
          continue;
        }
      }
      const nk = normalizePlayerNameForMatch(String(sp.name ?? ""));
      if (!nk) continue;
      const canonSlug = stablePoolSlugForTeamContext(tid, canonicalByInternalTeamId, canonRowById);
      if (canonSlug) {
        const canonPid = canonicalNameToPoolId.get(`${canonSlug}:${nk}`);
        if (canonPid != null && canonPid > 0) {
          statPlayerToPoolId.set(sid, canonPid);
          continue;
        }
      }
      const match = poolRows.find(
        (pp) => safeNum(pp.team_id) === tid && normalizePlayerNameForMatch(String(pp.name ?? "")) === nk
      );
      if (match) statPlayerToPoolId.set(sid, safeNum(match.id));
    }

    const statPlayerById = new Map<number, (typeof statPlayerRows)[0]>();
    for (const sp of statPlayerRows) {
      const sid = safeNum(sp.id);
      if (sid > 0) statPlayerById.set(sid, sp);
    }

    for (const row of pgs ?? []) {
      const statPid = safeNum(row.player_id);
      let poolPid = statPlayerToPoolId.get(statPid) ?? (poolIdSet.has(statPid) ? statPid : null);
      if (poolPid == null) {
        const spRow = statPlayerById.get(statPid);
        const gid = safeNum(row.game_id);
        const gt = gameTeamByGameId.get(gid);
        if (spRow && gt) {
          const nk = normalizePlayerNameForMatch(String(spRow.name ?? ""));
          if (nk) {
            const match = poolRows.find(
              (pp) =>
                (safeNum(pp.team_id) === gt.a || safeNum(pp.team_id) === gt.b) &&
                normalizePlayerNameForMatch(String(pp.name ?? "")) === nk
            );
            if (match) {
              poolPid = safeNum(match.id);
              statPlayerToPoolId.set(statPid, poolPid);
            }
          }
        }
      }
      if (poolPid == null || !poolIdSet.has(poolPid)) continue;

      const gid = safeNum(row.game_id);
      const meta = gameIdToScoringMeta.get(gid);
      if (!meta) continue;
      if (!includePlayerGameStatInFantasyTotals(meta.status, meta.round, maxLiveOrFinalDbRound)) continue;

      const arr = statsByPlayer.get(poolPid) ?? [];
      arr.push({ points: row.points });
      statsByPlayer.set(poolPid, arr);

      const embedded = row.games?.round;
      const gr =
        embedded != null && embedded !== "" ? safeNum(embedded) : gameIdToRound.get(gid);
      if (gr === undefined) continue;
      const bucket = fantasyRoundBucketFromDbRound(gr);
      if (bucket == null) continue;
      const pts = safeNum(row.points);
      const byR = pointsByDisplayRoundByPlayer.get(poolPid) ?? {};
      byR[bucket] = (byR[bucket] ?? 0) + pts;
      pointsByDisplayRoundByPlayer.set(poolPid, byR);

      const gids = tournamentStatGameIdsByPlayerId.get(poolPid) ?? new Set<number>();
      gids.add(gid);
      tournamentStatGameIdsByPlayerId.set(poolPid, gids);
    }

    for (const pp of poolRows) {
      const poolPid = safeNum(pp.id);
      const tid = safeNum(pp.team_id);
      if (poolPid <= 0 || tid <= 0) continue;
      const canon = stablePoolSlugForTeamContext(tid, canonicalByInternalTeamId, canonRowById);
      const dnpBuckets = canon ? finalFantasyRoundBucketsByCanonical.get(canon) : undefined;
      if (!dnpBuckets || dnpBuckets.size === 0) continue;
      const byR = pointsByDisplayRoundByPlayer.get(poolPid) ?? {};
      applyDnpZerosForFinalFantasyBuckets(byR, dnpBuckets);
      pointsByDisplayRoundByPlayer.set(poolPid, byR);
    }
  }

  const hasLiveGames = liveGameRows.length > 0;

  let expectedChalkGamesTotalByTeamId = new Map<number, number>();
  try {
    const metaByTeamId = new Map<number, ChalkTeamMeta>();
    for (const tr of teamsRows) {
      const row = tr as { id: unknown; overall_seed?: unknown; seed?: unknown };
      const id = safeNum(row.id);
      if (id <= 0) continue;
      metaByTeamId.set(id, {
        teamId: id,
        overallSeed: row.overall_seed != null ? safeNum(row.overall_seed) : null,
        regionalSeed: row.seed != null ? safeNum(row.seed) : null
      });
    }
    expectedChalkGamesTotalByTeamId = await computeExpectedChalkGamesPlayedFromBracket({
      seasonYear,
      metaByTeamId,
      teamIdByExternalTeamId
    });
  } catch {
    expectedChalkGamesTotalByTeamId = new Map();
  }

  const completedTournamentGamesByTeamId = new Map<number, number>();
  for (const tid of teamIds) {
    completedTournamentGamesByTeamId.set(tid, countPlayedTournamentGamesForTeam(tid, dbGameRows));
  }

  return {
    bracketState,
    allTeams,
    statsByPlayer,
    pointsByDisplayRoundByPlayer,
    hasLiveGames,
    teamIdsInLiveGame,
    expectedChalkGamesTotalByTeamId,
    completedTournamentGamesByTeamId,
    tournamentStatGameIdsByPlayerId
  };
}

export function playerTournamentProjectionsCore(opts: {
  teamId: number;
  seasonPpg: unknown;
  actualTournamentPoints: number;
  teamEliminated: boolean;
  bracketState: BracketState;
  allTeams: Map<string, { overallRank: number; isActive: boolean }>;
  expectedChalkGamesTotalByTeamId: Map<number, number>;
  completedTournamentGamesByTeamId: Map<number, number>;
  /**
   * When set (e.g. distinct stat game_ids for this player), used with
   * `Math.max(teamPlayed, this)` so box scores tied to `game_id` still reduce chalk remaining if `games.team_*_id` is off.
   */
  statDistinctGameCount?: number;
}): PlayerTournamentProjectionDetail {
  const tid = opts.teamId;
  const ppg = seasonPpgOrDefault(opts.seasonPpg);
  const actual = opts.actualTournamentPoints;
  const eliminated = opts.teamEliminated;

  const teamPlayed = opts.completedTournamentGamesByTeamId.get(tid) ?? 0;
  const statN = opts.statDistinctGameCount ?? 0;
  const played = Math.max(teamPlayed, statN);
  const overallRank = opts.allTeams.get(String(tid))?.overallRank ?? null;
  const effectiveOriginalG = fallbackOriginalGamesFromOverallRank(overallRank);

  const liveRemaining = eliminated ? 0 : Math.max(0, effectiveOriginalG - played);

  const liveProjection = calculatePlayerProjectionInt({
    seasonPpg: ppg,
    actualTournamentPoints: actual,
    teamEliminated: eliminated,
    expectedRemainingGames: liveRemaining
  });

  const originalProjection = Math.round(ppg * effectiveOriginalG);

  return {
    originalProjection,
    liveProjection,
    expectedChalkGamesTotal: effectiveOriginalG,
    completedTournamentGames: played,
    liveExpectedChalkGamesRemaining: liveRemaining
  };
}

export function playerTournamentProjections(opts: {
  teamId: number;
  playerId: number;
  seasonPpg: unknown;
  bundle: SeasonProjectionBundle;
}): PlayerTournamentProjectionDetail {
  const tid = opts.teamId;
  const actual = sumPointsFromPlayerGameStats(opts.bundle.statsByPlayer.get(opts.playerId) ?? []);
  const meta = opts.bundle.allTeams.get(String(tid));
  const eliminated = meta ? !meta.isActive : false;
  const statDistinctGameCount = opts.bundle.tournamentStatGameIdsByPlayerId.get(opts.playerId)?.size ?? 0;
  return playerTournamentProjectionsCore({
    teamId: tid,
    seasonPpg: opts.seasonPpg,
    actualTournamentPoints: actual,
    teamEliminated: eliminated,
    bracketState: opts.bundle.bracketState,
    allTeams: opts.bundle.allTeams,
    expectedChalkGamesTotalByTeamId: opts.bundle.expectedChalkGamesTotalByTeamId,
    completedTournamentGamesByTeamId: opts.bundle.completedTournamentGamesByTeamId,
    statDistinctGameCount
  });
}

/** Live projection only; see {@link playerTournamentProjections} for original + breakdown. */
export function projectionIntForPlayer(opts: {
  teamId: number;
  playerId: number;
  seasonPpg: unknown;
  bundle: SeasonProjectionBundle;
}): number {
  return playerTournamentProjections(opts).liveProjection;
}
