/**
 * Live ESPN men's college basketball team directory + roster helpers.
 * Logos come from ESPN's own team payload (same URLs the site uses).
 * Rosters supply official headshot hrefs + ESPN athlete ids for player rows.
 */

const TEAMS_URL =
  "https://site.api.espn.com/apis/site/v2/sports/basketball/mens-college-basketball/teams?limit=1500";

const ROSTER_URL = (teamId: number) =>
  `https://site.api.espn.com/apis/site/v2/sports/basketball/mens-college-basketball/teams/${teamId}/roster`;

const INDEX_TTL_MS = 1000 * 60 * 60 * 6;

export type EspnMbbTeamEntry = {
  id: number;
  slug: string;
  displayName: string;
  shortDisplayName: string;
  location: string;
  name: string;
  abbreviation: string;
  logoUrl: string;
};

export type EspnMbbTeamIndex = {
  bySlug: Map<string, EspnMbbTeamEntry>;
  byDisplayNorm: Map<string, EspnMbbTeamEntry>;
  byAbbrev: Map<string, EspnMbbTeamEntry[]>;
  byLocationNorm: Map<string, EspnMbbTeamEntry[]>;
};

export type EspnMbbRosterAthlete = {
  id: number;
  fullName: string;
  displayName: string;
  headshotHref: string | null;
  jersey: string | null;
  position: string | null;
  /** Height in inches when ESPN provides numeric `height`. */
  heightInches: number | null;
};

const ATHLETE_STATS_URL = (athleteId: number) =>
  `https://site.api.espn.com/apis/common/v3/sports/basketball/mens-college-basketball/athletes/${athleteId}/stats`;

let indexCache: { at: number; index: EspnMbbTeamIndex } | null = null;
const rosterCache = new Map<number, EspnMbbRosterAthlete[]>();

