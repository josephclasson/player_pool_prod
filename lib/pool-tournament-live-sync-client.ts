"use client";

import { createBrowserSupabaseClient } from "@/lib/supabase/browser";
import {
  PLAYER_POOL_LEAGUE_TEAM_ID_HEADER,
  readCommissionerSecretFromSession,
  readPlayerPoolSession
} from "@/lib/player-pool-session";

let tokenCache: { token: string | null; checkedAt: number } = { token: null, checkedAt: 0 };

async function readOptionalSupabaseAccessToken(): Promise<string | null> {
  const now = Date.now();
  if (now - tokenCache.checkedAt < 60_000) return tokenCache.token;
  const sb = createBrowserSupabaseClient();
  const { data: sess } = sb != null ? await sb.auth.getSession() : { data: { session: null } };
  const token = sess?.session?.access_token ?? null;
  tokenCache = { token, checkedAt: now };
  return token;
}

/**
 * POST /api/stat-tracker/:leagueId/live-sync — henrygd scoreboard + R1–R6 box-score backfill + projections.
 * Sends pool session / commissioner headers so sync works without Supabase login when a valid `league_teams` id is known.
 */
export async function postStatTrackerLiveSync(
  leagueId: string,
  opts?: { force?: boolean; fallbackLeagueTeamId?: string | null }
): Promise<unknown> {
  const headers: Record<string, string> = { Accept: "application/json" };
  const token = await readOptionalSupabaseAccessToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  const pool = readPlayerPoolSession();
  const fallbackTeamId = opts?.fallbackLeagueTeamId != null ? String(opts.fallbackLeagueTeamId).trim() : "";
  const leagueTeamId = pool?.leagueTeamId?.trim() || fallbackTeamId;
  if (leagueTeamId) headers[PLAYER_POOL_LEAGUE_TEAM_ID_HEADER] = leagueTeamId;
  const comm = readCommissionerSecretFromSession();
  if (comm) headers["x-player-pool-commissioner-secret"] = comm;
  const qs = opts?.force === true ? "?force=1" : "";
  const res = await fetch(`/api/stat-tracker/${encodeURIComponent(leagueId)}/live-sync${qs}`, {
    method: "POST",
    cache: "no-store",
    headers
  });
  const json = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) {
    throw new Error(json.error ?? `Live sync failed: ${res.status}`);
  }
  return json;
}
