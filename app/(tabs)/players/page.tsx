import { Suspense } from "react";
import type { Metadata } from "next";
import { PlayersPoolClient } from "./PlayersPoolClient";

export const metadata: Metadata = {
  title: "Player Statistics"
};

type PageProps = {
  searchParams?: Promise<{ seasonYear?: string; q?: string; leagueId?: string }>;
};

export default async function PlayersPage({ searchParams }: PageProps) {
  const sp = (await searchParams) ?? {};
  const syRaw = typeof sp.seasonYear === "string" ? Number(sp.seasonYear) : NaN;
  const seasonYear = Number.isFinite(syRaw) ? syRaw : 2026;
  const q = typeof sp.q === "string" ? sp.q : "";
  return (
    <Suspense
      fallback={
        <div className="rounded-lg border border-border/35 bg-muted/[0.06] px-3 py-2 pool-text-muted-sm text-sm">
          Loading…
        </div>
      }
    >
      <PlayersPoolClient initialSeasonYear={seasonYear} initialQ={q} />
    </Suspense>
  );
}
