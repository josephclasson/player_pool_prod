import type { SupabaseClient } from "@supabase/supabase-js";
import { getEspnMbbTeamIndex, resolveEspnTeamLogoFromIndex } from "@/lib/espn-mbb-directory";
import { resolveEspnTeamLogoForPoolRow } from "@/lib/espn-ncaam-assets";
import {
  applyOfficialSeedsToTeams,
  type OfficialSeedEntry
} from "@/lib/official-seeds";

/**
 * **Committee bracket** JSON (published field), not the daily scoreboard:
 * `https://ncaa-api.henrygd.me/brackets/basketball-men/d1/{year}`.
 * Same upstream family as scoreboards but a different endpoint — use this for tournament
 * structure and `teams.overall_seed` (1–68), not `lib/henrygd.ts` scoreboard sync.
 *
 * Overall 1–68 is often not a raw field in JSON, so we derive a deterministic approximation
 * (regional line × region order), then fill any remaining teams (e.g. First Four) from unused
 * slots 1–68. For an exact match to the published NCAA S-curve, use Commissioner →
 * Apply seeds from CBS/SI article (`lib/committee-report-scrape.ts`).
 */

type BracketTeam = { seoname?: string; seed?: number | null };
export type BracketGame = {
  bracketPositionId: number;
  /** Present on upstream JSON for feeder games; slot the winner advances into. */
  victorBracketPositionId?: number | null;
  sectionId?: number;
  teams?: BracketTeam[];
};

/** Single fetch of the committee bracket (all tournament teams), shared by seed + team upsert. */
export async function fetchHenrygdBracketGames(seasonYear: number): Promise<BracketGame[]> {
  const url = `https://ncaa-api.henrygd.me/brackets/basketball-men/d1/${seasonYear}`;
  const resp = await fetch(url, {
    headers: {
      Accept: "application/json",
      "User-Agent": "player-pool/henrygd-bracket-seeds"
    }
  });
  if (!resp.ok) {
    throw new Error(`Bracket fetch failed (${resp.status}). Is ${seasonYear} published on the feed?`);
  }
  const payload = (await resp.json()) as { championships?: Array<{ games?: BracketGame[] }> };
  return (payload?.championships?.[0]?.games ?? []) as BracketGame[];
}

/**
 * Insert/update every team that appears on the bracket feed (`seo-seasonYear`).
 * Scoreboard-only sync misses teams that are not playing on a given day; this ensures all 68
 * tournament clubs exist before `overall_seed` is applied so populate + chalk can run.
 */
export async function upsertTournamentTeamsFromBracketGames(
  supabase: SupabaseClient,
  seasonYear: number,
  games: BracketGame[]
): Promise<number> {
  const teamBySeo = new Map<
    string,
    { name: string; short_name: string | null; seed: number | null }
  >();

  for (const g of games) {
    for (const bt of g.teams ?? []) {
      const raw = bt as Record<string, unknown>;
      const seo = String(raw?.seoname ?? "").trim();
      if (!seo) continue;
      if (teamBySeo.has(seo)) continue;

      const shortName =
        raw.shortName != null
          ? String(raw.shortName)
          : raw.short_name != null
            ? String(raw.short_name)
            : null;
      const fullName =
        raw.name != null
          ? String(raw.name)
          : raw.teamName != null
            ? String(raw.teamName)
            : null;
      const name =
        (fullName?.trim() ? fullName.trim() : null) ??
        (shortName?.trim() ? shortName.trim() : null) ??
        seo
          .split("-")
          .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
          .join(" ");

      const seedRaw = raw.seed;
      let seed: number | null = null;
      if (typeof seedRaw === "number" && Number.isFinite(seedRaw)) {
        const n = Math.trunc(seedRaw);
        if (n >= 1 && n <= 16) seed = n;
      } else if (seedRaw != null && String(seedRaw).trim() !== "") {
        const n = Math.trunc(Number(seedRaw));
        if (Number.isFinite(n) && n >= 1 && n <= 16) seed = n;
      }

      teamBySeo.set(seo, {
        name,
        short_name: shortName?.trim() ? shortName.trim() : null,
        seed
      });
    }
  }

  let espnIdx: Awaited<ReturnType<typeof getEspnMbbTeamIndex>> | null = null;
  try {
    espnIdx = await getEspnMbbTeamIndex();
  } catch {
    espnIdx = null;
  }

  const payloads = [...teamBySeo.entries()].map(([seo, meta]) => ({
    external_team_id: `${seo}-${seasonYear}`,
    name: meta.name,
    short_name: meta.short_name,
    seed: meta.seed,
    region: null as string | null,
    conference: null as string | null,
    is_power5: false,
    logo_url:
      espnIdx != null
        ? resolveEspnTeamLogoFromIndex(espnIdx, {
            logoUrl: null,
            shortName: meta.short_name,
            fullName: meta.name,
            seo
          }) ??
          resolveEspnTeamLogoForPoolRow({
            logoUrl: null,
            shortName: meta.short_name,
            fullName: meta.name
          })
        : resolveEspnTeamLogoForPoolRow({
            logoUrl: null,
            shortName: meta.short_name,
            fullName: meta.name
          })
  }));

  if (payloads.length === 0) return 0;

  const { error } = await supabase.from("teams").upsert(payloads, { onConflict: "external_team_id" });
  if (error) throw error;
  return payloads.length;
}

function roundBucket(bracketPositionId: number) {
  return Math.floor(bracketPositionId / 100);
}

