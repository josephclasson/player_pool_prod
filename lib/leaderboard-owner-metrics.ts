/**
 * Owner-level aggregates and Plackett–Luce win / top-3 probabilities for the Leaderboard tab.
 * Mirrors StatTracker’s `computeOwnerWinAndTop3Probabilities` and `rankAmongOwners` behavior.
 */

import { tournamentOuFromProjections } from "@/lib/tournament-total-ou";

export type LeaderboardOwnerPlayerMetrics = {
  tournamentRoundPoints: Record<number, number>;
  projection: number | null;
  eliminated: boolean;
  eliminatedRound: number | null;
  /**
   * When set from the leaderboard API: true if the team has **clinched** advancement past the league’s
   * active display round (final win in that round, or eliminated only in a later round).
   */
  advancedPastActiveRound?: boolean;
};

/** Map API roster rows to metrics inputs; missing elimination fields default to still alive. */
export function rosterPlayersToOwnerMetrics(
  players:
    | Array<{
        tournamentRoundPoints: Record<number, number>;
        projection: number | null;
        eliminated?: boolean;
        eliminatedRound?: number | null;
        advancedPastActiveRound?: boolean;
      }>
    | undefined
): LeaderboardOwnerPlayerMetrics[] {
  return (players ?? []).map((p) => ({
    tournamentRoundPoints: p.tournamentRoundPoints ?? {},
    projection: p.projection != null && Number.isFinite(Number(p.projection)) ? Number(p.projection) : null,
    eliminated: p.eliminated === true,
    eliminatedRound:
      p.eliminatedRound != null && Number.isFinite(Number(p.eliminatedRound))
        ? Math.trunc(Number(p.eliminatedRound))
        : null,
    advancedPastActiveRound:
      typeof p.advancedPastActiveRound === "boolean" ? p.advancedPastActiveRound : undefined
  }));
}

/** Projected standings rank by summed live projection (1 = highest projection). */
export function projectedRankByTeamId(
  teams: Array<{ leagueTeamId: string; ownerName: string; projection: number | null }>
): Map<string, number> {
  const eligible = teams
    .filter((t) => t.projection != null && Number.isFinite(Number(t.projection)))
    .map((t) => ({
      leagueTeamId: t.leagueTeamId,
      ownerName: t.ownerName,
      proj: Math.round(Number(t.projection))
    }));
  eligible.sort((a, b) => b.proj - a.proj || a.ownerName.localeCompare(b.ownerName));
  const m = new Map<string, number>();
  eligible.forEach((it, idx) => m.set(it.leagueTeamId, idx + 1));
  return m;
}

export type LeaderboardOwnerForProbabilities = {
  leagueTeamId: string;
  players: LeaderboardOwnerPlayerMetrics[];
};

export function displayTournamentRoundForAdvancement(currentRound: number): number {
  return currentRound <= 0 ? 1 : currentRound;
}

/**
 * True when the team has **already** advanced past the league’s active display round `R`:
 * they lost in a **later** round (survived R), or they are still alive and have a **final win**
 * recorded in bucket `R` (won the current-round game; not merely waiting or live).
 */
export function playerAdvancedPastLeagueActiveRound(opts: {
  currentRound: number;
  eliminated: boolean;
  eliminatedRound: number | null;
  playerCanonKey: string | null;
  finalWinBucketsByCanon: Map<string, Set<number>> | undefined;
}): boolean {
  const R = displayTournamentRoundForAdvancement(opts.currentRound);
  const er = opts.eliminatedRound;
  if (er != null) {
    return er > R;
  }
  if (opts.eliminated) return false;
  const canon = opts.playerCanonKey;
  if (!canon || !opts.finalWinBucketsByCanon) return false;
  return opts.finalWinBucketsByCanon.get(canon)?.has(R) ?? false;
}

