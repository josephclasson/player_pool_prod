import { NextResponse } from "next/server";
import { createSupabaseAdminClientSafe } from "@/lib/supabase/admin";
import { resolveLeagueFromCommissionerParam } from "@/lib/commissioner/resolve-league";
import { requireLeagueOfficer } from "@/lib/commissioner/require-league-officer";
import { resetLeagueDraft } from "@/lib/draft/reset-league-draft";
import { persistLeagueLiveScoreboard } from "@/lib/scoring/persist-league-scoreboard";

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

  const result = await resetLeagueDraft(supabase, id);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 404 });
  }

  try {
    await persistLeagueLiveScoreboard(supabase, id);
  } catch {
    /* optional */
  }

  return NextResponse.json({ status: "ok", message: "Draft cleared; back to pick 1." });
}
