/**
 * Single place for fantasy round scoring rules (stat tracker + players pool).
 *
 * 1) Box-score rows count toward R1–R6 totals only once a game "counts" for scoring
 *    (final, live, or an older bracket round when the feed left status stuck on-scheduled).
 * 2) DNP zeros appear only for display rounds where the team already has a *final* game
 *    in that bucket — never for scheduled/live-in-progress games (avoids R3=0 before tip).
 */

import { isFinalStatus, isLiveStatus } from "@/lib/chalk-remaining-games";
import { participationBucketFromDbRound } from "@/lib/tournament-team-canonical";

function safeNum(x: unknown): number {
  const n = typeof x === "number" ? x : Number(x);
  return Number.isFinite(n) ? n : 0;
}

/** Highest DB `games.round` among live or final rows (same idea as league `currentRound` in scoring). */
export function maxDbRoundAmongLiveOrFinal(
  games: Array<{ status: string; round: number | unknown }>
): number {
  let m = 0;
  for (const g of games) {
    if (!isLiveStatus(g.status) && !isFinalStatus(g.status)) continue;
    const r = safeNum(g.round);
    if (r > m) m = r;
  }
  return m;
}

/**
 * Whether a `player_game_stats` row for this game may change displayed fantasy totals.
 * Excludes scheduled/pre so phantom 0-point rows do not populate a round before the game starts.
 */
export function includePlayerGameStatInFantasyTotals(
  gameStatus: string,
  gameDbRound: number,
  maxLiveOrFinalDbRound: number
): boolean {
  if (isFinalStatus(gameStatus) || isLiveStatus(gameStatus)) return true;
  return (
    maxLiveOrFinalDbRound > 0 &&
    gameDbRound > 0 &&
    gameDbRound < maxLiveOrFinalDbRound
  );
}

export type GameSideRowForFantasy = {
  status: string;
  round: number | unknown;
  team_a_id: number | unknown;
  team_b_id: number | unknown;
};

/**
 * Per canonical team slug: fantasy display buckets (1–6) where that team has a *finished* tournament game.
 * Used only to insert intentional DNP zeros when no stat line exists.
 */
export function buildFinalFantasyRoundBucketsByCanonicalTeam(opts: {
  games: GameSideRowForFantasy[];
  canonForTeamId: (internalTeamId: number) => string | null;
}): Map<string, Set<number>> {
  const out = new Map<string, Set<number>>();
  for (const g of opts.games) {
    if (!isFinalStatus(g.status)) continue;
    const bucket = participationBucketFromDbRound(safeNum(g.round));
    if (bucket == null) continue;
    const a = safeNum(g.team_a_id);
    const b = safeNum(g.team_b_id);
    for (const tid of [a, b]) {
      if (tid <= 0) continue;
      const canon = opts.canonForTeamId(tid);
      if (!canon) continue;
      if (!out.has(canon)) out.set(canon, new Set());
      out.get(canon)!.add(bucket);
    }
  }
  return out;
}

/** Union final-round buckets for roster player team vs slot team when canonical keys differ (alias IDs). */
export function finalFantasyBucketsForPlayerFromCanonSlots(opts: {
  finalBucketsByCanon: Map<string, Set<number>>;
  canonPlayer: string | null;
  canonSlot: string | null;
}): Set<number> {
  const acc = new Set<number>();
  if (opts.canonPlayer) {
    const s = opts.finalBucketsByCanon.get(opts.canonPlayer);
    if (s) for (const r of s) acc.add(r);
  }
  if (opts.canonSlot && opts.canonSlot !== opts.canonPlayer) {
    const s = opts.finalBucketsByCanon.get(opts.canonSlot);
    if (s) for (const r of s) acc.add(r);
  }
  return acc;
}

/** Set missing round keys to 0 only for rounds in `finalBuckets` (DNP after game is final). */
export function applyDnpZerosForFinalFantasyBuckets(
  pointsByRound: Record<number, number>,
  finalBuckets: Set<number> | undefined
): void {
  if (!finalBuckets || finalBuckets.size === 0) return;
  for (const r of finalBuckets) {
    if (!Object.prototype.hasOwnProperty.call(pointsByRound, r)) pointsByRound[r] = 0;
  }
}
