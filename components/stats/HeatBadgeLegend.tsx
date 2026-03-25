import type { HeatBadgeTier } from "@/lib/player-heat-badge";
import { heatBadgeLegendExplainer } from "@/lib/player-heat-badge";
import { HEAT_TIER_FIRE_CELL_CLASS } from "@/components/stats/heat-tier-styles";

const FIRE = "\u{1F525}";

const LEGEND_ROWS: { tier: HeatBadgeTier; label: string }[] = [
  { tier: "heating", label: "Heating Up" },
  { tier: "on_fire", label: "On Fire" },
  { tier: "en_fuego", label: "En Fuego" }
];

/**
 * Heat streak key for the filters toolbar (StatTracker + Player Statistics).
 */
export function HeatBadgeLegend({ className }: { className?: string }) {
  return (
    <div
      className={`flex flex-nowrap items-center gap-x-3 text-[10px] leading-tight text-foreground/75 ${className ?? ""}`}
    >
      <span className="font-semibold uppercase tracking-wide text-foreground/55 shrink-0">Heat Streak</span>
      {LEGEND_ROWS.map(({ tier, label }) => (
        <span key={tier} className="inline-flex items-center gap-1 shrink-0" title={heatBadgeLegendExplainer(tier)}>
          <span className={HEAT_TIER_FIRE_CELL_CLASS[tier]} aria-hidden>
            {FIRE}
          </span>
          <span>{label}</span>
        </span>
      ))}
    </div>
  );
}
