import { NextResponse } from "next/server";
import { createSupabaseAdminClientSafe } from "@/lib/supabase/admin";

function safeNum(x: unknown) {
  const n = typeof x === "number" ? x : Number(x);
  return Number.isFinite(n) ? n : 0;
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ leagueId: string }> }
) {
  const { leagueId } = await params;
  if (!leagueId) {
    return NextResponse.json({ error: "leagueId required" }, { status: 400 });
  }

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

  // Current round from live/final games.
  const { data: games } = await supabase
    .from("games")
    .select("id, round, status, start_time, team_a_id, team_b_id")
    .in("round", [1, 2, 3, 4, 5, 6])
    .in("status", ["live", "final"]);

  const gameRows = (games ?? []) as any[];

  const currentRound = gameRows.length ? Math.max(...gameRows.map((g) => safeNum(g.round))) : 0;

  const gameIds = gameRows.map((g) => safeNum(g.id));
  const { data: stats } = await supabase
    .from("team_game_stats")
    .select("game_id, team_id, points")
    .in("game_id", gameIds);

  const pointsByGameTeam = new Map<string, number>();
  for (const st of (stats ?? []) as any[]) {
    pointsByGameTeam.set(`${safeNum(st.game_id)}:${safeNum(st.team_id)}`, safeNum(st.points));
  }

  const resultGames = gameRows.map((g) => {
    const gameId = safeNum(g.id);
    const teamA = safeNum(g.team_a_id);
    const teamB = safeNum(g.team_b_id);
    return {
      id: gameId,
      round: safeNum(g.round),
      status: g.status,
      startTime: g.start_time,
      teamA: { id: teamA, name: "", score: pointsByGameTeam.get(`${gameId}:${teamA}`) ?? 0 },
      teamB: { id: teamB, name: "", score: pointsByGameTeam.get(`${gameId}:${teamB}`) ?? 0 }
    };
  });

  const teamIds = Array.from(
    new Set(
      resultGames.flatMap((g: any) => [safeNum(g.teamA.id), safeNum(g.teamB.id)])
    )
  );

  const { data: teams } = await supabase
    .from("teams")
    .select("id, name")
    .in("id", teamIds);
  const teamById = new Map<number, any>(
    (teams ?? []).map((t: any) => [safeNum(t.id), t])
  );

  for (const g of resultGames as any[]) {
    const tA = teamById.get(safeNum(g.teamA.id));
    const tB = teamById.get(safeNum(g.teamB.id));
    g.teamA.name = tA?.name ?? `Team ${g.teamA.id}`;
    g.teamB.name = tB?.name ?? `Team ${g.teamB.id}`;
  }

  return NextResponse.json({
    currentRound,
    games: resultGames.sort((a: any, b: any) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime())
  });
}