function normKey(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function pickTeamLogo(team: Record<string, unknown>): string {
  const logos = team.logos;
  if (!Array.isArray(logos) || logos.length === 0) {
    return `https://a.espncdn.com/i/teamlogos/ncaa/500/${team.id}.png`;
  }
  const preferred =
    (logos as { href?: string; rel?: string[] }[]).find(
      (l) => Array.isArray(l.rel) && l.rel.includes("full") && l.rel.includes("default")
    ) ?? (logos as { href?: string }[])[0];
  const href = preferred?.href;
  return typeof href === "string" && href.startsWith("http")
    ? href
    : `https://a.espncdn.com/i/teamlogos/ncaa/500/${team.id}.png`;
}

/**
 * Bracket / henrygd `seo` → ESPN `slug` when they differ.
 * Exported for tournament elimination canonical keys when `external_team_id` uses the ESPN slug base.
 */
export const SEO_SLUG_ALIASES: Record<string, string> = {
  "miami-fl": "miami-hurricanes",
  "miami-oh": "miami-oh-redhawks",
  "miami-ohio": "miami-oh-redhawks",
  tcu: "tcu-horned-frogs",
  ucf: "ucf-knights",
  smu: "smu-mustangs",
  umbc: "umbc-retrievers",
  uni: "northern-iowa-panthers",
  "nc-state": "nc-state-wolfpack",
  "north-carolina-state": "nc-state-wolfpack",
  "texas-am": "texas-am-aggies",
  "texas-a-m": "texas-am-aggies",
  "st-louis": "saint-louis-billikens",
  "saint-louis": "saint-louis-billikens",
  "cal-baptist": "california-baptist-lancers",
  "california-baptist": "california-baptist-lancers",
  "wright-st": "wright-state-raiders",
  "wright-state": "wright-state-raiders",
  "kennesaw-st": "kennesaw-owls",
  "kennesaw-state": "kennesaw-owls",
  "high-point": "high-point-panthers",
  akron: "akron-zips",
  furman: "furman-paladins",
  lehigh: "lehigh-mountain-hawks",
  hofstra: "hofstra-pride",
  "santa-clara": "santa-clara-broncos",
  villanova: "villanova-wildcats",
  georgia: "georgia-bulldogs",
  nebraska: "nebraska-cornhuskers",
  vanderbilt: "vanderbilt-commodores",
  ucla: "ucla-bruins",
  virginia: "virginia-cavaliers",
  michigan: "michigan-wolverines",
  /** henrygd / reference JSON use `st-john-s`; ESPN slug is `st-johns-red-storm` */
  "st-john-s": "st-johns-red-storm",
  "st-johns-ny": "st-johns-red-storm",
  "st-john-s-ny": "st-johns-red-storm",
  /** Bare `st-johns` is not an ESPN team slug */
  "st-johns": "st-johns-red-storm",
  /** henrygd / reference JSON uses `saint-mary-s`; ESPN slug is `saint-marys-gaels` */
  "saint-mary-s": "saint-marys-gaels",
  "st-mary-s": "saint-marys-gaels",
  "saint-marys": "saint-marys-gaels",
  /** henrygd sometimes includes location suffix: `st-marys-ca` */
  "st-marys": "saint-marys-gaels",
  "st-marys-ca": "saint-marys-gaels"
};

/**
 * Normalized display / feed strings → ESPN slug.
 */
const NORM_TO_SLUG: Record<string, string> = {
  "miami fl": "miami-hurricanes",
  "miami florida": "miami-hurricanes",
  "miami oh": "miami-oh-redhawks",
  "miami ohio": "miami-oh-redhawks",
  tcu: "tcu-horned-frogs",
  ucf: "ucf-knights",
  smu: "smu-mustangs",
  umbc: "umbc-retrievers",
  uni: "northern-iowa-panthers",
  "north carolina state": "nc-state-wolfpack",
  "nc state": "nc-state-wolfpack",
  "texas am": "texas-am-aggies",
  "texas a m": "texas-am-aggies",
  "texas aandm": "texas-am-aggies",
  "saint louis": "saint-louis-billikens",
  "st louis": "saint-louis-billikens",
  "st louis billikens": "saint-louis-billikens",
  "california baptist": "california-baptist-lancers",
  "cal baptist": "california-baptist-lancers",
  "wright state": "wright-state-raiders",
  "kennesaw st": "kennesaw-owls",
  "kennesaw state": "kennesaw-owls",
  "high point": "high-point-panthers",
  hofstra: "hofstra-pride",
  "santa clara": "santa-clara-broncos",
  "northern iowa": "northern-iowa-panthers",
  /** Committee / bracket strings e.g. `St. John's (NY)` */
  "st john s": "st-johns-red-storm",
  "st john s ny": "st-johns-red-storm",
  "st johns ny": "st-johns-red-storm",
  "st johns red storm": "st-johns-red-storm",
  /** St. Mary's (CA): normalize `Saint Mary's` / `St. Mary's` variations */
  "saint mary s": "saint-marys-gaels",
  "saint mary s ca": "saint-marys-gaels",
  "st mary s": "saint-marys-gaels",
  "st mary s ca": "saint-marys-gaels",
  "saint mary s gaels": "saint-marys-gaels",
  "st mary s gaels": "saint-marys-gaels"
};

function pushLocation(index: EspnMbbTeamIndex, locNorm: string, entry: EspnMbbTeamEntry) {
  if (!locNorm) return;
  const arr = index.byLocationNorm.get(locNorm) ?? [];
  arr.push(entry);
  index.byLocationNorm.set(locNorm, arr);
}

function pushAbbrev(index: EspnMbbTeamIndex, abbr: string, entry: EspnMbbTeamEntry) {
  const k = abbr.toLowerCase().replace(/\./g, "").trim();
  if (!k) return;
  const arr = index.byAbbrev.get(k) ?? [];
  arr.push(entry);
  index.byAbbrev.set(k, arr);
}

function buildIndex(teamsRaw: unknown): EspnMbbTeamIndex {
  const index: EspnMbbTeamIndex = {
    bySlug: new Map(),
    byDisplayNorm: new Map(),
    byAbbrev: new Map(),
    byLocationNorm: new Map()
  };

  const root = teamsRaw as {
    sports?: { leagues?: { teams?: { team: Record<string, unknown> }[] }[] }[];
  };
  const teams = root?.sports?.[0]?.leagues?.[0]?.teams ?? [];

  for (const wrap of teams) {
    const team = wrap?.team;
    if (!team || typeof team !== "object") continue;
    const id = Number(team.id);
    if (!Number.isFinite(id)) continue;
    const slug = String(team.slug ?? "").trim();
    const entry: EspnMbbTeamEntry = {
      id,
      slug,
      displayName: String(team.displayName ?? ""),
      shortDisplayName: String(team.shortDisplayName ?? ""),
      location: String(team.location ?? ""),
      name: String(team.name ?? ""),
      abbreviation: String(team.abbreviation ?? ""),
      logoUrl: pickTeamLogo(team)
    };

    if (slug) index.bySlug.set(slug, entry);
    const dn = normKey(entry.displayName);
    if (dn && !index.byDisplayNorm.has(dn)) index.byDisplayNorm.set(dn, entry);
    const locNick = normKey(`${entry.location} ${entry.name}`.trim());
    if (locNick && locNick !== dn && !index.byDisplayNorm.has(locNick)) {
      index.byDisplayNorm.set(locNick, entry);
    }
    const sdn = normKey(entry.shortDisplayName);
    if (sdn && sdn !== dn && !index.byDisplayNorm.has(sdn)) index.byDisplayNorm.set(sdn, entry);
    pushLocation(index, normKey(entry.location), entry);
    pushAbbrev(index, entry.abbreviation, entry);
  }

  return index;
}

export async function getEspnMbbTeamIndex(): Promise<EspnMbbTeamIndex> {
  if (indexCache && Date.now() - indexCache.at < INDEX_TTL_MS) {
    return indexCache.index;
  }
  const resp = await fetch(TEAMS_URL);
  if (!resp.ok) {
    if (indexCache) return indexCache.index;
    throw new Error(`ESPN MBB teams fetch failed: ${resp.status}`);
  }
  const json = await resp.json();
  const index = buildIndex(json);
  indexCache = { at: Date.now(), index };
  return index;
}

/** Clear roster cache (e.g. between test runs). */
export function clearEspnMbbRosterCache() {
  rosterCache.clear();
}

export async function fetchEspnMbbTeamRosterAthletes(teamEspnId: number): Promise<EspnMbbRosterAthlete[]> {
  if (rosterCache.has(teamEspnId)) return rosterCache.get(teamEspnId)!;

  const resp = await fetch(ROSTER_URL(teamEspnId));
  if (!resp.ok) {
    rosterCache.set(teamEspnId, []);
    return [];
  }
  const j = (await resp.json()) as { athletes?: unknown[] };
  const raw = Array.isArray(j.athletes) ? j.athletes : [];
  const out: EspnMbbRosterAthlete[] = [];

  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const wrap = item as Record<string, unknown>;
    const a =
      wrap.athlete && typeof wrap.athlete === "object"
        ? (wrap.athlete as Record<string, unknown>)
        : wrap;
    const id = Number(a.id);
    if (!Number.isFinite(id) || id <= 0) continue;
    const fullName = String(a.fullName ?? "").trim();
    const displayName = String(a.displayName ?? fullName).trim();
    const head = a.headshot as { href?: string } | undefined;
    const headshotHref =
      head && typeof head.href === "string" && head.href.startsWith("http") ? head.href : null;
    const jerseyRaw = a.jersey;
    const jersey =
      jerseyRaw != null && String(jerseyRaw).trim() ? String(jerseyRaw).trim() : null;
    const pos = a.position;
    let position: string | null = null;
    if (pos && typeof pos === "object") {
      const p = pos as Record<string, unknown>;
      position =
        (typeof p.abbreviation === "string" && p.abbreviation.trim()) ||
        (typeof p.shortName === "string" && p.shortName.trim()) ||
        null;
    }
    let heightInches: number | null = null;
    if (typeof a.height === "number" && Number.isFinite(a.height) && a.height > 40 && a.height < 100) {
      heightInches = Math.round(a.height);
    }
    out.push({
      id,
      fullName: fullName || displayName,
      displayName: displayName || fullName,
      headshotHref,
      jersey,
      position,
      heightInches
    });
  }

  rosterCache.set(teamEspnId, out);
  return out;
}

