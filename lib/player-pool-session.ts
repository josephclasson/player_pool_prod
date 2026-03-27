/** Browser session keys — identity is link + who you claim to be; no Supabase login required. */

export const PLAYER_POOL_SESSION_LEAGUE_ID_KEY = "player_pool_league_id";
export const PLAYER_POOL_SESSION_TEAM_ID_KEY = "player_pool_league_team_id";
export const PLAYER_POOL_SESSION_TEAM_NAME_KEY = "player_pool_league_team_name";
/** NCAA tournament season year for the active league (e.g. 2026). */
export const PLAYER_POOL_SESSION_SEASON_YEAR_KEY = "player_pool_league_season_year";
/** Same value sent as `x-player-pool-commissioner-secret` (matches `COMMISSIONER_API_SECRET` on the server). */
export const PLAYER_POOL_COMMISSIONER_SECRET_KEY = "player_pool_commissioner_secret";

/** HTTP header for `readPlayerPoolSession().leagueTeamId` — verified server-side against `league_teams`. */
export const PLAYER_POOL_LEAGUE_TEAM_ID_HEADER = "x-player-pool-league-team-id";

export const PLAYER_POOL_IDENTITY_CHANGE_EVENT = "player-pool-identity-changed";

export type PlayerPoolSession = {
  leagueId: string;
  leagueTeamId: string;
  teamName: string;
  /** League `season_year` when known (from enter-pool flow or backfill). */
  seasonYear?: number | null;
};

export function readPlayerPoolSession(): PlayerPoolSession | null {
  if (typeof window === "undefined") return null;
  try {
    const leagueId = sessionStorage.getItem(PLAYER_POOL_SESSION_LEAGUE_ID_KEY)?.trim() ?? "";
    const leagueTeamId = sessionStorage.getItem(PLAYER_POOL_SESSION_TEAM_ID_KEY)?.trim() ?? "";
    const teamName = sessionStorage.getItem(PLAYER_POOL_SESSION_TEAM_NAME_KEY)?.trim() ?? "";
    const seasonRaw = sessionStorage.getItem(PLAYER_POOL_SESSION_SEASON_YEAR_KEY)?.trim();
    const seasonParsed = seasonRaw != null && seasonRaw !== "" ? Number(seasonRaw) : NaN;
    const seasonYear = Number.isFinite(seasonParsed) ? seasonParsed : null;
    if (!leagueId || !leagueTeamId) return null;
    return { leagueId, leagueTeamId, teamName: teamName || "Owner", seasonYear };
  } catch {
    return null;
  }
}

export function writePlayerPoolSession(session: PlayerPoolSession): void {
  if (typeof window === "undefined") return;
  try {
    sessionStorage.setItem(PLAYER_POOL_SESSION_LEAGUE_ID_KEY, session.leagueId.trim());
    sessionStorage.setItem(PLAYER_POOL_SESSION_TEAM_ID_KEY, session.leagueTeamId.trim());
    sessionStorage.setItem(PLAYER_POOL_SESSION_TEAM_NAME_KEY, session.teamName.trim() || "Owner");
    if (session.seasonYear != null && Number.isFinite(session.seasonYear)) {
      sessionStorage.setItem(PLAYER_POOL_SESSION_SEASON_YEAR_KEY, String(session.seasonYear));
    } else if (session.seasonYear === null) {
      sessionStorage.removeItem(PLAYER_POOL_SESSION_SEASON_YEAR_KEY);
    }
    window.dispatchEvent(new Event(PLAYER_POOL_IDENTITY_CHANGE_EVENT));
  } catch {
    /* private mode */
  }
}

/** Backfill season year for the current session (e.g. after API load). No-op if no session. */
export function patchPlayerPoolSessionSeasonYear(seasonYear: number): void {
  if (typeof window === "undefined") return;
  if (!Number.isFinite(seasonYear)) return;
  try {
    if (!readPlayerPoolSession()) return;
    sessionStorage.setItem(PLAYER_POOL_SESSION_SEASON_YEAR_KEY, String(seasonYear));
    window.dispatchEvent(new Event(PLAYER_POOL_IDENTITY_CHANGE_EVENT));
  } catch {
    /* private mode */
  }
}

export function clearPlayerPoolSession(): void {
  if (typeof window === "undefined") return;
  try {
    sessionStorage.removeItem(PLAYER_POOL_SESSION_LEAGUE_ID_KEY);
    sessionStorage.removeItem(PLAYER_POOL_SESSION_TEAM_ID_KEY);
    sessionStorage.removeItem(PLAYER_POOL_SESSION_TEAM_NAME_KEY);
    sessionStorage.removeItem(PLAYER_POOL_SESSION_SEASON_YEAR_KEY);
    window.dispatchEvent(new Event(PLAYER_POOL_IDENTITY_CHANGE_EVENT));
  } catch {
    /* ignore */
  }
}

export function readCommissionerSecretFromSession(): string {
  if (typeof window === "undefined") return "";
  try {
    return sessionStorage.getItem(PLAYER_POOL_COMMISSIONER_SECRET_KEY)?.trim() ?? "";
  } catch {
    return "";
  }
}

export function writeCommissionerSecretToSession(secret: string): void {
  if (typeof window === "undefined") return;
  try {
    const v = secret.trim();
    if (v) sessionStorage.setItem(PLAYER_POOL_COMMISSIONER_SECRET_KEY, v);
    else sessionStorage.removeItem(PLAYER_POOL_COMMISSIONER_SECRET_KEY);
    window.dispatchEvent(new Event(PLAYER_POOL_IDENTITY_CHANGE_EVENT));
  } catch {
    /* ignore */
  }
}