export function playerAdvancedThroughCurrentRound(
  p: LeaderboardOwnerPlayerMetrics,
  currentRound: number
): boolean {
  if (typeof p.advancedPastActiveRound === "boolean") {
    return p.advancedPastActiveRound;
  }
  const R = displayTournamentRoundForAdvancement(currentRound);
  const er = p.eliminatedRound;
  if (er == null) {
    return !p.eliminated;
  }
  return er > R;
}

function computeOwnerTotalsFromPlayers(players: LeaderboardOwnerPlayerMetrics[]): {
  total: number;
  projection: number | null;
} {
  let total = 0;
  for (let r = 1; r <= 6; r++) {
    const vals = players
      .map((p) => p.tournamentRoundPoints[r])
      .filter((v): v is number => v != null && Number.isFinite(v));
    if (vals.length > 0) total += vals.reduce((a, b) => a + b, 0);
  }

  const allProjectionsKnown =
    players.length > 0 && players.every((p) => p.projection != null && Number.isFinite(p.projection));
  const projection = allProjectionsKnown
    ? players.reduce((sum, p) => sum + Math.round(Number(p.projection)), 0)
    : null;

  return { total, projection };
}

/**
 * Heuristic win and “in the money” (top 3) probabilities — full league cohort only.
 */
export function computeLeaderboardOwnerWinAndTop3Probabilities(
  owners: LeaderboardOwnerForProbabilities[],
  currentRound: number
): Map<string, { winPct: number; top3Pct: number }> {
  const out = new Map<string, { winPct: number; top3Pct: number }>();
  const n = owners.length;
  if (n === 0) return out;

  const projOrTotal: number[] = [];
  const fracRem: number[] = [];
  const fracAdv: number[] = [];

  for (const o of owners) {
    const { total, projection } = computeOwnerTotalsFromPlayers(o.players);
    const sz = o.players.length;
    const remN = sz === 0 ? 0 : o.players.filter((p) => !p.eliminated).length;
    const advN =
      sz === 0 ? 0 : o.players.filter((p) => playerAdvancedThroughCurrentRound(p, currentRound)).length;
    const p = projection != null && Number.isFinite(projection) ? projection : total;
    projOrTotal.push(p);
    fracRem.push(sz === 0 ? 0 : remN / sz);
    fracAdv.push(sz === 0 ? 0 : advN / sz);
  }

  const minMaxNorm = (xs: number[]): number[] => {
    const mn = Math.min(...xs);
    const mx = Math.max(...xs);
    const d = mx - mn || 1;
    return xs.map((x) => (x - mn) / d);
  };

  const nP = minMaxNorm(projOrTotal);
  const nR = minMaxNorm(fracRem);
  const nA = minMaxNorm(fracAdv);

  const W_PROJ = 0.52;
  const W_REM = 0.28;
  const W_ADV = 0.2;
  const EXP_SCALE = 2.35;

  const strengths = owners.map((_, i) => W_PROJ * nP[i] + W_REM * nR[i] + W_ADV * nA[i]);
  const weights = strengths.map((s) => 0.025 + Math.exp(s * EXP_SCALE));
  const sumW = weights.reduce((a, b) => a + b, 0);

  const kMoney = Math.min(3, n);
  const activeAll = owners.map((_, i) => i);

  function probInTopK(targetIndex: number, k: number, active: number[]): number {
    if (k <= 0) return 0;
    if (active.length === 0) return 0;
    if (!active.includes(targetIndex)) return 0;
    const sw = active.reduce((acc, i) => acc + weights[i], 0);
    if (sw <= 0) return 1 / active.length;

    let p = 0;
    for (const j of active) {
      const pickJ = weights[j] / sw;
      if (j === targetIndex) {
        p += pickJ;
      } else {
        p += pickJ * probInTopK(targetIndex, k - 1, active.filter((x) => x !== j));
      }
    }
    return p;
  }

  for (let i = 0; i < n; i++) {
    out.set(owners[i].leagueTeamId, {
      winPct: (weights[i] / sumW) * 100,
      top3Pct: probInTopK(i, kMoney, activeAll) * 100
    });
  }

  return out;
}

