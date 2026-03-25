import { MIN_POOL_SEASON_PPG } from "@/lib/player-pool-constants";

/**
 * Pool / draft: season PPG must be present and at least {@link MIN_POOL_SEASON_PPG} (blank / &lt; min excluded at data load).
 */
export function playerHasValidSeasonPpg(seasonPpg: unknown): boolean {
  if (seasonPpg == null) return false;
  if (typeof seasonPpg === "string" && seasonPpg.trim() === "") return false;
  const n = typeof seasonPpg === "number" ? seasonPpg : Number(seasonPpg);
  return Number.isFinite(n) && n >= MIN_POOL_SEASON_PPG;
}

/**
 * True when the NCAA team row looks like a tournament bracket team (overall seed 1–68).
 * (Diagnostics / future use; draft pool uses {@link playerHasValidSeasonPpg} only.)
 */
export function teamRowInTournamentBracket(team: Record<string, unknown> | null | undefined): boolean {
  if (!team) return false;
  const os = team.overall_seed;
  const n = typeof os === "number" ? os : Number(os);
  return Number.isFinite(n) && n >= 1 && n <= 68;
}

/** Draft / Player Statistics pool — must meet minimum season PPG (same bar as ESPN populate). */
export function playerEligibleForDraftAndPool(
  seasonPpg: unknown,
  _team: Record<string, unknown> | null | undefined
): boolean {
  void _team;
  return playerHasValidSeasonPpg(seasonPpg);
}
