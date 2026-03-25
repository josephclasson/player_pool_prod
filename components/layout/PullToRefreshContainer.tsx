"use client";

import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { dispatchPlayerPoolPullRefresh } from "@/lib/player-pool-pull-refresh";
import type { MainScrollContainerRef } from "@/lib/main-scroll-ref";
import { poolHapticsLight } from "@/lib/pool-mobile-haptics";

const PULL_THRESHOLD_PX = 56;
const MAX_PULL_PX = 96;

type Props = {
  scrollRef: MainScrollContainerRef;
  children: ReactNode;
  className?: string;
};

/**
 * Mobile-only pull-down on the main scroll panel to refresh. Desktop unchanged.
 * `scrollRef` must point at this component's root (overflow scroll element).
 */
export function PullToRefreshContainer({ scrollRef, children, className }: Props) {
  const [barProgress, setBarProgress] = useState(0);
  const [refreshingFlash, setRefreshingFlash] = useState(false);
  const startYRef = useRef(0);
  const trackingRef = useRef(false);
  const pullAmtRef = useRef(0);
  const refreshingLockRef = useRef(false);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    const isMobile = () => window.matchMedia("(max-width: 767px)").matches;

    const onTouchStart = (e: TouchEvent) => {
      if (!isMobile() || refreshingLockRef.current) return;
      if (el.scrollTop <= 0) {
        trackingRef.current = true;
        startYRef.current = e.touches[0]?.clientY ?? 0;
        pullAmtRef.current = 0;
      }
    };

    const onTouchMove = (e: TouchEvent) => {
      if (!isMobile() || refreshingLockRef.current || !trackingRef.current) return;
      if (el.scrollTop > 0) {
        trackingRef.current = false;
        pullAmtRef.current = 0;
        setBarProgress(0);
        return;
      }
      const y = e.touches[0]?.clientY ?? startYRef.current;
      const dy = y - startYRef.current;
      if (dy > 0) {
        e.preventDefault();
        const amt = Math.min(dy * 0.55, MAX_PULL_PX);
        pullAmtRef.current = amt;
        setBarProgress(Math.min(1, amt / PULL_THRESHOLD_PX));
      } else {
        pullAmtRef.current = 0;
        setBarProgress(0);
      }
    };

    const onTouchEnd = () => {
      if (!isMobile() || refreshingLockRef.current) {
        trackingRef.current = false;
        pullAmtRef.current = 0;
        setBarProgress(0);
        return;
      }
      if (!trackingRef.current) return;
      trackingRef.current = false;
      const amt = pullAmtRef.current;
      pullAmtRef.current = 0;
      setBarProgress(0);
      if (amt >= PULL_THRESHOLD_PX) {
        refreshingLockRef.current = true;
        setRefreshingFlash(true);
        poolHapticsLight();
        dispatchPlayerPoolPullRefresh();
        window.setTimeout(() => {
          refreshingLockRef.current = false;
          setRefreshingFlash(false);
        }, 700);
      }
    };

    const onTouchCancel = () => {
      trackingRef.current = false;
      pullAmtRef.current = 0;
      setBarProgress(0);
    };

    el.addEventListener("touchstart", onTouchStart, { passive: true });
    el.addEventListener("touchmove", onTouchMove, { passive: false });
    el.addEventListener("touchend", onTouchEnd);
    el.addEventListener("touchcancel", onTouchCancel);

    return () => {
      el.removeEventListener("touchstart", onTouchStart);
      el.removeEventListener("touchmove", onTouchMove);
      el.removeEventListener("touchend", onTouchEnd);
      el.removeEventListener("touchcancel", onTouchCancel);
    };
  }, [scrollRef]);

  const showBar = barProgress > 0.04 || refreshingFlash;

  return (
    <div ref={scrollRef} className={className ?? ""} style={{ touchAction: "pan-y" }}>
      <div
        className="pointer-events-none sticky top-0 z-30 -mb-0 h-0 overflow-visible md:hidden"
        aria-hidden
      >
        {showBar ? (
          <div
            className="h-0.5 w-full origin-left bg-accent transition-transform duration-200"
            style={{
              transform: `scaleX(${refreshingFlash ? 1 : barProgress})`,
              opacity: refreshingFlash ? 0.9 : 0.35 + barProgress * 0.55
            }}
          />
        ) : null}
      </div>
      {children}
    </div>
  );
}
