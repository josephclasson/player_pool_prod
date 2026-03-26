import { PoolResponsiveOwnerNameText } from "@/components/stats/PoolResponsiveDisplayNames";

/** Second line under player name: team · seed · fantasy owner (tight spacing). Omit `ownerName` when the section already implies the owner (e.g. StatTracker roster). */
export function PoolPlayerSublineTeamSeedOwner({
  teamName,
  seed,
  regionName,
  ownerName,
  uniformMuted
}: {
  teamName: string;
  seed: number | null;
  /** Optional bracket region label (shown after seed). */
  regionName?: string;
  /** When set, shown after team (and seed when present). */
  ownerName?: string;
  /** When true, render all inline values in one consistent muted gray tone. */
  uniformMuted?: boolean;
}) {
  const showOwner = ownerName != null && ownerName.trim() !== "";
  const showRegion = regionName != null && regionName.trim() !== "";
  const valueToneClass = uniformMuted ? "text-foreground/65" : "";
  return (
    <div className="mt-1 min-w-0 max-w-full overflow-hidden text-[10px] sm:text-[11px] text-foreground/65 font-normal leading-snug">
      <div className="flex min-w-0 max-w-full flex-nowrap items-baseline gap-x-px whitespace-nowrap">
        <span
          className={[
            "min-w-0 max-w-[min(100%,11rem)] shrink grow-0 truncate md:max-w-[min(100%,13rem)]",
            uniformMuted ? "font-normal text-foreground/65" : "text-foreground/75 font-medium"
          ].join(" ")}
          title={teamName}
        >
          {teamName}
        </span>
        {seed != null ? (
          <>
            <span className="shrink-0 px-px text-foreground/35 select-none" aria-hidden>
              ·
            </span>
            <span
              className={["shrink-0 tabular-nums", uniformMuted ? "text-foreground/65" : "text-foreground/80"].join(" ")}
              title={`Regional pod seed ${seed} (1–16 within the bracket)`}
            >
              {seed}
            </span>
          </>
        ) : null}
        {showRegion ? (
          <>
            <span className="shrink-0 px-px text-foreground/35 select-none" aria-hidden>
              ·
            </span>
            <span
              className={[
                "min-w-0 max-w-[min(100%,8rem)] shrink grow-0 truncate md:max-w-[min(100%,10rem)]",
                valueToneClass || "text-foreground/75"
              ].join(" ")}
              title={regionName}
            >
              {regionName}
            </span>
          </>
        ) : null}
        {showOwner ? (
          <>
            <span className="shrink-0 px-px text-foreground/35 select-none" aria-hidden>
              ·
            </span>
            <span
              className={[
                "min-w-0 max-w-[min(100%,9rem)] shrink grow-0 truncate md:max-w-[min(100%,11rem)]",
                valueToneClass || "text-foreground/85"
              ].join(" ")}
              title={ownerName}
            >
              <PoolResponsiveOwnerNameText full={ownerName} />
            </span>
          </>
        ) : null}
      </div>
    </div>
  );
}
