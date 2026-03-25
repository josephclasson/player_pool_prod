import type { SupabaseClient } from "@supabase/supabase-js";

export type EnsureDraftStartedResult =
  | { ok: true; draftRoomId: string; status: "created" | "started" | "already_in_progress" }
  | { ok: false; error: string; code: "no_teams" | "completed" | "db" };

const DEFAULT_ROUNDS = 8;
const DEFAULT_ROSTER = 8;
const DEFAULT_TIMER = 90;

/**
 * Creates a draft room or moves `pending` → `in_progress`. Idempotent if already in progress.
 * Fails if draft is `completed` (reset or bulk-assign first).
 */
export async function ensureDraftRoomStarted(
  supabase: SupabaseClient,
  leagueId: string,
  opts?: { totalRounds?: number; rosterSize?: number; pickTimerSeconds?: number }
): Promise<EnsureDraftStartedResult> {
  const totalRounds = opts?.totalRounds ?? DEFAULT_ROUNDS;
  const rosterSize = opts?.rosterSize ?? DEFAULT_ROSTER;
  const pickTimerSeconds = opts?.pickTimerSeconds ?? DEFAULT_TIMER;

  const { data: teamRows, error: teamErr } = await supabase
    .from("league_teams")
    .select("id, draft_position")
    .eq("league_id", leagueId);

  if (teamErr) {
    return { ok: false, error: teamErr.message, code: "db" };
  }

  const draftOrder = (teamRows ?? [])
    .sort(
      (a: { draft_position?: number }, b: { draft_position?: number }) =>
        (a.draft_position ?? 0) - (b.draft_position ?? 0)
    )
    .map((t: { id: string }) => t.id);

  if (draftOrder.length === 0) {
    return {
      ok: false,
      error: "Add owners / league teams before starting the draft.",
      code: "no_teams"
    };
  }

  const { data: room, error: roomErr } = await supabase
    .from("draft_rooms")
    .select("id, status")
    .eq("league_id", leagueId)
    .maybeSingle();

  if (roomErr) {
    return { ok: false, error: roomErr.message, code: "db" };
  }

  const startedAt = new Date().toISOString();

  if (!room) {
    const { data: created, error: insErr } = await supabase
      .from("draft_rooms")
      .insert({
        league_id: leagueId,
        status: "in_progress",
        total_rounds: totalRounds,
        roster_size: rosterSize,
        pick_timer_seconds: pickTimerSeconds,
        current_pick_overall: 1,
        draft_order: draftOrder,
        started_at: startedAt
      })
      .select("id")
      .single();

    if (insErr) {
      return { ok: false, error: insErr.message, code: "db" };
    }
    return {
      ok: true,
      draftRoomId: (created as { id: string }).id,
      status: "created"
    };
  }

  const status = String((room as { status?: string }).status ?? "");

  if (status === "completed") {
    return {
      ok: false,
      error: "Draft is already completed. Reset the draft or use bulk assign for offline results.",
      code: "completed"
    };
  }

  if (status === "in_progress") {
    return {
      ok: true,
      draftRoomId: (room as { id: string }).id,
      status: "already_in_progress"
    };
  }

  const { error: updErr } = await supabase
    .from("draft_rooms")
    .update({
      status: "in_progress",
      total_rounds: totalRounds,
      roster_size: rosterSize,
      pick_timer_seconds: pickTimerSeconds,
      current_pick_overall: 1,
      draft_order: draftOrder,
      started_at: startedAt,
      completed_at: null
    })
    .eq("id", (room as { id: string }).id);

  if (updErr) {
    return { ok: false, error: updErr.message, code: "db" };
  }

  return {
    ok: true,
    draftRoomId: (room as { id: string }).id,
    status: "started"
  };
}
