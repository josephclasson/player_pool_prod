/**
 * Shared helpers for tournament game status (used by scoring + projection).
 */

/** Exported for scoring + sync (henrygd may vary casing). */
export function isFinalStatus(status: string): boolean {
  const s = String(status ?? "").trim().toLowerCase();
  // Providers vary: final, final_ot, post, finished, complete, closed, ended.
  return (
    s === "post" ||
    s === "finished" ||
    s === "complete" ||
    s === "closed" ||
    s === "ended" ||
    s.startsWith("final")
  );
}

export function isLiveStatus(status: string): boolean {
  const s = String(status ?? "").trim().toLowerCase();
  if (!s) return false;
  if (s === "live") return true;
  /* Some feeds / legacy rows before DB normalization. */
  if (s === "l") return true;
  const compact = s.replace(/\s+/g, "");
  if (compact === "inprogress" || s === "in_progress") return true;
  if (s === "progress") return true;
  return false;
}

/** Ignore “live” rows whose listed tipoff was more than this many ms ago (stuck provider state). */
export const MAX_TOURNAMENT_LIVE_GAME_AGE_MS = 8 * 60 * 60 * 1000;

/** Upper bound for treating `scheduled/pre` as underway when `status` lags the feed. */
const MAX_SCHEDULED_IN_PROGRESS_WINDOW_MS = 6 * 60 * 60 * 1000;

/**
 * True when a row should drive “playing live” UI: explicit live (or synonym) status, or a plausible
 * in-progress game while still `scheduled/pre` (bounded tipoff window; score updates can lag in prod).
 */
export function isPlausiblyLiveGameForUi(
  g: {
    status: string;
    start_time: string;
    team_a_score?: number | null;
    team_b_score?: number | null;
  },
  nowMs: number
): boolean {
  if (isFinalStatus(g.status)) return false;
  const startMs = new Date(g.start_time).getTime();
  const staleCutoff = nowMs - MAX_TOURNAMENT_LIVE_GAME_AGE_MS;
  if (Number.isFinite(startMs) && startMs < staleCutoff) return false;
  const tipGraceMs = 10 * 60 * 1000;
  if (Number.isFinite(startMs) && nowMs < startMs - tipGraceMs) return false;

  if (isLiveStatus(g.status)) return true;

  const s = String(g.status ?? "").trim().toLowerCase();
  const preLike =
    s === "scheduled" ||
    s === "pre" ||
    s === "pre_game" ||
    s === "pregame";
  if (preLike) {
    if (!Number.isFinite(startMs)) return false;
    if (nowMs - startMs > MAX_SCHEDULED_IN_PROGRESS_WINDOW_MS) return false;
    // Do not require scores here: some prod feeds keep scores null while game status lags.
    return nowMs >= startMs - 5 * 60 * 1000;
  }
  return false;
}