/** Bracket `iowa-st-*` must match ESPN `iowa-state-*`; try expanded SEO before raw so longest-prefix does not latch onto `iowa`. */
function bracketSeoCandidatesForResolution(seo: string): string[] {
  const raw = seo.trim().toLowerCase().replace(/_/g, "-");
  const expanded = raw.replace(/-st-/g, "-state-");
  return raw === expanded ? [raw] : [expanded, raw];
}

function resolveEspnMbbTeamFromSeoSingle(index: EspnMbbTeamIndex, s: string): EspnMbbTeamEntry | null {
  if (index.bySlug.has(s)) return index.bySlug.get(s)!;
  const alias = SEO_SLUG_ALIASES[s];
  if (alias && index.bySlug.has(alias)) return index.bySlug.get(alias)!;

  /** Longest slug wins: `iowa-state-*` maps to Iowa State, not Iowa (fixes Iowa vs Iowa State, Michigan vs Michigan State, etc.). */
  let best: EspnMbbTeamEntry | null = null;
  let bestLen = -1;
  for (const [slug, entry] of index.bySlug) {
    if (!slug) continue;
    if (s === slug || s.startsWith(`${slug}-`)) {
      if (slug.length > bestLen) {
        bestLen = slug.length;
        best = entry;
      }
    }
  }
  return best;
}

