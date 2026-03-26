"use client";

import { useRouter } from "next/navigation";
import { History, RefreshCcw, ShieldCheck } from "lucide-react";

export function HistoryPageClient() {
  const router = useRouter();

  return (
    <div className="pool-page-stack pool-page-stack-tight">
      <div className="pool-hero pool-hero-databallr">
        <div className="grid grid-cols-[5rem_1fr_5rem] items-center gap-2 md:grid-cols-[auto_1fr_auto]">
          <div className="flex items-center justify-start md:justify-start">
            <div
              className="h-9 w-9 shrink-0 rounded-md bg-accent/15 border border-accent/40 flex items-center justify-center"
              aria-hidden
            >
              <History className="h-4 w-4 text-accent" />
            </div>
          </div>
          <div className="min-w-0 text-center md:text-center">
            <h1 className="stat-tracker-page-title text-center md:text-center">History</h1>
            <div className="text-[10px] text-foreground/50 mt-0.5 hidden md:block text-center">
              This feature is currently on the backlog and coming soon!
            </div>
          </div>
          <div className="flex items-center justify-end gap-1">
            <button
              type="button"
              className="pool-top-icon-btn pool-btn-outline-cta pool-btn-outline-cta--sm !p-1 !w-9 !h-9 flex items-center justify-center"
              onClick={() => router.refresh()}
              aria-label="Refresh Data"
            >
              <RefreshCcw className="h-4 w-4" aria-hidden />
              <span className="sr-only">Refresh Data</span>
            </button>
            <button
              type="button"
              className="pool-top-icon-btn pool-btn-outline-cta pool-btn-outline-cta--sm !p-1 !w-9 !h-9 flex items-center justify-center"
              onClick={() => router.push("/commissioner")}
              aria-label="Commissioner login"
            >
              <ShieldCheck className="h-4 w-4" aria-hidden />
              <span className="sr-only">Commissioner login</span>
            </button>
          </div>
        </div>
        <div className="mt-1.5 pt-2 border-t border-border/25 text-[10px] text-foreground/45 hidden md:block">
          Past seasons, draft histories, final standings, and year-over-year pool outcomes.
        </div>
      </div>
    </div>
  );
}
