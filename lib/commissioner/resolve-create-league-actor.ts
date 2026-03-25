import { randomUUID } from "crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

export type CreateLeagueActorResult =
  | { ok: true; profileId: string; email: string | null }
  | { ok: false; status: number; error: string };

/**
 * Who may create a league row:
 * - Dev bypass env
 * - `x-player-pool-commissioner-secret` matching `COMMISSIONER_API_SECRET` (shared commissioner password)
 * - Legacy: `Authorization: Bearer` Supabase JWT (profile id = auth user id)
 */
export async function resolveCreateLeagueActor(
  req: Request,
  supabase: SupabaseClient
): Promise<CreateLeagueActorResult> {
  if (process.env.ALLOW_COMMISSIONER_ROUTES_WITHOUT_AUTH === "true") {
    const profileId = randomUUID();
    const { error } = await supabase
      .from("profiles")
      .upsert({ id: profileId, display_name: "Dev league creator" }, { onConflict: "id" });
    if (error) return { ok: false, status: 500, error: `Profile: ${error.message}` };
    return { ok: true, profileId, email: null };
  }

  const apiSecret = process.env.COMMISSIONER_API_SECRET?.trim();
  const hdrSecret = req.headers.get("x-player-pool-commissioner-secret")?.trim();
  if (apiSecret && hdrSecret && hdrSecret === apiSecret) {
    const profileId = randomUUID();
    const { error } = await supabase
      .from("profiles")
      .upsert({ id: profileId, display_name: "Commissioner (pool password)" }, { onConflict: "id" });
    if (error) return { ok: false, status: 500, error: `Profile: ${error.message}` };
    return { ok: true, profileId, email: null };
  }

  const authz = req.headers.get("authorization");
  const token = authz?.startsWith("Bearer ") ? authz.slice("Bearer ".length).trim() : null;
  if (!token) {
    return {
      ok: false,
      status: 401,
      error:
        "Enter the commissioner password in the app header (stored as x-player-pool-commissioner-secret), or use a legacy Bearer token, or set ALLOW_COMMISSIONER_ROUTES_WITHOUT_AUTH for local dev."
    };
  }

  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data?.user) {
    return { ok: false, status: 401, error: "Invalid or expired access token." };
  }

  return { ok: true, profileId: data.user.id, email: data.user.email ?? null };
}
