/** Minimal slice of roster player rows (Leaderboard / StatTracker payloads). */
export type RosterPlayerTqsInput = {
  overallSeed: number | null;
  team: { seed: number | null } | null;
};

/**
 * Post-tournament roster “Team Quality Score” (TQS) adjustment.
 *
 * Mirrors `scripts/roster_tqs_adjustment.py`. Tune weights here (and in Python) together.
 *
 * **TQS (per NCAA team)** — higher = stronger team (easier path / better seeding):
 *   `tqs = w_r * (69 - overall_rank) + w_s * (17 - seed)`
 *   - overall_rank: 1 = best S-curve team … 68 = worst
 *   - seed: regional pod seed 1 = best … 16 = worst
 *
 * **Roster TQS** — mean TQS across drafted players’ teams (uses each player’s
 * `overallSeed` + `team.seed` from the leaderboard payload).
 *
 * **Adjustment** — `k * (league_avg_roster_tqs - roster_tqs)` bumps weaker
 * (lower TQS) rosters up and pulls stronger rosters down, in raw points.
 *
 * **Tuning `k`** — scale to your league’s raw totals. If totals are usually
 * ~200–400, try `k` between 0.8 and 1.5; raise `k` for a stronger correction.
 */

/** Weight on `(69 - overall_rank)`. */
export const ROSTER_TQS_WEIGHT_RANK = 1.0;

/** Weight on `(17 - regional_seed)` — ~2× rank weight (bracket path). */
export const ROSTER_TQS_WEIGHT_SEED = 2.0;

/**
 * Points multiplier for `(league_avg - roster_tqs)`.
 * Increase if adjustments feel too small vs typical raw totals.
 */
export const ROSTER_TQS_K = 1.0;

export function calculateTeamTqs(
  overallRank: number | null | undefined,
  regionalSeed: number | null | undefined,
  wR: number = ROSTER_TQS_WEIGHT_RANK,
  wS: number = ROSTER_TQS_WEIGHT_SEED
): number | null {
  const r =
    overallRank != null && Number.isFinite(Number(overallRank))
      ? Math.round(Number(overallRank))
      : NaN;
  const s =
    regionalSeed != null && Number.isFinite(Number(regionalSeed))
      ? Math.round(Number(regionalSeed))
      : NaN;
  if (r < 1 || r > 68 || s < 1 || s > 16) return null;
  return wR * (69 - r) + wS * (17 - s);
}

/** Mean TQS over roster players with valid team quality inputs; null if none. */
export function rosterMeanTqsFromPlayers(
  players: RosterPlayerTqsInput[] | undefined,
  wR: number = ROSTER_TQS_WEIGHT_RANK,
  wS: number = ROSTER_TQS_WEIGHT_SEED
): number | null {
  if (!players?.length) return null;
  const vals: number[] = [];
  for (const p of players) {
    const tqs = calculateTeamTqs(p.overallSeed, p.team?.seed ?? null, wR, wS);
    if (tqs != null) vals.push(tqs);
  }
  if (vals.length === 0) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

export type RosterTqsAdjustmentRow = {
  rosterTqs: number | null;
  /** Same for every roster in the league when any roster has a TQS; else null. */
  leagueAvgRosterTqs: number | null;
  /** Points added (can be negative). Zero when TQS data insufficient. */
  tqsAdjustment: number;
  adjustedTotalScore: number;
};

/**
 * League-wide adjustments. Only rosters with at least one valid per-player TQS
 * participate in `leagueAvgRosterTqs`; others get 0 adjustment.
 */
export function computeRosterTqsAdjustmentsForLeague(
  teams: Array<{
    leagueTeamId: string;
    totalScore: number;
    players?: RosterPlayerTqsInput[];
  }>,
  options?: { wR?: number; wS?: number; k?: number }
): Map<string, RosterTqsAdjustmentRow> {
  const wR = options?.wR ?? ROSTER_TQS_WEIGHT_RANK;
  const wS = options?.wS ?? ROSTER_TQS_WEIGHT_SEED;
  const k = options?.k ?? ROSTER_TQS_K;

  const rosterTqsById = new Map<string, number | null>();
  const defined: number[] = [];
  for (const t of teams) {
    const rt = rosterMeanTqsFromPlayers(t.players, wR, wS);
    rosterTqsById.set(t.leagueTeamId, rt);
    if (rt != null) defined.push(rt);
  }

  const leagueAvg = defined.length > 0 ? defined.reduce((a, b) => a + b, 0) / defined.length : null;

  const out = new Map<string, RosterTqsAdjustmentRow>();
  for (const t of teams) {
    const rosterTqs = rosterTqsById.get(t.leagueTeamId) ?? null;
    let tqsAdjustment = 0;
    if (rosterTqs != null && leagueAvg != null) {
      tqsAdjustment = k * (leagueAvg - rosterTqs);
    }
    const adjustedTotalScore = t.totalScore + tqsAdjustment;
    out.set(t.leagueTeamId, {
      rosterTqs,
      leagueAvgRosterTqs: leagueAvg,
      tqsAdjustment,
      adjustedTotalScore
    });
  }
  return out;
}
