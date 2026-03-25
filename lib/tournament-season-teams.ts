import type { SupabaseClient } from "@supabase/supabase-js";

function safeNum(x: unknown): number {
  const n = typeof x === "number" ? x : Number(x);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Tournament field from `teams.external_team_id` (`%-{seasonYear}`), plus any referenced
 * `teams.id` rows missing from that set (NULL/wrong external id — e.g. sync drift).
 */
export async function fetchTournamentSeasonTeamsMerged(
  supabase: SupabaseClient,
  seasonYear: number,
  extraTeamIds: number[],
  select: string
): Promise<Record<string, unknown>[]> {
  const { data: primary } = await supabase
    .from("teams")
    .select(select)
    .ilike("external_team_id", `%-${seasonYear}`);

  const byId = new Map<number, Record<string, unknown>>();
  for (const t of primary ?? []) {
    const id = safeNum((t as { id?: unknown }).id);
    if (id > 0) byId.set(id, t as unknown as Record<string, unknown>);
  }

  const need = [...new Set(extraTeamIds.map(safeNum).filter((id) => id > 0))].filter((id) => !byId.has(id));
  if (need.length === 0) return [...byId.values()];

  const { data: extra } = await supabase.from("teams").select(select).in("id", need);
  for (const t of extra ?? []) {
    const id = safeNum((t as { id?: unknown }).id);
    if (id > 0) byId.set(id, t as unknown as Record<string, unknown>);
  }

  return [...byId.values()];
}
