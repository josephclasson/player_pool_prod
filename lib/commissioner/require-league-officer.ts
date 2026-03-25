import type { SupabaseClient } from "@supabase/supabase-js";

const OFFICER_ROLES = new Set(["owner", "commissioner", "co_commissioner"]);

export type LeagueOfficerResult =
  | { ok: true; userId: string | null; bypass: boolean }
  | { ok: false; status: number; error: string };

/**
 * Commissioner API guard:
 * - `ALLOW_COMMISSIONER_ROUTES_WITHOUT_AUTH=true` — local/dev only (no auth).
 * - `COMMISSIONER_API_SECRET` — if request header `x-player-pool-commissioner-secret` matches, allow (server-side secret).
 * - Otherwise require `Authorization: Bearer <supabase_access_token>` and `league_members.role` in
 *   owner | commissioner | co_commissioner for this league.
 *
 * Assign roles via `league_members.role` in Supabase (already supports commissioner + co_commissioner).
 */
export async function requireLeagueOfficer(
  req: Request,
  supabase: SupabaseClient,
  leagueIdUuid: string
): Promise<LeagueOfficerResult> {
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
      error:
        "Unauthorized: set header x-player-pool-commissioner-secret to your COMMISSIONER_API_SECRET (commissioner password), or legacy Authorization: Bearer <token>, or ALLOW_COMMISSIONER_ROUTES_WITHOUT_AUTH=true for local dev."
    };
  }

  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data?.user) {
    return { ok: false, status: 401, error: "Invalid or expired access token." };
  }

  const userId = data.user.id;
  const { data: mem, error: memErr } = await supabase
    .from("league_members")
    .select("role")
    .eq("league_id", leagueIdUuid)
    .eq("user_id", userId)
    .maybeSingle();

  if (memErr) {
    return { ok: false, status: 503, error: `Member lookup failed: ${memErr.message}` };
  }

  const role = String((mem as { role?: string } | null)?.role ?? "");
  if (!OFFICER_ROLES.has(role)) {
    return {
      ok: false,
      status: 403,
      error:
        "Forbidden: owner, commissioner, or co_commissioner role required for this league."
    };
  }

  return { ok: true, userId, bypass: false };
}
