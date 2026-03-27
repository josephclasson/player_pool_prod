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

/**
 * True when a row should drive “playing live” UI: explicit live (or synonym) status, or `scheduled/pre`
 * with a positive combined score after tip (status often lags the scoreboard in prod).
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

  /* DB row can lag `scheduled` while scores already update (esp. when sync writes 0–0 before tip). */
  const sa = g.team_a_score;
  const sb = g.team_b_score;
  const a = typeof sa === "number" ? sa : sa != null ? Number(sa) : NaN;
  const b = typeof sb === "number" ? sb : sb != null ? Number(sb) : NaN;
  const sum = (Number.isFinite(a) ? a : 0) + (Number.isFinite(b) ? b : 0);
  const s = String(g.status ?? "").trim().toLowerCase();
  const preLike = s === "scheduled" || s === "pre" || s === "pre_game" || s === "pregame";
  const maxScheduledButScoringMs = 6 * 60 * 60 * 1000;
  if (
    preLike &&
    sum > 0 &&
    Number.isFinite(startMs) &&
    nowMs - startMs <= maxScheduledButScoringMs
  ) {
    return true;
  }

  return false;
}
