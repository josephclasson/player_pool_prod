/**
 * Client-side polling for tournament tabs. Override via `NEXT_PUBLIC_*` (rebuild required).
 * Minimum 3s to avoid hammering APIs / HenryGD.
 */

function envMs(name: string, fallback: number, minMs = 3000): number {
  if (typeof process === "undefined") return fallback;
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= minMs ? Math.floor(n) : fallback;
}

/** Stat tracker background tick: tries live-sync, then falls back to GET. */
export function statTrackerPollIntervalMs(anyLiveGames: boolean): number {
  return anyLiveGames
    ? envMs("NEXT_PUBLIC_STAT_TRACKER_POLL_LIVE_MS", 12_000)
    : envMs("NEXT_PUBLIC_STAT_TRACKER_POLL_IDLE_MS", 36_000);
}

/**
 * Leaderboard + Players pool: backoff when repeated 304s (unchanged payload).
 * Push updates still arrive via `subscribeLeagueLiveScoreboard` when the cache row changes.
 */
export function adaptivePoolListPollMs(opts: {
  hasLiveGames: boolean;
  unchangedRefreshStreak: number;
}): number {
  const { hasLiveGames, unchangedRefreshStreak } = opts;
  if (hasLiveGames) {
    const fast = envMs("NEXT_PUBLIC_POOL_POLL_LIVE_FAST_MS", 10_000);
    const slow = envMs("NEXT_PUBLIC_POOL_POLL_LIVE_SLOW_MS", 24_000);
    return unchangedRefreshStreak >= 3 ? slow : fast;
  }
  const fast = envMs("NEXT_PUBLIC_POOL_POLL_IDLE_FAST_MS", 25_000);
  const slow = envMs("NEXT_PUBLIC_POOL_POLL_IDLE_SLOW_MS", 55_000);
  return unchangedRefreshStreak >= 2 ? slow : fast;
}

export function liveScoreboardPushDebounceMs(): number {
  return envMs("NEXT_PUBLIC_LIVE_SCOREBOARD_PUSH_DEBOUNCE_MS", 450, 100);
}
