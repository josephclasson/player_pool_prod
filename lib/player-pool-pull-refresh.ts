/** Dispatched on mobile when user completes pull-to-refresh on the main scroll container. */
export const PLAYER_POOL_PULL_REFRESH_EVENT = "player-pool:pull-refresh" as const;

export function dispatchPlayerPoolPullRefresh(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(PLAYER_POOL_PULL_REFRESH_EVENT));
}

export function isNarrowViewport(): boolean {
  if (typeof window === "undefined") return false;
  return window.matchMedia("(max-width: 767px)").matches;
}
