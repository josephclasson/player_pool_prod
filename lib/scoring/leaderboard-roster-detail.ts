import type { SupabaseClient } from "@supabase/supabase-js";
import { displayCollegeTeamNameForUi } from "@/lib/college-team-display";
import {
  externalTeamIdToSeo,
  getEspnMbbTeamIndex,
  resolveEspnTeamLogoFromIndex
} from "@/lib/espn-mbb-directory";
import { resolveEspnTeamLogoForPoolRow } from "@/lib/espn-ncaam-assets";
import { resolvePlayerHeadshotUrlCandidates } from "@/lib/player-media";
import { regionNameFromOverallSeedApprox } from "@/lib/henrygd-bracket-seeds";
import { loadSeasonProjectionBundle, playerTournamentProjections } from "@/lib/player-pool-projection";
import { playerAdvancedPastLeagueActiveRound } from "@/lib/leaderboard-owner-metrics";
import type { LeagueLeaderboardTeamRow, LeagueScoringEngineState } from "@/lib/scoring";
import { stablePoolSlugForTeamContext } from "@/lib/tournament-team-canonical";

function safeNum(x: unknown) {
  const n = typeof x === "number" ? x : Number(x);
  return Number.isFinite(n) ? n : 0;
}

function regionLabelForTeamRow(t: Record<string, unknown> | undefined): string | null {
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

export type LeaderboardRosterPlayerApi = {
  playerId: number;
  rosterSlotId: string;
  /** Pool owner who drafted this player. */
  ownerName: string;
  name: string;
  shortName: string | null;
  position: string | null;
  seasonPpg: number | null;
  headshotUrls: string[];
  /** ESPN athlete id for profile links (StatTracker-aligned). */
  espnAthleteId: number | null;
  /** NCAA tournament overall seed 1–68 when known. */
  overallSeed: number | null;
  team: {
    id: number;
    name: string;
    shortName: string | null;
    seed: number | null;
    region: string | null;
    /** Conference SEO slug from `teams.conference` (e.g. `big-ten`, `acc`). */
    conference: string | null;
    /** `teams.external_team_id` (e.g. `iowa-st-2026`); used when `conference` is null. */
    externalTeamId?: string | null;
    logoUrl: string | null;
  } | null;
  /** Fantasy points by tournament display round R1–R6. */
  tournamentRoundPoints: Record<number, number>;
  projection: number | null;
  originalProjection: number | null;
  plusMinus: number | null;
  /** Team eliminated from tournament (from last synced NCAA results). */
  eliminated?: boolean;
  /** Tournament display round where team was eliminated (1..6), else null. */
  eliminatedRound?: number | null;
  /**
   * True when the team has clinched advancement past the league’s active display round
   * (final win in that round, or eliminated only later).
   */
  advancedPastActiveRound?: boolean;
  /** League-wide draft order (1 = first overall). Used for “best pick per draft round”. */
  pickOverall?: number | null;
};

type DraftPickRow = { player_id: number; league_team_id: string; pick_overall: number };

/**
 * Per-owner roster rows in draft order, with stats/projection aligned to Player Statistics.
 */
export async function buildLeaderboardRosterPlayersByLeagueTeam(
  supabase: SupabaseClient,
  leagueId: string,
  seasonYear: number,
  state: LeagueScoringEngineState,
  rankedTeams: LeagueLeaderboardTeamRow[],
  slotProjectionByRosterSlotId: Map<string, number>
): Promise<Record<string, LeaderboardRosterPlayerApi[]>> {
  const out: Record<string, LeaderboardRosterPlayerApi[]> = {};

  const { data: draftRoom } = await supabase
    .from("draft_rooms")
    .select("id")
    .eq("league_id", leagueId)
    .maybeSingle();
  const roomId = (draftRoom as { id?: string } | null)?.id;

  let draftPicks: DraftPickRow[] = [];
  if (roomId) {
    const { data: picks } = await supabase
      .from("player_draft_picks")
      .select("player_id, league_team_id, pick_overall")
      .eq("draft_room_id", roomId)
      .order("pick_overall", { ascending: true });
    draftPicks = (picks ?? []) as DraftPickRow[];
  }

  const picksByLt = new Map<string, DraftPickRow[]>();
  for (const p of draftPicks) {
    const lid = String(p.league_team_id);
    const arr = picksByLt.get(lid) ?? [];
    arr.push(p);
    picksByLt.set(lid, arr);
  }

  const rosterPlayerIds = Array.from(
    new Set((state.slots as { player_id?: unknown }[]).map((s) => safeNum(s.player_id)).filter((id) => id > 0))
  );
  if (rosterPlayerIds.length === 0) {
    for (const t of rankedTeams) out[t.leagueTeamId] = [];
    return out;
  }

  const { data: playerRows } = await supabase
    .from("players")
    .select(
      "id, name, short_name, position, season_ppg, team_id, headshot_url, espn_athlete_id"
    )
    .eq("season_year", seasonYear)
    .in("id", rosterPlayerIds);

  const playerById = new Map<number, Record<string, unknown>>(
    (playerRows ?? []).map((p: Record<string, unknown>) => [safeNum(p.id), p])
  );

  const teamIdsNeeded = new Set<number>();
  for (const s of state.slots as { team_id?: unknown }[]) {
    const tid = safeNum(s.team_id);
    if (tid > 0) teamIdsNeeded.add(tid);
  }
  for (const p of playerRows ?? []) {
    const tid = safeNum((p as { team_id?: unknown }).team_id);
    if (tid > 0) teamIdsNeeded.add(tid);
  }

  const { data: teamsSeason } = await supabase
    .from("teams")
    .select(
      "id, name, short_name, seed, overall_seed, region, conference, is_power5, external_team_id, logo_url"
    )
    .ilike("external_team_id", `%-${seasonYear}`);

  const teamById = new Map<number, Record<string, unknown>>(
    (teamsSeason ?? []).map((t: Record<string, unknown>) => [safeNum(t.id), t])
  );

  const missingTeamIds = [...teamIdsNeeded].filter((id) => id > 0 && !teamById.has(id));
  if (missingTeamIds.length > 0) {
    const { data: extraTeams } = await supabase
      .from("teams")
      .select(
        "id, name, short_name, seed, overall_seed, region, conference, is_power5, external_team_id, logo_url"
      )
      .in("id", missingTeamIds);
    for (const t of extraTeams ?? []) {
      const id = safeNum((t as { id?: unknown }).id);
      if (id > 0) teamById.set(id, t as Record<string, unknown>);
    }
  }

  let espnIdx: Awaited<ReturnType<typeof getEspnMbbTeamIndex>> | null = null;
  try {
    espnIdx = await getEspnMbbTeamIndex();
  } catch {
    espnIdx = null;
  }

  const resolvedLogoByTeamId = new Map<number, string | null>();
  function resolveLogoForTeamRow(t: Record<string, unknown>): string | null {
    const id = safeNum(t.id);
    if (id <= 0) return null;
    if (resolvedLogoByTeamId.has(id)) return resolvedLogoByTeamId.get(id) ?? null;
    const dbLogo = t.logo_url != null ? String(t.logo_url).trim() : "";
    if (dbLogo) {
      resolvedLogoByTeamId.set(id, dbLogo);
      return dbLogo;
    }
    const ext = String(t.external_team_id ?? "");
    const seo = externalTeamIdToSeo(ext, seasonYear);
    const resolved =
      espnIdx != null
        ? resolveEspnTeamLogoFromIndex(espnIdx, {
            logoUrl: null,
            shortName: t.short_name != null ? String(t.short_name) : null,
            fullName: t.name != null ? String(t.name) : null,
            seo
          })
        : null;
    const fallback =
      resolved ??
      resolveEspnTeamLogoForPoolRow({
        logoUrl: null,
        shortName: t.short_name != null ? String(t.short_name) : null,
        fullName: t.name != null ? String(t.name) : null
      });
    resolvedLogoByTeamId.set(id, fallback);
    return fallback;
  }

  const bundle = await loadSeasonProjectionBundle(supabase, seasonYear, rosterPlayerIds);

  function orderedSlotsForTeam(ltId: string): Array<Record<string, unknown>> {
    const slots = state.slotsByLeagueTeam.get(ltId) ?? [];
    const picks = picksByLt.get(ltId) ?? [];
    if (picks.length === 0) {
      return [...slots].sort((a, b) => safeNum(a.pick_overall) - safeNum(b.pick_overall));
    }
    const byPid = new Map<number, Record<string, unknown>>();
    for (const s of slots) byPid.set(safeNum(s.player_id), s);
    const ordered: Array<Record<string, unknown>> = [];
    for (const p of picks) {
      if (String(p.league_team_id) !== ltId) continue;
      const slot = byPid.get(safeNum(p.player_id));
      if (slot) ordered.push(slot);
    }
    if (ordered.length > 0) return ordered;
    return [...slots].sort((a, b) => safeNum(a.pick_overall) - safeNum(b.pick_overall));
  }

  for (const lt of rankedTeams) {
    const ltId = lt.leagueTeamId;
    const rows: LeaderboardRosterPlayerApi[] = [];

    for (const slot of orderedSlotsForTeam(ltId)) {
      const slotId = String(slot.id);
      const playerId = safeNum(slot.player_id);
      const teamId = safeNum(slot.team_id);
      if (playerId <= 0) continue;

      const computed = state.slotComputed.get(slotId);
      const pr = playerById.get(playerId);
      const playerTeamFromDb = pr != null ? safeNum(pr.team_id) : 0;
      const effectiveTeamId = playerTeamFromDb > 0 ? playerTeamFromDb : teamId;
      const playerTeamId = pr != null ? safeNum(pr.team_id) : teamId;
      const collegeRow = teamById.get(playerTeamId) ?? teamById.get(teamId);
      const rosterTid = playerTeamId > 0 ? playerTeamId : teamId;
      const fallbackTeam = rosterTid > 0 ? `Team #${rosterTid}` : "—";

      const headshotUrls = resolvePlayerHeadshotUrlCandidates({
        headshot_url: pr?.headshot_url != null ? String(pr.headshot_url) : null,
        espn_athlete_id: pr?.espn_athlete_id as number | string | null | undefined
      });

      const tr: Record<number, number> = {};
      const byR = computed?.pointsByRound ?? {};
      for (let r = 1; r <= 6; r++) {
        if (Object.prototype.hasOwnProperty.call(byR, r)) tr[r] = byR[r] as number;
      }

      const tproj = playerTournamentProjections({
        teamId: teamId > 0 ? teamId : playerTeamId,
        playerId,
        seasonPpg: pr?.season_ppg,
        bundle
      });
      const slotProj = slotProjectionByRosterSlotId.get(slotId);
      const liveRounded =
        slotProj != null && Number.isFinite(Number(slotProj))
          ? Math.round(Number(slotProj))
          : Math.round(tproj.liveProjection);
      const origRounded = Math.round(tproj.originalProjection);

      const espnAid = pr?.espn_athlete_id;
      const espnAthleteId =
        espnAid != null && String(espnAid).trim() !== ""
          ? safeNum(espnAid as number | string)
          : null;
      const seedRaw = collegeRow?.seed != null ? safeNum(collegeRow.seed) : null;
      const seed = seedRaw != null && seedRaw > 0 ? seedRaw : null;
      const overallRaw = collegeRow?.overall_seed != null ? safeNum(collegeRow.overall_seed) : null;
      const overallSeed =
        overallRaw != null && Number.isFinite(overallRaw) && overallRaw >= 1 && overallRaw <= 68
          ? Math.trunc(overallRaw)
          : null;

      const ownerDisplay = String(lt.ownerName ?? "").trim() || "—";

      const playerCanonKey = stablePoolSlugForTeamContext(
        effectiveTeamId,
        state.canonicalByInternalTeamId,
        state.canonRowById
      );
      const advancedPastActiveRound = playerAdvancedPastLeagueActiveRound({
        currentRound: state.currentRound,
        eliminated: computed?.eliminated ?? false,
        eliminatedRound: computed?.eliminatedRound ?? null,
        playerCanonKey,
        finalWinBucketsByCanon: state.finalWinDisplayBucketsByCanonical
      });

      const pickOverallFromSlot = safeNum(slot.pick_overall);
      let pickOverall: number | null = pickOverallFromSlot > 0 ? pickOverallFromSlot : null;
      if (pickOverall == null) {
        const picks = picksByLt.get(ltId) ?? [];
        const pickRow = picks.find((pp) => safeNum(pp.player_id) === playerId);
        if (pickRow != null) {
          const po = safeNum(pickRow.pick_overall);
          if (po > 0) pickOverall = po;
        }
      }

      const confRaw =
        collegeRow?.conference != null && String(collegeRow.conference).trim()
          ? String(collegeRow.conference).trim()
          : null;
      const extTeamRaw = collegeRow?.external_team_id != null ? String(collegeRow.external_team_id).trim() : "";
      const externalTeamId = extTeamRaw !== "" ? extTeamRaw : null;

      const teamPayload = collegeRow
        ? {
            id: safeNum(collegeRow.id),
            name: displayCollegeTeamNameForUi(collegeRow, fallbackTeam),
            shortName: collegeRow.short_name != null ? String(collegeRow.short_name) : null,
            seed,
            region: regionLabelForTeamRow(collegeRow),
            conference: confRaw,
            externalTeamId,
            logoUrl: resolveLogoForTeamRow(collegeRow)
          }
        : rosterTid > 0
          ? {
              id: rosterTid,
              name: fallbackTeam,
              shortName: null,
              seed: null,
              region: null,
              conference: null,
              externalTeamId: null,
              logoUrl: null as string | null
            }
          : null;

      rows.push({
        playerId,
        rosterSlotId: slotId,
        ownerName: ownerDisplay,
        name: pr != null && String(pr.name ?? "").trim() ? String(pr.name) : `Player ${playerId}`,
        shortName: pr?.short_name != null ? String(pr.short_name) : null,
        position: pr?.position != null && String(pr.position).trim() ? String(pr.position).trim() : null,
        seasonPpg: pr?.season_ppg != null && pr.season_ppg !== "" ? Number(pr.season_ppg) : null,
        headshotUrls,
        espnAthleteId: espnAthleteId != null && espnAthleteId > 0 ? espnAthleteId : null,
        overallSeed,
        team: teamPayload,
        tournamentRoundPoints: tr,
        projection: liveRounded,
        originalProjection: origRounded,
        plusMinus: liveRounded - origRounded,
        eliminated: computed?.eliminated ?? false,
        eliminatedRound: computed?.eliminatedRound ?? null,
        advancedPastActiveRound,
        pickOverall
      });
    }

    out[ltId] = rows;
  }

  return out;
}
