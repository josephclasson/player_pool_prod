import { createBrowserSupabaseClient } from "@/lib/supabase/browser";
import { liveScoreboardPushDebounceMs } from "@/lib/pool-refresh-intervals";

/**
 * When `league_live_scoreboard` is upserted (after live-sync, commissioner sync, draft, etc.),
 * all subscribed tabs can refetch immediately instead of waiting for the next poll.
 */
export function subscribeLeagueLiveScoreboard(
  leagueId: string | null | undefined,
  onUpdate: () => void,
  opts: { debounceMs?: number; channelPrefix: string }
): () => void {
  const id = leagueId?.trim();
  if (!id) return () => {};

  const debounceMs = opts.debounceMs ?? liveScoreboardPushDebounceMs();
  const prefix = opts.channelPrefix;

  const sb = createBrowserSupabaseClient();
  if (!sb) return () => {};

  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  const schedule = () => {
    if (timeoutId != null) clearTimeout(timeoutId);
    timeoutId = setTimeout(() => {
      timeoutId = null;
      onUpdate();
    }, debounceMs);
  };

  const ch = sb
    .channel(`${prefix}:${id}`)
    .on(
      "postgres_changes",
      {
        event: "*",
        schema: "public",
        table: "league_live_scoreboard",
        filter: `league_id=eq.${id}`
      },
      () => schedule()
    )
    .subscribe();

  return () => {
    if (timeoutId != null) clearTimeout(timeoutId);
    void sb.removeChannel(ch);
  };
}