export function resolveEspnMbbTeamFromSeo(index: EspnMbbTeamIndex, seo: string | null): EspnMbbTeamEntry | null {
  if (!seo) return null;
  for (const s of bracketSeoCandidatesForResolution(seo)) {
    const hit = resolveEspnMbbTeamFromSeoSingle(index, s);
    if (hit) return hit;
  }
  return null;
}

function expandNameCandidates(shortName?: string | null, fullName?: string | null): string[] {
  const out: string[] = [];
  const push = (x: string | null | undefined) => {
    const t = x?.trim();
    if (t) out.push(t);
  };
  push(fullName);
  push(shortName);
  const comma = fullName?.split(",")[0]?.trim();
  push(comma);

  const extra: string[] = [];
  for (const c of [...out]) {
    const m = c.match(/^(.+?)\s*\(\s*([^)]+?)\s*\)\s*(.*)$/i);
    if (m) {
      const base = m[1]!.trim();
      const region = m[2]!.trim();
      const rest = m[3]!.trim();
      extra.push(`${base} ${region}`.trim());
      if (rest) extra.push(`${base} ${rest}`.trim());
      if (/^(fl|fla|florida)$/i.test(region)) extra.push("Miami Hurricanes");
      if (/^(oh|ohio)$/i.test(region)) extra.push("Miami Ohio");
      if (
        /^(ny|n y|new york)$/i.test(region.trim()) &&
        /\bst\.?\s*johns?\b/i.test(base)
      ) {
        extra.push("St. John's Red Storm");
      }
    }
  }
  return [...new Set([...out, ...extra].map((x) => x.trim()).filter(Boolean))];
}

