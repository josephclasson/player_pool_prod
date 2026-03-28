import type { SupabaseClient } from "@supabase/supabase-js";
import { isFinalStatus } from "@/lib/chalk-remaining-games";
import { ESPN_NCAAM_TEAM_NAME_TO_ID } from "@/lib/espn-ncaam-assets";
import { SEO_SLUG_ALIASES } from "@/lib/espn-mbb-directory";
import ncaaRef from "@/data/ncaa-d1-mbb-team-reference.json";

/** DB `games.round` → participation bucket (First Four → R1). */
export function participationBucketFromDbRound(gameRound: number): number | null {
  if (gameRound >= 1 && gameRound <= 6) return gameRound;
  if (gameRound === 0) return 1;
  return null;
}

function safeNum(x: unknown): number {
  const n = typeof x === "number" ? x : Number(x);
  return Number.isFinite(n) ? n : 0;
}

/** `${seo}-${year}` → `seo` (henrygd / pool convention). Strip repeated trailing `-YYYY`. */
export function canonicalBaseFromExternalTeamId(ext: string): string {
  let s = String(ext ?? "").trim().toLowerCase();
  let next: string;
  do {
    next = s;
    s = next.replace(/-\d{4}$/, "");
  } while (s !== next);
  return s;
}

/** Alternate `external_team_id` bases (after stripping `-YYYY`) → `cbbSchoolBySlug` key used on games. */
const EXTERNAL_SLUG_ALIASES: Record<string, string> = {
  "wisconsin-badgers": "wisconsin",
  "byu-cougars": "byu",
  "brigham-young": "byu",
  "brigham-young-cougars": "byu",
  "north-carolina-tar-heels": "north-carolina",
  "north-carolina-unc": "north-carolina",
  "unc-chapel-hill": "north-carolina",
  "unc-tar-heels": "north-carolina",
  unc: "north-carolina",
  "smc-gaels": "saint-mary-s",
  "saint-marys-college-gaels": "saint-mary-s",
  /** Saint Mary's College (CA); avoid colliding with Mount St. Mary's (`mount-st-mary-s`). */
  "saint-marys-gaels": "saint-mary-s",
  "saint-marys": "saint-mary-s",
  "st-marys": "saint-mary-s",
  "st-marys-ca": "saint-mary-s",
  "st-mary-s": "saint-mary-s",
  "saint-mary-s-college": "saint-mary-s"
};

/**
 * `bracketSeoToCbbSchool` / directory matching can map `-st` abbreviations to the wrong flagship
 * (e.g. `iowa-st` → Iowa Hawkeyes instead of Iowa State). Force correct `cbbSchoolBySlug` keys.
 */
const BRACKET_SEO_TO_POOL_SLUG_OVERRIDE: Record<string, string> = {
  "north-carolina-st": "nc-state",
  "iowa-st": "iowa-state",
  "michigan-st": "michigan-state",
  "north-dakota-st": "north-dakota-state",
  "ohio-st": "ohio-state",
  "tennessee-st": "tennessee-state",
  "texas-am": "texas-aandm",
  "utah-st": "utah-state"
};

/** When `name`/`short_name` embed a school but don’t match cbbSchoolBySlug exactly. */
const SCHOOL_SUBSTRING_TO_SLUG: Array<{ test: (s: string) => boolean; slug: string }> = [
  { test: (s) => /\bnc\s+state\b/i.test(s) || /\bn\.?\s*c\.?\s*state\b/i.test(s), slug: "nc-state" },
  { test: (s) => /\bnorth carolina state\b/i.test(s), slug: "nc-state" },
  {
    test: (s) => {
      const t = s.toLowerCase();
      if (/\bunc\s+(wilmington|greensboro|asheville|charlotte)\b/.test(t)) return false;
      if (/\bnorth carolina\s+(a&t|central|state)\b/.test(t)) return false;
      if (/\bnorth carolina\s+a&t\b/.test(t)) return false;
      if (/\btar heels\b/.test(t)) return true;
      if (/\bunc\b/.test(t)) return true;
      return /\bnorth carolina\b/.test(t) && !/\bstate\b/.test(t);
    },
    slug: "north-carolina"
  },
  { test: (s) => /\bbyu\b/i.test(s) || /\bbrigham young\b/i.test(s), slug: "byu" },
  {
    test: (s) => {
      const t = s.toLowerCase();
      if (/\bmount\s+st\.?\s*mary/i.test(t)) return false;
      return (
        /\bsaint mary'?s\b/i.test(t) ||
        /\bst\.?\s*mary'?s\b/i.test(t) ||
        /\bst marys\b/i.test(t) ||
        /\bsaint marys\b/i.test(t)
      );
    },
    slug: "saint-mary-s"
  },
  { test: (s) => /\bwisconsin\b/i.test(s), slug: "wisconsin" }
];

