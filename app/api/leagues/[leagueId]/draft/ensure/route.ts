import { NextResponse } from "next/server";
import { createSupabaseAdminClientSafe } from "@/lib/supabase/admin";
import { resolveLeagueFromCommissionerParam } from "@/lib/commissioner/resolve-league";
import { ensureDraftRoomStarted } from "@/lib/draft/ensure-draft-room-started";
import { persistLeagueLiveScoreboard } from "@/lib/scoring/persist-league-scoreboard";

/**
 * Creates or opens the draft room for a league (same as Commissioner → Start draft).
 * Public: anyone with the league id can call — link-based access model.
 */
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ leagueId: string }> }
) {
  const raw = (await params).leagueId;
  if (!raw?.trim()) {
    return NextResponse.json({ error: "leagueId required" }, { status: 400 });
  }

  const supabase = createSupabaseAdminClientSafe();
  if (!supabase) {
    return NextResponse.json({ error: "Supabase not configured" }, { status: 503 });
  }

  const resolved = await resolveLeagueFromCommissionerParam(supabase, raw);
  if (!resolved.ok) {
    return NextResponse.json({ error: resolved.error }, { status: resolved.status });
  }

  const result = await ensureDraftRoomStarted(supabase, resolved.league.id);

  if (!result.ok) {
    const status = result.code === "completed" ? 409 : result.code === "no_teams" ? 400 : 500;
    return NextResponse.json({ error: result.error, code: result.code }, { status });
  }

  try {
    await persistLeagueLiveScoreboard(supabase, resolved.league.id);
  } catch {
    /* optional */
  }

  return NextResponse.json({
    status: "ok",
    leagueId: resolved.league.id,
    draftRoomId: result.draftRoomId,
    startStatus: result.status
  });
}
