import { NextResponse } from "next/server";
import { z } from "zod";
import { createSupabaseAdminClientSafe } from "@/lib/supabase/admin";
import { resolveLeagueFromCommissionerParam } from "@/lib/commissioner/resolve-league";
import { requireLeagueOfficer } from "@/lib/commissioner/require-league-officer";
import { bulkAssignSnakeDraft } from "@/lib/commissioner/bulk-assign-rosters";
import { captureLeagueOriginalProjectionsIfNeeded } from "@/lib/projections";
import { persistLeagueLiveScoreboard } from "@/lib/scoring/persist-league-scoreboard";

const bodySchema = z.object({
  /** `leagueTeamId` (uuid) -> ordered player ids for that team (length = draft `total_rounds`) */
  assignments: z.record(z.string().uuid(), z.array(z.number().int().positive()))
});

export async function POST(req: Request, { params }: { params: Promise<{ leagueId: string }> }) {
  const { leagueId } = await params;
  if (!leagueId) return NextResponse.json({ error: "leagueId required" }, { status: 400 });

  const supabase = createSupabaseAdminClientSafe();
  if (!supabase) {
    return NextResponse.json({ error: "Supabase not configured" }, { status: 503 });
  }

  const resolved = await resolveLeagueFromCommissionerParam(supabase, leagueId);
  if (!resolved.ok) {
    return NextResponse.json({ error: resolved.error }, { status: resolved.status });
  }
  const id = resolved.league.id;

  const officer = await requireLeagueOfficer(req, supabase, id);
  if (!officer.ok) {
    return NextResponse.json({ error: officer.error }, { status: officer.status });
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

  try {
    const { picksInserted } = await bulkAssignSnakeDraft({
      supabase,
      leagueId: id,
      assignments: parsed.data.assignments
    });
    try {
      await captureLeagueOriginalProjectionsIfNeeded(supabase, id);
    } catch {
      /* optional */
    }
    try {
      await persistLeagueLiveScoreboard(supabase, id);
    } catch {
      /* optional */
    }
    return NextResponse.json({ status: "ok", picksInserted });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 400 });
  }
}
