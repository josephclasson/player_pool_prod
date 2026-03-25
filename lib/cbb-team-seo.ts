/**
 * Shared helpers for mapping henrygd / bracket SEO slugs to directory `school` / display labels.
 * Used by scripts that generate `data/ncaa-d1-mbb-team-reference.json`.
 */

import type { TeamDirectorySchoolRow } from "./team-directory-types";

export function uniqueStrings(xs: string[]) {
  const out: string[] = [];
  const s = new Set<string>();
  for (const x of xs) {
    const v = String(x ?? "").trim();
    if (!v) continue;
    const key = v.toLowerCase();
    if (s.has(key)) continue;
    s.add(key);
    out.push(v);
  }
  return out;
}

export function normalizeSchoolCandidate(s: string) {
  return s
    .trim()
    .replace(/\s+/g, " ")
    .replace(/\./g, "")
    .replace(/\s+State$/i, " State")
    .replace(/\bSt\b/i, "State");
}

export function slugifySchoolKey(s: string) {
  return s
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * Bracket feeds often abbreviate "State" as `st` (e.g. `iowa-st-cyclones`). Team directories often use `iowa-state`.
 */
export function bracketSeoKeyVariants(seoKey: string): string[] {
  const k = seoKey.trim().toLowerCase().replace(/^-|-$/g, "");
  if (!k) return [];
  const expanded = k.replace(/-st-/g, "-state-");
  return uniqueStrings([k, expanded]);
}

export function slugifySchoolNameKey(s: string) {
  return slugifySchoolKey(s.trim());
}

/**
 * Slugs in the team directory that prefix-match `seoKey` — keep only the **longest** slug
 * (e.g. `iowa-state` beats `iowa` for `iowa-state-cyclones`).
 */
export function winningDirectorySlugsForSeo(seoKey: string, directory: TeamDirectorySchoolRow[]): Set<string> {
  const keys = bracketSeoKeyVariants(seoKey);
  const hits: { slug: string; len: number }[] = [];
  for (const key of keys) {
    for (const t of directory) {
      for (const label of [t.school, t.displayName]) {
        if (!label) continue;
        const slug = slugifySchoolNameKey(label);
        if (!slug) continue;
        if (key === slug || key.startsWith(`${slug}-`)) {
          hits.push({ slug, len: slug.length });
          break;
        }
      }
    }
  }
  if (hits.length === 0) return new Set();
  const maxLen = Math.max(...hits.map((h) => h.len));
  return new Set(hits.filter((h) => h.len === maxLen).map((h) => h.slug));
}

/** Directory `school` strings for this bracket SEO using longest-prefix disambiguation. */
export function directorySchoolsForSeo(seo: string | null, directory: TeamDirectorySchoolRow[]): string[] {
  if (!seo || directory.length === 0) return [];
  const seoKey = slugifySchoolKey(seo.replace(/_/g, "-"));
  const winners = winningDirectorySlugsForSeo(seoKey, directory);
  if (winners.size === 0) return [];

  const schools: string[] = [];
  for (const t of directory) {
    if (!t.school) continue;
    for (const label of [t.school, t.displayName]) {
      if (!label) continue;
      const slug = slugifySchoolNameKey(label);
      if (winners.has(slug)) {
        schools.push(t.school);
        break;
      }
    }
  }
  return uniqueStrings(schools);
}

export function filterTeamNameCandidatesForSeo(
  seo: string | null,
  candidates: string[],
  directory: TeamDirectorySchoolRow[]
): string[] {
  if (!seo || directory.length === 0) return candidates;
  const seoKey = slugifySchoolKey(seo.replace(/_/g, "-"));
  const winners = winningDirectorySlugsForSeo(seoKey, directory);
  if (winners.size === 0) return candidates;
  return candidates.filter((c) => {
    const ck = slugifySchoolNameKey(c);
    return winners.has(ck);
  });
}

export function slugVariantsForDirectoryTeamLabel(label: string): Set<string> {
  const t = label.trim();
  const keys = new Set<string>();
  if (!t) return keys;
  const variants = [
    t,
    t.replace(/^University of\s+/i, "").trim(),
    t.replace(/\s+University$/i, "").trim(),
    t.replace(/^The\s+/i, "").trim()
  ];
  for (const v of variants) {
    const k = slugifySchoolNameKey(v);
    if (k) keys.add(k);
  }
  return keys;
}

export function directoryTeamLabelMatchesBracketSeo(
  teamLabel: string,
  seo: string | null,
  directory: TeamDirectorySchoolRow[]
): boolean {
  const seoKey = slugifySchoolKey((seo ?? "").replace(/_/g, "-"));
  if (!seoKey) return true;
  const bracketWinners = winningDirectorySlugsForSeo(seoKey, directory);
  if (bracketWinners.size === 0) return false;

  for (const v of slugVariantsForDirectoryTeamLabel(teamLabel)) {
    if (!v) continue;
    const labelWinners = winningDirectorySlugsForSeo(v, directory);
    for (const w of labelWinners) {
      if (bracketWinners.has(w)) return true;
    }
  }
  for (const school of directorySchoolsForSeo(seo, directory)) {
    if (teamLabel.trim().toLowerCase() === school.trim().toLowerCase()) return true;
  }
  return false;
}
