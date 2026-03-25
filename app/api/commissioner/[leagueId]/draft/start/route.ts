import { NextResponse } from "next/server";
import { z } from "zod";
import { createSupabaseAdminClientSafe } from "@/lib/supabase/admin";
import { resolveLeagueFromCommissionerParam } from "@/lib/commissioner/resolve-league";
import { requireLeagueOfficer } from "@/lib/commissioner/require-league-officer";
import { ensureDraftRoomStarted } from "@/lib/draft/ensure-draft-room-started";
import { persistLeagueLiveScoreboard } from "@/lib/scoring/persist-league-scoreboard";

const bodySchema = z.object({
  totalRounds: z.number().int().min(1).max(24).optional(),
  rosterSize: z.number().int().min(1).max(24).optional(),
  pickTimerSeconds: z.number().int().min(10).max(600).optional()
});

export async function POST(
  req: Request,
  { params }: { params: Promise<{ leagueId: string }> }
) {
  const { leagueId: param } = await params;
  if (!param) {
    return NextResponse.json({ error: "leagueId required" }, { status: 400 });
  }

  const supabase = createSupabaseAdminClientSafe();
  if (!supabase) {
    return NextResponse.json({ error: "Supabase not configured" }, { status: 503 });
  }

  const resolved = await resolveLeagueFromCommissionerParam(supabase, param);
  if (!resolved.ok) {
    return NextResponse.json({ error: resolved.error }, { status: resolved.status });
  }

  const officer = await requireLeagueOfficer(req, supabase, resolved.league.id);
  if (!officer.ok) {
    return NextResponse.json({ error: officer.error }, { status: officer.status });
  }

  let body: unknown = {};
  try {
    body = await req.json();
  } catch {
    body = {};
  }
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const result = await ensureDraftRoomStarted(supabase, resolved.league.id, {
    totalRounds: parsed.data.totalRounds,
    rosterSize: parsed.data.rosterSize,
    pickTimerSeconds: parsed.data.pickTimerSeconds
  });

  if (!result.ok) {
    const status = result.code === "completed" ? 409 : result.code === "no_teams" ? 400 : 500;
    return NextResponse.json({ error: result.error, code: result.code }, { status });
  }

  try {
    await persistLeagueLiveScoreboard(supabase, resolved.league.id);
  } catch {
    /* optional */
  }

  return NextResponse.json({
    status: "ok",
    draftRoomId: result.draftRoomId,
    startStatus: result.status,
    leagueId: resolved.league.id
  });
}
