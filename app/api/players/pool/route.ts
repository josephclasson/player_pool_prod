import { NextResponse } from "next/server";
import { z } from "zod";
import { createSupabaseAdminClientSafe } from "@/lib/supabase/admin";
import { loadSeasonProjectionBundle, playerTournamentProjections } from "@/lib/player-pool-projection";
import {
  externalTeamIdToSeo,
  getEspnMbbTeamIndex,
  resolveEspnTeamLogoFromIndex
} from "@/lib/espn-mbb-directory";
import { resolveEspnTeamLogoForPoolRow } from "@/lib/espn-ncaam-assets";
import { resolvePlayerHeadshotUrlCandidates } from "@/lib/player-media";
import { regionNameFromOverallSeedApprox } from "@/lib/henrygd-bracket-seeds";
import { MIN_POOL_SEASON_PPG } from "@/lib/player-pool-constants";

const querySchema = z.object({
  seasonYear: z.coerce.number().int().min(2000).max(3000),
  q: z.string().max(80).optional(),
  /** Large default so all ~68-team pools appear (was 500; alphabetical cut hid whole teams). */
  limit: z.coerce.number().int().min(1).max(8000).optional(),
  /** When set, each player includes `ownerTeamName` (roster/draft) or null → show "Undrafted" in UI. */
  leagueId: z.preprocess(
    (v) => (v === "" || v === null || v === undefined ? undefined : v),
    z.string().uuid().optional()
  )
});

function buildEtag(parts: Array<string | number | null | undefined>): string {
  const raw = parts.map((p) => String(p ?? "")).join("|");
  return `W/"${Buffer.from(raw).toString("base64url")}"`;
}

