import type { SupabaseClient } from "@supabase/supabase-js";

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

  const authz = req.headers.get("authorization");
  const token =
    authz?.startsWith("Bearer ") ? authz.slice("Bearer ".length).trim() : null;
  if (!token) {
    return {
      ok: false,
      status: 401,
      error: "Sign in required. Use Refresh after logging in, or open the pool in a signed-in browser tab."
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
