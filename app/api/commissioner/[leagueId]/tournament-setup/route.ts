import { NextResponse } from "next/server";
import { z } from "zod";
import { createSupabaseAdminClientSafe } from "@/lib/supabase/admin";
import { resolveLeagueFromCommissionerParam } from "@/lib/commissioner/resolve-league";
import { requireLeagueOfficer } from "@/lib/commissioner/require-league-officer";
import { runTournamentSetup } from "@/lib/tournament-setup";

export const runtime = "nodejs";

const bodySchema = z.object({
  dateISO: z.string().optional(),
  /** Default true: import player pool from ESPN (roster + season PPG). */
  populatePlayers: z.boolean().optional().default(true),
  replacePlayers: z.boolean().optional().default(true)
});

function zodIssuesToString(err: z.ZodError): string {
  return err.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ");
}

function serializeSetupResponse(result: Awaited<ReturnType<typeof runTournamentSetup>>, seasonYear: number) {
  const sync = result.sync;
  const pop = result.populate;
  return {
    status: "ok" as const,
    seasonYear,
    sync: {
      teamsUpserted: sync.teamsUpserted,
      gamesUpserted: sync.gamesUpserted,
      teamGameStatsUpserted: sync.teamGameStatsUpserted,
      playersUpserted: sync.playersUpserted,
      playerGameStatsUpserted: sync.playerGameStatsUpserted
    },
    seeds: {
      updated: result.seeds.updated,
      unmatchedCount: result.seeds.unmatched.length
    },
    populate: pop
      ? {
          seasonYear: pop.seasonYear,
          teamsSuccess: pop.teamsSuccess,
          teamsFailed: pop.teamsFailed,
          playersUpserted: pop.playersUpserted,
          seasonPpgPopulated: pop.seasonPpgPopulated,
          rosterFailures: pop.rosterFailures,
          statsFailures: pop.statsFailures,
          ...(pop.warning ? { warning: pop.warning } : {})
        }
      : null,
    populateSkippedReason: result.populateSkippedReason ?? null,
    recompute: result.recompute
  };
}

export async function POST(
  req: Request,
  context: { params: Promise<{ leagueId: string }> }
) {
  try {
    const { leagueId } = await context.params;
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

    let body: unknown = {};
    try {
      body = await req.json();
    } catch {
      body = {};
    }

    const parsed = bodySchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: zodIssuesToString(parsed.error) }, { status: 400 });
    }

    const resolved = await resolveLeagueFromCommissionerParam(supabase, leagueId);
    if (!resolved.ok) {
      return NextResponse.json({ error: resolved.error }, { status: resolved.status });
    }

    const officer = await requireLeagueOfficer(req, supabase, resolved.league.id);
    if (!officer.ok) {
      return NextResponse.json({ error: officer.error }, { status: officer.status });
    }

    const date = parsed.data.dateISO
      ? new Date(parsed.data.dateISO + "T00:00:00Z")
      : new Date();

    const result = await runTournamentSetup({
      supabase,
      canonicalLeagueId: resolved.league.id,
      seasonYear: resolved.league.season_year,
      date,
      populatePlayers: parsed.data.populatePlayers,
      replacePlayers: parsed.data.replacePlayers
    });

    const payload = serializeSetupResponse(result, resolved.league.season_year);
    return NextResponse.json(payload);
  } catch (e: unknown) {
    console.error("[tournament-setup]", e);
    const msg =
      e instanceof Error
        ? e.message
        : typeof e === "object" && e !== null && "message" in e
          ? String((e as { message: unknown }).message)
          : String(e);
    return NextResponse.json(
      { error: msg || "Full tournament setup failed (see server logs)." },
      { status: 500 }
    );
  }
}
