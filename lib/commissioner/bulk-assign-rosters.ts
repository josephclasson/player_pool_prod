import type { SupabaseClient } from "@supabase/supabase-js";

function calcTurnForPick(opts: { pickOverall: number; draftOrder: string[] }) {
  const { pickOverall, draftOrder } = opts;
  const ownersCount = draftOrder.length;
  if (ownersCount <= 0) {
    return { roundNumber: 1, pickNumberInRound: 1, currentLeagueTeamId: null as string | null };
  }
  const idx = pickOverall - 1;
  const roundNumber = Math.floor(idx / ownersCount) + 1;
  const pickNumberInRound = (idx % ownersCount) + 1;
  const forward = draftOrder;
  const reverse = [...draftOrder].reverse();
  const snakeOrder = roundNumber % 2 === 1 ? forward : reverse;
  const currentLeagueTeamId = snakeOrder[pickNumberInRound - 1] ?? null;
  return { roundNumber, pickNumberInRound, currentLeagueTeamId };
}

/**
 * Commissioner: assign full rosters in snake-draft pick order without using the pick UI.
 * `assignments[leagueTeamId]` = ordered player ids for that owner (length must equal totalRounds).
 */
export async function bulkAssignSnakeDraft(opts: {
  supabase: SupabaseClient;
  leagueId: string;
  assignments: Record<string, number[]>;
}): Promise<{ picksInserted: number }> {
  const { supabase, leagueId, assignments } = opts;

  const { data: draftRoom, error: drErr } = await supabase
    .from("draft_rooms")
    .select("*")
    .eq("league_id", leagueId)
    .maybeSingle();

  if (drErr) throw drErr;
  if (!draftRoom) throw new Error("draft room not found");

  const draftOrder = (draftRoom.draft_order ?? []) as string[];
  if (draftOrder.length === 0) throw new Error("draft order empty");

  const totalRounds = Number(draftRoom.total_rounds ?? 6);
  const expectedSlots = totalRounds;

  for (const ltId of draftOrder) {
    const list = assignments[ltId];
    if (!list || !Array.isArray(list)) {
      throw new Error(`Missing assignments for league team ${ltId}`);
    }
    if (list.length !== expectedSlots) {
      throw new Error(
        `Team ${ltId}: expected ${expectedSlots} player ids (total rounds), got ${list.length}`
      );
    }
  }

  const allIds = Object.values(assignments).flat();
  const uniq = new Set(allIds);
  if (uniq.size !== allIds.length) throw new Error("Duplicate player id across assignments");

  const totalPicks = totalRounds * draftOrder.length;

  await supabase.from("player_draft_picks").delete().eq("draft_room_id", draftRoom.id);
  const { data: ltRows } = await supabase.from("league_teams").select("id").eq("league_id", leagueId);
  const ltIds = (ltRows ?? []).map((x: { id: string }) => x.id);
  if (ltIds.length) {
    await supabase.from("player_roster_slots").delete().in("league_team_id", ltIds);
  }

  const nextIdx = new Map<string, number>();
  for (const id of draftOrder) nextIdx.set(id, 0);

  for (let pickOverall = 1; pickOverall <= totalPicks; pickOverall++) {
    const { roundNumber, pickNumberInRound, currentLeagueTeamId } = calcTurnForPick({
      pickOverall,
      draftOrder
    });
    if (!currentLeagueTeamId) throw new Error("snake turn resolution failed");

    const idx = nextIdx.get(currentLeagueTeamId) ?? 0;
    const playerId = assignments[currentLeagueTeamId]![idx];
    nextIdx.set(currentLeagueTeamId, idx + 1);

    const { data: playerRow, error: pErr } = await supabase
      .from("players")
      .select("id, team_id")
      .eq("id", playerId)
      .maybeSingle();
    if (pErr) throw pErr;
    if (!playerRow) throw new Error(`Player ${playerId} not found`);

    const { error: insErr } = await supabase.from("player_draft_picks").insert({
      draft_room_id: draftRoom.id,
      league_team_id: currentLeagueTeamId,
      player_id: playerId,
      team_id: playerRow.team_id,
      round_number: roundNumber,
      pick_number_in_round: pickNumberInRound,
      pick_overall: pickOverall,
      is_autopick: false
    });
    if (insErr) throw insErr;

    const { error: rsErr } = await supabase.from("player_roster_slots").insert({
      league_team_id: currentLeagueTeamId,
      player_id: playerId,
      team_id: playerRow.team_id,
      round_slot: roundNumber,
      pick_overall: pickOverall,
      eliminated: false,
      first_four_team: false
    });
    if (rsErr) throw rsErr;
  }

  const nextPick = totalPicks + 1;
  await supabase
    .from("draft_rooms")
    .update({
      current_pick_overall: nextPick,
      status: "completed",
      completed_at: new Date().toISOString()
    })
    .eq("id", draftRoom.id);

  return { picksInserted: totalPicks };
}
