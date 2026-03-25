/**
 * Tab routes that require a completed pool session (league + owner row) and a `leagueId` query.
 * Used by client-side navigation and URL sync.
 */
export const POOL_APP_PATH_PREFIXES = [
  "/draft",
  "/stat-tracker",
  "/leaderboard",
  "/players",
  "/history",
  "/commissioner"
] as const;

export function poolRouteNeedsSession(pathname: string): boolean {
  return POOL_APP_PATH_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

/** Paths that never require the pool onboarding session (marketing / auth / static). */
export function poolRouteIsPublic(pathname: string): boolean {
  if (pathname === "/") return true;
  if (pathname.startsWith("/join")) return true;
  if (pathname.startsWith("/analytics")) return true;
  return false;
}

export function hrefWithLeagueId(href: string, leagueId: string): string {
  const id = leagueId.trim();
  if (!id) return href;
  const [path, query = ""] = href.split("?");
  if (!poolRouteNeedsSession(path)) return href;
  const params = new URLSearchParams(query);
  params.set("leagueId", id);
  const q = params.toString();
  return q ? `${path}?${q}` : `${path}?leagueId=${encodeURIComponent(id)}`;
}
