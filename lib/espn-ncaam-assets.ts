/**
 * Unofficial ESPN CDN patterns for NCAA men's basketball visuals.
 * No API key; URLs can change. Prefer caching + fallbacks in production.
 * See docs/ncaa-player-and-team-media.md for licensed API options.
 */

/** 500px wide PNG on ESPN's CDN */
export function espnNcaamTeamLogoUrl(teamId: number): string {
  return `https://a.espncdn.com/i/teamlogos/ncaa/500/${teamId}.png`;
}

/** Square headshot; 404 if ID wrong or image missing */
export function espnNcaamPlayerHeadshotUrl(athleteId: number): string {
  return `https://a.espncdn.com/i/headshots/mens-college-basketball/players/full/${athleteId}.png`;
}

/** Try PNG first (historical default), then JPG — ESPN serves one or the other per athlete. */
export function espnNcaamPlayerHeadshotUrlCandidates(athleteId: number): string[] {
  const base = `https://a.espncdn.com/i/headshots/mens-college-basketball/players/full/${athleteId}`;
  return [`${base}.png`, `${base}.jpg`];
}

/**
 * ESPN "location" team ids (subset for demo seed data).
 * Source: espn.com/mens-college-basketball/team/_/id/{id}/...
 */
export const ESPN_NCAAM_TEAM_NAME_TO_ID: Record<string, number> = {
  Florida: 57,
  Duke: 150,
  Wisconsin: 275,
  Missouri: 142,
  Maryland: 120,
  "Ole Miss": 145,
  "Texas Tech": 2641,
  BYU: 252,
  "Iowa St.": 66,
  Purdue: 2509,
  Houston: 248,
  Iowa: 2294,
  UConn: 41,
  Connecticut: 41,
  Kansas: 2305,
  Kentucky: 96,
  "North Carolina": 153,
  Arizona: 12,
  Gonzaga: 2250,
  Tennessee: 2633,
  Alabama: 333,
  Baylor: 239,
  Creighton: 156,
  Illinois: 356,
  "Michigan St.": 127,
  "Michigan State": 127,
  "Ohio St.": 194,
  "Ohio State": 194,
  "Florida St.": 52,
  "Florida State": 52,
  "Virginia Tech": 259,
  Clemson: 228,
  Auburn: 2,
  Arkansas: 8,
  "Saint Mary's": 2608,
  "St. Mary's": 2608,
  "San Diego St.": 21,
  "San Diego State": 21,
  "New Mexico": 167,
  Colorado: 38,
  "Colorado St.": 36,
  "Colorado State": 36,
  "Utah St.": 328,
  "Utah State": 328,
  "Grand Canyon": 2900,
  McNeese: 2377,
  "James Madison": 256,
  "Samford": 2535,
  "Oakland": 2473,
  "South Dakota St.": 2571,
  "South Dakota State": 2571,
  Vermont: 261,
  "Long Beach St.": 299,
  "Long Beach State": 299,
  Colgate: 2142,
  "Western Ky.": 98,
  "Western Kentucky": 98,
  Drake: 2181,
  "Howard": 47,
  /** Peacocks — was incorrectly 2599 (St. John's) */
  "Saint Peter's": 2612,
  "St. Peter's": 2612,
  "Montana St.": 147,
  "Montana State": 147,
  Duquesne: 2184,
  "Longwood": 2344,
  Wagner: 2681,
  Grambling: 2755,
  "NC Central": 2428,
  "Texas Southern": 2640,
  "South Carolina": 2579,
  "Texas A&M": 245,
  Louisville: 97,
  Memphis: 235,
  "Boise St.": 68,
  "Boise State": 68,
  Marquette: 269,
  "Mississippi St.": 344,
  "Mississippi State": 344,
  Oklahoma: 201,
  "Saint Joseph's": 2603,
  "St. Joseph's": 2603,
  "St. John's": 2599,
  "St John's": 2599,
  "St. John's (NY)": 2599,
  "St Johns (NY)": 2599,
  "St. John's Red Storm": 2599,
  "St Johns Red Storm": 2599,
  VCU: 2670,
  "UC San Diego": 28,
  Yale: 43,
  "Bryant": 2803,
  "American": 23,
  "Omaha": 2437,
  "SIU Edwardsville": 2565,
  "Troy": 2653,
  "Liberty": 2335,
  "UC Irvine": 300,
  "Lipscomb": 288,
  "UNC Wilmington": 350,
  "UNCW": 350,
  /** Common bracket / henrygd short names missing earlier */
  Texas: 251,
  "Texas Longhorns": 251,
  Hawaii: 62,
  "Hawaii Rainbow Warriors": 62,
  "North Dakota State": 2440,
  "North Dakota St.": 2440,
  "North Dakota St": 2440,
  Penn: 219,
  Pennsylvania: 219,
  "Penn Quakers": 219,
  Idaho: 70,
  "Idaho Vandals": 70,
  Siena: 2561,
  "Siena Saints": 2561,
  "Iowa State": 66,
  "Iowa State Cyclones": 66,
  /** Common bracket / display strings (fallback when live ESPN index unavailable) */
  Michigan: 130,
  Virginia: 258,
  Nebraska: 158,
  Vanderbilt: 238,
  UCLA: 26,
  "Miami Hurricanes": 2390,
  "Miami (FL)": 2390,
  "Miami FL": 2390,
  "Miami (OH)": 193,
  "Miami OH": 193,
  "Miami Ohio": 193,
  "Miami RedHawks": 193,
  Georgia: 61,
  Villanova: 222,
  TCU: 2628,
  "Texas Christian": 2628,
  UCF: 2116,
  "Central Florida": 2116,
  SMU: 2567,
  "Southern Methodist": 2567,
  UMBC: 2378,
  UNI: 2460,
  "Northern Iowa": 2460,
  "North Carolina State": 152,
  "NC State": 152,
  "N.C. State": 152,
  "Saint Louis": 139,
  "St. Louis": 139,
  "St. Louis Billikens": 139,
  "Santa Clara": 2541,
  "Texas Am": 245,
  "Texas A M": 245,
  Akron: 2006,
  "High Point": 2272,
  "California Baptist": 2856,
  "Cal Baptist": 2856,
  Hofstra: 2275,
  "Wright State": 2756,
  "Kennesaw St.": 338,
  "Kennesaw State": 338,
  Furman: 231,
  Lehigh: 232
};

