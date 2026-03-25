/** Last active league UUID for tabs that don't receive `?leagueId=` (e.g. player statistics). */
export const PLAYER_POOL_ACTIVE_LEAGUE_ID_KEY = "player_pool_active_league_id";
/** When true, StatTracker shows the TPPG column and the TPPG−PPG +/− column. */
export const STAT_TRACKER_SHOW_TPPG_COLUMNS_KEY = "stat_tracker_show_tppg_columns";
/** @deprecated Old key; migrated once on read. */
const STAT_TRACKER_SHOW_PROJECTIONS_KEY_LEGACY = "stat_tracker_show_projections";
export const STAT_TRACKER_SHOW_INLINE_RANKS_KEY = "stat_tracker_show_inline_ranks";
/** Leaderboard: Win %, Odds, Line, Money % (default show). */
export const LEADERBOARD_SHOW_PROBABILITY_ODDS_KEY = "leaderboard_show_probability_odds";
export const PLAYER_STATS_SNAPSHOT_PREFIX = "player_stats_snapshot_v1";
export const LEADERBOARD_SNAPSHOT_PREFIX = "leaderboard_snapshot_v1";

export function readStoredActiveLeagueId(): string {
  if (typeof window === "undefined") return "";
  try {
    return localStorage.getItem(PLAYER_POOL_ACTIVE_LEAGUE_ID_KEY)?.trim() ?? "";
  } catch {
    return "";
  }
}

export function writeStoredActiveLeagueId(id: string): void {
  if (typeof window === "undefined") return;
  const t = id.trim();
  if (!t) return;
  try {
    localStorage.setItem(PLAYER_POOL_ACTIVE_LEAGUE_ID_KEY, t);
  } catch {
    /* private mode / quota */
  }
}

export function clearStoredActiveLeagueId(): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.removeItem(PLAYER_POOL_ACTIVE_LEAGUE_ID_KEY);
  } catch {
    /* ignore */
  }
}

/** `true` = show TPPG + TPPG−PPG columns (default). */
export function readStoredStatTrackerShowTppgColumns(): boolean {
  if (typeof window === "undefined") return true;
  try {
    const raw = localStorage.getItem(STAT_TRACKER_SHOW_TPPG_COLUMNS_KEY);
    if (raw != null) {
      if (raw === "1") return true;
      if (raw === "0") return false;
      return true;
    }
    // One-time migration: legacy key from older UI; default to showing TPPG cols.
    const legacy = localStorage.getItem(STAT_TRACKER_SHOW_PROJECTIONS_KEY_LEGACY);
    if (legacy != null) {
      localStorage.setItem(STAT_TRACKER_SHOW_TPPG_COLUMNS_KEY, "1");
      try {
        localStorage.removeItem(STAT_TRACKER_SHOW_PROJECTIONS_KEY_LEGACY);
      } catch {
        /* ignore */
      }
    }
    return true;
  } catch {
    return true;
  }
}

export function writeStoredStatTrackerShowTppgColumns(show: boolean): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(STAT_TRACKER_SHOW_TPPG_COLUMNS_KEY, show ? "1" : "0");
  } catch {
    /* private mode / quota */
  }
}

export function readStoredStatTrackerShowInlineRanks(): boolean {
  if (typeof window === "undefined") return true;
  try {
    const raw = localStorage.getItem(STAT_TRACKER_SHOW_INLINE_RANKS_KEY);
    if (raw == null) return true;
    if (raw === "1") return true;
    if (raw === "0") return false;
    return true;
  } catch {
    return true;
  }
}

export function writeStoredStatTrackerShowInlineRanks(show: boolean): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(STAT_TRACKER_SHOW_INLINE_RANKS_KEY, show ? "1" : "0");
  } catch {
    /* private mode / quota */
  }
}

/** `true` = show Probability & Odds columns on Leaderboard (default). */
export function readStoredLeaderboardShowProbabilityOddsColumns(): boolean {
  if (typeof window === "undefined") return true;
  try {
    const raw = localStorage.getItem(LEADERBOARD_SHOW_PROBABILITY_ODDS_KEY);
    if (raw == null) return true;
    if (raw === "1") return true;
    if (raw === "0") return false;
    return true;
  } catch {
    return true;
  }
}

export function writeStoredLeaderboardShowProbabilityOddsColumns(show: boolean): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(LEADERBOARD_SHOW_PROBABILITY_ODDS_KEY, show ? "1" : "0");
  } catch {
    /* private mode / quota */
  }
}

type StoredSnapshotEnvelope<T> = {
  savedAt: number;
  value: T;
};

type SnapshotIndexEntry = {
  key: string;
  savedAt: number;
};

function pruneSnapshotPrefix(prefix: string, maxEntries: number): void {
  if (typeof window === "undefined") return;
  try {
    const matches: SnapshotIndexEntry[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k || !k.startsWith(prefix)) continue;
      const raw = localStorage.getItem(k);
      if (!raw) continue;
      try {
        const parsed = JSON.parse(raw) as StoredSnapshotEnvelope<unknown>;
        const savedAt =
          typeof parsed?.savedAt === "number" && Number.isFinite(parsed.savedAt) ? parsed.savedAt : 0;
        matches.push({ key: k, savedAt });
      } catch {
        localStorage.removeItem(k);
      }
    }
    if (matches.length <= maxEntries) return;
    matches.sort((a, b) => b.savedAt - a.savedAt);
    for (const stale of matches.slice(maxEntries)) {
      localStorage.removeItem(stale.key);
    }
  } catch {
    /* ignore cleanup failures */
  }
}

export function playerStatsSnapshotKey(opts: {
  seasonYear: number;
  q: string;
  leagueId?: string | null;
}): string {
  const leaguePart = (opts.leagueId ?? "").trim() || "none";
  const qPart = opts.q.trim().toLowerCase();
  return `${PLAYER_STATS_SNAPSHOT_PREFIX}:${opts.seasonYear}:${leaguePart}:${qPart}`;
}

export function leaderboardSnapshotKey(opts: { leagueId: string }): string {
  return `${LEADERBOARD_SNAPSHOT_PREFIX}:${opts.leagueId.trim()}`;
}

export function readStoredSnapshot<T>(key: string, maxAgeMs: number): T | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredSnapshotEnvelope<T>;
    if (!parsed || typeof parsed !== "object") return null;
    if (typeof parsed.savedAt !== "number" || !Number.isFinite(parsed.savedAt)) return null;
    if (Date.now() - parsed.savedAt > maxAgeMs) return null;
    return parsed.value ?? null;
  } catch {
    return null;
  }
}

export function writeStoredSnapshot<T>(key: string, value: T): void {
  if (typeof window === "undefined") return;
  try {
    const payload: StoredSnapshotEnvelope<T> = { savedAt: Date.now(), value };
    localStorage.setItem(key, JSON.stringify(payload));
    if (key.startsWith(PLAYER_STATS_SNAPSHOT_PREFIX)) {
      pruneSnapshotPrefix(PLAYER_STATS_SNAPSHOT_PREFIX, 24);
    } else if (key.startsWith(LEADERBOARD_SNAPSHOT_PREFIX)) {
      pruneSnapshotPrefix(LEADERBOARD_SNAPSHOT_PREFIX, 16);
    }
  } catch {
    /* private mode / quota */
  }
}
