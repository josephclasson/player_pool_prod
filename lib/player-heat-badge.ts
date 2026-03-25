/**
 * NCAA tournament "heat" badges: consecutive rounds with fantasy points strictly above season PPG.
 * Each R1–R6 bucket with box-score data counts as one tournament game appearance.
 */

export type HeatBadgeTier = "heating" | "on_fire" | "en_fuego";

export type HeatBadgeInfo = {
  tier: HeatBadgeTier;
  /** Consecutive above-PPG rounds (most recent backward, no gaps). */
  streak: number;
};

function pointsForRound(
  roundScores: Record<number, number | null | undefined> | undefined,
  r: number
): number | null {
  const v = roundScores?.[r];
  if (v === null || v === undefined) return null;
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/**
 * Rounds with posted scores, highest (most recent) first.
 */
export function roundsWithDataDescending(
  roundScores: Record<number, number | null | undefined> | undefined
): number[] {
  const out: number[] = [];
  for (let r = 6; r >= 1; r--) {
    if (pointsForRound(roundScores, r) !== null) out.push(r);
  }
  return out;
}

/**
 * Count consecutive tournament rounds (from most recent backward) where fantasy points > season PPG.
 * Streak breaks on: first round at or below PPG, or a missing round between counted rounds.
 */
export function computeConsecutiveAbovePpgStreak(
  roundScores: Record<number, number | null | undefined> | undefined,
  seasonPpg: number
): number {
  if (!Number.isFinite(seasonPpg)) return 0;
  const rounds = roundsWithDataDescending(roundScores);
  let streak = 0;
  for (let i = 0; i < rounds.length; i++) {
    const r = rounds[i];
    if (i > 0 && rounds[i - 1] !== r + 1) break;
    const pts = pointsForRound(roundScores, r);
    if (pts === null) break;
    if (pts > seasonPpg) streak++;
    else break;
  }
  return streak;
}

export function heatBadgeFromStreak(streak: number): HeatBadgeInfo | null {
  if (streak >= 4) return { tier: "en_fuego", streak };
  if (streak === 3) return { tier: "on_fire", streak };
  if (streak === 2) return { tier: "heating", streak };
  return null;
}

export function computeHeatBadgeInfo(
  roundScores: Record<number, number | null | undefined> | undefined,
  seasonPpg: number
): HeatBadgeInfo | null {
  return heatBadgeFromStreak(computeConsecutiveAbovePpgStreak(roundScores, seasonPpg));
}

const TIER_LABEL: Record<HeatBadgeTier, string> = {
  heating: "Heating Up",
  on_fire: "On Fire",
  en_fuego: "En Fuego"
};

/** Popover body (title is shown separately in the UI). */
export function heatBadgeTooltipBody(info: HeatBadgeInfo, seasonPpg: number): string {
  const ppg = Number.isFinite(seasonPpg) ? seasonPpg.toFixed(1) : "—";
  const roundsWord = info.streak === 1 ? "round" : "rounds";
  const tierRule =
    info.tier === "heating"
      ? "Heating Up after 2 straight tournament games above your season PPG."
      : info.tier === "on_fire"
        ? "On Fire after 3 straight tournament games above your season PPG."
        : "En Fuego after 4+ straight tournament games above your season PPG.";
  const tierExplain =
    info.tier === "heating"
      ? "Early ignition vs. your season scoring rate."
      : info.tier === "on_fire"
        ? "Sustained run vs. your season scoring rate."
        : "Peak stretch vs. your season scoring rate.";

  return `${tierRule} Streak: ${info.streak} ${roundsWord} above ${ppg} PPG. ${tierExplain} Each R1–R6 round with box-score data counts as one game; count runs from the most recent round backward with no gaps.`;
}

export function heatBadgeAriaLabel(info: HeatBadgeInfo, seasonPpg: number): string {
  return `${TIER_LABEL[info.tier]}. ${heatBadgeTooltipBody(info, seasonPpg)}`;
}

export function heatBadgeShortLabel(tier: HeatBadgeTier): string {
  return TIER_LABEL[tier];
}

/** Native `title` on legend rows (no player-specific PPG or streak). */
export function heatBadgeLegendExplainer(tier: HeatBadgeTier): string {
  const tierRule =
    tier === "heating"
      ? "Heating Up: 2 straight tournament games above season PPG."
      : tier === "on_fire"
        ? "On Fire: 3 straight tournament games above season PPG."
        : "En Fuego: 4+ straight tournament games above season PPG.";
  return `${tierRule} Each R1–R6 round with box-score data counts as one game; streak is unbroken from the most recent round backward. Hover the fire icon on a player row for streak vs. PPG.`;
}

/** Aligns with StatTracker `roundScores`: only rounds present in the API map count as played. */
export function roundScoresFromTournamentRoundPoints(
  tr: Record<string, number | undefined> | Record<number, number | undefined> | null | undefined
): Record<number, number | null | undefined> {
  if (!tr) return {};
  const raw = tr as Record<string, number | undefined>;
  const out: Record<number, number | null | undefined> = {};
  for (let r = 1; r <= 6; r++) {
    const sk = String(r);
    const hasKey =
      Object.prototype.hasOwnProperty.call(raw, sk) || Object.prototype.hasOwnProperty.call(raw, r);
    if (!hasKey) continue;
    const v = raw[sk] ?? raw[r];
    out[r] = typeof v === "number" && Number.isFinite(v) ? v : 0;
  }
  return out;
}