let espnLongSlugToPoolSlugCache: Map<string, string> | null = null;

/** Inverse of {@link SEO_SLUG_ALIASES}: ESPN-style `team.slug` base → pool `cbbSchoolBySlug` key. */
function espnLongSlugToPoolSlugMap(): Map<string, string> {
  if (espnLongSlugToPoolSlugCache) return espnLongSlugToPoolSlugCache;
  const cbb = (ncaaRef as { cbbSchoolBySlug?: Record<string, string> }).cbbSchoolBySlug ?? {};
  const out = new Map<string, string>();
  for (const [poolSeo, espnSlug] of Object.entries(SEO_SLUG_ALIASES)) {
    if (!poolSeo || !espnSlug) continue;
    if (!Object.prototype.hasOwnProperty.call(cbb, poolSeo)) continue;
    const k = String(espnSlug).trim().toLowerCase();
    if (!k) continue;
    if (!out.has(k)) out.set(k, poolSeo);
  }
  espnLongSlugToPoolSlugCache = out;
  return out;
}

function bracketSeoToPoolSlug(seo: string): string | null {
  const o = BRACKET_SEO_TO_POOL_SLUG_OVERRIDE[seo];
  if (o) return o;
  const bracketMap = (ncaaRef as { bracketSeoToCbbSchool?: Record<string, string> }).bracketSeoToCbbSchool ?? {};
  const display = bracketMap[seo];
  if (!display) return null;
  return schoolDisplayNameToBracketSlugMap().get(normalizeSchoolLookupKey(display)) ?? null;
}

/**
 * `external_team_id` like `iowa-st-2026` → pool slug (`cbbSchoolBySlug` key), e.g. `iowa-state`.
 * Used when `teams.conference` is missing (bracket upserts) for analytics fallbacks.
 */
export function poolSlugFromExternalTeamIdString(externalTeamId: string | null | undefined): string | null {
  const ext = String(externalTeamId ?? "").trim();
  if (!ext) return null;
  const base = canonicalBaseFromExternalTeamId(ext);
  if (!base || /^\d+$/.test(base)) return null;
  return normalizeExternalBaseToPoolSlug(base);
}

/**
 * Map henrygd/ESPN/bracket external base string → canonical pool slug (`cbbSchoolBySlug` key).
 */
function normalizeExternalBaseToPoolSlug(base: string): string | null {
  let b = base.trim().toLowerCase().replace(/-(ncaa|espn)$/i, "");
  if (!b) return null;
  const cbb = (ncaaRef as { cbbSchoolBySlug?: Record<string, string> }).cbbSchoolBySlug ?? {};
  if (Object.prototype.hasOwnProperty.call(cbb, b)) return b;
  const aliased = EXTERNAL_SLUG_ALIASES[b];
  if (aliased) return aliased;
  const fromEspnLong = espnLongSlugToPoolSlugMap().get(b);
  if (fromEspnLong) return fromEspnLong;
  const fromBracket = bracketSeoToPoolSlug(b);
  if (fromBracket) return fromBracket;
  return null;
}

let espnTeamIdToBracketSlugCache: Map<number, string> | null = null;

/** Map ESPN location id (often stored as `external_team_id` without henrygd slug) → henrygd-style slug. */
function espnTeamIdToBracketSlugMap(): Map<number, string> {
  if (espnTeamIdToBracketSlugCache) return espnTeamIdToBracketSlugCache;
  const out = new Map<number, string>();
  const displayToSlug = schoolDisplayNameToBracketSlugMap();
  for (const [espnName, rawId] of Object.entries(ESPN_NCAAM_TEAM_NAME_TO_ID)) {
    const espnId = typeof rawId === "number" ? rawId : safeNum(rawId);
    if (espnId <= 0) continue;
    const slug = displayToSlug.get(normalizeSchoolLookupKey(espnName));
    if (slug) out.set(espnId, slug);
  }
  out.set(275, "wisconsin");
  out.set(252, "byu");
  out.set(153, "north-carolina");
  out.set(2608, "saint-mary-s");
  espnTeamIdToBracketSlugCache = out;
  return out;
}

