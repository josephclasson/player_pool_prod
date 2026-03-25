import { NextResponse } from "next/server";
import { z } from "zod";
import { createSupabaseAdminClientSafe } from "@/lib/supabase/admin";
import { resolveLeagueFromCommissionerParam } from "@/lib/commissioner/resolve-league";
import { requireLeagueOfficer } from "@/lib/commissioner/require-league-officer";
import { syncLeagueOwnerTeams } from "@/lib/demo/sync-league-teams";

const teamRowSchema = z.object({
  id: z
    .preprocess(
      (v) => (v === undefined || v === null || (typeof v === "string" && v.trim() === "") ? undefined : v),
      z.string().optional()
    )
    .optional(),
  teamName: z.string().min(1).max(48)
});

const bodySchema = z.object({
  teams: z.array(teamRowSchema).min(1).max(12),
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

export async function PUT(req: Request, { params }: { params: Promise<{ leagueId: string }> }) {
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
    const result = await syncLeagueOwnerTeams({
      supabase,
      leagueId: id,
      leagueCode: code,
      teams: parsed.data.teams.map((t) => ({ id: t.id ?? null, teamName: t.teamName })),
      passcode: parsed.data.passcode
    });
    return NextResponse.json({
      status: "ok",
      ...result,
      hint: "If you changed owner count, use Draft reset in commissioner tools, then re-open the draft."
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 400 });
  }
}