export function resolveEspnTeamLogoUrlFromName(teamName: string): string | null {
  const trimmed = teamName.trim();
  if (!trimmed) return null;
  const id = ESPN_NCAAM_TEAM_NAME_TO_ID[trimmed];
  if (id != null) return espnNcaamTeamLogoUrl(id);
  const lower = trimmed.toLowerCase();
  for (const [k, v] of Object.entries(ESPN_NCAAM_TEAM_NAME_TO_ID)) {
    if (k.toLowerCase() === lower) return espnNcaamTeamLogoUrl(v);
  }
  return null;
}

/**
 * Prefer `logoUrl` from DB; then try short name, full name, and trimmed variants for ESPN CDN.
 */
export function resolveEspnTeamLogoForPoolRow(opts: {
  logoUrl?: string | null;
  shortName?: string | null;
  fullName?: string | null;
}): string | null {
  const lu = opts.logoUrl?.trim();
  if (lu) return lu;

  const tries: string[] = [];
  const push = (s: string | null | undefined) => {
    const t = s?.trim();
    if (t) tries.push(t);
  };

  push(opts.shortName);
  push(opts.fullName);
  const comma = opts.fullName?.split(",")[0]?.trim();
  push(comma);

  for (const raw of tries) {
    let u = resolveEspnTeamLogoUrlFromName(raw);
    if (u) return u;
    const noMascot = raw
      .replace(
        /\s+(Hawkeyes|Wildcats|Longhorns|Eagles|Bulldogs|Cavaliers|Tar Heels|Blue Devils|Crimson Tide|Volunteers|Jayhawks|Huskies|Spartans|Buckeyes|Mountaineers|Sooners|Aggies|Panthers|Cardinals|Wolfpack|Hoosiers|Boilermakers|Cougars|Gaels|Aztecs|Lobos|Rams|Peacocks|Bison|Terriers|Pirates|Broncos|Flames|Owls|Demon Deacons|Friars|Rebels|Mustangs|Toreros|Anteaters|Chanticleers|Spiders|Trojans|Yellow Jackets|Rainbow Warriors|Quakers|Vandals|Saints|Cyclones|Wolverines|Cornhuskers|Commodores|Bruins|Hurricanes|RedHawks|Horned Frogs|Knights|Retrievers|Billikens|Zips|Lancers|Raiders|Paladins|Mountain Hawks|Pride)$/i,
        ""
      )
      .trim();
    if (noMascot && noMascot !== raw) {
      u = resolveEspnTeamLogoUrlFromName(noMascot);
      if (u) return u;
    }
    // e.g. "North Dakota St." → try "North Dakota State"
    const expandedSt = raw
      .replace(/\bSt\.\s*$/i, "State")
      .replace(/\bSt\s*$/i, "State")
      .trim();
    if (expandedSt !== raw) {
      u = resolveEspnTeamLogoUrlFromName(expandedSt);
      if (u) return u;
    }
  }
  return null;
}

/** Demo-only: map internal playerId → ESPN athlete id when we want a real headshot */
export const DEMO_PLAYER_ID_TO_ESPN_ATHLETE_ID: Record<string, number> = {
  "p-7": 5041939 // Cooper Flagg — verify yearly on ESPN player page
};

export function resolveDemoPlayerHeadshotUrl(playerId: string): string | null {
  const aid = DEMO_PLAYER_ID_TO_ESPN_ATHLETE_ID[playerId];
  return aid != null ? espnNcaamPlayerHeadshotUrl(aid) : null;
}