function inferSlugFromCompositeLabels(name?: unknown, shortName?: unknown): string | null {
  for (const label of [name, shortName]) {
    if (label == null) continue;
    const s = String(label).trim().replace(/\u2019|\u2018/g, "'");
    if (!s) continue;
    for (const { test, slug } of SCHOOL_SUBSTRING_TO_SLUG) {
      if (test(s)) return slug;
    }
  }
  return null;
}

function normalizeSchoolLookupKey(label: string): string {
  return label
    .trim()
    .toLowerCase()
    .replace(/\u2019|\u2018/g, "'")
    .replace(/\s+/g, " ");
}

/** Display names / nicknames → bracket slug (matches external id base). */
const EXTRA_DISPLAY_TO_SLUG: Record<string, string> = {
  "wisconsin badgers": "wisconsin",
  badgers: "wisconsin",
  "university of wisconsin": "wisconsin",
  "university of wisconsin-madison": "wisconsin",
  "uw-madison": "wisconsin",
  wisc: "wisconsin",
  /** Short labels on ESPN / pool rows */
  unc: "north-carolina",
  "tar heels": "north-carolina"
};

let schoolDisplayToSlugCache: Map<string, string> | null = null;

function schoolDisplayNameToBracketSlugMap(): Map<string, string> {
  if (schoolDisplayToSlugCache) return schoolDisplayToSlugCache;
  const m = new Map<string, string>();
  const cbb = (ncaaRef as { cbbSchoolBySlug?: Record<string, string> }).cbbSchoolBySlug ?? {};
  for (const [slug, display] of Object.entries(cbb)) {
    const k = normalizeSchoolLookupKey(display);
    if (!m.has(k)) m.set(k, slug);
  }
  for (const [k, slug] of Object.entries(EXTRA_DISPLAY_TO_SLUG)) {
    if (!m.has(k)) m.set(k, slug);
  }
  schoolDisplayToSlugCache = m;
  return m;
}

export type TeamRowForCanonical = {
  id: unknown;
  external_team_id?: unknown;
  name?: unknown;
  short_name?: unknown;
};

/**
 * Stable cross-table identity for tournament games vs roster `teams.id` rows.
 * Prefer `external_team_id` base; if missing, map `name` / `short_name` via NCAA reference.
 */
export function resolveCanonicalTeamKeyFromRow(row: TeamRowForCanonical): string {
  const internalId = safeNum(row.id);
  const ext = String(row.external_team_id ?? "").trim();
  const base = canonicalBaseFromExternalTeamId(ext);

  // Henrygd / ESPN / bracket slug base (e.g. `wisconsin`, `wisconsin-badgers`, `saint-marys-gaels`).
  if (base && !/^\d+$/.test(base)) {
    const normalized = normalizeExternalBaseToPoolSlug(base);
    if (normalized) return normalized;
    // Unknown slug string — try `name` / `short_name` below instead of locking to a non-matching key.
  }

  // Some DB rows use ESPN numeric id as `external_team_id` (e.g. `275` / `275-2026`) — align to bracket slug.
  if (base && /^\d+$/.test(base)) {
    const eid = safeNum(base);
    const fromEspn = espnTeamIdToBracketSlugMap().get(eid);
    if (fromEspn) return fromEspn;
  }

  const map = schoolDisplayNameToBracketSlugMap();
  for (const label of [row.short_name, row.name]) {
    if (label == null) continue;
    const slug = map.get(normalizeSchoolLookupKey(String(label)));
    if (slug) return slug;
  }

  const inferred = inferSlugFromCompositeLabels(row.name, row.short_name);
  if (inferred) return inferred;

  return `__id_${internalId}`;
}

export function buildCanonicalByInternalTeamIdFromRows(
  rows: TeamRowForCanonical[]
): Map<number, string> {
  const out = new Map<number, string>();
  for (const row of rows) {
    const id = safeNum(row.id);
    if (id > 0) out.set(id, resolveCanonicalTeamKeyFromRow(row));
  }
  return out;
}