export function rankAmongOwners(
  entries: { ownerId: string; value: number | null }[],
  mode: "higher" | "lower"
): Map<string, { rank: number; pool: number }> {
  const eligible = entries.filter(
    (e): e is { ownerId: string; value: number } =>
      e.value != null && Number.isFinite(e.value)
  );
  eligible.sort((a, b) => {
    const cmp =
      mode === "higher"
        ? b.value - a.value || a.ownerId.localeCompare(b.ownerId)
        : a.value - b.value || a.ownerId.localeCompare(b.ownerId);
    return cmp;
  });
  const out = new Map<string, { rank: number; pool: number }>();
  const pool = eligible.length;
  let i = 0;
  while (i < eligible.length) {
    const v = eligible[i].value;
    let j = i + 1;
    while (j < eligible.length && eligible[j].value === v) j++;
    const rank = i + 1;
    for (let k = i; k < j; k++) out.set(eligible[k].ownerId, { rank, pool });
    i = j;
  }
  return out;
}

export type OwnerRankBundle = { rank: number | undefined; pool: number };

export function bundleRank(
  map: Map<string, { rank: number; pool: number }>,
  ownerId: string
): OwnerRankBundle {
  const hit = map.get(ownerId);
  return { rank: hit?.rank, pool: hit?.pool ?? 0 };
}

export type LeaderboardTeamRowInput = {
  leagueTeamId: string;
  ownerName: string;
  roundScores: Record<number, number>;
  totalScore: number;
  projection: number | null;
  projectionOriginal: number | null;
  players?: LeaderboardOwnerPlayerMetrics[];
  /** Quality-adjustment points (TQS column). */
  tqsAdjustment?: number | null;
  /** Raw total + TQS. */
  adjustedTotalScore?: number | null;
};

/**
 * Inline owner-vs-owner ranks for Leaderboard columns (higher is better).
 */
