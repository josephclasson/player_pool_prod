import { NextResponse } from "next/server";
import { createSupabaseAdminClientSafe } from "@/lib/supabase/admin";
import { resolveLeagueFromCommissionerParam } from "@/lib/commissioner/resolve-league";
import { requireLeagueOfficer } from "@/lib/commissioner/require-league-officer";
import {
  buildDraftBulkAssignTemplateWorkbook,
  type DraftBulkAssignPlayerPoolRow,
  type DraftBulkAssignTemplateTeamRow
} from "@/lib/commissioner/draft-bulk-assign-excel";

export const runtime = "nodejs";

function safeFilenamePart(s: string) {
  return s.replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 48) || "league";
}

export async function GET(req: Request, { params }: { params: Promise<{ leagueId: string }> }) {
  const { leagueId } = await params;
  if (!leagueId) {
    return NextResponse.json({ error: "leagueId required" }, { status: 400 });
  }

  const supabase = createSupabaseAdminClientSafe();
  if (!supabase) {
    return NextResponse.json({ error: "Supabase not configured" }, { status: 503 });
  }

  const resolved = await resolveLeagueFromCommissionerParam(supabase, leagueId);
  if (!resolved.ok) {
    return NextResponse.json({ error: resolved.error }, { status: resolved.status });
  }
  const canonicalId = resolved.league.id;
  const seasonYear = resolved.league.season_year;

  const officer = await requireLeagueOfficer(req, supabase, canonicalId);
  if (!officer.ok) {
    return NextResponse.json({ error: officer.error }, { status: officer.status });
  }

  const { data: leagueRow } = await supabase
    .from("leagues")
    .select("code")
    .eq("id", canonicalId)
    .maybeSingle();
  const code = (leagueRow as { code?: string } | null)?.code?.trim();

  const { data: draftRoom, error: drErr } = await supabase
    .from("draft_rooms")
    .select("draft_order, total_rounds")
    .eq("league_id", canonicalId)
    .maybeSingle();
  if (drErr) {
    return NextResponse.json({ error: drErr.message }, { status: 503 });
  }
  if (!draftRoom) {
    return NextResponse.json(
      { error: "Draft room not found. Ensure owners / draft are initialized for this league." },
      { status: 404 }
    );
  }

  const draftOrder = (draftRoom.draft_order ?? []) as string[];
  if (draftOrder.length === 0) {
    return NextResponse.json({ error: "Draft order is empty." }, { status: 400 });
  }

  const totalRounds = Math.max(1, Math.min(32, Number(draftRoom.total_rounds ?? 6) || 6));

  const { data: leagueTeams } = await supabase
    .from("league_teams")
    .select("id, team_name")
    .eq("league_id", canonicalId);
  const nameByLt = new Map<string, string>(
    (leagueTeams ?? []).map((r: { id: string; team_name?: string }) => [
      r.id,
      String(r.team_name ?? "").trim() || r.id.slice(0, 8)
    ])
  );

  const teamRows: DraftBulkAssignTemplateTeamRow[] = draftOrder.map((leagueTeamId, i) => ({
    leagueTeamId,
    snakePickOrder: i + 1,
    ownerDisplay: nameByLt.get(leagueTeamId) ?? leagueTeamId.slice(0, 8)
  }));

  const { data: players } = await supabase
    .from("players")
    .select("id, name, short_name, season_ppg, team_id")
    .eq("season_year", seasonYear);

  const teamIds = [
    ...new Set(
      (players ?? [])
        .map((p: { team_id?: unknown }) => Number(p.team_id))
        .filter((n) => Number.isFinite(n) && n > 0)
    )
  ];
  const { data: teams } =
    teamIds.length > 0
      ? await supabase.from("teams").select("id, name, short_name").in("id", teamIds)
      : { data: [] as { id: number; name?: string; short_name?: string }[] };

  const collegeByTeamId = new Map<number, string>();
  for (const t of teams ?? []) {
    const id = Number((t as { id?: unknown }).id);
    if (!Number.isFinite(id)) continue;
    const short = String((t as { short_name?: string }).short_name ?? "").trim();
    const full = String((t as { name?: string }).name ?? "").trim();
    collegeByTeamId.set(id, short || full || `Team ${id}`);
  }

  const playerPool: DraftBulkAssignPlayerPoolRow[] = (players ?? [])
    .map((p: { id?: unknown; name?: string; short_name?: string; season_ppg?: unknown; team_id?: unknown }) => {
      const pid = Number(p.id);
      const tid = Number(p.team_id);
      return {
        playerId: pid,
        playerName: String(p.short_name ?? "").trim() || String(p.name ?? "").trim() || `Player ${pid}`,
        collegeTeam: Number.isFinite(tid) && tid > 0 ? collegeByTeamId.get(tid) ?? `Team ${tid}` : "—",
        seasonPpg: typeof p.season_ppg === "number" && Number.isFinite(p.season_ppg) ? p.season_ppg : null
      };
    })
    .filter((r) => Number.isFinite(r.playerId) && r.playerId > 0)
    .sort((a, b) => a.playerName.localeCompare(b.playerName));

  const leagueLabel = code ? `${code} (${canonicalId.slice(0, 8)}…)` : canonicalId;

  try {
    const buf = await buildDraftBulkAssignTemplateWorkbook({
      leagueLabel,
      totalRounds,
      teamRows,
      playerPool
    });
    const out = Buffer.from(buf);
    const fname = `draft-bulk-assign-${safeFilenamePart(code ?? canonicalId.slice(0, 8))}.xlsx`;
    return new NextResponse(out, {
      status: 200,
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="${fname}"`
      }
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
