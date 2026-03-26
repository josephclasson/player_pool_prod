"use client";

import { BarChart3 } from "lucide-react";

export function AnalyticsPageClient() {
  return (
    <div className="pool-page-stack pool-page-stack-tight">
      <div className="pool-hero pool-hero-databallr">
        <div className="grid grid-cols-[5rem_1fr_5rem] items-center gap-2 md:grid-cols-[auto_1fr_auto]">
          <div className="flex items-center justify-start md:justify-start">
            <div
              className="h-9 w-9 shrink-0 rounded-md bg-accent/15 border border-accent/40 flex items-center justify-center"
              aria-hidden
            >
              <BarChart3 className="h-4 w-4 text-accent" />
            </div>
          </div>
          <div className="min-w-0 text-center md:text-left">
            <h1 className="stat-tracker-page-title text-center md:text-left">Advanced Analytics</h1>
            <div className="text-[10px] text-foreground/50 mt-0.5 hidden md:block">
              This feature is currently on the backlog and coming soon!
            </div>
          </div>
        </div>
        <div className="mt-1.5 pt-2 border-t border-border/25 text-[10px] text-foreground/45 hidden md:block">
          Team paths, anomaly detection, leverage signals, and deeper pool-performance breakdowns.
        </div>
      </div>
    </div>
  );
}
