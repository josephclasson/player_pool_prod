"use client";

import { abbreviateOwnerNameForMobile, abbreviatePlayerNameForMobile } from "@/lib/pool-mobile-display-names";

export function PoolResponsivePlayerNameText({ full }: { full: string }) {
  const short = abbreviatePlayerNameForMobile(full);
  if (short === full) return <>{full}</>;
  return (
    <>
      <span className="hidden lg:inline">{full}</span>
      <span className="lg:hidden">{short}</span>
    </>
  );
}

export function PoolResponsiveOwnerNameText({ full }: { full: string }) {
  const short = abbreviateOwnerNameForMobile(full);
  if (short === full) return <>{full}</>;
  return (
    <>
      <span className="hidden lg:inline">{full}</span>
      <span className="lg:hidden">{short}</span>
    </>
  );
}