export function resolveEspnMbbTeamFromPoolStrings(
  index: EspnMbbTeamIndex,
  shortName?: string | null,
  fullName?: string | null
): EspnMbbTeamEntry | null {
  const candidates = expandNameCandidates(shortName, fullName);

  for (const raw of candidates) {
    const slugHint = NORM_TO_SLUG[normKey(raw)];
    if (slugHint && index.bySlug.has(slugHint)) return index.bySlug.get(slugHint)!;
  }

  for (const raw of candidates) {
    const k = normKey(raw);
    const hit = index.byDisplayNorm.get(k);
    if (hit) return hit;
  }

  for (const raw of candidates) {
    const k = normKey(raw);
    const locHits = index.byLocationNorm.get(k);
    if (locHits?.length === 1) return locHits[0]!;
  }

  for (const raw of candidates) {
    const noMascot = raw
      .replace(
        /\s+(Hawkeyes|Wildcats|Longhorns|Eagles|Bulldogs|Cavaliers|Tar Heels|Blue Devils|Crimson Tide|Volunteers|Jayhawks|Huskies|Spartans|Buckeyes|Mountaineers|Sooners|Aggies|Panthers|Cardinals|Wolfpack|Hoosiers|Boilermakers|Cougars|Gaels|Aztecs|Lobos|Rams|Peacocks|Bison|Terriers|Pirates|Broncos|Flames|Owls|Demon Deacons|Friars|Rebels|Mustangs|Toreros|Anteaters|Chanticleers|Spiders|Trojans|Yellow Jackets|Rainbow Warriors|Quakers|Vandals|Saints|Cyclones|Billikens|Retrievers|Knights|Horned Frogs|Commodores|Bruins|Cornhuskers|Wolverines|Hurricanes|RedHawks|Zips|Paladins|Mountain Hawks|Pride|Lancers|Raiders|Red Storm)$/i,
        ""
      )
      .trim();
    if (noMascot && noMascot !== raw) {
      const k = normKey(noMascot);
      const locHits = index.byLocationNorm.get(k);
      if (locHits?.length === 1) return locHits[0]!;
      const d = index.byDisplayNorm.get(k);
      if (d) return d;
    }
    const expandedSt = raw
      .replace(/\bSt\.\s*$/i, "State")
      .replace(/\bSt\s*$/i, "State")
      .trim();
    if (expandedSt !== raw) {
      const d = index.byDisplayNorm.get(normKey(expandedSt));
      if (d) return d;
    }
  }

  for (const raw of candidates) {
    const k = normKey(raw);
    if (k.length <= 5) {
      const ab = index.byAbbrev.get(k);
      if (ab?.length === 1) return ab[0]!;
    }
  }

  return null;
}

export function resolveEspnMbbTeamForPopulate(
  index: EspnMbbTeamIndex,
  opts: { seo: string | null; shortName: string | null; fullName: string }
): EspnMbbTeamEntry | null {
  return (
    resolveEspnMbbTeamFromSeo(index, opts.seo) ??
    resolveEspnMbbTeamFromPoolStrings(index, opts.shortName, opts.fullName)
  );
}

/** Parse `${seo}-${seasonYear}` → `seo` (henrygd / bracket pattern). */
export function externalTeamIdToSeo(externalTeamId: string, seasonYear: number): string | null {
  const suf = `-${seasonYear}`;
  if (!externalTeamId.endsWith(suf)) return null;
  return externalTeamId.slice(0, -suf.length).toLowerCase();
}

/** Logo URL from live index, or null if unresolved. */
export function resolveEspnTeamLogoFromIndex(
  index: EspnMbbTeamIndex,
  opts: {
    logoUrl?: string | null;
    shortName?: string | null;
    fullName?: string | null;
    /** Bracket henrygd `seoname` slug (e.g. `michigan-wolverines`). */
    seo?: string | null;
  }
): string | null {
  const lu = opts.logoUrl?.trim();
  if (lu) return lu;
  const bySeo = opts.seo ? resolveEspnMbbTeamFromSeo(index, opts.seo) : null;
  if (bySeo) return bySeo.logoUrl;
  const t = resolveEspnMbbTeamFromPoolStrings(index, opts.shortName ?? null, opts.fullName ?? null);
  return t?.logoUrl ?? null;
}

export function normalizePlayerNameForMatch(name: string): string {
  return normKey(
    name
      .replace(/\bJr\.?|Sr\.?|II|III|IV\b/gi, "")
      .replace(/\./g, " ")
      .trim()
  );
}

type EspnAthleteStatsCategory = {
  name?: string;
  names?: string[];
  statistics?: Array<{
    teamId?: string;
    season?: { year?: number };
    stats?: string[];
  }>;
};

