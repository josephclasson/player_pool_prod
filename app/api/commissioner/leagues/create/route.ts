import { NextResponse } from "next/server";
import { z } from "zod";
import { createSupabaseAdminClientSafe } from "@/lib/supabase/admin";
import { ensureProfileForAuthUser } from "@/lib/commissioner/ensure-profile-for-auth-user";
import { resolveCreateLeagueActor } from "@/lib/commissioner/resolve-create-league-actor";

const bodySchema = z.object({
  name: z.string().min(1).max(120),
  /** Short league id / code (e.g. CHALK26) — stored in `leagues.code`, unique per season. */
  code: z.string().min(1).max(12),
  seasonYear: z.number().int().min(2000).max(3000),
  defaultPasscode: z.string().min(1).max(64).optional(),
  guestPasscode: z.string().min(1).max(64).optional()
});

export async function POST(req: Request) {
  const supabase = createSupabaseAdminClientSafe();
  if (!supabase) {
    return NextResponse.json({ error: "Supabase not configured" }, { status: 503 });
  }

  const actor = await resolveCreateLeagueActor(req, supabase);
  if (!actor.ok) {
    return NextResponse.json({ error: actor.error }, { status: actor.status });
  }

  let raw: unknown = {};
  try {
    raw = await req.json();
  } catch {
    raw = {};
  }

  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const { name, code, seasonYear, defaultPasscode, guestPasscode } = parsed.data;
  const codeNorm = code.trim();

  const ownerParsed = z.string().uuid().safeParse(String(actor.profileId).trim());
  if (!ownerParsed.success) {
    return NextResponse.json(
      { error: "Invalid league owner user id from auth — cannot create league." },
      { status: 500 }
    );
  }
  const ownerUserId = ownerParsed.data;

  const { data: authActor, error: authActorErr } = await supabase.auth.admin.getUserById(ownerUserId);
  if (authActorErr || !authActor?.user?.id) {
    return NextResponse.json(
      {
        error:
          "Create league needs a Supabase Auth user for the league owner. If you used a Bearer token, it must be from this project. Prefer the commissioner password in the site header, or set COMMISSIONER_LEAGUE_OWNER_USER_ID to a user UUID from Dashboard → Authentication."
      },
      { status: 500 }
    );
  }

  const emailForDisplay =
    actor.email?.trim() || authActor.user.email?.trim() || "";
  const displayName = emailForDisplay.split("@")[0]?.trim().slice(0, 80) || "Commissioner";

  const profileOk = await ensureProfileForAuthUser(supabase, ownerUserId, displayName);
  if (!profileOk.ok) {
    return NextResponse.json({ error: profileOk.error }, { status: 500 });
  }

  const { data: created, error } = await supabase
    .from("leagues")
    .insert({
      name: name.trim(),
      season_year: seasonYear,
      code: codeNorm,
      owner_id: ownerUserId,
      default_passcode: defaultPasscode ?? null,
      guest_passcode: guestPasscode ?? "guest"
    })
    .select("id, name, code, season_year")
    .single();

  if (error) {
    if (String(error.code) === "23505") {
      return NextResponse.json(
        {
          error: `A league with code "${codeNorm}" already exists for season ${seasonYear}. Pick another code or season.`
        },
        { status: 409 }
      );
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const row = created as { id: string; name: string; code: string; season_year: number };

  await supabase.from("league_members").upsert(
    {
      league_id: row.id,
      user_id: ownerUserId,
      role: "commissioner",
      is_autodraft: false
    },
    { onConflict: "league_id,user_id" }
  );

  return NextResponse.json({
    status: "ok",
    league: {
      id: row.id,
      name: row.name,
      code: row.code,
      seasonYear: row.season_year
    }
  });
}
