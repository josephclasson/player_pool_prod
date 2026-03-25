import type { ReactNode } from "react";
import { Banknote, CircleDollarSign, CloudSnow, Coins, Refrigerator, ThermometerSnowflake } from "lucide-react";

const ICE_CHIP =
  "inline-flex size-[13px] shrink-0 select-none items-center justify-center rounded-full leading-none bg-sky-600 text-white dark:bg-sky-500 sm:size-[14px]";
const MONEY_CHIP =
  "inline-flex size-[13px] shrink-0 select-none items-center justify-center rounded-full leading-none bg-emerald-600 text-white dark:bg-emerald-500 sm:size-[14px]";
const ICON = "h-[7px] w-[7px] sm:h-2 sm:w-2";

function Chip({
  label,
  sub,
  chipClass,
  children
}: {
  label: string;
  sub: string;
  chipClass: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-2 text-center max-w-[7rem]">
      <span className={chipClass}>{children}</span>
      <div>
        <div className="text-xs font-semibold text-foreground">{label}</div>
        <div className="text-[10px] text-foreground/60 leading-snug mt-0.5">{sub}</div>
      </div>
    </div>
  );
}

/** Temporary preview: open /badge-icon-options, then remove this route if you do not want it in production. */
export default function BadgeIconOptionsPage() {
  return (
    <div className="min-h-[50vh] px-4 py-8 max-w-3xl mx-auto pool-page-stack">
      <h1 className="text-lg font-semibold text-foreground mb-1">Badge icon options</h1>
      <p className="text-sm text-foreground/65 mb-8">
        Same chip size and colors as Leaderboard <code className="text-xs">IceBoxBadge</code> and{" "}
        <code className="text-xs">InMoneyBadge</code>. Swap the import + component in those files.
      </p>

      <p className="text-xs text-foreground/50 mb-2">
        Ice badge in production: <code className="text-[10px]">Snowflake</code> in{" "}
        <code className="text-[10px]">IceBoxBadge.tsx</code>. Money: <code className="text-[10px]">DollarSign</code>.
      </p>
      <p className="text-xs text-foreground/65 mb-6">
        <strong className="text-foreground/80">Three ice icons to pick from</strong> (swap import + JSX in{" "}
        <code className="text-[10px]">IceBoxBadge.tsx</code>):
      </p>

      <h2 className="text-xs font-semibold uppercase tracking-wide text-foreground/55 mb-4">
        Ice alternatives
      </h2>
      <div className="flex flex-wrap gap-8 mb-10 justify-start">
        <Chip
          label="ThermometerSnowflake"
          sub="Cold meter + flake; busy at 13px."
          chipClass={ICE_CHIP}
        >
          <ThermometerSnowflake className={ICON} strokeWidth={2.8} aria-hidden />
        </Chip>
        <Chip label="CloudSnow" sub="Weather / chill; softer than a lone flake." chipClass={ICE_CHIP}>
          <CloudSnow className={ICON} strokeWidth={2.8} aria-hidden />
        </Chip>
        <Chip label="Refrigerator" sub="Literal ice box; matches the name." chipClass={ICE_CHIP}>
          <Refrigerator className={ICON} strokeWidth={2.8} aria-hidden />
        </Chip>
      </div>

      <h2 className="text-xs font-semibold uppercase tracking-wide text-foreground/55 mb-4">
        Three money alternatives (in-the-money badge)
      </h2>
      <div className="flex flex-wrap gap-8 justify-start">
        <Chip label="CircleDollarSign" sub="$ in a circle; bold at small size." chipClass={MONEY_CHIP}>
          <CircleDollarSign className={ICON} strokeWidth={2.8} aria-hidden />
        </Chip>
        <Chip label="Banknote" sub="Cash / payout feel." chipClass={MONEY_CHIP}>
          <Banknote className={ICON} strokeWidth={2.8} aria-hidden />
        </Chip>
        <Chip label="Coins" sub="Stacked coins; prize-pool vibe." chipClass={MONEY_CHIP}>
          <Coins className={ICON} strokeWidth={2.8} aria-hidden />
        </Chip>
      </div>
    </div>
  );
}
