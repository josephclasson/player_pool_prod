"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { HeatBadgeInfo } from "@/lib/player-heat-badge";
import { heatBadgeAriaLabel, heatBadgeShortLabel, heatBadgeTooltipBody } from "@/lib/player-heat-badge";
import { HEAT_TIER_FIRE_CELL_CLASS } from "@/components/stats/heat-tier-styles";

type PlayerHeatBadgeProps = {
  info: HeatBadgeInfo;
  seasonPpg: number;
  className?: string;
};

const FIRE = "\u{1F525}"; // 🔥

/**
 * Tiny inline heat marker (no table column): fire emoji on tier-colored background + portal tooltip.
 */
export function PlayerHeatBadge({ info, seasonPpg, className }: PlayerHeatBadgeProps) {
  const body = heatBadgeTooltipBody(info, seasonPpg);
  const label = heatBadgeShortLabel(info.tier);
  const aria = heatBadgeAriaLabel(info, seasonPpg);

  const anchorRef = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ x: 0, y: 0 });

  const updatePos = useCallback(() => {
    const el = anchorRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({ x: r.left + r.width / 2, y: r.bottom + 4 });
  }, []);

  useEffect(() => {
    if (!open) return;
    updatePos();
    const onMove = () => updatePos();
    window.addEventListener("scroll", onMove, true);
    window.addEventListener("resize", onMove);
    return () => {
      window.removeEventListener("scroll", onMove, true);
      window.removeEventListener("resize", onMove);
    };
  }, [open, updatePos]);

  const tooltip =
    open && typeof document !== "undefined"
      ? createPortal(
          <div
            role="tooltip"
            style={{
              position: "fixed",
              left: pos.x,
              top: pos.y,
              transform: "translateX(-50%)",
              zIndex: 200
            }}
            className="pointer-events-none w-[min(16rem,calc(100vw-1.5rem))] rounded-sm border-[0.5px] border-border bg-background px-2 py-1.5 text-[10px] leading-snug text-foreground"
          >
            <span className="font-semibold text-foreground">{label}</span>
            <span className="mt-0.5 block text-foreground/85">{body}</span>
          </div>,
          document.body
        )
      : null;

  return (
    <>
      <span ref={anchorRef} className={`relative inline-flex align-baseline ${className ?? ""}`}>
        <span
          className="inline-flex items-center justify-center leading-none cursor-default"
          tabIndex={0}
          aria-label={aria}
          onMouseEnter={() => {
            updatePos();
            setOpen(true);
          }}
          onMouseLeave={() => setOpen(false)}
          onFocus={() => {
            updatePos();
            setOpen(true);
          }}
          onBlur={() => setOpen(false)}
        >
          <span className={HEAT_TIER_FIRE_CELL_CLASS[info.tier]} aria-hidden>
            {FIRE}
          </span>
        </span>
      </span>
      {tooltip}
    </>
  );
}
