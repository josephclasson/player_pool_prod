"use client";

import { Snowflake } from "lucide-react";

/** Same footprint as InMoneyBadge / heat streak chips. */
const ICE_CHIP_BASE =
  "inline-flex size-[13px] shrink-0 select-none items-center justify-center rounded-full leading-none sm:size-[14px]";

type IceBoxBadgeProps = {
  leagueSize: number;
  className?: string;
};

/**
 * Inline marker after an owner name: snowflake on a cool-toned chip (last place in standings).
 */
export function IceBoxBadge({ leagueSize, className }: IceBoxBadgeProps) {
  const title = `Ice box: last place in current standings (${leagueSize} teams)`;
  return (
    <span
      className={`${ICE_CHIP_BASE} bg-sky-600 text-white dark:bg-sky-500 ${className ?? ""}`}
      title={title}
      aria-label={title}
    >
      <Snowflake className="h-[7px] w-[7px] sm:h-2 sm:w-2" strokeWidth={2.8} aria-hidden />
    </span>
  );
}
