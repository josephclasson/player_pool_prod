import { NextResponse } from "next/server";
import { z } from "zod";
import { createSupabaseAdminClientSafe } from "@/lib/supabase/admin";
import { resolveLeagueFromCommissionerParam } from "@/lib/commissioner/resolve-league";
import { requireLeagueOfficer } from "@/lib/commissioner/require-league-officer";
import { ensureLeagueOwnerRows } from "@/lib/demo/ensure-owners";

const bodySchema = z.object({
  /** Display names in draft order (1..N). Creates auth users + league_teams + members. */
  ownerDisplayNames: z.array(z.string().min(1).max(48)).min(1).max(12),
  /**
   * Optional demo-user password. Empty / whitespace / null are treated as omitted (server default).
   * When set, must be at least 3 characters (matches Draft tab default `365` and `demoPassword` logic).
   */
  passcode: z.preprocess(
    (v) => {
      if (v === undefined || v === null) return undefined;
      if (typeof v !== "string") return undefined;
      const t = v.trim();
      return t.length === 0 ? undefined : t;
    },
    z.string().min(3).max(64).optional()
  )
});

export async function POST(req: Request, { params }: { params: Promise<{ leagueId: string }> }) {
  const { leagueId } = await params;
  if (!leagueId) return NextResponse.json({ error: "leagueId required" }, { status: 400 });

  const supabase = createSupabaseAdminClientSafe();
  if (!supabase) {
    return NextResponse.json({ error: "Supabase not configured" }, { status: 503 });
  }

  const resolved = await resolveLeagueFromCommissionerParam(supabase, leagueId);
  if (!resolved.ok) {
    return NextResponse.json({ error: resolved.error }, { status: resolved.status });
  }
  const id = resolved.league.id;

  const officer = await requireLeagueOfficer(req, supabase, id);
  if (!officer.ok) {
    return NextResponse.json({ error: officer.error }, { status: officer.status });
  }

  const { data: league } = await supabase.from("leagues").select("code").eq("id", id).maybeSingle();
  const code = (league as { code?: string } | null)?.code;
  if (!code) {
    return NextResponse.json({ error: "league code missing" }, { status: 500 });
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

  try {
    const { createdOrUpdated } = await ensureLeagueOwnerRows({
      supabase,
      leagueId: id,
      leagueCode: code,
      ownerDisplayNames: parsed.data.ownerDisplayNames,
      passcode: parsed.data.passcode
    });
    return NextResponse.json({
      status: "ok",
      createdOrUpdated,
      hint: "If you changed owner count, use Draft reset in commissioner tools, then re-open the draft."
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
