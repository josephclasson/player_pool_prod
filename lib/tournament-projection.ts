/**
 * NCAA tournament projection: no-upset simulation from the current bracket state.
 * Lower overall committee rank (1 = best) always wins future games; finalized games use actual winners.
 */

import { fetchHenrygdBracketGames, type BracketGame } from "@/lib/henrygd-bracket-seeds";
import { isFinalStatus, isLiveStatus } from "@/lib/chalk-remaining-games";

export type BracketGameStatus = "scheduled" | "live" | "final" | "missing";

/** Serializable snapshot for {@link calculateExpectedRemainingGames}. */
export type BracketState = {
  seasonYear: number;
  /**
   * All bracket matchups in round / bracketPosition order, with resolved team ids.
   * `simulatedWinnerId` = who advances under hybrid rules (actual final, score leader if live, else chalk).
   */
  games: ReadonlyArray<{
    bracketPositionId: number;
    round: number;
    teamAId: number;
    teamBId: number;
    gameStatus: BracketGameStatus;
    simulatedWinnerId: number;
  }>;
};

function safeNum(x: unknown): number {
  const n = typeof x === "number" ? x : Number(x);
  return Number.isFinite(n) ? n : 0;
}

function roundNumberFromBracketPositionId(bracketPositionId: number): number {
  return Math.floor(bracketPositionId / 100);
}

/** Lower rank wins (1 = best). */
export function favoriteTeamIdByOverallRank(
  teamAId: number,
  teamBId: number,
  overallRankByTeamId: ReadonlyMap<number, number | null>
): number {
  const ra = overallRankByTeamId.get(teamAId);
  const rb = overallRankByTeamId.get(teamBId);
  const oa = ra != null && ra > 0 ? ra : null;
  const ob = rb != null && rb > 0 ? rb : null;
  if (oa != null && ob != null && oa !== ob) return oa < ob ? teamAId : teamBId;
  if (oa != null && ob == null) return teamAId;
  if (ob != null && oa == null) return teamBId;
  return teamAId < teamBId ? teamAId : teamBId;
}

export type DbTournamentGameRow = {
  id: number;
  round: number;
  status: string;
  team_a_id: number;
  team_b_id: number;
  team_a_score: number | null;
  team_b_score: number | null;
};

function normalizePairKey(teamAId: number, teamBId: number, round: number): string {
  const lo = Math.min(teamAId, teamBId);
  const hi = Math.max(teamAId, teamBId);
  return `${round}:${lo}:${hi}`;
}

function buildDbGameIndex(rows: readonly DbTournamentGameRow[]): Map<string, DbTournamentGameRow> {
  const m = new Map<string, DbTournamentGameRow>();
  for (const g of rows) {
    m.set(normalizePairKey(g.team_a_id, g.team_b_id, g.round), g);
  }
  return m;
}

function statusFromDbRow(g: DbTournamentGameRow | undefined): BracketGameStatus {
  if (!g) return "missing";
  const s = String(g.status ?? "").trim().toLowerCase();
  if (isFinalStatus(s)) {
    const a = safeNum(g.team_a_score);
    const b = safeNum(g.team_b_score);
    // Scoreboard rows are often upserted as `final` with 0–0 (or ties) before a real result exists.
    // Count those as not finished so expected remaining games stays correct (e.g. 6 for a 1-seed path).
    if (a !== b) return "final";
    return "scheduled";
  }
  if (isLiveStatus(s)) return "live";
  return "scheduled";
}

function actualWinnerFromFinal(g: DbTournamentGameRow): number | null {
  if (!isFinalStatus(g.status)) return null;
  const a = safeNum(g.team_a_score);
  const b = safeNum(g.team_b_score);
  if (a > b) return g.team_a_id;
  if (b > a) return g.team_b_id;
  return null;
}

function hybridGameWinner(
  teamAId: number,
  teamBId: number,
  gameStatus: BracketGameStatus,
  dbRow: DbTournamentGameRow | undefined,
  overallRankByTeamId: ReadonlyMap<number, number | null>
): number {
  const chalk = favoriteTeamIdByOverallRank(teamAId, teamBId, overallRankByTeamId);
  if (gameStatus === "final" && dbRow) {
    const aw = actualWinnerFromFinal(dbRow);
    if (aw != null && (aw === teamAId || aw === teamBId)) return aw;
    return chalk;
  }
  if (gameStatus === "live" && dbRow) {
    const a = safeNum(dbRow.team_a_score);
    const b = safeNum(dbRow.team_b_score);
    if (a > b) return dbRow.team_a_id;
    if (b > a) return dbRow.team_b_id;
    return chalk;
  }
  return chalk;
}

