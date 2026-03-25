"use client";

import { useEffect } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { readPlayerPoolSession } from "@/lib/player-pool-session";
import { poolRouteIsPublic, poolRouteNeedsSession } from "@/lib/pool-navigation";

/**
 * - Sends users without a session to `/` (welcome) when they open a pool tab.
 * - Ensures `?leagueId=` is present on pool tabs when session exists (bookmark/share safety).
 */
export function PoolSessionRoutes() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const router = useRouter();
  const searchKey = searchParams.toString();

  useEffect(() => {
    if (poolRouteIsPublic(pathname)) return;
    if (!poolRouteNeedsSession(pathname)) return;

    const session = readPlayerPoolSession();
    if (!session) {
      router.replace("/");
      return;
    }

    const q = new URLSearchParams(searchKey).get("leagueId")?.trim();
    if (q) return;

    const next = new URLSearchParams(searchKey);
    next.set("leagueId", session.leagueId);
    const s = next.toString();
    router.replace(s ? `${pathname}?${s}` : `${pathname}?leagueId=${encodeURIComponent(session.leagueId)}`);
  }, [pathname, router, searchKey]);

  return null;
}
