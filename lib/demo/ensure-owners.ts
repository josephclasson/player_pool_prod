import type { SupabaseClient } from "@supabase/supabase-js";
import { ensureProfileForAuthUser } from "@/lib/commissioner/ensure-profile-for-auth-user";
import { normalizeEmailFragment } from "@/lib/demo/league";

function demoPassword(pass: string | undefined) {
  const p = pass?.trim();
  return p && p.length >= 3 ? p : "demo1234";
}

async function listUsersByEmailSearch(supabase: SupabaseClient, email: string) {
  const { data, error } = await supabase.auth.admin.listUsers({ page: 1, perPage: 1000 });
  if (error) throw error;
  const users = data?.users ?? [];
  const needle = email.trim().toLowerCase();
  return users.filter((u) => String(u.email ?? "").trim().toLowerCase() === needle);
}

/**
 * Creates or reuses a Supabase auth user + profile for a demo-style owner (`name+{leagueCode}@playerpool.local`).
 */
export async function ensureDemoAuthProfileForLeague(opts: {
  supabase: SupabaseClient;
  leagueCode: string;
  displayName: string;
  passcode?: string;
}): Promise<{ userId: string }> {
  const { supabase, leagueCode, displayName, passcode } = opts;
  const email = `${normalizeEmailFragment(displayName)}+${leagueCode}@playerpool.local`;
  const password = demoPassword(passcode);

  const users = await listUsersByEmailSearch(supabase, email);
  const existing = users.find((x: { email?: string }) => x.email === email);

  if (!existing) {
    const { data: created, error: createErr } = await supabase.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { display_name: displayName }
    });
    if (createErr) throw createErr;
    const userId = created.user!.id;
    const prof = await ensureProfileForAuthUser(supabase, userId, displayName);
    if (!prof.ok) throw new Error(prof.error);
    return { userId };
  }

  const userId = (existing as { id: string }).id;
  const prof = await ensureProfileForAuthUser(supabase, userId, displayName);
  if (!prof.ok) throw new Error(prof.error);
  return { userId };
}

/**
 * Ensures each display name has `league_members` + `league_teams` for the league (upsert).
 * Does not remove existing owners. Assigns `draft_position` by array order (1-based).
 */
export async function ensureLeagueOwnerRows(opts: {
  supabase: SupabaseClient;
  leagueId: string;
  leagueCode: string;
  /** Ordered owner display names (team names in draft UI). */
  ownerDisplayNames: string[];
  passcode?: string;
}): Promise<{ createdOrUpdated: number }> {
  const { supabase, leagueId, leagueCode, ownerDisplayNames, passcode } = opts;

  const { data: leagueRow } = await supabase
    .from("leagues")
    .select("owner_id")
    .eq("id", leagueId)
    .maybeSingle();
  const leagueOwnerId = (leagueRow as { owner_id?: string } | null)?.owner_id ?? null;

  let n = 0;
  for (let idx = 0; idx < ownerDisplayNames.length; idx++) {
    const displayName = ownerDisplayNames[idx]!.trim();
    if (!displayName) continue;

    const { userId } = await ensureDemoAuthProfileForLeague({
      supabase,
      leagueCode,
      displayName,
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
        team_name: displayName,
        draft_position: idx + 1
      },
      { onConflict: "league_id,user_id" }
    );
    n += 1;
  }

  const { data: leagueTeams } = await supabase
    .from("league_teams")
    .select("id, draft_position")
    .eq("league_id", leagueId);

  const ordered = (leagueTeams ?? [])
    .sort((a, b) => (a.draft_position ?? 0) - (b.draft_position ?? 0))
    .map((t) => t.id);

  const { data: room } = await supabase.from("draft_rooms").select("id").eq("league_id", leagueId).maybeSingle();
  if (room?.id) {
    await supabase.from("draft_rooms").update({ draft_order: ordered }).eq("id", room.id);
  }

  return { createdOrUpdated: n };
}
