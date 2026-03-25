/**
 * Tab routes that require a completed pool session (league + owner row) and a `leagueId` query.
 * Used by client-side navigation and URL sync.
 */
/** Owner tabs: require pool session (league + team chosen on `/`). */
export const POOL_APP_PATH_PREFIXES = [
  "/draft",
  "/stat-tracker",
  "/leaderboard",
  "/players",
  "/history"
] as const;

/**
 * Commissioner setup is intentionally **not** in {@link POOL_APP_PATH_PREFIXES}: the commissioner must be able to
 * open `/commissioner` before any owner has completed the home wizard (e.g. create league). `?leagueId=` is still
 * appended when a session exists via {@link hrefWithLeagueId} (see {@link poolRouteWantsLeagueIdQuery}) and
 * `CommissionerForm` session sync.
 */
export const POOL_COMMISSIONER_PATH_PREFIXES = ["/commissioner"] as const;

export function poolRouteNeedsSession(pathname: string): boolean {
  return POOL_APP_PATH_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

/** Tab URLs that should carry `leagueId` when the user has a session (owner tabs + commissioner). */
export function poolRouteWantsLeagueIdQuery(pathname: string): boolean {
  if (poolRouteNeedsSession(pathname)) return true;
  return POOL_COMMISSIONER_PATH_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
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
  if (!poolRouteWantsLeagueIdQuery(path)) return href;
  const params = new URLSearchParams(query);
  params.set("leagueId", id);
  const q = params.toString();
  return q ? `${path}?${q}` : `${path}?leagueId=${encodeURIComponent(id)}`;
}
