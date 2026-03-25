"use client";

import { DollarSign } from "lucide-react";

/** Same footprint as heat streak chips (PlayerHeatBadge / heat-tier-styles). */
const MONEY_CHIP_BASE =
  "inline-flex size-[13px] shrink-0 select-none items-center justify-center rounded-full leading-none sm:size-[14px]";

type InMoneyBadgeProps = {
  /** Payout positions (typically `min(3, leagueSize)`). */
  kMoney: number;
  leagueSize: number;
  className?: string;
};

/**
 * Inline marker after an owner name: dollar icon on a green chip (StatTracker heat-badge style).
 */
export function InMoneyBadge({ kMoney, leagueSize, className }: InMoneyBadgeProps) {
  const title = `In the money: top ${kMoney} of ${leagueSize} in current standings (payout positions)`;
  return (
    <span
      className={`${MONEY_CHIP_BASE} bg-emerald-600 text-white dark:bg-emerald-500 ${className ?? ""}`}
      title={title}
      aria-label={title}
    >
      <DollarSign className="h-[7px] w-[7px] sm:h-2 sm:w-2" strokeWidth={2.8} aria-hidden />
    </span>
  );
}
