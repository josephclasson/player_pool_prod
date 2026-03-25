import { NextResponse } from "next/server";
import { z } from "zod";
import { createSupabaseAdminClientSafe } from "@/lib/supabase/admin";
import { resolveLeagueFromCommissionerParam } from "@/lib/commissioner/resolve-league";
import { populatePoolPlayersFromEspn } from "@/lib/populate-pool-espn";

const bodySchema = z.object({
  replace: z.boolean().optional(),
  source: z.string().min(1).max(120).optional()
});

export async function POST(req: Request, { params }: { params: Promise<{ leagueId: string }> }) {
  const { leagueId } = await params;
  if (!leagueId) return NextResponse.json({ error: "leagueId required" }, { status: 400 });

  const supabase = createSupabaseAdminClientSafe();
  if (!supabase) {
    return NextResponse.json(
      {
        error: "Supabase not configured",
        missing: [
          !process.env.NEXT_PUBLIC_SUPABASE_URL ? "NEXT_PUBLIC_SUPABASE_URL" : null,
          !process.env.SUPABASE_SERVICE_ROLE_KEY ? "SUPABASE_SERVICE_ROLE_KEY" : null
        ].filter(Boolean)
      },
      { status: 503 }
    );
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

  const resolved = await resolveLeagueFromCommissionerParam(supabase, leagueId);
  if (!resolved.ok) {
    return NextResponse.json({ error: resolved.error }, { status: resolved.status });
  }
  const seasonYear = resolved.league.season_year;

  try {
    const result = await populatePoolPlayersFromEspn({
      supabase,
      seasonYear,
      replace: parsed.data.replace ?? true,
      source: parsed.data.source
    });
    return NextResponse.json({ status: "ok", ...result });
  } catch (e: unknown) {
    let msg: string;
    if (e instanceof Error) {
      msg = e.message;
    } else if (e && typeof e === "object" && "message" in e) {
      const m = (e as { message?: unknown }).message;
      msg = typeof m === "string" ? m : JSON.stringify(e);
    } else {
      msg = typeof e === "string" ? e : JSON.stringify(e);
    }
    return NextResponse.json({ error: msg }, { status: 400 });
  }
}
