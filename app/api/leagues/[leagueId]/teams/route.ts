import { NextResponse } from "next/server";
import { createSupabaseAdminClientSafe } from "@/lib/supabase/admin";
import { resolveLeagueFromCommissionerParam } from "@/lib/commissioner/resolve-league";

/**
 * Public list of league teams for the “pick your owner” dropdown.
 * Anyone with the league id or code can load names (honor-system access model).
 */
export async function GET(
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

  const leagueId = resolved.league.id;

  const { data: rows, error } = await supabase
    .from("league_teams")
    .select("id, team_name, draft_position")
    .eq("league_id", leagueId)
    .order("draft_position", { ascending: true, nullsFirst: false });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const teams = (rows ?? []).map((r: { id: string; team_name: string }) => ({
    id: r.id,
    teamName: r.team_name
  }));

  return NextResponse.json({
    leagueId,
    leagueName: resolved.league.name,
    seasonYear: resolved.league.season_year,
    teams
  });
}
