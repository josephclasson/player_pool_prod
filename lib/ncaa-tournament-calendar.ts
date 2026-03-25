import type { SupabaseClient } from "@supabase/supabase-js";

function safeNum(x: unknown): number {
  const n = typeof x === "number" ? x : Number(x);
  return Number.isFinite(n) ? n : 0;
}

/** DB `games.round`: 1 = round of 64 … 6 = championship (First Four was 0 — excluded from scoring). */
export const TOURNAMENT_SCORING_ROUNDS = [1, 2, 3, 4, 5, 6] as const;

/** Max calendar days to scan from First Round Thursday (covers off weeks + championship Monday). */
export const TOURNAMENT_SYNC_MAX_CALENDAR_DAYS = 45;

/**
 * Baked First Round **Thursday** (UTC date) per championship year. Override with env
 * `TOURNAMENT_FIRST_ROUND_THURSDAY_{YEAR}` (YYYY-MM-DD).
 */
const BAKED_FIRST_ROUND_THURSDAY: Record<number, string> = {
  2025: "2025-03-20",
  2026: "2026-03-19"
};

function envFirstRoundThursday(seasonYear: number): string | undefined {
  const v = process.env[`TOURNAMENT_FIRST_ROUND_THURSDAY_${seasonYear}`]?.trim();
  return v || undefined;
}

/**
 * First day of NCAA **First Round** (round of 64), i.e. the Thursday that starts the main bracket.
 * Does not include First Four (Tue/Wed).
 */
export function firstRoundThursdayISOForSeason(seasonYear: number): string | null {
  const fromEnv = envFirstRoundThursday(seasonYear);
  if (fromEnv && /^\d{4}-\d{2}-\d{2}$/.test(fromEnv)) return fromEnv;
  const baked = BAKED_FIRST_ROUND_THURSDAY[seasonYear];
  return baked ?? null;
}

/** YYYY-MM-DD UTC strings from start (inclusive) for `maxDays` days. */
export function utcTodayISO(): string {
  const n = new Date();
  const y = n.getUTCFullYear();
  const m = String(n.getUTCMonth() + 1).padStart(2, "0");
  const d = String(n.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function utcDateISOsFromStart(startISO: string, maxDays: number): string[] {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startISO)) return [];
  const [y, m, d] = startISO.split("-").map((x) => parseInt(x, 10));
  if (!y || !m || !d) return [];
  const out: string[] = [];
  const cur = new Date(Date.UTC(y, m - 1, d));
  for (let i = 0; i < maxDays; i++) {
    const yy = cur.getUTCFullYear();
    const mm = String(cur.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(cur.getUTCDate()).padStart(2, "0");
    out.push(`${yy}-${mm}-${dd}`);
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return out;
}

/**
 * Championship (DB round 6) is final with a winner, and both teams belong to this `seasonYear`.
 */
export async function checkChampionshipFinalForSeason(
  supabase: SupabaseClient,
  seasonYear: number
): Promise<boolean> {
  const suffix = `-${seasonYear}`;
  const { data: finals, error } = await supabase
    .from("games")
    .select("team_a_id, team_b_id, team_a_score, team_b_score, status")
    .eq("round", 6)
    .eq("status", "final");

  if (error || !finals?.length) return false;

  const teamIds = new Set<number>();
  for (const g of finals) {
    const row = g as Record<string, unknown>;
    const a = safeNum(row.team_a_id);
    const b = safeNum(row.team_b_id);
    if (a > 0) teamIds.add(a);
    if (b > 0) teamIds.add(b);
  }
  if (teamIds.size === 0) return false;

  const { data: teams } = await supabase
    .from("teams")
    .select("id, external_team_id")
    .in("id", [...teamIds]);

  const idToExt = new Map<number, string>(
    (teams ?? []).map((t: { id: unknown; external_team_id?: unknown }) => [
      safeNum(t.id),
      String(t.external_team_id ?? "")
    ])
  );

  for (const g of finals) {
    const row = g as Record<string, unknown>;
    const a = safeNum(row.team_a_id);
    const b = safeNum(row.team_b_id);
    const aPts = row.team_a_score != null ? safeNum(row.team_a_score) : 0;
    const bPts = row.team_b_score != null ? safeNum(row.team_b_score) : 0;
    if (aPts === bPts) continue;
    const extA = idToExt.get(a) ?? "";
    const extB = idToExt.get(b) ?? "";
    if (extA.endsWith(suffix) && extB.endsWith(suffix)) return true;
  }
  return false;
}
