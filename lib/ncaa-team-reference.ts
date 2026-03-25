import type { TeamDirectorySchoolRow } from '@/lib/team-directory-types'
import { directorySchoolsForSeo } from '@/lib/cbb-team-seo'

import baseReference from '@/data/ncaa-d1-mbb-team-reference.json'
import manualOverrides from '@/data/ncaa-team-reference-overrides.json'

export type NcaaTeamReferenceFile = {
  version: number
  seasonYear: number
  generatedAt: string
  source?: string
  cbbApiSeason?: number
  bracketSeoToCbbSchool: Record<string, string>
  cbbSchoolBySlug: Record<string, string>
  /** Optional crosswalk from Balldontlie `college` (lowercase key) when `generate:team-reference` ran with a key. */
  balldontlieByCollegeLower?: Record<
    string,
    { full_name: string; abbreviation: string | null; name: string }
  >
}

export type NcaaTeamReferenceOverrides = {
  seoToCbbSchool: Record<string, string>
}

const base = baseReference as NcaaTeamReferenceFile
const overrides = manualOverrides as NcaaTeamReferenceOverrides

function normalizeBracketSeoKey(seo: string): string {
  return seo.trim().toLowerCase().replace(/_/g, '-')
}

function expandedStateSeoKey(seo: string): string {
  return normalizeBracketSeoKey(seo).replace(/-st-/g, '-state-')
}

function schoolExistsInDirectory(school: string, directory: TeamDirectorySchoolRow[]): boolean {
  const t = school.trim().toLowerCase()
  return directory.some((d) => d.school.trim().toLowerCase() === t)
}

/**
 * Preferred directory `school` label for a henrygd bracket `seoname`, using generated reference +
 * manual overrides, validated against the live directory (e.g. ESPN team index rows).
 * Falls back to directorySchoolsForSeo (longest-prefix) when no explicit mapping exists.
 */
export function getPreferredCbbSchoolForBracketSeo(
  seo: string | null | undefined,
  directory: TeamDirectorySchoolRow[],
  ref: NcaaTeamReferenceFile = base
): string | null {
  if (!seo?.trim() || directory.length === 0) return null

  const keys = [normalizeBracketSeoKey(seo), expandedStateSeoKey(seo)]

  const tryResolve = (school: string | undefined): string | null => {
    if (!school?.trim()) return null
    return schoolExistsInDirectory(school, directory) ? school.trim() : null
  }

  for (const key of keys) {
    const fromOverride = tryResolve(overrides.seoToCbbSchool[key])
    if (fromOverride) return fromOverride
    const fromRef = tryResolve(ref.bracketSeoToCbbSchool[key])
    if (fromRef) return fromRef
  }

  const fallback = directorySchoolsForSeo(seo, directory)[0] ?? null
  return fallback
}

export function getNcaaTeamReference(): NcaaTeamReferenceFile {
  return base
}

export function getNcaaTeamReferenceOverrides(): NcaaTeamReferenceOverrides {
  return overrides
}
