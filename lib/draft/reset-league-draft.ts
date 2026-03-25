import type { SupabaseClient } from "@supabase/supabase-js";
import { clearLeagueOriginalProjections } from "@/lib/projections";

/**
 * Clears all picks + roster slots for a league and rewinds the draft room to pick 1.
 */
export async function resetLeagueDraft(supabase: SupabaseClient, leagueId: string) {
  const { data: room } = await supabase
    .from("draft_rooms")
    .select("id")
    .eq("league_id", leagueId)
    .maybeSingle();

  if (!room?.id) return { ok: false as const, error: "no draft room" };

  const { data: ltRows } = await supabase.from("league_teams").select("id").eq("league_id", leagueId);
  const ltIds = (ltRows ?? []).map((x: { id: string }) => x.id);

  await supabase.from("player_draft_picks").delete().eq("draft_room_id", room.id);
  if (ltIds.length > 0) {
    await supabase.from("player_roster_slots").delete().in("league_team_id", ltIds);
  }

  const { data: orderedTeams } = await supabase
    .from("league_teams")
    .select("id, draft_position")
    .eq("league_id", leagueId);

  const draftOrder = (orderedTeams ?? [])
    .sort((a: { draft_position?: number }, b: { draft_position?: number }) => {
      return (a.draft_position ?? 0) - (b.draft_position ?? 0);
    })
    .map((t: { id: string }) => t.id);

  await supabase
    .from("draft_rooms")
    .update({
      current_pick_overall: 1,
      status: "in_progress",
      completed_at: null,
      draft_order: draftOrder
    })
    .eq("id", room.id);

  await clearLeagueOriginalProjections(supabase, leagueId);

  return { ok: true as const, draftRoomId: room.id as string };
}
