"use client";

import { BarChart3 } from "lucide-react";

export function AnalyticsPageClient() {
  return (
    <div className="pool-page-stack pool-page-stack-tight">
      <div className="pool-hero pool-hero-databallr">
        <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between md:gap-3">
          <div className="flex items-center gap-2.5 md:gap-3 min-w-0">
            <div
              className="h-9 w-9 shrink-0 rounded-md bg-accent/15 border border-accent/40 flex items-center justify-center"
              aria-hidden
            >
              <BarChart3 className="h-4 w-4 text-accent" />
            </div>
            <div className="min-w-0">
              <h1 className="stat-tracker-page-title">Advanced Analytics</h1>
              <div className="text-[10px] text-foreground/50 mt-0.5">This feature is currently on the backlog and coming soon!</div>
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
