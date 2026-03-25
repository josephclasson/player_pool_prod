import { NextResponse } from "next/server";
import { z } from "zod";
import { createSupabaseAdminClientSafe } from "@/lib/supabase/admin";
import { resolveLeagueFromCommissionerParam } from "@/lib/commissioner/resolve-league";
import { requireLeagueOfficer } from "@/lib/commissioner/require-league-officer";
import { computeLeagueLeaderboardAndRoundScores } from "@/lib/scoring";
import {
  captureLeagueOriginalProjectionsIfNeeded,
  computeLeagueProjections,
  upsertLeagueProjectionChalkPreservingOriginals
} from "@/lib/projections";
import { persistLeagueLiveScoreboard } from "@/lib/scoring/persist-league-scoreboard";
import { MIN_POOL_SEASON_PPG } from "@/lib/player-pool-constants";

const playerEntrySchema = z.object({
  name: z.string().min(1).max(120),
  shortName: z.string().min(1).max(120).optional(),
  position: z.string().min(1).max(64).optional(),
  externalPlayerId: z.string().min(1).max(128).optional(),
  seasonPpg: z.coerce.number().min(MIN_POOL_SEASON_PPG).max(200),
  // Team mapping options:
  // - `teamExternalTeamId` should equal teams.external_team_id (henrygd pattern: `${seo}-${seasonYear}`)
  // - or provide `teamSeo` and we will construct `${teamSeo}-${seasonYear}`
  teamExternalTeamId: z.string().min(1).max(128).optional(),
  teamSeo: z.string().min(1).max(64).optional()
});

const bodySchema = z.object({
  source: z.string().min(1).max(120).optional(),
  seasonYear: z.number().int().min(2000).max(3000).optional(),
  replace: z.boolean().optional(),
  players: z.array(playerEntrySchema).min(1).max(500)
});

export async function POST(
  req: Request,
  { params }: { params: Promise<{ leagueId: string }> }
) {
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

  const { source, seasonYear, replace, players } = parsed.data;

  const resolved = await resolveLeagueFromCommissionerParam(supabase, leagueId);
  if (!resolved.ok) {
    return NextResponse.json({ error: resolved.error }, { status: resolved.status });
  }
  const canonicalLeagueId = resolved.league.id;
  const resolvedSeasonYear = seasonYear ?? resolved.league.season_year;

  const officer = await requireLeagueOfficer(req, supabase, canonicalLeagueId);
  if (!officer.ok) {
    return NextResponse.json({ error: officer.error }, { status: officer.status });
  }

  const { data: teamRows } = await supabase
    .from("teams")
    .select("id, external_team_id, name, short_name")
    .order("id");

  const byExternal = new Map<string, number>((teamRows ?? []).map((t: any) => [t.external_team_id, t.id]));

  if (replace) {
    // Replace season players to avoid duplicates.
    await supabase.from("players").delete().eq("season_year", resolvedSeasonYear);
  }

  const withTeam = [];
  const missingTeam: typeof players = [];

  for (const p of players) {
    let ext = p.teamExternalTeamId;
    if (!ext && p.teamSeo) ext = `${p.teamSeo}-${resolvedSeasonYear}`;
    if (!ext) {
      missingTeam.push(p);
      continue;
    }
    const teamId = byExternal.get(ext);
    if (!teamId) {
      missingTeam.push(p);
      continue;
    }
    withTeam.push({ ...p, teamId });
  }

  if (withTeam.length === 0) {
    return NextResponse.json(
      { error: "No players could be mapped to teams", missingTeamCount: missingTeam.length },
      { status: 400 }
    );
  }

  const upsertWithExternal = withTeam.filter((p: any) => Boolean(p.externalPlayerId));
  const upsertWithoutExternal = withTeam.filter((p: any) => !p.externalPlayerId);

  let insertedOrUpdatedExternal = 0;
  let insertedOrUpdatedNoExternal = 0;

  if (upsertWithExternal.length > 0) {
    const payload = upsertWithExternal.map((p: any) => ({
      external_player_id: p.externalPlayerId ?? null,
      team_id: p.teamId,
      name: p.name,
      short_name: p.shortName ?? null,
      position: p.position ?? null,
      season_year: resolvedSeasonYear,
      season_ppg: p.seasonPpg,
      season_ppg_source: source ?? null
    }));

    const { error } = await supabase
      .from("players")
      .upsert(payload, { onConflict: "external_player_id" });
    if (error) throw error;
    insertedOrUpdatedExternal = payload.length;
  }

  if (upsertWithoutExternal.length > 0) {
    const payload = upsertWithoutExternal.map((p: any) => ({
      team_id: p.teamId,
      name: p.name,
      short_name: p.shortName ?? null,
      position: p.position ?? null,
      season_year: resolvedSeasonYear,
      season_ppg: p.seasonPpg,
      season_ppg_source: source ?? null
    }));

    const { error } = await supabase
      .from("players")
      .upsert(payload, { onConflict: "team_id,name,season_year" });
    if (error) throw error;
    insertedOrUpdatedNoExternal = payload.length;
  }

  // Optional: recompute projections so the board updates once players start being drafted.
  // (No roster slots => projections will be null.)
  const scoring = await computeLeagueLeaderboardAndRoundScores(supabase, canonicalLeagueId);
  const projections = await computeLeagueProjections(supabase, canonicalLeagueId);

  await supabase.from("scoring_snapshots").insert({
    league_id: canonicalLeagueId,
    round: scoring.currentRound,
    data: {
      currentRound: scoring.currentRound,
      lastSyncedAt: scoring.lastSyncedAt,
      partialDataWarning: scoring.partialDataWarning,
      teams: scoring.teams
    },
    is_official: true
  });

  if (projections.teams.length > 0) {
    await upsertLeagueProjectionChalkPreservingOriginals(
      supabase,
      canonicalLeagueId,
      projections.teams.map((t) => ({
        leagueTeamId: t.leagueTeamId,
        projectionChalk: t.projectionChalk
      }))
    );
  }
  try {
    await captureLeagueOriginalProjectionsIfNeeded(supabase, canonicalLeagueId);
  } catch {
    /* optional */
  }

  await persistLeagueLiveScoreboard(supabase, canonicalLeagueId);

  return NextResponse.json({
    status: "ok",
    seasonYear: resolvedSeasonYear,
    updatedExternal: insertedOrUpdatedExternal,
    updatedNoExternal: insertedOrUpdatedNoExternal,
    missingTeamCount: missingTeam.length
  });
}

