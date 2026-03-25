import { NextResponse } from "next/server";
import { displayCollegeTeamNameForUi } from "@/lib/college-team-display";
import { z } from "zod";
import { createSupabaseAdminClientSafe } from "@/lib/supabase/admin";
import { requireLeagueOfficer } from "@/lib/commissioner/require-league-officer";
import {
  loadSeasonProjectionBundle,
  playerTournamentProjections,
  projectionIntForPlayer
} from "@/lib/player-pool-projection";
import { playerEligibleForDraftAndPool } from "@/lib/player-pool-eligibility";
import { resolvePlayerHeadshotUrlCandidates } from "@/lib/player-media";
import { regionNameFromOverallSeedApprox } from "@/lib/henrygd-bracket-seeds";
import { fetchTournamentSeasonTeamsMerged } from "@/lib/tournament-season-teams";

function safeNum(x: unknown) {
  const n = typeof x === "number" ? x : Number(x);
  return Number.isFinite(n) ? n : 0;
}

function regionLabelForTeam(t: Record<string, unknown> | undefined): string | null {
  if (!t) return null;
  const tr = t.region;
  if (tr != null && String(tr).trim() !== "") return String(tr).trim();
  const os = t.overall_seed;
  const on = typeof os === "number" ? os : Number(os);
  if (Number.isFinite(on) && on >= 1 && on <= 68) {
    return regionNameFromOverallSeedApprox(Math.trunc(on));
  }
  return null;
}

/** Average fantasy points per R1–R6 round that has box-score data (matches Player Statistics TPPG). */
function tppgFromRoundMap(byR: Record<number, number> | undefined): number | null {
  if (!byR) return null;
  let sum = 0;
  let n = 0;
  for (let r = 1; r <= 6; r++) {
    if (!Object.prototype.hasOwnProperty.call(byR, r)) continue;
    const v = byR[r];
    if (typeof v === "number" && Number.isFinite(v)) {
      sum += v;
      n += 1;
    }
  }
  return n > 0 ? sum / n : null;
}

const querySchema = z.object({
  /** Preferred: league team UUID from session “who I am”. */
  leagueTeamId: z.string().min(1).optional(),
  // optional; legacy fallback when no leagueTeamId
  username: z.string().optional(),
  overallMin: z.coerce.number().int().min(1).max(68).optional(),
  overallMax: z.coerce.number().int().min(1).max(68).optional(),
  // kept for backward compatibility, but draft board ordering is projection-based
  sort: z.enum(["overall_seed_asc", "overall_seed_desc", "name"]).optional()
});