/**
 * Season scoring average (PPG) from ESPN’s athlete stats feed. Picks the row for `teamEspnId` and the
 * season whose `season.year` best matches `championshipYear` (NCAA tournament year / league season_year).
 */
export async function fetchEspnMbbAthleteSeasonPpg(opts: {
  athleteId: number;
  teamEspnId: number;
  championshipYear: number;
}): Promise<number | null> {
  const { athleteId, teamEspnId, championshipYear } = opts;
  if (!Number.isFinite(athleteId) || athleteId <= 0) return null;
  const resp = await fetch(ATHLETE_STATS_URL(athleteId));
  if (!resp.ok) return null;
  const j = (await resp.json()) as { categories?: EspnAthleteStatsCategory[] };
  const categories = j.categories ?? [];
  const avg =
    categories.find((c) => String(c.name ?? "").toLowerCase() === "averages") ??
    // ESPN sometimes changes casing or includes extra label fields; try a loose match.
    categories.find((c) => String((c as any).displayName ?? "").toLowerCase() === "season averages");
  if (!avg?.names?.length || !avg.statistics?.length) return null;
  const ppgIdx = avg.names.findIndex((n) => String(n ?? "").trim().toLowerCase() === "avgpoints");
  // Fallback when ESPN changes metadata shape: use display names if present.
  let resolvedPpgIdx = ppgIdx;
  if (resolvedPpgIdx < 0) {
    const displayNames: unknown = (avg as any).displayNames;
    if (Array.isArray(displayNames)) {
      resolvedPpgIdx = displayNames.findIndex((d) => String(d ?? "").trim().toLowerCase() === "points per game");
    }
  }

  const want = String(teamEspnId);
  let rows = avg.statistics.filter((s) => String(s.teamId ?? "") === want);
  // ESPN’s athlete stats payload sometimes omits `teamId` or uses a different
  // representation for a player’s team. If there’s no exact match, fall back
  // to any rows that look season-aligned so we can still populate `season_ppg`.
  if (rows.length === 0) {
    rows = avg.statistics.filter((s) => s.teamId == null || String(s.teamId ?? "").trim() === "");
  }
  if (rows.length === 0) {
    rows = avg.statistics;
  }

  const scored = rows.map((r) => ({
    row: r,
    year: r.season?.year ?? 0,
    dist: Math.abs((r.season?.year ?? 0) - championshipYear)
  }));
  scored.sort((a, b) => a.dist - b.dist || b.year - a.year);
  const pick = scored[0]?.row;
  const stats = pick?.stats;
  if (!Array.isArray(stats) || stats.length === 0) return null;

  // ESPN's averages category is stable in practice: the last stat column is
  // typically points-per-game even if the labels shift.
  const fallbackIdx = stats.length - 1;
  const idxToUse =
    resolvedPpgIdx != null && Number.isFinite(resolvedPpgIdx) && resolvedPpgIdx >= 0 && resolvedPpgIdx < stats.length
      ? resolvedPpgIdx
      : fallbackIdx;

  const raw = stats[idxToUse] ?? stats[fallbackIdx];
  if (raw == null) return null;

  const n = Number(String(raw).replace(/[^\d.-]/g, ""));
  return Number.isFinite(n) && n > 0 ? Number(n.toFixed(2)) : null;
}

/** Last path segment for ESPN player profile URLs (e.g. `cameron-boozer`). */
export function espnMbbPlayerUrlSlug(displayName: string): string {
  const s = displayName
    .trim()
    .toLowerCase()
    .replace(/['.]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return s.length > 0 ? s : "player";
}

/** `https://www.espn.com/mens-college-basketball/player/_/id/{id}/{slug}` */
export function espnMensCollegeBasketballPlayerProfileUrl(opts: {
  espnAthleteId: number;
  playerName: string;
}): string {
  const slug = espnMbbPlayerUrlSlug(opts.playerName);
  return `https://www.espn.com/mens-college-basketball/player/_/id/${opts.espnAthleteId}/${slug}`;
}
