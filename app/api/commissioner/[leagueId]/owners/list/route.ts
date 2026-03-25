import { NextResponse } from "next/server";
import { createSupabaseAdminClientSafe } from "@/lib/supabase/admin";
import { resolveLeagueFromCommissionerParam } from "@/lib/commissioner/resolve-league";
import { requireLeagueOfficer } from "@/lib/commissioner/require-league-officer";

/**
 * GET league teams (owner slots) for commissioner preseason "modify existing" flow.
 */
export async function GET(req: Request, { params }: { params: Promise<{ leagueId: string }> }) {
  const { leagueId } = await params;
  if (!leagueId) {
    return NextResponse.json({ error: "leagueId required" }, { status: 400 });
  }

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

  const { data: leagueMeta } = await supabase.from("leagues").select("owner_id").eq("id", id).maybeSingle();
  const ownerId = (leagueMeta as { owner_id?: string } | null)?.owner_id ?? null;

  const { data: rows, error } = await supabase
    .from("league_teams")
    .select("id, team_name, draft_position, user_id")
    .eq("league_id", id)
    .order("draft_position", { ascending: true, nullsFirst: false });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const teams = (rows ?? []).map(
    (r: { id: string; team_name: string; draft_position: number | null; user_id: string }) => ({
      id: r.id,
      teamName: r.team_name,
      draftPosition: r.draft_position,
      userId: r.user_id,
      isCommissioner: ownerId != null && r.user_id === ownerId
    })
  );

  return NextResponse.json({ leagueId: id, count: teams.length, teams });
}