type HenrygdPayloadGame = BracketGame;

/**
 * Build bracket state: henrygd structure + internal team ids + DB status + hybrid winner per slot.
 */
export async function buildBracketStateFromHenrygdAndDb(opts: {
  seasonYear: number;
  teamIdByExternalTeamId: ReadonlyMap<string, number>;
  dbGames: readonly DbTournamentGameRow[];
  /** `teams.id` → committee overall seed 1–68 (lower = better). */
  overallRankByTeamId: ReadonlyMap<number, number | null>;
}): Promise<BracketState> {
  const { seasonYear, teamIdByExternalTeamId, dbGames, overallRankByTeamId } = opts;
  const gamesRaw = await fetchHenrygdBracketGames(seasonYear);
  if (gamesRaw.length === 0) {
    return { seasonYear, games: [] };
  }

  const gameByBracketPos = new Map<number, HenrygdPayloadGame>(
    gamesRaw.map((g) => [g.bracketPositionId, g])
  );

  const feedersByVictorPos = new Map<number, HenrygdPayloadGame[]>();
  for (const g of gamesRaw) {
    if (g.victorBracketPositionId == null) continue;
    const arr = feedersByVictorPos.get(g.victorBracketPositionId) ?? [];
    arr.push(g);
    feedersByVictorPos.set(g.victorBracketPositionId, arr);
  }

  const dbIndex = buildDbGameIndex(dbGames);
  const winnerByBracketPos = new Map<number, number | null>();

  function resolveParticipantsForGame(game: HenrygdPayloadGame): [number | null, number | null] {
    const teams = game.teams ?? [];
    if (teams.length >= 2) {
      const t0 = teams[0]?.seoname ? `${teams[0].seoname}-${seasonYear}` : null;
      const t1 = teams[1]?.seoname ? `${teams[1].seoname}-${seasonYear}` : null;
      const id0 = t0 ? teamIdByExternalTeamId.get(t0) ?? null : null;
      const id1 = t1 ? teamIdByExternalTeamId.get(t1) ?? null : null;
      return [id0, id1];
    }

    const feeders = feedersByVictorPos.get(game.bracketPositionId) ?? [];
    if (feeders.length < 2) return [null, null];

    const w0 = resolveWinnerByBracketPos(feeders[0].bracketPositionId);
    const w1 = resolveWinnerByBracketPos(feeders[1].bracketPositionId);
    return [w0, w1];
  }

  function resolveWinnerByBracketPos(bracketPositionId: number): number | null {
    if (winnerByBracketPos.has(bracketPositionId)) return winnerByBracketPos.get(bracketPositionId) ?? null;
    const game = gameByBracketPos.get(bracketPositionId);
    if (!game) {
      winnerByBracketPos.set(bracketPositionId, null);
      return null;
    }

    const [a, b] = resolveParticipantsForGame(game);
    if (a == null || b == null || a <= 0 || b <= 0) {
      winnerByBracketPos.set(bracketPositionId, null);
      return null;
    }

    const round = roundNumberFromBracketPositionId(game.bracketPositionId);
    const mappedRound = round === 1 ? 0 : round - 1;
    const dbRow = dbIndex.get(normalizePairKey(a, b, mappedRound));
    const st = statusFromDbRow(dbRow);

    const winner = hybridGameWinner(a, b, st, dbRow, overallRankByTeamId);
    winnerByBracketPos.set(bracketPositionId, winner);
    return winner;
  }

  const positions = Array.from(gameByBracketPos.keys());
  positions.sort((x, y) => roundNumberFromBracketPositionId(x) - roundNumberFromBracketPositionId(y));
  for (const pos of positions) resolveWinnerByBracketPos(pos);

  const out: Array<BracketState["games"][number]> = [];

  for (const pos of positions) {
    const game = gameByBracketPos.get(pos);
    if (!game) continue;
    const [a, b] = resolveParticipantsForGame(game);
    if (a == null || b == null || a <= 0 || b <= 0) continue;

    const round = roundNumberFromBracketPositionId(game.bracketPositionId);
    const mappedRound = round === 1 ? 0 : round - 1;
    const dbRow = dbIndex.get(normalizePairKey(a, b, mappedRound));
    const gameStatus = statusFromDbRow(dbRow);
    const simulatedWinnerId = winnerByBracketPos.get(game.bracketPositionId) ?? hybridGameWinner(a, b, gameStatus, dbRow, overallRankByTeamId);

    out.push({
      bracketPositionId: game.bracketPositionId,
      round: mappedRound,
      teamAId: a,
      teamBId: b,
      gameStatus,
      simulatedWinnerId
    });
  }

  return { seasonYear, games: out };
}

