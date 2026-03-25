"use client";

import { Suspense, useMemo } from "react";
import { useSearchParams } from "next/navigation";
import { LeaderboardTabClient } from "./LeaderboardTabClient";

function LeaderboardWithQuery() {
  const sp = useSearchParams();
  const leagueId = useMemo(() => {
    const raw = sp.get("leagueId");
    return raw ?? undefined;
  }, [sp]);

  return <LeaderboardTabClient leagueId={leagueId} />;
}

export default function LeaderboardTabPage() {
  return (
    <Suspense
      fallback={
        <div className="pool-page-stack pool-page-stack-tight">
          <div className="pool-hero pool-hero-databallr">
            <div className="pool-text-muted text-[11px] py-0.5">Loading…</div>
          </div>
        </div>
      }
    >
      <LeaderboardWithQuery />
    </Suspense>
  );
}
