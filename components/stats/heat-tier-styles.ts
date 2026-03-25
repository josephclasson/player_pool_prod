import type { HeatBadgeTier } from "@/lib/player-heat-badge";

/** Shared: circular chip, slightly smaller than default emoji size. */
const HEAT_FIRE_CHIP_BASE =
  "inline-flex size-[13px] shrink-0 select-none items-center justify-center rounded-full leading-none text-[9px] sm:size-[14px] sm:text-[10px]";

/** Tier chip: fire emoji on a circular yellow / orange / red background. */
export const HEAT_TIER_FIRE_CELL_CLASS: Record<HeatBadgeTier, string> = {
  heating: `${HEAT_FIRE_CHIP_BASE} bg-yellow-400 dark:bg-yellow-500`,
  on_fire: `${HEAT_FIRE_CHIP_BASE} bg-orange-500`,
  en_fuego: `${HEAT_FIRE_CHIP_BASE} bg-red-600`
};
