import { NextResponse } from "next/server";
import { z } from "zod";
import { createSupabaseAdminClientSafe } from "@/lib/supabase/admin";
import { resolveLeagueFromCommissionerParam } from "@/lib/commissioner/resolve-league";
import { requireLeagueOfficer } from "@/lib/commissioner/require-league-officer";
import { persistLeagueLiveScoreboard } from "@/lib/scoring/persist-league-scoreboard";
import { scrapeCommitteeReportFromUrl } from "@/lib/committee-report-scrape";
import { applyOfficialSeedsToTeams, dedupeOfficialSeedsByRankLastWins } from "@/lib/official-seeds";

/** Official 1–68 committee seeds: CBS/SI article scrape only (commissioner button). No pasted JSON or env URL. */
const bodySchema = z
  .object({
    seasonYear: z.number().int().min(2000).max(3000).optional(),
    scrapeCommitteeReportUrl: z.string().url().max(2048)
  })
  .strict();

export async function POST(
  req: Request,
  { params }: { params: Promise<{ leagueId: string }> }
) {
  const { leagueId } = await params;
  if (!leagueId) {
    return NextResponse.json({ error: "leagueId required" }, { status: 400 });
  }

  const supabase = createSupabaseAdminClientSafe();
  if (!supabase) {
    return NextResponse.json(
      {
        error: "Supabase not configured",
        missing: [
          !process.env.NEXT_PUBLIC_SUPABASE_URL ? "NEXT_PUBLIC_SUPABASE_URL" : null,
          !process.env.SUPABASE_SERVICE_ROLE_KEY ? "SUPABASE_SERVICE_ROLE_KEY" : null
        ].filter(Boolean)
      },
      { status: 503 }
    );
  }

  let raw: unknown = {};
  try {
    raw = await req.json();
  } catch {
    raw = {};
  }

  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const resolved = await resolveLeagueFromCommissionerParam(supabase, leagueId);
  if (!resolved.ok) {
    return NextResponse.json({ error: resolved.error }, { status: resolved.status });
  }

  const officer = await requireLeagueOfficer(req, supabase, resolved.league.id);
  if (!officer.ok) {
    return NextResponse.json({ error: officer.error }, { status: officer.status });
  }

  const seasonYear = parsed.data.seasonYear ?? resolved.league.season_year;

  let scrapeCommitteeSource: string | undefined;
  let scrapeWarnings: string[] | undefined;

  try {
    const scraped = await scrapeCommitteeReportFromUrl(parsed.data.scrapeCommitteeReportUrl.trim());
    scrapeCommitteeSource = scraped.sourceLabel;
    scrapeWarnings = scraped.warnings;
    const mergedDeduped = dedupeOfficialSeedsByRankLastWins(scraped.entries);

    if (mergedDeduped.length === 0) {
      return NextResponse.json(
        { error: "Article did not yield any 1–68 seed rows. Try another CBS/SI URL or check the page layout." },
        { status: 400 }
      );
    }

    const source = scrapeCommitteeSource ?? "committee_article_scrape";

    const result = await applyOfficialSeedsToTeams({
      supabase,
      seasonYear,
      entries: mergedDeduped,
      source
    });

    await persistLeagueLiveScoreboard(supabase, resolved.league.id);

    return NextResponse.json({
      status: "ok",
      seasonYear,
      source,
      updated: result.updated,
      unmatchedCount: result.unmatched.length,
      unmatched: result.unmatched.slice(0, 25),
      ...(scrapeWarnings?.length ? { scrapeWarnings } : {})
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 400 });
  }
}