/**
 * Pool `cbbSchoolBySlug` key from a `teams` row (external id, then names). Used to align
 * `games.team_*_id` with roster rows when `canonicalByInternalTeamId` still has `__id_*`.
 */
export function poolSlugClusterKeyFromTeamRow(row: TeamRowForCanonical): string | null {
  const ext = String(row.external_team_id ?? "").trim().toLowerCase();
  if (ext) {
    const eb = canonicalBaseFromExternalTeamId(ext);
    if (eb) {
      if (/^\d+$/.test(eb)) {
        const fromNum = espnTeamIdToBracketSlugMap().get(safeNum(eb));
        if (fromNum) return fromNum;
      } else {
        const norm = normalizeExternalBaseToPoolSlug(eb);
        if (norm) return norm;
      }
    }
  }
  const map = schoolDisplayNameToBracketSlugMap();
  for (const label of [row.short_name, row.name]) {
    if (label == null) continue;
    const slug = map.get(normalizeSchoolLookupKey(String(label)));
    if (slug) return slug;
  }
  return inferSlugFromCompositeLabels(row.name, row.short_name);
}

/**
 * Prefer reconciled `cbbSchoolBySlug` key; if the map still has `__id_*`, derive slug from the `teams` row.
 */
export function stablePoolSlugForTeamContext(
  internalTeamId: number,
  canonicalByInternalTeamId: Map<number, string>,
  teamRowByInternalId?: Map<number, TeamRowForCanonical>
): string | null {
  if (internalTeamId <= 0) return null;
  const direct = canonicalByInternalTeamId.get(internalTeamId);
  if (direct && !direct.startsWith("__id_")) return direct;
  if (teamRowByInternalId) {
    const row = teamRowByInternalId.get(internalTeamId);
    if (row) {
      const fromRow = poolSlugClusterKeyFromTeamRow(row);
      if (fromRow) return fromRow;
    }
  }
  return direct ?? null;
}

/**
 * Henrygd sync and ESPN/populate often create different `teams.id` rows for the same school
 * (`wisconsin-2026` vs `wisconsin-badgers-2026`). Per-row resolution can yield `__id_*` for one
 * while the other maps to the pool slug; elimination then misses roster-side ids. Merge all rows
 * that share the same normalized external identity to one canonical slug before building
 * `eliminationRoundByCanonical`.
 */
export function reconcileCanonicalTeamIdsFromRows(
  rows: TeamRowForCanonical[],
  canonicalByInternalTeamId: Map<number, string>
): void {
  const slugToIds = new Map<string, number[]>();
  function addIdToSlug(slug: string, id: number) {
    const arr = slugToIds.get(slug) ?? [];
    arr.push(id);
    slugToIds.set(slug, arr);
  }
  for (const row of rows) {
    const id = safeNum(row.id);
    if (id <= 0) continue;
    const slug = poolSlugClusterKeyFromTeamRow(row);
    if (slug) {
      addIdToSlug(slug, id);
      continue;
    }
    // Rare: external id / name edge cases where cluster key missed but full resolution succeeds.
    const resolved = resolveCanonicalTeamKeyFromRow(row);
    if (resolved && !resolved.startsWith("__id_")) {
      addIdToSlug(resolved, id);
    }
  }

  for (const [slug, ids] of slugToIds) {
    let preferred: string | null = null;
    for (const tid of ids) {
      const c = canonicalByInternalTeamId.get(tid);
      if (c != null && !c.startsWith("__id_")) {
        preferred = c;
        break;
      }
    }
    if (preferred == null) preferred = slug;
    for (const tid of ids) {
      canonicalByInternalTeamId.set(tid, preferred);
    }
  }
}

export async function fetchTeamRowsForCanonicalKeys(
  supabase: SupabaseClient,
  teamIds: number[]
): Promise<TeamRowForCanonical[]> {
  const uniq = [...new Set(teamIds.filter((id) => id > 0))];
  if (uniq.length === 0) return [];
  const out: TeamRowForCanonical[] = [];
  const chunkSize = 400;
  for (let i = 0; i < uniq.length; i += chunkSize) {
    const chunk = uniq.slice(i, i + chunkSize);
    const { data } = await supabase
      .from("teams")
      .select("id, external_team_id, name, short_name")
      .in("id", chunk);
    out.push(...((data ?? []) as TeamRowForCanonical[]));
  }
  return out;
}

