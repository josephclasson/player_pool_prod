import type { SupabaseClient } from "@supabase/supabase-js";
import { ensureProfileForAuthUser } from "@/lib/commissioner/ensure-profile-for-auth-user";
import { adminFindUserIdByEmail } from "@/lib/supabase/admin-find-user-by-email";

const USERNAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{1,23}$/;

export type OwnerInviteRow = {
  fullName: string;
  username: string;
  email: string;
};

export type InviteLeagueOwnersResult = {
  results: Array<{
    email: string;
    username: string;
    status: "invited" | "linked_existing" | "skipped";
    detail?: string;
  }>;
};

function normalizeOwners(rows: OwnerInviteRow[]): OwnerInviteRow[] {
  const out: OwnerInviteRow[] = [];
  const seenUser = new Set<string>();
  const seenEmail = new Set<string>();
  for (const r of rows) {
    const fullName = r.fullName.trim();
    const username = r.username.trim();
    const email = r.email.trim().toLowerCase();
    if (!fullName || !username || !email) continue;
    const ukey = username.toLowerCase();
    if (seenUser.has(ukey)) throw new Error(`Duplicate username in list: ${username}`);
    if (seenEmail.has(email)) throw new Error(`Duplicate email in list: ${email}`);
    if (!USERNAME_RE.test(username)) {
      throw new Error(
        `Invalid username "${username}" — use 2–24 letters, numbers, dot, underscore, or hyphen (start with alphanumeric).`
      );
    }
    seenUser.add(ukey);
    seenEmail.add(email);
    out.push({ fullName, username, email });
  }
  if (out.length === 0) throw new Error("Add at least one owner with full name, username, and email.");
  if (out.length > 24) throw new Error("Maximum 24 owners per batch.");
  return out;
}

async function upsertLeagueMembership(opts: {
  supabase: SupabaseClient;
  leagueId: string;
  userId: string;
  username: string;
  fullName: string;
  leagueOwnerId: string | null;
  draftPosition: number;
}) {
  const { supabase, leagueId, userId, username, fullName, leagueOwnerId, draftPosition } = opts;

  const role = leagueOwnerId && userId === leagueOwnerId ? "commissioner" : "member";

  const prof = await ensureProfileForAuthUser(supabase, userId, fullName);
  if (!prof.ok) throw new Error(prof.error);

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
      team_name: username,
      draft_position: draftPosition
    },
    { onConflict: "league_id,user_id" }
  );
}

async function refreshDraftOrder(supabase: SupabaseClient, leagueId: string) {
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
}

/**
 * Invites owners by real email (Supabase invite mail). New users get a link to `/join` to set a 6-digit PIN.
 * Existing Auth users are linked to the league without a new email (commissioner should tell them to sign in).
 */
export async function inviteLeagueOwners(opts: {
  supabase: SupabaseClient;
  leagueId: string;
  leagueCode: string;
  leagueName: string;
  appBaseUrl: string;
  owners: OwnerInviteRow[];
}): Promise<InviteLeagueOwnersResult> {
  const { supabase, leagueId, leagueCode, leagueName, appBaseUrl } = opts;
  const owners = normalizeOwners(opts.owners);
  const base = appBaseUrl.replace(/\/$/, "");
  /**
   * Owners land on `/join` so both PKCE (`?code=`) and implicit (`#access_token=`) redirects work.
   * Commissioner magic links use `/auth/confirm`; cold email invites often need
   * implicit tokens or Supabase email settings — see README.
   */
  const redirectTo = `${base}/join`;

  const { data: leagueRow } = await supabase
    .from("leagues")
    .select("owner_id")
    .eq("id", leagueId)
    .maybeSingle();
  const leagueOwnerId = (leagueRow as { owner_id?: string } | null)?.owner_id ?? null;

  const { data: existingTeams } = await supabase
    .from("league_teams")
    .select("team_name")
    .eq("league_id", leagueId);
  const takenNames = new Set(
    (existingTeams ?? []).map((t: { team_name?: string }) => String(t.team_name ?? "").toLowerCase())
  );

  const results: InviteLeagueOwnersResult["results"] = [];

  for (let i = 0; i < owners.length; i++) {
    const row = owners[i]!;
    const pos = i + 1;
    const unameKey = row.username.toLowerCase();

    if (takenNames.has(unameKey)) {
      results.push({
        email: row.email,
        username: row.username,
        status: "skipped",
        detail: `Username "${row.username}" already used in this league.`
      });
      continue;
    }

    const existingId = await adminFindUserIdByEmail(supabase, row.email);

    if (existingId) {
      await upsertLeagueMembership({
        supabase,
        leagueId,
        userId: existingId,
        username: row.username,
        fullName: row.fullName,
        leagueOwnerId,
        draftPosition: pos
      });
      takenNames.add(unameKey);
      results.push({
        email: row.email,
        username: row.username,
        status: "linked_existing",
        detail:
          "Account already exists — no invite email sent. Owner should open this app and sign in with Email link or Password using this email."
      });
      continue;
    }

    const { data: invited, error: invErr } = await supabase.auth.admin.inviteUserByEmail(row.email, {
      redirectTo,
      data: {
        display_name: row.fullName,
        login_username: row.username,
        league_id: leagueId,
        league_code: leagueCode,
        league_name: leagueName
      }
    });

    if (invErr || !invited?.user?.id) {
      const msg = invErr?.message ?? "invite failed";
      if (msg.toLowerCase().includes("already") || msg.toLowerCase().includes("registered")) {
        const retryId = await adminFindUserIdByEmail(supabase, row.email);
        if (retryId) {
          await upsertLeagueMembership({
            supabase,
            leagueId,
            userId: retryId,
            username: row.username,
            fullName: row.fullName,
            leagueOwnerId,
            draftPosition: pos
          });
          takenNames.add(unameKey);
          results.push({
            email: row.email,
            username: row.username,
            status: "linked_existing",
            detail: "User exists — linked to league (no new invite email)."
          });
          continue;
        }
      }
      throw new Error(`${row.email}: ${msg}`);
    }

    const userId = invited.user.id;

    await upsertLeagueMembership({
      supabase,
      leagueId,
      userId,
      username: row.username,
      fullName: row.fullName,
      leagueOwnerId,
      draftPosition: pos
    });

    takenNames.add(unameKey);
    results.push({
      email: row.email,
      username: row.username,
      status: "invited",
      detail: `Invite email sent by Supabase (check spam). League code: ${leagueCode}`
    });
  }

  await refreshDraftOrder(supabase, leagueId);

  return { results };
}
