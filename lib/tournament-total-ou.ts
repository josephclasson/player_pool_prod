/**
 * Tournament fantasy-points total styled like a sportsbook game **Total** (O/U) —
 * half-point line with typical main-market prices on Over / Under.
 * Posted total follows **live** projected finish (updates as rounds/games progress), not a frozen opening line.
 * @see https://sportsbook.fanduel.com/navigation/ncaab — Total column lists the number; each side has a price (often −110).
 */

/** Nearest ½ point (e.g. 396.3 → 396.5). */
export function roundTotalToHalfPoint(points: number): number {
  if (!Number.isFinite(points)) return NaN;
  return Math.round(points * 2) / 2;
}

/**
 * Posted O/U line: round to nearest ½, then if that value is a whole number use **x.5** (book-style; e.g. 396 → 396.5).
 * Sorting, ranks, and display all use this value.
 */
export function postedOuLineFromPoints(points: number): number {
  if (!Number.isFinite(points)) return NaN;
  const half = roundTotalToHalfPoint(points);
  if (!Number.isFinite(half)) return NaN;
  return Number.isInteger(half) ? half + 0.5 : half;
}

/** Always one decimal place (396.5, 142.0). */
export function formatTournamentOuLine(line: number): string {
  if (!Number.isFinite(line)) return "—";
  return line.toFixed(1);
}

export type TournamentOuLean = "over" | "under" | "pick";

export type TournamentOuDisplay = {
  /** Posted O/U from live (½-point grid, whole numbers become x.5), or opening fallback when live is unknown. */
  line: number;
  /** Standard prices on each side for illustration (not a real market). */
  overAmerican: string;
  underAmerican: string;
  /** Whether live expected total is above / below / near the opening projection. */
  lean: TournamentOuLean | null;
};

const MAIN_MARKET_JUICE = "−110";

function finiteOrNull(n: number | null | undefined): number | null {
  if (n == null) return null;
  const x = Number(n);
  return Number.isFinite(x) ? x : null;
}

/**
 * Build display for one owner row. **Posted line** = live projected tournament total (½-point), so it moves each round
 * as projections refresh. Falls back to opening projection only when live is missing. Lean compares raw live vs opening.
 */
export function tournamentOuFromProjections(
  origProj: number | null | undefined,
  liveProj: number | null | undefined
): TournamentOuDisplay | null {
  const orig = finiteOrNull(origProj);
  const live = finiteOrNull(liveProj);
  const base = live != null ? live : orig;
  if (base == null) return null;
  const line = postedOuLineFromPoints(base);
  if (!Number.isFinite(line)) return null;

  let lean: TournamentOuLean | null = null;
  if (orig != null && live != null) {
    const d = live - orig;
    if (d > 1) lean = "over";
    else if (d < -1) lean = "under";
    else lean = "pick";
  }

  return {
    line,
    overAmerican: MAIN_MARKET_JUICE,
    underAmerican: MAIN_MARKET_JUICE,
    lean
  };
}

export function tournamentOuTooltip(
  ou: TournamentOuDisplay,
  currentTotalRounded: number,
  hasOpeningLine: boolean
): string {
  const openNote = hasOpeningLine
    ? "Posted line is live projected total (nearest ½, shown with one decimal; whole totals use x.5). Updates as the tournament progresses. Orig Proj is the opening reference."
    : "Posted line from live projection (nearest ½, one decimal; whole totals use x.5). No opening line on file.";
  const leanNote =
    ou.lean === "over"
      ? "Model expects to finish over the opening total."
      : ou.lean === "under"
        ? "Model expects to finish under the opening total."
        : ou.lean === "pick"
          ? "Live projection near opening total."
          : "Compare live vs opening projection when both exist.";
  return `${openNote} Current score ${currentTotalRounded}. Over and Under each shown at ${ou.overAmerican} (typical main-market juice, illustrative). ${leanNote}`.trim();
}