export type MinimalGameForElimination = {
  round: number;
  status: string;
  start_time: string;
  team_a_id: number;
  team_b_id: number;
  team_a_score: number | null;
  team_b_score: number | null;
};

/**
 * For each canonical school key, elimination round when they lost their chronologically latest final.
 * Matches `loadLeagueScoringEngineState` semantics.
 */
export function buildEliminationRoundByCanonicalFromGames(
  gameRows: MinimalGameForElimination[],
  canonicalByInternalTeamId: Map<number, string>,
  teamRowByInternalId?: Map<number, TeamRowForCanonical>
): Map<string, number> {
  const latestFinalByCanonical = new Map<
    string,
    { atMs: number; eliminatedRound: number | null; lost: boolean }
  >();

  for (const g of gameRows) {
    if (!isFinalStatus(g.status)) continue;
    const atMs = Number.isFinite(new Date(g.start_time).getTime()) ? new Date(g.start_time).getTime() : 0;
    const bucket = participationBucketFromDbRound(safeNum(g.round));
    for (const side of [0, 1] as const) {
      const tid = side === 0 ? g.team_a_id : g.team_b_id;
      if (tid <= 0) continue;
      const canon = stablePoolSlugForTeamContext(tid, canonicalByInternalTeamId, teamRowByInternalId);
      if (!canon) continue;
      const rawTeam = side === 0 ? g.team_a_score : g.team_b_score;
      const rawOpp = side === 0 ? g.team_b_score : g.team_a_score;
      if (rawTeam == null && rawOpp == null) continue;
      const teamPts = side === 0 ? safeNum(g.team_a_score) : safeNum(g.team_b_score);
      const oppPts = side === 0 ? safeNum(g.team_b_score) : safeNum(g.team_a_score);
      const prev = latestFinalByCanonical.get(canon);
      if (!prev || atMs >= prev.atMs) {
        latestFinalByCanonical.set(canon, {
          atMs,
          eliminatedRound: bucket,
          lost: teamPts < oppPts
        });
      }
    }
  }

  const eliminationRoundByCanonical = new Map<string, number>();
  for (const [canon, info] of latestFinalByCanonical) {
    if (info.lost && info.eliminatedRound != null) {
      eliminationRoundByCanonical.set(canon, info.eliminatedRound);
    }
  }
  return eliminationRoundByCanonical;
}

/**
 * Per canonical school: display buckets (R1–R6) where that team has at least one **final** game **win**.
 * Used for ADV = “clinched advance past the league’s active round” (won that round’s game, or lost later).
 */
export function buildFinalWinDisplayBucketsByCanonicalFromGames(
  gameRows: MinimalGameForElimination[],
  canonicalByInternalTeamId: Map<number, string>,
  teamRowByInternalId?: Map<number, TeamRowForCanonical>
): Map<string, Set<number>> {
  const out = new Map<string, Set<number>>();
  for (const g of gameRows) {
    if (!isFinalStatus(g.status)) continue;
    const bucket = participationBucketFromDbRound(safeNum(g.round));
    if (bucket == null) continue;
    for (const side of [0, 1] as const) {
      const tid = side === 0 ? g.team_a_id : g.team_b_id;
      if (tid <= 0) continue;
      const rawTeam = side === 0 ? g.team_a_score : g.team_b_score;
      const rawOpp = side === 0 ? g.team_b_score : g.team_a_score;
      if (rawTeam == null && rawOpp == null) continue;
      const teamPts = side === 0 ? safeNum(g.team_a_score) : safeNum(g.team_b_score);
      const oppPts = side === 0 ? safeNum(g.team_b_score) : safeNum(g.team_a_score);
      if (teamPts <= oppPts) continue;
      const canon = stablePoolSlugForTeamContext(tid, canonicalByInternalTeamId, teamRowByInternalId);
      if (!canon) continue;
      if (!out.has(canon)) out.set(canon, new Set());
      out.get(canon)!.add(bucket);
    }
  }
  return out;
}