function calcTurn({
  currentPickOverall,
  draftOrder
}: {
  currentPickOverall: number;
  draftOrder: string[];
}) {
  const ownersCount = draftOrder.length;
  if (ownersCount <= 0) {
    return { roundNumber: 1, pickNumberInRound: 1, currentLeagueTeamId: null as string | null };
  }

  const idx = currentPickOverall - 1; // 0-based pick index
  const roundNumber = Math.floor(idx / ownersCount) + 1; // 1-based
  const pickNumberInRound = (idx % ownersCount) + 1; // 1..N

  const forward = draftOrder;
  const reverse = [...draftOrder].reverse();
  const snakeOrder = roundNumber % 2 === 1 ? forward : reverse;
  const currentLeagueTeamId = snakeOrder[pickNumberInRound - 1] ?? null;

  return { roundNumber, pickNumberInRound, currentLeagueTeamId };
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ leagueId: string }> }
) {
  const leagueId = (await params).leagueId;
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
  const parsed = querySchema.safeParse(Object.fromEntries(new URL(req.url).searchParams.entries()));
  const q = parsed.success ? parsed.data : {};
  const leagueTeamIdParam = q.leagueTeamId;
  const username = q.username;
  const overallMin = q.overallMin;
  const overallMax = q.overallMax;
  void q.sort; // draft board ordering is always projection-based

  const { data: draftRoom } = await supabase
    .from("draft_rooms")
    .select("*")
    .eq("league_id", leagueId)
    .maybeSingle();

  if (!draftRoom) {
    return NextResponse.json({ error: "draft room not found" }, { status: 404 });
  }

  const draftOrder = (draftRoom.draft_order ?? []) as string[];
  const { roundNumber, pickNumberInRound, currentLeagueTeamId } = calcTurn({
    currentPickOverall: draftRoom.current_pick_overall ?? 1,
    draftOrder
  });

  const { data: picks } = await supabase
    .from("player_draft_picks")
    .select("*")
    .eq("draft_room_id", draftRoom.id)
    .order("pick_overall", { ascending: true });

  const pickedPlayerIds = new Set((picks ?? []).map((p: any) => p.player_id));

  const { data: league } = await supabase
    .from("leagues")
    .select("season_year")
    .eq("id", leagueId)
    .maybeSingle();

  const seasonYear = (league as any)?.season_year as number | undefined;
  if (!seasonYear) {
    return NextResponse.json({ error: "league season_year missing" }, { status: 404 });
  }

  const { data: boardRow } = await supabase
    .from("league_live_scoreboard")
    .select("updated_at")
    .eq("league_id", leagueId)
    .maybeSingle();
  const boardUpdatedAt =
    typeof (boardRow as { updated_at?: unknown } | null)?.updated_at === "string"
      ? String((boardRow as { updated_at: string }).updated_at)
      : null;

  const { data: players } = await supabase
    .from("players")
    .select("id, name, season_ppg, team_id, short_name, position, headshot_url, espn_athlete_id")
    .eq("season_year", seasonYear);

  const playerTeamIds = (players ?? [])
    .map((p: { team_id?: unknown }) => safeNum(p.team_id))
    .filter((id: number) => id > 0);
  const teamsMerged = await fetchTournamentSeasonTeamsMerged(
    supabase,
    seasonYear,
    playerTeamIds,
    "id, name, short_name, seed, overall_seed, region, conference, is_power5, external_team_id, logo_url"
  );
  const teamById = new Map<number, any>(teamsMerged.map((t: any) => [t.id, t]));

  let pool = (players ?? []).filter(
    (p: any) =>
      !pickedPlayerIds.has(p.id) && playerEligibleForDraftAndPool(p.season_ppg, teamById.get(p.team_id))
  );

  if (overallMin != null) {
    pool = pool.filter(
      (p: any) => teamById.get(p.team_id)?.overall_seed != null && teamById.get(p.team_id)?.overall_seed >= overallMin
    );
  }
  if (overallMax != null) {
    pool = pool.filter(
      (p: any) => teamById.get(p.team_id)?.overall_seed != null && teamById.get(p.team_id)?.overall_seed <= overallMax
    );
  }

  const allSeasonPlayerIds = (players ?? []).map((p: { id?: unknown }) => safeNum(p.id)).filter((id) => id > 0);
  const projectionBundle = await loadSeasonProjectionBundle(supabase, seasonYear, allSeasonPlayerIds);

  pool.sort((a: any, b: any) => {
    const aProj = projectionIntForPlayer({
      teamId: safeNum(a.team_id),
      playerId: safeNum(a.id),
      seasonPpg: a.season_ppg,
      bundle: projectionBundle
    });
    const bProj = projectionIntForPlayer({
      teamId: safeNum(b.team_id),
      playerId: safeNum(b.id),
      seasonPpg: b.season_ppg,
      bundle: projectionBundle
    });
    if (bProj !== aProj) return bProj - aProj;
    return String(a.name ?? "").localeCompare(String(b.name ?? ""));
  });

  const availablePlayers = pool.slice(0, 500);

  const { data: leagueTeams } = await supabase
    .from("league_teams")
    .select("id, team_name, user_id, draft_position")
    .eq("league_id", leagueId);

  const leagueTeamRows = leagueTeams ?? [];
  const leagueTeamsById = new Map<string, any>();
  for (const lt of leagueTeamRows) leagueTeamsById.set(lt.id, lt);

  const { data: profiles } = await supabase
    .from("profiles")
    .select("id, display_name");
  const profilesById = new Map<string, any>(
    (profiles ?? []).map((p: any) => [p.id, p])
  );

  let yourLeagueTeamId: string | null = null;
  if (leagueTeamIdParam) {
    const hit = leagueTeamRows.find((t: any) => t.id === leagueTeamIdParam);
    yourLeagueTeamId = hit ? leagueTeamIdParam : null;
  } else if (username) {
    yourLeagueTeamId = leagueTeamRows.find((t: any) => t.team_name === username)?.id ?? null;
  }

  /** Picks can reference teams outside the season `external_team_id` filter; load those for board display. */
  const missingPickTeamIds = new Set<number>();
  for (const p of picks ?? []) {
    const row = (players ?? []).find((x: any) => x.id === p.player_id);
    const tid = row != null ? safeNum(row.team_id) : safeNum((p as { team_id?: unknown }).team_id);
    if (tid > 0 && !teamById.has(tid)) missingPickTeamIds.add(tid);
  }
  if (missingPickTeamIds.size > 0) {
    const { data: extraTeams } = await supabase
      .from("teams")
      .select(
        "id, name, short_name, seed, overall_seed, region, conference, is_power5, external_team_id, logo_url"
      )
      .in("id", [...missingPickTeamIds]);
    for (const t of extraTeams ?? []) {
      const id = safeNum((t as { id?: unknown }).id);
      if (id > 0) teamById.set(id, t);
    }
  }

  let viewerCanCommissionerPick = false;
  if (String(draftRoom.status ?? "") === "in_progress") {
    const officer = await requireLeagueOfficer(req, supabase, leagueId);
    viewerCanCommissionerPick = officer.ok;
  }

  return NextResponse.json({
    seasonYear,
    lastSyncedAt: boardUpdatedAt,
    draftRoom: {
      id: draftRoom.id,
      leagueId,
      status: draftRoom.status,
      totalRounds: draftRoom.total_rounds,
      rosterSize: draftRoom.roster_size,
      pickTimerSeconds: draftRoom.pick_timer_seconds,
      currentPickOverall: draftRoom.current_pick_overall,
      startedAt: draftRoom.started_at,
      completedAt: draftRoom.completed_at
    },
    draftOrder,
    currentTurn: {
      roundNumber,
      pickNumberInRound,
      leagueTeamId: currentLeagueTeamId
    },
    picks: (picks ?? []).map((p: any) => {
      const lt = leagueTeamsById.get(p.league_team_id);

      const playerRow = (players ?? []).find((x: any) => x.id === p.player_id);
      const teamId = playerRow != null ? safeNum(playerRow.team_id) : safeNum(p.team_id);
      const playerTeam = teamId > 0 ? teamById.get(teamId) : null;
      const playerId = playerRow != null ? safeNum(playerRow.id) : 0;
      const pickProj =
        playerRow != null && teamId > 0 && playerId > 0
          ? playerTournamentProjections({
              teamId,
              playerId,
              seasonPpg: playerRow.season_ppg,
              bundle: projectionBundle
            })
          : null;
      const pickTeamDisplay = playerTeam
        ? displayCollegeTeamNameForUi(playerTeam, `Team #${safeNum(playerTeam.id)}`)
        : "";

      return {
        pickOverall: p.pick_overall,
        roundNumber: p.round_number,
        pickNumberInRound: p.pick_number_in_round,
        leagueTeamId: p.league_team_id,
        ownerName:
          lt?.team_name ??
          profilesById.get(lt?.user_id)?.display_name ??
          "Unknown",
        player: playerRow
          ? {
              id: playerRow.id,
              name: playerRow.name,
              shortName: playerRow.short_name,
              espnAthleteId: playerRow.espn_athlete_id ?? null,
              seasonPpg: playerRow.season_ppg ?? null,
              position:
                playerRow.position != null && String(playerRow.position).trim()
                  ? String(playerRow.position).trim()
                  : null,
              headshotUrls: resolvePlayerHeadshotUrlCandidates({
                headshot_url: playerRow.headshot_url != null ? String(playerRow.headshot_url) : null,
                espn_athlete_id: playerRow.espn_athlete_id as number | string | null | undefined
              }),
              originalProjection: pickProj != null ? Math.round(pickProj.originalProjection) : null,
              projection: pickProj != null ? Math.round(pickProj.liveProjection) : null,
              team: playerTeam
                ? {
                    id: playerTeam.id,
                    name: pickTeamDisplay,
                    shortName: pickTeamDisplay,
                    seed: playerTeam.seed,
                    region: regionLabelForTeam(playerTeam),
                    conference: playerTeam.conference,
                    isPower5: playerTeam.is_power5,
                    logoUrl:
                      playerTeam.logo_url != null && String(playerTeam.logo_url).trim()
                        ? String(playerTeam.logo_url).trim()
                        : null
                  }
                : null
            }
          : {
              id: p.player_id,
              name: `Player ${p.player_id}`,
              shortName: null,
              espnAthleteId: null,
              seasonPpg: null,
              team: null
            }
      };
    }),
    availablePlayers: availablePlayers.map((p: any) => {
      const t = teamById.get(p.team_id);
      const tid = safeNum(p.team_id);
      const pid = safeNum(p.id);
      const tproj = playerTournamentProjections({
        teamId: tid,
        playerId: pid,
        seasonPpg: p.season_ppg,
        bundle: projectionBundle
      });
      const byR = projectionBundle.pointsByDisplayRoundByPlayer.get(pid);
      const tppg = tppgFromRoundMap(byR);
      const liveRounded = Math.round(tproj.liveProjection);
      const origRounded = Math.round(tproj.originalProjection);
      const headshotUrls = resolvePlayerHeadshotUrlCandidates({
        headshot_url: p.headshot_url != null ? String(p.headshot_url) : null,
        espn_athlete_id: p.espn_athlete_id as number | string | null | undefined
      });
      const dbLogo = t?.logo_url != null ? String(t.logo_url).trim() : "";
      const availTeamDisplay = t
        ? displayCollegeTeamNameForUi(t, `Team #${safeNum(t.id)}`)
        : "—";

      return {
        id: p.id,
        name: p.name,
        shortName: p.short_name,
        espnAthleteId: p.espn_athlete_id ?? null,
        position: p.position != null && String(p.position).trim() ? String(p.position).trim() : null,
        seasonPpg: p.season_ppg ?? null,
        headshotUrls,
        displayHeadshotUrl: headshotUrls[0] ?? null,
        /** Live projection integer (list order + legacy clients). */
        chalkProjection: projectionIntForPlayer({
          teamId: tid,
          playerId: pid,
          seasonPpg: p.season_ppg,
          bundle: projectionBundle
        }),
        /** Pre-tournament orig projection (same formula as Player Statistics “Orig Proj” / draft column “Draft Projection”). */
        projection: origRounded,
        /** Explicit pre-tournament value for ADP/report-card consumers. */
        originalProjection: origRounded,
        projectionPlusMinus: liveRounded - origRounded,
        tppg,
        team: t
          ? {
              id: t.id,
              name: availTeamDisplay,
              shortName: availTeamDisplay,
              seed: t.seed,
              overallSeed: t.overall_seed ?? null,
              region: regionLabelForTeam(t),
              conference: t.conference,
              isPower5: t.is_power5,
              logoUrl: dbLogo || null
            }
          : null
      };
    }),
    leagueTeams: leagueTeamRows.map((t: any) => ({
      id: t.id as string,
      teamName: t.team_name as string
    })),
    yourLeagueTeamId,
    viewerCanCommissionerPick
  });
}