/**
 * Additional not-yet-started games (scheduled / missing DB row) the team is expected to play
 * on their hybrid path. Final and live games do not add to this count (points come from actuals).
 *
 * First Four (`round` 0 in bracket state) is skipped so counts align with fantasy R1–R6 and chalk
 * sim totals that exclude play-in games.
 */
export function calculateExpectedRemainingGames(
  teamId: string,
  currentBracketState: BracketState,
  allTeams: Map<string, { overallRank: number; isActive: boolean }>
): number {
  const tid = safeNum(teamId);
  if (tid <= 0) return 0;
  const meta = allTeams.get(String(tid));
  if (meta && meta.isActive === false) return 0;

  const sorted = [...currentBracketState.games].sort((a, b) => {
    if (a.round !== b.round) return a.round - b.round;
    return a.bracketPositionId - b.bracketPositionId;
  });

  let alive = true;
  let remaining = 0;
  for (const g of sorted) {
    if (!alive) break;
    if (g.round < 1 || g.round > 6) continue;
    if (g.teamAId !== tid && g.teamBId !== tid) continue;

    if (g.gameStatus === "final") {
      if (g.simulatedWinnerId !== tid) alive = false;
      continue;
    }
    if (g.gameStatus === "live") {
      if (g.simulatedWinnerId !== tid) alive = false;
      continue;
    }
    remaining += 1;
    if (g.simulatedWinnerId !== tid) alive = false;
  }
  return remaining;
}

/**
 * Integer projection for one player.
 * Eliminated: sum of actual tournament points only.
 * Active: actual + seasonPpg × expectedRemainingGames.
 */
export function calculatePlayerProjectionInt(opts: {
  seasonPpg: number;
  actualTournamentPoints: number;
  teamEliminated: boolean;
  expectedRemainingGames: number;
}): number {
  const ppg = Number.isFinite(opts.seasonPpg) && opts.seasonPpg > 0 ? opts.seasonPpg : 0;
  if (opts.teamEliminated) {
    return Math.round(opts.actualTournamentPoints);
  }
  return Math.round(opts.actualTournamentPoints + ppg * opts.expectedRemainingGames);
}

/** Sum box-score points for stats rows (caller filters by player / games). */
export function sumPointsFromPlayerGameStats(
  statsRows: ReadonlyArray<{ points: unknown }>
): number {
  let sum = 0;
  for (const st of statsRows) {
    sum += safeNum(st.points);
  }
  return sum;
}

/**
 * R1–R6 games in `rows` where `teamId` played and the row is final with a decisive score.
 * Used to subtract completed chalk-path games from full-tournament expected games.
 */
export function countCompletedTournamentGamesForTeam(
  teamId: number,
  rows: readonly DbTournamentGameRow[]
): number {
  if (teamId <= 0) return 0;
  let n = 0;
  for (const g of rows) {
    if (g.round < 1 || g.round > 6) continue;
    if (g.team_a_id !== teamId && g.team_b_id !== teamId) continue;
    if (!isFinalStatus(g.status)) continue;
    const a = safeNum(g.team_a_score);
    const b = safeNum(g.team_b_score);
    if (a === b) continue;
    n += 1;
  }
  return n;
}

/**
 * R1–R6 games where `teamId` participates and the game already consumes a chalk “slot” for live projection:
 * `live`, or `final` / finished with a decisive score (excludes 0–0 placeholder finals).
 *
 * Use the same `games` rows you use for stats (typically all R1–R6 rows), not a season-filtered subset that
 * can drop rows when `team_*_id` drifts from `teams.id`.
 */
export function countPlayedTournamentGamesForTeam(
  teamId: number,
  rows: readonly DbTournamentGameRow[]
): number {
  if (teamId <= 0) return 0;
  let n = 0;
  for (const g of rows) {
    if (g.round < 1 || g.round > 6) continue;
    if (g.team_a_id !== teamId && g.team_b_id !== teamId) continue;
    const s = String(g.status ?? "").trim().toLowerCase();
    if (isLiveStatus(s)) {
      n += 1;
      continue;
    }
    if (isFinalStatus(s)) {
      const a = safeNum(g.team_a_score);
      const b = safeNum(g.team_b_score);
      if (a === b) continue;
      n += 1;
    }
  }
  return n;
}
