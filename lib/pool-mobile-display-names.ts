/** Names like Jr., Sr., II — keep with previous token as the displayed surname tail. */
const NAME_SUFFIX_RE = /^(?:jr|sr|ii|iii|iv|v)$/i;

function playerLastNameSegment(parts: string[]): string {
  if (parts.length === 0) return "";
  const last = parts[parts.length - 1] ?? "";
  const lastNorm = last.replace(/\./g, "").toLowerCase();
  if (parts.length >= 2 && NAME_SUFFIX_RE.test(lastNorm)) {
    return `${parts[parts.length - 2]!} ${last}`.trim();
  }
  return last;
}

/** Mobile: "Cameron Boozer" → "C. Boozer" (first initial + last name segment). */
export function abbreviatePlayerNameForMobile(name: string): string {
  const t = name.trim();
  if (!t) return "—";
  const parts = t.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "—";
  if (parts.length === 1) return parts[0]!;
  const first = parts[0]!;
  const initial = first[0]!;
  const lastSeg = playerLastNameSegment(parts);
  return `${initial.toLocaleUpperCase()}. ${lastSeg}`;
}

/** Mobile: "Joe Classon" → "Joe" (first word only). */
export function abbreviateOwnerNameForMobile(name: string): string {
  const t = name.trim();
  if (!t) return "—";
  const first = t.split(/\s+/).filter(Boolean)[0];
  return first ?? t;
}
