import type { SupabaseClient } from "@supabase/supabase-js";
import { ensureDemoAuthProfileForLeague } from "@/lib/demo/ensure-owners";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(s: string): boolean {
  return UUID_RE.test(s.trim());
}

/**
 * Full sync of league teams in draft order: create, update, delete rows.
 * Does not remove the commissioner's team row (league owner).
 */
export async function syncLeagueOwnerTeams(opts: {
  supabase: SupabaseClient;
  leagueId: string;
  leagueCode: string;
  /** Draft order: each entry is an existing row id (uuid) or a new owner (omit id / empty). */
  teams: Array<{ id?: string | null; teamName: string }>;
  passcode?: string;
}): Promise<{ created: number; updated: number; deleted: number }> {
  const { supabase, leagueId, leagueCode, passcode } = opts;
  const rawTeams = opts.teams
    .map((t) => ({ id: t.id?.trim() || "", teamName: t.teamName.trim() }))
    .filter((t) => t.teamName.length > 0);

  if (rawTeams.length < 1) {
    throw new Error("Add at least one team with a name.");
  }
  if (rawTeams.length > 12) {
    throw new Error("At most 12 teams.");
  }

  const nameLower = rawTeams.map((t) => t.teamName.toLowerCase());
  if (new Set(nameLower).size !== nameLower.length) {
    throw new Error("Duplicate team names are not allowed in the list.");
  }

  const seenIds = new Set<string>();
  for (const t of rawTeams) {
    if (!t.id) continue;
    if (!isUuid(t.id)) continue;
    if (seenIds.has(t.id)) throw new Error("Duplicate team id in list.");
    seenIds.add(t.id);
  }

  const { data: leagueRow } = await supabase
    .from("leagues")
    .select("owner_id")
    .eq("id", leagueId)
    .maybeSingle();
  const leagueOwnerId = (leagueRow as { owner_id?: string } | null)?.owner_id ?? null;

  const { data: existingRows, error: exErr } = await supabase
    .from("league_teams")
    .select("id, user_id, team_name")
    .eq("league_id", leagueId);
  if (exErr) throw new Error(exErr.message);

  const byId = new Map((existingRows ?? []).map((r: { id: string; user_id: string; team_name: string }) => [r.id, r]));

  const incomingIds = new Set<string>();
  for (const t of rawTeams) {
    if (t.id && isUuid(t.id) && byId.has(t.id)) incomingIds.add(t.id);
  }

  let deleted = 0;
  for (const row of existingRows ?? []) {
    const r = row as { id: string; user_id: string };
    if (incomingIds.has(r.id)) continue;
    if (leagueOwnerId && r.user_id === leagueOwnerId) {
      throw new Error("Cannot remove the commissioner's team from the league.");
    }
    const { error: delMem } = await supabase
      .from("league_members")
      .delete()
      .eq("league_id", leagueId)
      .eq("user_id", r.user_id);
    if (delMem) throw new Error(delMem.message);
    const { error: delLt } = await supabase.from("league_teams").delete().eq("id", r.id);
    if (delLt) throw new Error(delLt.message);
    deleted += 1;
  }

  let created = 0;
  let updated = 0;

  for (let idx = 0; idx < rawTeams.length; idx++) {
    const t = rawTeams[idx]!;
    const pos = idx + 1;
    const id = t.id && isUuid(t.id) ? t.id : "";
    if (t.id && isUuid(t.id) && !byId.has(t.id)) {
      throw new Error(`Unknown team id: ${t.id}`);
    }
    const existing = id && byId.has(id) ? byId.get(id)! : null;

    if (existing) {
      const { error: up } = await supabase
        .from("league_teams")
        .update({ team_name: t.teamName, draft_position: pos })
        .eq("id", id)
        .eq("league_id", leagueId);
      if (up) throw new Error(up.message);
      updated += 1;
      continue;
    }

    const { userId } = await ensureDemoAuthProfileForLeague({
      supabase,
      leagueCode,
      displayName: t.teamName,
      passcode
    });

    const role = leagueOwnerId && userId === leagueOwnerId ? "commissioner" : "member";

    await supabase.from("league_members").upsert(
      {
        league_id: leagueId,
        user_id: userId,
        role,
        is_autodraft: false
      },
      { onConflict: "league_id,user_id" }
    );

    await supabase.from("league_teams").upsert(
      {
        league_id: leagueId,
        user_id: userId,
        team_name: t.teamName,
        draft_position: pos
      },
      { onConflict: "league_id,user_id" }
    );
    created += 1;
  }

  const { data: leagueTeamsAfter } = await supabase
    .from("league_teams")
    .select("id, draft_position")
    .eq("league_id", leagueId);

  const ordered = (leagueTeamsAfter ?? [])
    .sort((a: { draft_position?: number }, b: { draft_position?: number }) => {
      return (a.draft_position ?? 0) - (b.draft_position ?? 0);
    })
    .map((t: { id: string }) => t.id);

  const { data: room } = await supabase.from("draft_rooms").select("id").eq("league_id", leagueId).maybeSingle();
  if (room?.id) {
    await supabase.from("draft_rooms").update({ draft_order: ordered }).eq("id", room.id);
  }

  return { created, updated, deleted };
}
