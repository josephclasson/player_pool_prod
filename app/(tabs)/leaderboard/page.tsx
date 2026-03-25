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
    <Suspense fallback={null}>
      <LeaderboardWithQuery />
    </Suspense>
  );
}
