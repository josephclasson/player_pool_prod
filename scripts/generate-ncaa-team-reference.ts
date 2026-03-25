/**
 * Builds `data/ncaa-d1-mbb-team-reference.json`:
 * - `cbbSchoolBySlug`: team `school` label (ESPN `displayName`) indexed by slugified label — key name kept for compatibility.
 * - `bracketSeoToCbbSchool`: henrygd bracket `seoname` → preferred directory `school` (longest-prefix logic, same as `lib/cbb-team-seo.ts`).
 *
 * Data sources: ESPN men’s college basketball team index (public) + henrygd bracket JSON.
 * Optional: BALLDONTLIE_API_KEY or BALLDONTLIE_NCAAB_API_KEY — merges Balldontlie `college` / `abbreviation` / `full_name`.
 *
 * Usage: npm run generate:team-reference -- 2026
 * (Uses tsconfig.scripts.json so ts-node runs as CommonJS and resolves ../lib without ESM extension rules.)
 */

import { writeFileSync } from "fs";
import { resolve } from "path";
import { config as loadEnv } from "dotenv";
import { getEspnMbbTeamIndex, type EspnMbbTeamIndex } from "../lib/espn-mbb-directory";
import type { TeamDirectorySchoolRow } from "../lib/team-directory-types";
import { directorySchoolsForSeo, slugifySchoolNameKey } from "../lib/cbb-team-seo";

/** Same payload as `lib/henrygd-bracket-seeds.ts` — inlined here so this script does not import `@/` modules. */
type HenrygdBracketGame = {
  bracketPositionId: number;
  sectionId?: number;
  teams?: Array<{ seoname?: string; seed?: number | null }>;
};

async function fetchHenrygdBracketGames(seasonYear: number): Promise<HenrygdBracketGame[]> {
  const url = `https://ncaa-api.henrygd.me/brackets/basketball-men/d1/${seasonYear}`;
  const resp = await fetch(url, {
    headers: {
      Accept: "application/json",
      "User-Agent": "player-pool/generate-ncaa-team-reference"
    }
  });
  if (!resp.ok) {
    throw new Error(`Bracket fetch failed (${resp.status}). Is ${seasonYear} published on the feed?`);
  }
  const payload = (await resp.json()) as { championships?: Array<{ games?: HenrygdBracketGame[] }> };
  return (payload?.championships?.[0]?.games ?? []) as HenrygdBracketGame[];
}

function loadDotenv() {
  loadEnv({ path: resolve(process.cwd(), ".env.local") });
  loadEnv({ path: resolve(process.cwd(), ".env") });
}

const OUT = resolve(process.cwd(), "data/ncaa-d1-mbb-team-reference.json");

type BalldontlieTeamRow = {
  id?: number;
  full_name?: string;
  name?: string;
  college?: string | null;
  abbreviation?: string | null;
};

type OutputFile = {
  version: number;
  seasonYear: number;
  generatedAt: string;
  source: string;
  bracketSeoToCbbSchool: Record<string, string>;
  cbbSchoolBySlug: Record<string, string>;
  balldontlieByCollegeLower?: Record<
    string,
    { full_name: string; abbreviation: string | null; name: string }
  >;
};

function espnIndexToDirectory(index: EspnMbbTeamIndex): TeamDirectorySchoolRow[] {
  const seen = new Set<number>();
  const rows: TeamDirectorySchoolRow[] = [];
  for (const entry of index.bySlug.values()) {
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    const school =
      entry.displayName?.trim() || `${entry.location} ${entry.name}`.trim();
    if (!school) continue;
    rows.push({
      school,
      displayName: entry.displayName || undefined,
      abbreviation: entry.abbreviation || undefined
    });
  }
  return rows;
}

function collectBracketSeonames(games: HenrygdBracketGame[]): string[] {
  const set = new Set<string>();
  for (const g of games) {
    for (const bt of g.teams ?? []) {
      const raw = bt as Record<string, unknown>;
      const seo = String(raw?.seoname ?? "").trim().toLowerCase();
      if (seo) set.add(seo);
    }
  }
  return [...set].sort();
}

