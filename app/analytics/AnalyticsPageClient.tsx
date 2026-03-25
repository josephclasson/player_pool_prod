"use client";

import { useEffect, useState } from "react";
import { BarChart3 } from "lucide-react";
import { readCommissionerSecretFromSession } from "@/lib/player-pool-session";

export function AnalyticsPageClient() {
  const [commUnlocked, setCommUnlocked] = useState(false);

  useEffect(() => {
    const sync = () => setCommUnlocked(readCommissionerSecretFromSession().length > 0);
    sync();
    window.addEventListener("focus", sync);
    return () => window.removeEventListener("focus", sync);
  }, []);

  return (
    <div className="pool-page-stack pool-page-stack-tight">
      <div className="pool-hero pool-hero-databallr">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
          <div className="flex items-center gap-2.5 sm:gap-3 min-w-0">
            <div
              className="h-9 w-9 shrink-0 rounded-md bg-accent/15 border border-accent/40 flex items-center justify-center"
              aria-hidden
            >
              <BarChart3 className="h-4 w-4 text-accent" />
            </div>
            <div className="min-w-0">
              <h1 className="stat-tracker-page-title">Advanced Analytics</h1>
              {commUnlocked ? (
                <div className="text-[10px] text-foreground/50 mt-0.5">Analytics access enabled</div>
              ) : (
                <div className="text-[10px] text-amber-300/90 mt-0.5">Commissioner login required</div>
              )}
            </div>
          </div>
        </div>
        <div className="mt-1.5 pt-2 border-t border-border/25 text-[10px] text-foreground/45">
          Team paths, anomaly detection, leverage signals, and deeper pool-performance breakdowns.
        </div>
      </div>
    </div>
  );
}
