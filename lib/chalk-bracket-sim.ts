export type ChalkTeamMeta = {
  teamId: number;
  overallSeed: number | null;
  regionalSeed: number | null;
};

type BracketTeam = {
  seoname?: string;
  seed?: number | null;
};

type BracketGame = {
  bracketPositionId: number;
  victorBracketPositionId: number | null;
  teams?: BracketTeam[];
};

type BracketPayload = {
  championships?: Array<{
    games?: BracketGame[];
  }>;
};

function chalkFavoriteTeamId(
  teamAId: number,
  teamBId: number,
  metaByTeamId: Map<number, ChalkTeamMeta>
) {
  const a = metaByTeamId.get(teamAId);
  const b = metaByTeamId.get(teamBId);
  const oa = a?.overallSeed != null && a.overallSeed > 0 ? a.overallSeed : null;
  const ob = b?.overallSeed != null && b.overallSeed > 0 ? b.overallSeed : null;
  if (oa != null && ob != null && oa !== ob) return oa < ob ? teamAId : teamBId;

  const ra = a?.regionalSeed != null && a.regionalSeed > 0 ? a.regionalSeed : null;
  const rb = b?.regionalSeed != null && b.regionalSeed > 0 ? b.regionalSeed : null;
  if (ra != null && rb != null && ra !== rb) return ra < rb ? teamAId : teamBId;

  return teamAId < teamBId ? teamAId : teamBId;
}

function roundNumberFromBracketPositionId(bracketPositionId: number) {
  return Math.floor(bracketPositionId / 100); // 1..7 for NCAA
}

/**
 * henrygd bracket: `bracketPositionId` 101–199 are First Four (sectionId 1 / "FIRST FOUR").
 * Fantasy scoring excludes those games (DB `games.round` 0); chalk counts must match for original projection.
 */
function isFirstFourBracketGame(bracketPositionId: number): boolean {
  return roundNumberFromBracketPositionId(bracketPositionId) === 1;
}

const CACHE_KEY = "__chalkBracketExpectedGamesPlayedByTeam__";

function getCache() {
  const g = globalThis as any;
  if (!g[CACHE_KEY]) g[CACHE_KEY] = new Map<string, { computedAt: number; byTeamId: Map<number, number> }>();
  return g[CACHE_KEY] as Map<string, { computedAt: number; byTeamId: Map<number, number> }>;
}

function serializeExpectedGamesKey(seasonYear: number) {
  return `${seasonYear}:excl_first_four_v1`;
}

/**
 * Expected chalk games played under “no upsets” (better 1–68 `overall_seed` wins each game).
 *
 * **First Four** (`bracketPositionId` 101–199) is excluded from the count so this matches fantasy
 * R1–R6 (round of 64 through championship). Winners who played a play-in game are still credited
 * only from the round of 64 onward — e.g. max 6 games to a title, same as a 1-seed.
 *
 * Used for original / live projection chalk totals (`playerTournamentProjectionsCore`).
 */
export async function computeExpectedChalkGamesPlayedFromBracket(opts: {
  seasonYear: number;
  /** Map by `teams.id` */
  metaByTeamId: Map<number, ChalkTeamMeta>;
  /** Map from `teams.external_team_id` (i.e. `${seoname}-${seasonYear}`) -> `teams.id` */
  teamIdByExternalTeamId: Map<string, number>;
}): Promise<Map<number, number>> {
  const { seasonYear, metaByTeamId, teamIdByExternalTeamId } = opts;
  const cacheKey = serializeExpectedGamesKey(seasonYear);
  const cache = getCache();
  const cached = cache.get(cacheKey);
  const TTL_MS = 6 * 60 * 60 * 1000;
  if (cached && Date.now() - cached.computedAt < TTL_MS) return cached.byTeamId;

  const url = `https://ncaa-api.henrygd.me/brackets/basketball-men/d1/${seasonYear}`;
  const resp = await fetch(url, {
    headers: { Accept: "application/json", "User-Agent": "player-pool/chalk-bracket-sim" }
  });
  if (!resp.ok) {
    throw new Error(`Bracket fetch failed: ${resp.status}`);
  }

  const payload = (await resp.json()) as BracketPayload;
  const champ = payload?.championships?.[0];
  const games = (champ?.games ?? []) as BracketGame[];
  if (games.length === 0) return new Map<number, number>();

  const gameByBracketPos = new Map<number, BracketGame>(games.map((g) => [g.bracketPositionId, g]));

  // victorBracketPositionId -> games that feed into that next-round game.
  const feedersByVictorPos = new Map<number, BracketGame[]>();
  for (const g of games) {
    if (g.victorBracketPositionId == null) continue;
    const arr = feedersByVictorPos.get(g.victorBracketPositionId) ?? [];
    arr.push(g);
    feedersByVictorPos.set(g.victorBracketPositionId, arr);
  }

  const winnerByBracketPos = new Map<number, number | null>();

  function resolveParticipantsForGame(game: BracketGame): [number | null, number | null] {
    const teams = game.teams ?? [];
    if (teams.length >= 2) {
      const t0 = teams[0]?.seoname ? `${teams[0].seoname}-${seasonYear}` : null;
      const t1 = teams[1]?.seoname ? `${teams[1].seoname}-${seasonYear}` : null;
      const id0 = t0 ? teamIdByExternalTeamId.get(t0) ?? null : null;
      const id1 = t1 ? teamIdByExternalTeamId.get(t1) ?? null : null;
      return [id0, id1];
    }

    const feeders = feedersByVictorPos.get(game.bracketPositionId) ?? [];
    if (feeders.length < 2) return [null, null];

    const w0 = resolveWinnerByBracketPos(feeders[0].bracketPositionId);
    const w1 = resolveWinnerByBracketPos(feeders[1].bracketPositionId);
    return [w0, w1];
  }

  function resolveWinnerByBracketPos(bracketPositionId: number): number | null {
    if (winnerByBracketPos.has(bracketPositionId)) return winnerByBracketPos.get(bracketPositionId) ?? null;
    const game = gameByBracketPos.get(bracketPositionId);
    if (!game) {
      winnerByBracketPos.set(bracketPositionId, null);
      return null;
    }

    const [a, b] = resolveParticipantsForGame(game);
    if (a == null || b == null) {
      winnerByBracketPos.set(bracketPositionId, null);
      return null;
    }

    const winner = chalkFavoriteTeamId(a, b, metaByTeamId);
    winnerByBracketPos.set(bracketPositionId, winner);
    return winner;
  }

  // Pre-resolve winners for all games so participant computation can recurse.
  const positions = Array.from(gameByBracketPos.keys());
  positions.sort((x, y) => roundNumberFromBracketPositionId(x) - roundNumberFromBracketPositionId(y));
  for (const pos of positions) resolveWinnerByBracketPos(pos);

  const gamesPlayedByTeamId = new Map<number, number>();

  // Count games played under chalk (fantasy-relevant rounds only — skip First Four).
  for (const game of games) {
    if (isFirstFourBracketGame(game.bracketPositionId)) continue;
    const [a, b] = resolveParticipantsForGame(game);
    if (a == null || b == null) continue;
    gamesPlayedByTeamId.set(a, (gamesPlayedByTeamId.get(a) ?? 0) + 1);
    if (b !== a) gamesPlayedByTeamId.set(b, (gamesPlayedByTeamId.get(b) ?? 0) + 1);
  }

  cache.set(cacheKey, { computedAt: Date.now(), byTeamId: gamesPlayedByTeamId });
  return gamesPlayedByTeamId;
}

