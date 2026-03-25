"use client";

import { useEffect, useRef } from "react";
import { PLAYER_POOL_PULL_REFRESH_EVENT } from "@/lib/player-pool-pull-refresh";

export function useSubscribePullRefresh(onRefresh: () => void | Promise<void>, enabled = true) {
  const ref = useRef(onRefresh);
  ref.current = onRefresh;

  useEffect(() => {
    if (!enabled || typeof window === "undefined") return;
    const fn = () => {
      void Promise.resolve(ref.current());
    };
    window.addEventListener(PLAYER_POOL_PULL_REFRESH_EVENT, fn);
    return () => window.removeEventListener(PLAYER_POOL_PULL_REFRESH_EVENT, fn);
  }, [enabled]);
}
