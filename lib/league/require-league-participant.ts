import type { SupabaseClient } from "@supabase/supabase-js";
import { PLAYER_POOL_LEAGUE_TEAM_ID_HEADER } from "@/lib/player-pool-session";

export type LeagueParticipantResult =
  | { ok: true; userId: string | null; bypass: boolean }
  | { ok: false; status: number; error: string };

/**
 * Any signed-in user who owns a `league_teams` row or any `league_members` row for the league.
 * Mirrors dev bypass flags used by commissioner routes.
 */
export async function requireLeagueParticipant(
  req: Request,
  supabase: SupabaseClient,
  leagueIdUuid: string
): Promise<LeagueParticipantResult> {
  if (process.env.ALLOW_COMMISSIONER_ROUTES_WITHOUT_AUTH === "true") {
    return { ok: true, userId: null, bypass: true };
  }

  const apiSecret = process.env.COMMISSIONER_API_SECRET?.trim();
  const hdrSecret = req.headers.get("x-player-pool-commissioner-secret")?.trim();
  if (apiSecret && hdrSecret && hdrSecret === apiSecret) {
    return { ok: true, userId: null, bypass: true };
  }

  const poolTeamId = req.headers.get(PLAYER_POOL_LEAGUE_TEAM_ID_HEADER)?.trim() ?? "";
  if (poolTeamId) {
    const { data: ltRow, error: poolLtErr } = await supabase
      .from("league_teams")
      .select("id")
      .eq("id", poolTeamId)
      .eq("league_id", leagueIdUuid)
      .maybeSingle();

    if (poolLtErr) {
      return { ok: false, status: 503, error: `Team lookup failed: ${poolLtErr.message}` };
    }
    if (ltRow?.id) {
      return { ok: true, userId: null, bypass: false };
    }
  }

  const authz = req.headers.get("authorization");
  const token =
    authz?.startsWith("Bearer ") ? authz.slice("Bearer ".length).trim() : null;
  if (!token) {
    return {
      ok: false,
      status: 401,
      error:
        "Open this league from the pool home flow so your team is saved (session), sign in with Supabase, or use the commissioner secret. Then use Refresh to pull live NCAA data."
    };
  }

  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data?.user) {
    return { ok: false, status: 401, error: "Invalid or expired access token." };
  }

  const userId = data.user.id;

  const { data: lt, error: ltErr } = await supabase
    .from("league_teams")
    .select("id")
    .eq("league_id", leagueIdUuid)
    .eq("user_id", userId)
    .limit(1);

  if (ltErr) {
    return { ok: false, status: 503, error: `Team lookup failed: ${ltErr.message}` };
  }
  if (lt && lt.length > 0) {
    return { ok: true, userId, bypass: false };
  }

  const { data: mem, error: memErr } = await supabase
    .from("league_members")
    .select("role")
    .eq("league_id", leagueIdUuid)
    .eq("user_id", userId)
    .maybeSingle();

  if (memErr) {
    return { ok: false, status: 503, error: `Member lookup failed: ${memErr.message}` };
  }
  if (mem) {
    return { ok: true, userId, bypass: false };
  }

  return {
    ok: false,
    status: 403,
    error: "You are not in this league (no team or membership row)."
  };
}
