import { NextResponse } from "next/server";
import { createSupabaseAdminClientSafe } from "@/lib/supabase/admin";
import { requireLeagueOfficer } from "@/lib/commissioner/require-league-officer";
import { resolveLeagueFromCommissionerParam } from "@/lib/commissioner/resolve-league";
import { persistLeagueLiveScoreboard } from "@/lib/scoring/persist-league-scoreboard";

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ leagueId: string }> }
) {
  const leagueIdParam = (await params).leagueId;
  if (!leagueIdParam) return NextResponse.json({ error: "leagueId required" }, { status: 400 });

  const supabase = createSupabaseAdminClientSafe();
  if (!supabase) {
    return NextResponse.json({ error: "Supabase not configured" }, { status: 503 });
  }

  const resolved = await resolveLeagueFromCommissionerParam(supabase, leagueIdParam);
  if (!resolved.ok) {
    return NextResponse.json({ error: resolved.error }, { status: resolved.status });
  }
  const leagueId = resolved.league.id;

  const officer = await requireLeagueOfficer(_req, supabase, leagueId);
  if (!officer.ok) {
    return NextResponse.json({ error: officer.error }, { status: officer.status });
  }

  const { data: draftRoom } = await supabase
    .from("draft_rooms")
    .select("*")
    .eq("league_id", leagueId)
    .maybeSingle();

  if (!draftRoom) return NextResponse.json({ error: "draft room not found" }, { status: 404 });
  if (draftRoom.status !== "in_progress") {
    return NextResponse.json({ error: "draft not in progress" }, { status: 409 });
  }

  const draftOrder = (draftRoom.draft_order ?? []) as string[];
  const ownersCount = draftOrder.length;
  if (ownersCount <= 0) return NextResponse.json({ error: "draft order missing" }, { status: 500 });

  const { data: lastPickRows, error: lastPickErr } = await supabase
    .from("player_draft_picks")
    .select("*")
    .eq("draft_room_id", draftRoom.id)
    .order("pick_overall", { ascending: false })
    .limit(1);

  if (lastPickErr) throw lastPickErr;
  if (!lastPickRows || lastPickRows.length === 0) {
    return NextResponse.json({ error: "no picks to undo" }, { status: 409 });
  }

  const lastPick = lastPickRows[0] as {
    league_team_id: string;
    player_id: number;
    team_id: number;
    round_number: number;
    pick_overall: number;
  };

  const lastPickOverall = lastPick.pick_overall;

  await supabase.from("player_draft_picks").delete().eq("draft_room_id", draftRoom.id).eq("pick_overall", lastPickOverall);
  await supabase
    .from("player_roster_slots")
    .delete()
    .eq("league_team_id", lastPick.league_team_id)
    .eq("player_id", lastPick.player_id)
    .eq("team_id", lastPick.team_id)
    .eq("round_slot", lastPick.round_number)
    .eq("pick_overall", lastPickOverall);

  const nextPickOverall = lastPickOverall;
  const maxPick = (draftRoom.total_rounds ?? 6) * ownersCount;
  const status = nextPickOverall > maxPick ? "completed" : "in_progress";
  const completedAt = status === "completed" ? new Date().toISOString() : null;

  await supabase
    .from("draft_rooms")
    .update({ current_pick_overall: nextPickOverall, status, completed_at: completedAt })
    .eq("id", draftRoom.id);

  try {
    await persistLeagueLiveScoreboard(supabase, leagueId);
  } catch {
    /* optional */
  }

  return NextResponse.json({
    status: "ok",
    undone: {
      pickOverall: lastPickOverall
    }
  });
}

