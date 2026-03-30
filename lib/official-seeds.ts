import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Official committee 1–68 (`teams.overall_seed`) — **not** from the daily scoreboard.
 *
 * - CBS/SI committee list: commissioner **Apply seeds from CBS/SI article** only (`lib/committee-report-scrape.ts`).
 *   Use each season’s article that lists the full NCAA S-curve 1–68 (SI often titles this “official 1–68 seed rankings”).
 * - Automated fallback: henrygd **bracket** endpoint (`henrygd-bracket-seeds.ts`) for full tournament setup / demo.
 * - Daily scoreboard sync (`lib/henrygd.ts`) updates games and regional pod seeds only.
 */

export type OfficialSeedEntry = {
  overallSeed: number;
  /** henrygd / internal key suffix, e.g. "uconn" → matches external_team_id `uconn-2026` */
  seo?: string;
  /** Full `teams.external_team_id` when you already know it */
  external_team_id?: string;
  /** Loose fallback match against `teams.name` / `short_name` */
  displayName?: string;
  /** NCAA region label: East | Midwest | South | West (from bracket section or manual JSON) */
  region?: string;
};

export type ApplyOfficialSeedsResult = {
  updated: number;
  unmatched: OfficialSeedEntry[];
};

function norm(s: string) {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Keep one row per `overallSeed`; when duplicates exist, the last entry wins (later sources override). */
export function dedupeOfficialSeedsByRankLastWins(entries: OfficialSeedEntry[]): OfficialSeedEntry[] {
  const byRank = new Map<number, OfficialSeedEntry>();
  for (const e of entries) {
    const k = Math.trunc(Number(e.overallSeed));
    if (!Number.isFinite(k) || k < 1 || k > 68) continue;
    byRank.set(k, { ...e, overallSeed: k });
  }
  return Array.from(byRank.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([, row]) => row);
}

export async function applyOfficialSeedsToTeams(opts: {
  supabase: SupabaseClient;
  seasonYear: number;
  entries: OfficialSeedEntry[];
  source: string;
}): Promise<ApplyOfficialSeedsResult> {
  const { supabase, seasonYear, entries, source } = opts;

  const { data: allTeams } = await supabase
    .from("teams")
    .select("id, external_team_id, name, short_name");

  const rows = allTeams ?? [];
  const byExternal = new Map(rows.map((t: any) => [t.external_team_id as string, t]));
  /** `seo` portion of `external_team_id` (lowercase), e.g. `iowa-hawkeyes` → row */
  const byBracketSeo = new Map<string, any>();
  for (const t of rows) {
    const ext = String((t as any).external_team_id ?? "");
    const suf = `-${seasonYear}`;
    if (ext.endsWith(suf)) {
      byBracketSeo.set(ext.slice(0, -suf.length).toLowerCase(), t);
    }
  }
  const byNormName = new Map<string, any[]>();
  for (const t of rows) {
    const keys = [norm(String((t as any).name ?? "")), norm(String((t as any).short_name ?? ""))].filter(
      Boolean
    );
    for (const k of keys) {
      const arr = byNormName.get(k) ?? [];
      arr.push(t);
      byNormName.set(k, arr);
    }
  }

  const unmatched: OfficialSeedEntry[] = [];
  const updates: Array<{
    id: number;
    overall_seed: number;
    seed_source: string;
    seeds_updated_at: string;
    region?: string;
  }> = [];

  for (const e of entries) {
    const os = Math.trunc(Number(e.overallSeed));
    if (!Number.isFinite(os) || os < 1 || os > 68) {
      unmatched.push(e);
      continue;
    }

    let row: any | undefined;
    if (e.external_team_id) {
      row = byExternal.get(e.external_team_id);
    }
    if (!row && e.seo) {
      const seoKey = String(e.seo).trim().toLowerCase();
      row = byExternal.get(`${seoKey}-${seasonYear}`) ?? byBracketSeo.get(seoKey);
    }
    if (!row && e.displayName) {
      const k = norm(e.displayName);
      const candidates = byNormName.get(k) ?? [];
      row = candidates.find((c: any) => String(c.external_team_id).endsWith(`-${seasonYear}`));
      if (!row && candidates.length === 1) row = candidates[0];
    }

    if (!row) {
      unmatched.push(e);
      continue;
    }

    const reg =
      typeof e.region === "string" && e.region.trim() ? e.region.trim() : undefined;

    updates.push({
      id: row.id,
      overall_seed: os,
      seed_source: source,
      seeds_updated_at: new Date().toISOString(),
      ...(reg ? { region: reg } : {})
    });
  }

  let updated = 0;
  for (const u of updates) {
    const payload: Record<string, unknown> = {
      overall_seed: u.overall_seed,
      seed_source: u.seed_source,
      seeds_updated_at: u.seeds_updated_at
    };
    if (u.region != null && u.region !== "") payload.region = u.region;

    const { error } = await supabase.from("teams").update(payload).eq("id", u.id);
    if (!error) updated += 1;
  }

  return { updated, unmatched };
}
