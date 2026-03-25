import type { Metadata } from "next";
import { DraftTabClient } from "./DraftTabClient";

export const metadata: Metadata = {
  title: "Draft"
};

type DraftPageProps = {
  searchParams?: Promise<{ leagueId?: string }>;
};

export default async function DraftPage({ searchParams }: DraftPageProps) {
  const sp = (await searchParams) ?? {};
  const raw = sp.leagueId;
  const leagueId =
    typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : undefined;
  return <DraftTabClient initialLeagueId={leagueId} />;
}