/** Region order for S-curve *line* assignment (approximation): East → Midwest → South → West. */
function sectionRank(sectionId: number): number | null {
  switch (sectionId) {
    case 2:
      return 1;
    case 5:
      return 2;
    case 4:
      return 3;
    case 3:
      return 4;
    default:
      return null;
  }
}

/** henrygd bracket `sectionId` → region name (matches sectionRank mapping). */
export function sectionIdToRegionName(sectionId: number): string | null {
  switch (sectionId) {
    case 2:
      return "East";
    case 5:
      return "Midwest";
    case 4:
      return "South";
    case 3:
      return "West";
    default:
      return null;
  }
}

/**
 * Infer region from overall 1–68 using the same (regional line × region) grid as seed assignment.
 * Used when `teams.region` was never backfilled (e.g. pre-fix DBs).
 */
export function regionNameFromOverallSeedApprox(overall: number): string | null {
  if (overall < 1 || overall > 68) return null;
  const r = ((overall - 1) % 4) + 1;
  switch (r) {
    case 1:
      return "East";
    case 2:
      return "Midwest";
    case 3:
      return "South";
    case 4:
      return "West";
    default:
      return null;
  }
}

type Acc = {
  seoname: string;
  regionalSeed: number;
  sectionId: number;
  bracketPositionId: number;
  roundB: number;
};

function betterAcc(a: Acc, b: Acc): Acc {
  if (a.roundB !== b.roundB) return a.roundB > b.roundB ? a : b;
  return a.bracketPositionId <= b.bracketPositionId ? a : b;
}

/** Build 1–68 seed entries from bracket games (same structure as `fetchHenrygdBracketGames`). */
export function buildOfficialSeedEntriesFromGames(games: BracketGame[]): OfficialSeedEntry[] {
  if (games.length === 0) return [];

  const bySeo = new Map<string, Acc>();

  for (const g of games) {
    const bracketPositionId = Number(g.bracketPositionId);
    if (!Number.isFinite(bracketPositionId)) continue;
    const sectionId = Number(g.sectionId ?? 0);
    const roundB = roundBucket(bracketPositionId);
    for (const t of g.teams ?? []) {
      const raw = t as Record<string, unknown>;
      const seo = String(raw?.seoname ?? "").trim();
      if (!seo) continue;
      const seedRaw = raw?.seed;
      let seed: number | null = null;
      if (typeof seedRaw === "number" && Number.isFinite(seedRaw)) {
        const n = Math.trunc(seedRaw);
        if (n >= 1 && n <= 16) seed = n;
      } else if (seedRaw != null && String(seedRaw).trim() !== "") {
        const n = Math.trunc(Number(seedRaw));
        if (Number.isFinite(n) && n >= 1 && n <= 16) seed = n;
      }
      if (seed == null) continue;

      const next: Acc = {
        seoname: seo,
        regionalSeed: seed,
        sectionId,
        bracketPositionId,
        roundB
      };
      const prev = bySeo.get(seo);
      if (!prev) bySeo.set(seo, next);
      else bySeo.set(seo, betterAcc(prev, next));
    }
  }

  const usedOverall = new Set<number>();
  const entries: OfficialSeedEntry[] = [];
  const needSlot: Acc[] = [];

  for (const acc of bySeo.values()) {
    const rr = sectionRank(acc.sectionId);
    if (acc.roundB >= 2 && rr != null) {
      const overall = (acc.regionalSeed - 1) * 4 + rr;
      if (overall >= 1 && overall <= 68 && !usedOverall.has(overall)) {
        usedOverall.add(overall);
        entries.push({
          overallSeed: overall,
          seo: acc.seoname,
          region: sectionIdToRegionName(acc.sectionId) ?? undefined
        });
        continue;
      }
    }
    needSlot.push(acc);
  }

  const pool: number[] = [];
  for (let o = 1; o <= 68; o++) {
    if (!usedOverall.has(o)) pool.push(o);
  }

  needSlot.sort(
    (a, b) => a.bracketPositionId - b.bracketPositionId || a.seoname.localeCompare(b.seoname)
  );

  for (let i = 0; i < needSlot.length; i++) {
    const o = pool[i];
    if (o == null) break;
    usedOverall.add(o);
    entries.push({
      overallSeed: o,
      seo: needSlot[i].seoname,
      region: sectionIdToRegionName(needSlot[i].sectionId) ?? undefined
    });
  }

  return entries;
}

export async function buildOfficialSeedEntriesFromHenrygdBracket(
  seasonYear: number
): Promise<OfficialSeedEntry[]> {
  const games = await fetchHenrygdBracketGames(seasonYear);
  return buildOfficialSeedEntriesFromGames(games);
}

export async function applyHenrygdBracketOfficialSeeds(opts: {
  supabase: SupabaseClient;
  seasonYear: number;
}) {
  const games = await fetchHenrygdBracketGames(opts.seasonYear);
  if (games.length === 0) {
    throw new Error("Bracket contained no games; is the tournament feed published?");
  }

  await upsertTournamentTeamsFromBracketGames(opts.supabase, opts.seasonYear, games);

  const entries = buildOfficialSeedEntriesFromGames(games);
  if (entries.length === 0) {
    throw new Error("Bracket contained no teams with seo + seed; is the tournament bracket live?");
  }
  if (entries.length < 68) {
    // First Four / placeholder brackets can be short until the field is final; still apply what we have.
    console.warn(
      `[henrygd seeds] Only ${entries.length} teams received overall seeds (expected 68 when the field is complete).`
    );
  }

  return applyOfficialSeedsToTeams({
    supabase: opts.supabase,
    seasonYear: opts.seasonYear,
    entries,
    source: "henrygd_ncaa_bracket_api"
  });
}