export function buildLeaderboardOwnerCategoryRanks(
  teams: LeaderboardTeamRowInput[],
  currentRound: number,
  outcomeProbByTeamId: Map<string, { winPct: number; top3Pct: number }>
): {
  winPct: Map<string, { rank: number; pool: number }>;
  moneyPct: Map<string, { rank: number; pool: number }>;
  remaining: Map<string, { rank: number; pool: number }>;
  advanced: Map<string, { rank: number; pool: number }>;
  r1: Map<string, { rank: number; pool: number }>;
  r2: Map<string, { rank: number; pool: number }>;
  r3: Map<string, { rank: number; pool: number }>;
  r4: Map<string, { rank: number; pool: number }>;
  r5: Map<string, { rank: number; pool: number }>;
  r6: Map<string, { rank: number; pool: number }>;
  total: Map<string, { rank: number; pool: number }>;
  origProj: Map<string, { rank: number; pool: number }>;
  liveProj: Map<string, { rank: number; pool: number }>;
  /** Ranks by O/U posted line (nearest ½, whole → x.5), not integer live projection. */
  tournamentOu: Map<string, { rank: number; pool: number }>;
  projPlusMinus: Map<string, { rank: number; pool: number }>;
  /** Higher adjustment = better (more points from quality correction). */
  tqsAdjustment: Map<string, { rank: number; pool: number }>;
  adjustedTotal: Map<string, { rank: number; pool: number }>;
} {
  const id = (t: LeaderboardTeamRowInput) => t.leagueTeamId;

  const remaining = (t: LeaderboardTeamRowInput) => {
    const pl = t.players;
    if (!pl || pl.length === 0) return null;
    return pl.filter((p) => !p.eliminated).length;
  };

  const advancedCount = (t: LeaderboardTeamRowInput) => {
    const pl = t.players;
    if (!pl || pl.length === 0) return null;
    return pl.filter((p) => playerAdvancedThroughCurrentRound(p, currentRound)).length;
  };

  const roundVal = (t: LeaderboardTeamRowInput, r: number): number | null => {
    const rs = t.roundScores ?? {};
    if (!Object.prototype.hasOwnProperty.call(rs, r)) return null;
    const v = rs[r];
    return typeof v === "number" && Number.isFinite(v) ? v : null;
  };

  const liveProjVal = (t: LeaderboardTeamRowInput): number | null =>
    t.projection != null && Number.isFinite(Number(t.projection)) ? Math.round(Number(t.projection)) : null;

  const origProjVal = (t: LeaderboardTeamRowInput): number | null =>
    t.projectionOriginal != null && Number.isFinite(Number(t.projectionOriginal))
      ? Math.round(Number(t.projectionOriginal))
      : null;

  const pmVal = (t: LeaderboardTeamRowInput): number | null => {
    const l = liveProjVal(t);
    const o = origProjVal(t);
    if (l == null || o == null) return null;
    return l - o;
  };

  const tqsAdjVal = (t: LeaderboardTeamRowInput): number | null => {
    const n = t.tqsAdjustment;
    return typeof n === "number" && Number.isFinite(n) ? n : null;
  };

  const adjTotalVal = (t: LeaderboardTeamRowInput): number | null => {
    const n = t.adjustedTotalScore;
    return typeof n === "number" && Number.isFinite(n) ? n : null;
  };

  const tournamentOuLineVal = (t: LeaderboardTeamRowInput): number | null => {
    const ou = tournamentOuFromProjections(t.projectionOriginal, t.projection);
    return ou?.line ?? null;
  };

  const winR = rankAmongOwners(
    teams.map((t) => ({
      ownerId: id(t),
      value: outcomeProbByTeamId.get(id(t))?.winPct ?? null
    })),
    "higher"
  );
  const moneyR = rankAmongOwners(
    teams.map((t) => ({
      ownerId: id(t),
      value: outcomeProbByTeamId.get(id(t))?.top3Pct ?? null
    })),
    "higher"
  );

  const remainingR = rankAmongOwners(
    teams.map((t) => ({ ownerId: id(t), value: remaining(t) })),
    "higher"
  );
  const advancedR = rankAmongOwners(
    teams.map((t) => ({ ownerId: id(t), value: advancedCount(t) })),
    "higher"
  );

  const mkRound = (r: number) =>
    rankAmongOwners(
      teams.map((t) => ({ ownerId: id(t), value: roundVal(t, r) })),
      "higher"
    );

  return {
    winPct: winR,
    moneyPct: moneyR,
    remaining: remainingR,
    advanced: advancedR,
    r1: mkRound(1),
    r2: mkRound(2),
    r3: mkRound(3),
    r4: mkRound(4),
    r5: mkRound(5),
    r6: mkRound(6),
    total: rankAmongOwners(
      teams.map((t) => ({
        ownerId: id(t),
        value: Number.isFinite(t.totalScore) ? t.totalScore : null
      })),
      "higher"
    ),
    origProj: rankAmongOwners(
      teams.map((t) => ({ ownerId: id(t), value: origProjVal(t) })),
      "higher"
    ),
    liveProj: rankAmongOwners(
      teams.map((t) => ({ ownerId: id(t), value: liveProjVal(t) })),
      "higher"
    ),
    tournamentOu: rankAmongOwners(
      teams.map((t) => ({ ownerId: id(t), value: tournamentOuLineVal(t) })),
      "higher"
    ),
    projPlusMinus: rankAmongOwners(
      teams.map((t) => ({ ownerId: id(t), value: pmVal(t) })),
      "higher"
    ),
    tqsAdjustment: rankAmongOwners(
      teams.map((t) => ({ ownerId: id(t), value: tqsAdjVal(t) })),
      "higher"
    ),
    adjustedTotal: rankAmongOwners(
      teams.map((t) => ({ ownerId: id(t), value: adjTotalVal(t) })),
      "higher"
    )
  };
}