function safeNum(x: unknown) {
  const n = typeof x === "number" ? x : Number(x);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Read-only player pool for a tournament season (teams + seeds + PPG).
 * Used by the Players tab to verify commissioner data loads.
 */
export async function GET(req: Request) {
  const supabase = createSupabaseAdminClientSafe();
  if (!supabase) {
    return NextResponse.json({ error: "Supabase not configured" }, { status: 503 });
  }

  const url = new URL(req.url);
  const noCache =
    url.searchParams.get("nocache") === "1" ||
    url.searchParams.get("refresh") === "1";
  const parsed = querySchema.safeParse(Object.fromEntries(url.searchParams.entries()));
  if (!parsed.success) {
    const msg = parsed.error.issues
      .map((i) => `${i.path.length ? i.path.join(".") : "query"}: ${i.message}`)
      .join("; ");
    return NextResponse.json({ error: msg || "Invalid query parameters" }, { status: 400 });
  }

  const { seasonYear, q, limit, leagueId } = parsed.data;
  const take = limit ?? 4000;
  const ifNoneMatch = req.headers.get("if-none-match");

  const seasonStartIso = `${seasonYear}-01-01T00:00:00.000Z`;
  const seasonEndIso = `${seasonYear + 1}-01-01T00:00:00.000Z`;
  const { data: latestGame } = await supabase
    .from("games")
    .select("last_synced_at")
    .gte("start_time", seasonStartIso)
    .lt("start_time", seasonEndIso)
    .not("last_synced_at", "is", null)
    .order("last_synced_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const lastSyncedAt =
    typeof (latestGame as { last_synced_at?: unknown } | null)?.last_synced_at === "string"
      ? String((latestGame as { last_synced_at: string }).last_synced_at)
      : null;
  const etag = buildEtag(["players-pool", seasonYear, q?.trim() ?? "", take, leagueId ?? "", lastSyncedAt ?? ""]);
  if (ifNoneMatch && ifNoneMatch === etag) {
    return new NextResponse(null, {
      status: 304,
      headers: {
        ETag: etag,
        "Cache-Control": noCache ? "no-store" : "private, max-age=10, stale-while-revalidate=30"
      }
    });
  }

  const ownerByPlayerId = new Map<number, string>();
  if (leagueId) {
    const { data: leagueTeams } = await supabase
      .from("league_teams")
      .select("id, team_name")
      .eq("league_id", leagueId);
    const ltRows = (leagueTeams ?? []) as { id: string; team_name: string }[];
    const nameByLtId = new Map(ltRows.map((x) => [x.id, String(x.team_name ?? "Team")]));
    const ltIds = ltRows.map((x) => x.id);

    if (ltIds.length > 0) {
      const { data: slots } = await supabase
        .from("player_roster_slots")
        .select("player_id, league_team_id")
        .in("league_team_id", ltIds);
      for (const s of (slots ?? []) as { player_id: number; league_team_id: string }[]) {
        const pid = safeNum(s.player_id);
        if (pid <= 0) continue;
        const nm = nameByLtId.get(s.league_team_id);
        if (nm) ownerByPlayerId.set(pid, nm);
      }
    }

    const { data: room } = await supabase
      .from("draft_rooms")
      .select("id")
      .eq("league_id", leagueId)
      .maybeSingle();
    const roomId = (room as { id?: string } | null)?.id;
    if (roomId) {
      const { data: picks } = await supabase
        .from("player_draft_picks")
        .select("player_id, league_team_id")
        .eq("draft_room_id", roomId);
      for (const p of (picks ?? []) as { player_id: number; league_team_id: string }[]) {
        const pid = safeNum(p.player_id);
        if (pid <= 0) continue;
        if (ownerByPlayerId.has(pid)) continue;
        const nm = nameByLtId.get(p.league_team_id);
        if (nm) ownerByPlayerId.set(pid, nm);
      }
    }
  }

  const playerSelect =
    "id, name, short_name, position, jersey_number, height, season_year, season_ppg, season_ppg_source, external_player_id, headshot_url, espn_athlete_id, team_id";

  const { data: playerRows, error: pErr } = await supabase
    .from("players")
    .select(playerSelect)
    .eq("season_year", seasonYear)
    .gte("season_ppg", MIN_POOL_SEASON_PPG);

  if (pErr) {
    return NextResponse.json({ error: pErr.message }, { status: 500 });
  }

  let rows = (playerRows ?? []) as Record<string, unknown>[];
  if (q?.trim()) {
    const ql = q.trim().toLowerCase();
    rows = rows.filter((p) => String(p.name ?? "").toLowerCase().includes(ql));
  }
  rows.sort((a, b) => String(a.name ?? "").localeCompare(String(b.name ?? "")));
  rows = rows.slice(0, take);
  const teamIds = [...new Set(rows.map((r) => safeNum(r.team_id)).filter((id) => id > 0))];
  let teamById = new Map<number, Record<string, unknown>>();

  if (teamIds.length > 0) {
    const { data: teams, error: tErr } = await supabase
      .from("teams")
      .select(
        "id, name, short_name, seed, overall_seed, region, conference, is_power5, external_team_id, logo_url"
      )
      .in("id", teamIds);
    if (!tErr && teams) {
      teamById = new Map(teams.map((t: { id: number }) => [t.id, t as Record<string, unknown>]));
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

  const playerIdsForBundle = rows.map((p) => safeNum(p.id)).filter((id) => id > 0);
  const bundle = await loadSeasonProjectionBundle(supabase, seasonYear, playerIdsForBundle);
  const hasLiveGames = bundle.hasLiveGames;

  const players = rows.map((p: Record<string, unknown>) => {
    const tid = p.team_id as number;
    const t = teamById.get(tid);
    const pid = safeNum(p.id);
    const tproj = playerTournamentProjections({
      teamId: tid,
      playerId: pid,
      seasonPpg: p.season_ppg,
      bundle
    });
    const projection = tproj.liveProjection;
    const byR = bundle.pointsByDisplayRoundByPlayer.get(pid) ?? {};
    /** Only rounds with at least one box-score row (so R3+ stay omitted until played). */
    const tournamentRoundPoints: Record<number, number> = {};
    for (const key of Object.keys(byR)) {
      const r = Number(key);
      if (!Number.isInteger(r) || r < 1 || r > 6) continue;
      const v = byR[r];
      if (typeof v === "number" && Number.isFinite(v)) tournamentRoundPoints[r] = v;
    }
    const headshotUrls = resolvePlayerHeadshotUrlCandidates({
      headshot_url: p.headshot_url != null ? String(p.headshot_url) : null,
      espn_athlete_id: p.espn_athlete_id as number | string | null | undefined
    });
    const displayHeadshotUrl = headshotUrls[0] ?? null;

    let regionLabel: string | null = null;
    if (t) {
      const tr = t.region;
      if (tr != null && String(tr).trim() !== "") {
        regionLabel = String(tr).trim();
      } else {
        const os = t.overall_seed;
        const on = typeof os === "number" ? os : Number(os);
        if (Number.isFinite(on) && on >= 1 && on <= 68) {
          regionLabel = regionNameFromOverallSeedApprox(Math.trunc(on));
        }
      }
    }

    return {
      ...p,
      displayHeadshotUrl,
      headshotUrls,
      projection,
      projectionChalk: projection,
      originalProjection: tproj.originalProjection,
      tournamentRoundPoints,
      chalkGamesRemaining: tproj.liveExpectedChalkGamesRemaining,
      expectedChalkGamesTotal: tproj.expectedChalkGamesTotal,
      completedTournamentGames: tproj.completedTournamentGames,
      ownerTeamName: leagueId ? (ownerByPlayerId.get(pid) ?? null) : null,
      team: t
        ? {
            id: t.id,
            name: t.name,
            shortName: t.short_name,
            seed: t.seed,
            overallSeed: t.overall_seed,
            region: regionLabel,
            conference: t.conference,
            isPower5: t.is_power5,
            externalTeamId: t.external_team_id,
            logoUrl: resolveLogoForTeamRow(t)
          }
        : null
    };
  });

  players.sort((a, b) => {
    const ap = (a as { projection?: number }).projection ?? 0;
    const bp = (b as { projection?: number }).projection ?? 0;
    if (bp !== ap) return bp - ap;
    const ao = (a.team as { overallSeed?: unknown } | null)?.overallSeed;
    const bo = (b.team as { overallSeed?: unknown } | null)?.overallSeed;
    const an = ao != null && Number.isFinite(Number(ao)) ? Number(ao) : 999;
    const bn = bo != null && Number.isFinite(Number(bo)) ? Number(bo) : 999;
    if (an !== bn) return an - bn;
    return String((a as Record<string, unknown>).name ?? "").localeCompare(
      String((b as Record<string, unknown>).name ?? "")
    );
  });

  return NextResponse.json({
    seasonYear,
    count: players.length,
    limit: take,
    leagueId: leagueId ?? null,
    lastSyncedAt,
    hasLiveGames,
    players
  }, {
    headers: noCache
      ? { "Cache-Control": "no-store", ETag: etag }
      : { "Cache-Control": "private, max-age=10, stale-while-revalidate=30", ETag: etag }
  });
}
