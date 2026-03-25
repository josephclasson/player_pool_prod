import { NextResponse } from "next/server";
import { z } from "zod";
import { createSupabaseAdminClientSafe } from "@/lib/supabase/admin";
import { persistLeagueLiveScoreboard } from "@/lib/scoring/persist-league-scoreboard";
import { captureLeagueOriginalProjectionsIfNeeded } from "@/lib/projections";
import { requireLeagueOfficer } from "@/lib/commissioner/require-league-officer";
import { MIN_POOL_SEASON_PPG } from "@/lib/player-pool-constants";
import { playerHasValidSeasonPpg } from "@/lib/player-pool-eligibility";

const bodySchema = z
  .object({
    leagueTeamId: z.string().min(1).optional(),
    playerId: z.number().int().positive(),
    /**
     * When true, caller must be a league officer; pick is recorded for whoever is **on the clock**
     * (same as a normal pick, but does not require the caller to own that team).
     */
    commissionerOverride: z.boolean().optional()
  })
  .refine((b) => b.commissionerOverride === true || Boolean(b.leagueTeamId?.trim()), {
    message: "leagueTeamId is required unless commissionerOverride is true"
  });

function calcTurn({
  currentPickOverall,
  draftOrder
}: {
  currentPickOverall: number;
  draftOrder: string[];
}) {
  const ownersCount = draftOrder.length;
  const idx = currentPickOverall - 1;
  const roundNumber = Math.floor(idx / ownersCount) + 1;
  const pickNumberInRound = (idx % ownersCount) + 1;
  const snakeOrder = roundNumber % 2 === 1 ? draftOrder : [...draftOrder].reverse();
  const currentLeagueTeamId = snakeOrder[pickNumberInRound - 1] ?? null;
  return { roundNumber, pickNumberInRound, currentLeagueTeamId };
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ leagueId: string }> }
) {
  const leagueId = (await params).leagueId;
  if (!leagueId) {
    return NextResponse.json({ error: "leagueId required" }, { status: 400 });
  }

  const raw = await req.text();
  let json: unknown;
  try {
    json = raw ? JSON.parse(raw) : {};
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const { leagueTeamId: bodyLeagueTeamId, playerId, commissionerOverride } = parsed.data;
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

  const { data: draftRoom } = await supabase
    .from("draft_rooms")
    .select("*")
    .eq("league_id", leagueId)
    .maybeSingle();

  if (!draftRoom) {
    return NextResponse.json({ error: "draft room not found" }, { status: 404 });
  }

  if (draftRoom.status !== "in_progress") {
    return NextResponse.json({ error: "draft not in progress" }, { status: 409 });
  }

  const draftOrder = (draftRoom.draft_order ?? []) as string[];
  if (!draftOrder.length) {
    return NextResponse.json({ error: "draft order missing" }, { status: 500 });
  }

  const { roundNumber, pickNumberInRound, currentLeagueTeamId } = calcTurn({
    currentPickOverall: draftRoom.current_pick_overall ?? 1,
    draftOrder
  });

  let leagueTeamId = bodyLeagueTeamId ?? "";

  if (commissionerOverride === true) {
    const officer = await requireLeagueOfficer(req, supabase, leagueId);
    if (!officer.ok) {
      return NextResponse.json({ error: officer.error }, { status: officer.status });
    }
    if (!currentLeagueTeamId) {
      return NextResponse.json({ error: "no team on the clock" }, { status: 409 });
    }
    leagueTeamId = currentLeagueTeamId;
  } else {
    if (!currentLeagueTeamId || currentLeagueTeamId !== leagueTeamId) {
      return NextResponse.json({ error: "not your turn", currentLeagueTeamId }, { status: 403 });
    }
  }

  const { data: alreadyPicked } = await supabase
    .from("player_draft_picks")
    .select("pick_overall")
    .eq("draft_room_id", draftRoom.id)
    .eq("player_id", playerId)
    .limit(1);

  if (alreadyPicked && alreadyPicked.length > 0) {
    return NextResponse.json({ error: "player already picked" }, { status: 409 });
  }

  const pickOverall = draftRoom.current_pick_overall ?? 1;

  const { data: playerRow, error: playerErr } = await supabase
    .from("players")
    .select("id, team_id, season_ppg")
    .eq("id", playerId)
    .maybeSingle();
  if (playerErr) throw playerErr;
  if (!playerRow) {
    return NextResponse.json({ error: "player not found" }, { status: 404 });
  }

  if (!playerHasValidSeasonPpg((playerRow as { season_ppg?: unknown }).season_ppg)) {
    return NextResponse.json(
      {
        error: `Player is not draft-eligible: season PPG must be at least ${MIN_POOL_SEASON_PPG} (populate tournament players or fix ingest).`
      },
      { status: 400 }
    );
  }

  // Transaction-ish: insert pick + roster_slot, then update draft_room counter.
  await supabase.from("player_draft_picks").insert({
    draft_room_id: draftRoom.id,
    league_team_id: leagueTeamId,
    player_id: playerId,
    team_id: playerRow.team_id,
    round_number: roundNumber,
    pick_number_in_round: pickNumberInRound,
    pick_overall: pickOverall,
    is_autopick: false
  });

  await supabase.from("player_roster_slots").insert({
    league_team_id: leagueTeamId,
    player_id: playerId,
    team_id: playerRow.team_id,
    round_slot: roundNumber,
    pick_overall: pickOverall,
    eliminated: false,
    first_four_team: false
  });

  const nextPick = pickOverall + 1;
  const ownersCount = draftOrder.length;
  const maxPick = (draftRoom.total_rounds ?? 6) * ownersCount;

  const status = nextPick > maxPick ? "completed" : "in_progress";
  const completedAt = status === "completed" ? new Date().toISOString() : null;

  await supabase
    .from("draft_rooms")
    .update({
      current_pick_overall: nextPick,
      status,
      completed_at: completedAt
    })
    .eq("id", draftRoom.id);

  if (status === "completed") {
    try {
      await captureLeagueOriginalProjectionsIfNeeded(supabase, leagueId);
    } catch {
      /* bracket / seeds optional at draft time */
    }
  }

  try {
    await persistLeagueLiveScoreboard(supabase, leagueId);
  } catch {
    // Table may not exist until migration 0008 is applied; draft still succeeds.
  }

  return NextResponse.json({
    status: "ok",
    pick: {
      leagueTeamId,
      playerId,
      pickOverall,
      roundNumber,
      pickNumberInRound,
      commissionerOverride: commissionerOverride === true
    }
  });
}

