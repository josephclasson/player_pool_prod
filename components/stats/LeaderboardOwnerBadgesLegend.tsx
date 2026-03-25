"use client";

import { DollarSign, Snowflake } from "lucide-react";

/** Match InMoneyBadge / IceBoxBadge / HeatBadgeLegend chip footprint. */
const MONEY_CHIP =
  "inline-flex size-[13px] shrink-0 select-none items-center justify-center rounded-full leading-none bg-emerald-600 text-white dark:bg-emerald-500 sm:size-[14px]";
const ICE_CHIP =
  "inline-flex size-[13px] shrink-0 select-none items-center justify-center rounded-full leading-none bg-sky-600 text-white dark:bg-sky-500 sm:size-[14px]";
const ICON = "h-[7px] w-[7px] sm:h-2 sm:w-2";

const IN_MONEY_TITLE =
  "In The Money: top payout positions in current standings (green chip next to owner name).";
const ICE_BOX_TITLE =
  "Ice Box: tied for last place in current standings (blue chip next to owner name).";

/**
 * Leaderboard filter bar key for owner-column standing marks (mirrors StatTracker {@link HeatBadgeLegend}).
 */
export function LeaderboardOwnerBadgesLegend({ className }: { className?: string }) {
  return (
    <div
      className={`flex flex-nowrap items-center gap-x-3 text-[10px] leading-tight text-foreground/75 ${className ?? ""}`}
    >
      <span className="font-semibold uppercase tracking-wide text-foreground/55 shrink-0">LEGEND</span>
      <span className="inline-flex items-center gap-1 shrink-0" title={IN_MONEY_TITLE}>
        <span className={MONEY_CHIP} aria-hidden>
          <DollarSign className={ICON} strokeWidth={2.8} aria-hidden />
        </span>
        <span>In The Money</span>
      </span>
      <span className="inline-flex items-center gap-1 shrink-0" title={ICE_BOX_TITLE}>
        <span className={ICE_CHIP} aria-hidden>
          <Snowflake className={ICON} strokeWidth={2.8} aria-hidden />
        </span>
        <span>Ice Box</span>
      </span>
    </div>
  );
}
