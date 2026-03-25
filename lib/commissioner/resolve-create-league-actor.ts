import { randomUUID } from "crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { adminFindUserIdByEmail } from "@/lib/supabase/admin-find-user-by-email";

export type CreateLeagueActorResult =
  | { ok: true; profileId: string; email: string | null }
  | { ok: false; status: number; error: string };

/** Dev bypass: stable Auth user when `ALLOW_COMMISSIONER_ROUTES_WITHOUT_AUTH=true` and no UUID env override. */
const DEV_POOL_LEAGUE_ACTOR_EMAIL = "dev-league-actor@player-pool.local";

/**
 * Production (commissioner password): auto-created Auth user email when `COMMISSIONER_LEAGUE_OWNER_USER_ID` is unset.
 * Override with `COMMISSIONER_LEAGUE_OWNER_EMAIL` if you need a different inbox label in the Supabase dashboard.
 */
const DEFAULT_COMMISSIONER_LEAGUE_OWNER_EMAIL = "pool-league-owner@player-pool.internal";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** GoTrue row visible to Postgres FK checks (rare delay right after `createUser`). */
async function waitForAuthUserVisible(
  supabase: SupabaseClient,
  userId: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  for (let attempt = 0; attempt < 15; attempt++) {
    const { data, error } = await supabase.auth.admin.getUserById(userId);
    if (!error && data?.user?.id === userId) return { ok: true };
    await new Promise((r) => setTimeout(r, 60 + attempt * 35));
  }
  return {
    ok: false,
    error:
      "Auth user was created but is not visible to the database yet. Wait a few seconds and try creating the league again."
  };
}

async function ensureLeagueActorAuthUser(
  supabase: SupabaseClient,
  emailRaw: string,
  displayName: string
): Promise<{ ok: true; userId: string } | { ok: false; status: number; error: string }> {
  const email = emailRaw.trim().toLowerCase();
  if (!email.includes("@")) {
    return { ok: false, status: 500, error: "League actor email must be a valid address." };
  }

  const { data: created, error: createErr } = await supabase.auth.admin.createUser({
    email,
    password: randomUUID(),
    email_confirm: true,
    user_metadata: { display_name: displayName }
  });
  if (!createErr && created?.user?.id) {
    const visible = await waitForAuthUserVisible(supabase, created.user.id);
    if (!visible.ok) return { ok: false, status: 503, error: visible.error };
    return { ok: true, userId: created.user.id };
  }

  const dup =
    createErr && /already|registered|exists|duplicate/i.test(String(createErr.message));
  if (dup) {
    try {
      const existingId = await adminFindUserIdByEmail(supabase, email);
      if (existingId) return { ok: true, userId: existingId };
    } catch (e) {
      return {
        ok: false,
        status: 500,
        error: `Could not look up league actor user: ${e instanceof Error ? e.message : String(e)}`
      };
    }
  }

  return {
    ok: false,
    status: 500,
    error: `League actor Auth user: ${createErr?.message ?? "createUser failed"}. Set COMMISSIONER_LEAGUE_OWNER_USER_ID to an existing Auth UUID, or fix Supabase Auth / Email settings.`
  };
}

/**
 * `profiles.id` references `auth.users(id)`. League `owner_id` must be a real Auth user.
 * - If `COMMISSIONER_LEAGUE_OWNER_USER_ID` is set → use that Auth user.
 * - Else → create or reuse an Auth user with `autoProvision.email` (dev vs prod commissioner flows).
 */
async function resolvePoolLeagueActorUserId(
  supabase: SupabaseClient,
  autoProvision: { email: string; displayName: string }
): Promise<{ ok: true; userId: string } | { ok: false; status: number; error: string }> {
  const fromEnv = process.env.COMMISSIONER_LEAGUE_OWNER_USER_ID?.trim();
  if (fromEnv) {
    if (!UUID_RE.test(fromEnv)) {
      return {
        ok: false,
        status: 500,
        error: "COMMISSIONER_LEAGUE_OWNER_USER_ID must be a valid UUID (Supabase Dashboard → Authentication → Users)."
      };
    }
    const { data, error } = await supabase.auth.admin.getUserById(fromEnv);
    if (error || !data?.user?.id) {
      return {
        ok: false,
        status: 500,
        error:
          "COMMISSIONER_LEAGUE_OWNER_USER_ID is not a Supabase Auth user. Remove it to allow auto-provisioning, or set it to a valid user UUID from the dashboard."
      };
    }
    return { ok: true, userId: data.user.id };
  }

  return ensureLeagueActorAuthUser(supabase, autoProvision.email, autoProvision.displayName);
}

/**
 * Who may create a league row:
 * - Dev bypass: auto Auth user (or `COMMISSIONER_LEAGUE_OWNER_USER_ID`)
 * - Commissioner password: auto Auth user at `COMMISSIONER_LEAGUE_OWNER_EMAIL` or default email (or explicit UUID env)
 * - Bearer token: JWT subject as profile id
 */
export async function resolveCreateLeagueActor(
  req: Request,
  supabase: SupabaseClient
): Promise<CreateLeagueActorResult> {
  if (process.env.ALLOW_COMMISSIONER_ROUTES_WITHOUT_AUTH === "true") {
    const r = await resolvePoolLeagueActorUserId(supabase, {
      email: DEV_POOL_LEAGUE_ACTOR_EMAIL,
      displayName: "Dev league actor"
    });
    if (!r.ok) return { ok: false, status: r.status, error: r.error };
    return { ok: true, profileId: r.userId, email: null };
  }

  const apiSecret = process.env.COMMISSIONER_API_SECRET?.trim();
  const hdrSecret = req.headers.get("x-player-pool-commissioner-secret")?.trim();
  if (apiSecret && hdrSecret && hdrSecret === apiSecret) {
    const email =
      process.env.COMMISSIONER_LEAGUE_OWNER_EMAIL?.trim() || DEFAULT_COMMISSIONER_LEAGUE_OWNER_EMAIL;
    const r = await resolvePoolLeagueActorUserId(supabase, {
      email,
      displayName: "League owner (commissioner password)"
    });
    if (!r.ok) return { ok: false, status: r.status, error: r.error };
    return { ok: true, profileId: r.userId, email: null };
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
  if (error || !data?.user?.id) {
    return { ok: false, status: 401, error: "Invalid or expired access token." };
  }

  const uid = data.user.id;
  const { data: adminRow, error: adminErr } = await supabase.auth.admin.getUserById(uid);
  if (adminErr || !adminRow?.user?.id) {
    return {
      ok: false,
      status: 401,
      error:
        "This access token is not for the same Supabase project as the server (no Auth user with that id here). Create the league using the commissioner password, or sign in on this deployment and retry."
    };
  }

  return { ok: true, profileId: uid, email: data.user.email ?? null };
}
