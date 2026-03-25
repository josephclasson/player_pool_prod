/**
 * Convert model win probability (0–1) to common betting displays.
 * Uses fair / no-vig mapping from implied probability.
 */

/** `winPct` is 0–100 from the model. */
export function winProbabilityDecimal(winPct: number | null | undefined): number | null {
  if (winPct == null || !Number.isFinite(winPct)) return null;
  return winPct / 100;
}

/**
 * Human-style fractional odds: **"8:1"**-style (profit : stake) when the model is an underdog,
 * or **"1:4"** when a heavy favorite. Rounded to whole numbers like a book line.
 */
export function fractionalOddsLabelFromWinProbability(p: number): string | null {
  if (!Number.isFinite(p) || p <= 0 || p >= 1) return null;
  const profitPerUnitStake = (1 - p) / p;

  if (profitPerUnitStake >= 1) {
    const n = Math.max(1, Math.round(profitPerUnitStake));
    return `${n}:1`;
  }

  const stakePerUnitProfit = 1 / profitPerUnitStake;
  const m = Math.max(1, Math.round(stakePerUnitProfit));
  return `1:${m}`;
}

/**
 * American moneyline: negative favorite, positive underdog.
 */
export function americanOddsLabelFromWinProbability(p: number): string | null {
  if (!Number.isFinite(p) || p <= 0 || p >= 1) return null;
  if (p >= 0.5) {
    return String(Math.round((-100 * p) / (1 - p)));
  }
  return `+${Math.round((100 * (1 - p)) / p)}`;
}
