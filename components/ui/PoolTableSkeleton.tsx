"use client";

/** Compact loading placeholder for roster-style tables (mobile-friendly). */
export function PoolTableSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <div className="w-full min-w-0 space-y-2 py-1" aria-hidden>
      <div className="h-7 w-full max-w-md animate-pulse rounded-md bg-foreground/10" />
      <div className="space-y-1.5 rounded-md border border-border/40 p-2">
        {Array.from({ length: rows }, (_, i) => (
          <div
            key={i}
            className="h-8 w-full animate-pulse rounded bg-foreground/[0.07]"
            style={{ animationDelay: `${i * 40}ms` }}
          />
        ))}
      </div>
    </div>
  );
}
