"use client";

import { Suspense, useMemo } from "react";
import { useSearchParams } from "next/navigation";
import { AnalyticsPageClient } from "./AnalyticsPageClient";

function AnalyticsWithQuery() {
  const sp = useSearchParams();
  const leagueId = useMemo(() => {
    const raw = sp.get("leagueId");
    return raw ?? undefined;
  }, [sp]);

  return <AnalyticsPageClient leagueId={leagueId} />;
}

export default function AnalyticsPage() {
  return (
    <Suspense fallback={null}>
      <AnalyticsWithQuery />
    </Suspense>
  );
}