function buildSchoolBySlug(directory: TeamDirectorySchoolRow[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const t of directory) {
    const school = t.school?.trim();
    if (!school) continue;
    const slug = slugifySchoolNameKey(school);
    if (!slug) continue;
    if (out[slug] && out[slug] !== school) {
      console.warn(
        `[cbbSchoolBySlug] duplicate slug "${slug}": keeping "${out[slug]}", also saw "${school}"`
      );
      continue;
    }
    out[slug] = school;
  }
  return out;
}

async function fetchAllBalldontlieNcaabTeams(apiKey: string): Promise<BalldontlieTeamRow[]> {
  const base = "https://api.balldontlie.io/ncaab/v1/teams";
  const all: BalldontlieTeamRow[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 200; page++) {
    const u = new URL(base);
    if (cursor) u.searchParams.set("cursor", cursor);
    const resp = await fetch(u.toString(), {
      headers: { Authorization: apiKey }
    });
    if (!resp.ok) {
      throw new Error(`Balldontlie teams failed: ${resp.status}`);
    }
    const payload = (await resp.json()) as {
      data?: BalldontlieTeamRow[];
      meta?: { next_cursor?: string | null };
    };
    const chunk = payload.data ?? [];
    all.push(...chunk);
    const next = payload.meta?.next_cursor;
    if (!next || chunk.length === 0) break;
    cursor = next;
  }
  return all;
}

async function main() {
  loadDotenv();
  const seasonYear = Number(process.argv[2] || process.env.LEAGUE_SEASON_YEAR || "2026");
  if (!Number.isFinite(seasonYear) || seasonYear < 2000) {
    console.error("Usage: season year required (arg or LEAGUE_SEASON_YEAR).");
    process.exit(1);
  }

  console.log(`Fetching ESPN MBB team index (championship year ${seasonYear})…`);
  const espnIndex = await getEspnMbbTeamIndex();
  const directory = espnIndexToDirectory(espnIndex);
  console.log(`  ${directory.length} teams in directory.`);

  console.log(`Fetching henrygd bracket ${seasonYear}…`);
  const games = await fetchHenrygdBracketGames(seasonYear);
  const seos = collectBracketSeonames(games);
  console.log(`  ${seos.length} unique bracket seonames.`);

  const bracketSeoToCbbSchool: Record<string, string> = {};
  const unmapped: string[] = [];
  for (const seo of seos) {
    const schools = directorySchoolsForSeo(seo, directory);
    if (schools.length > 0) {
      bracketSeoToCbbSchool[seo] = schools[0];
    } else {
      unmapped.push(seo);
    }
  }
  if (unmapped.length > 0) {
    console.warn(
      `[bracketSeoToCbbSchool] ${unmapped.length} seonames had no directory match (add overrides): ${unmapped.slice(0, 12).join(", ")}${unmapped.length > 12 ? "…" : ""}`
    );
  }

  const cbbSchoolBySlug = buildSchoolBySlug(directory);

  const out: OutputFile = {
    version: 1,
    seasonYear,
    generatedAt: new Date().toISOString(),
    source: "ESPN MBB team index + henrygd bracket; optional Balldontlie /ncaab/v1/teams",
    bracketSeoToCbbSchool,
    cbbSchoolBySlug
  };

  const bdlKey =
    process.env.BALLDONTLIE_NCAAB_API_KEY?.trim() || process.env.BALLDONTLIE_API_KEY?.trim();
  if (bdlKey) {
    console.log("Fetching Balldontlie NCAAB teams…");
    const rows = await fetchAllBalldontlieNcaabTeams(bdlKey);
    const byCollege: NonNullable<OutputFile["balldontlieByCollegeLower"]> = {};
    for (const r of rows) {
      const college = (r.college ?? "").trim();
      if (!college) continue;
      const key = college.toLowerCase();
      byCollege[key] = {
        full_name: String(r.full_name ?? r.name ?? ""),
        name: String(r.name ?? ""),
        abbreviation: r.abbreviation != null ? String(r.abbreviation) : null
      };
    }
    out.balldontlieByCollegeLower = byCollege;
    console.log(`  ${Object.keys(byCollege).length} Balldontlie college keys.`);
  }

  writeFileSync(OUT, `${JSON.stringify(out, null, 2)}\n`, "utf8");
  console.log(`Wrote ${OUT}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
