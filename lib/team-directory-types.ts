/**
 * Generic “team directory” row for longest-prefix SEO → school/label matching (henrygd slugs, etc.).
 * Populated from ESPN’s team index or similar — not tied to a paid stats API.
 */
export type TeamDirectorySchoolRow = {
  school: string;
  displayName?: string;
  abbreviation?: string;
};
