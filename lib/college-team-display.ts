import {
  resolveCanonicalTeamKeyFromRow,
  type TeamRowForCanonical
} from "@/lib/tournament-team-canonical";

/** Canonical pool slug (`cbbSchoolBySlug` key) → label shown in tables, filters, and logo initials. */
const ON_PAGE_DISPLAY_BY_CANONICAL: Record<string, string> = {
  "st-john-s": "St. John's",
  "saint-mary-s": "St. Mary's",
  byu: "BYU",
  vcu: "VCU"
};

/** Trailing “St” / “St.” (state-school shorthand) → “ St.” */
function normalizeTrailingStateAbbreviation(label: string): string {
  return label.replace(/\s+St\.?\s*$/i, " St.");
}

function normalizeByuDisplay(label: string): string {
  const t = label.trim();
  if (!t) return label;
  if (/^byu$/i.test(t)) return "BYU";
  if (/^byu\s+cougars?$/i.test(t)) return "BYU";
  if (/^brigham\s+young\b/i.test(t)) return "BYU";
  return label;
}

function normalizeVcuDisplay(label: string): string {
  const t = label.trim();
  if (!t) return label;
  if (/^vcu$/i.test(t)) return "VCU";
  if (/^vcu\s+rams?$/i.test(t)) return "VCU";
  return label;
}

function applyCollegeTeamDisplayStringTransforms(label: string): string {
  const s = label.trim();
  if (!s) return s;

  let out = s.replace(/\bSt\.?\s*John'?s?\s*\(\s*NY\s*\)/gi, "St. John's");

  if (/\bmount\b/i.test(out)) {
    return normalizeTrailingStateAbbreviation(normalizeVcuDisplay(normalizeByuDisplay(out)));
  }

  const looksStMary = /\b(st\.?\s*mary|saint\s*mary|st\s*marys?)\b/i.test(out);
  if (looksStMary) {
    const smcHints =
      /\b(ca|california|moraga|gaels)\b/i.test(out) ||
      /\bst\s*marys?\s*-?\s*ca\b/i.test(out) ||
      /\bsmc\b/i.test(out);
    const plainShort =
      /^saint\s*mary'?s\b/i.test(out) ||
      /^st\.?\s*mary'?s\b/i.test(out) ||
      /^st\s*marys?\b/i.test(out);
    if (smcHints || plainShort) return "St. Mary's";
  }

  out = normalizeByuDisplay(out);
  out = normalizeVcuDisplay(out);
  out = normalizeTrailingStateAbbreviation(out);
  return out;
}

export type TeamRowForCollegeDisplay = {
  id?: unknown;
  external_team_id?: unknown;
  name?: unknown;
  short_name?: unknown;
};

/**
 * Preferred college-team label for UI: matches StatTracker / leaderboard (short then full), then
 * canonical overrides and light string cleanup for ESPN/henrygd variants.
 */
export function displayCollegeTeamNameForUi(
  teamRow: TeamRowForCollegeDisplay | Record<string, unknown> | undefined,
  fallback: string
): string {
  if (!teamRow) return applyCollegeTeamDisplayStringTransforms(fallback);

  const tr = teamRow as TeamRowForCollegeDisplay;
  const short =
    tr.short_name != null && String(tr.short_name).trim() ? String(tr.short_name).trim() : "";
  const full = tr.name != null && String(tr.name).trim() ? String(tr.name).trim() : "";
  const raw = short || full || fallback;

  const canonicalRow: TeamRowForCanonical = {
    id: tr.id,
    external_team_id: tr.external_team_id,
    name: tr.name,
    short_name: tr.short_name
  };
  const key = resolveCanonicalTeamKeyFromRow(canonicalRow);
  const mapped = ON_PAGE_DISPLAY_BY_CANONICAL[key];
  if (mapped) return mapped;

  return applyCollegeTeamDisplayStringTransforms(raw);
}
