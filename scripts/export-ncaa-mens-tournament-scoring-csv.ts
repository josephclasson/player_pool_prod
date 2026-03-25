/**
 * Export NCAA Division I men's tournament player scoring (2013–present) to CSV for Google Sheets.
 *
 * Data sources (same family as the app):
 * - Bracket + game metadata: https://ncaa-api.henrygd.me/brackets/basketball-men/d1/{year}
 * - Box scores (when supported): https://ncaa-api.henrygd.me/game/{contestId}/boxscore
 * - Fallback player lines: ESPN scoreboard + summary (public site.api.espn.com)
 *
 * R1–R6 = Round of 64 → national championship (First Four excluded). Season PPG is left blank
 * (ESPN roster/stats endpoints are inconsistent for historical seasons); merge from another source if needed.
 *
 * Usage:
 *   npx ts-node --project tsconfig.scripts.json scripts/export-ncaa-mens-tournament-scoring-csv.ts
 *   npx ts-node --project tsconfig.scripts.json scripts/export-ncaa-mens-tournament-scoring-csv.ts --from 2015 --to 2024 --out data/ncaa-mens-tournament-scoring.csv
 */

/* eslint-disable no-console */

type BracketTeam = {
  seoname?: string;
  seed?: number | null;
  nameShort?: string | null;
  nameFull?: string | null;
};

type BracketGame = {
  contestId: number;
  bracketPositionId: number;
  sectionId?: number | null;
  startDate?: string | null;
  teams?: BracketTeam[];
};

const UA = "player-pool/export-ncaa-mens-tournament-scoring-csv";

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchJson(url: string): Promise<any> {
  const resp = await fetch(url, {
    headers: { Accept: "application/json", "User-Agent": UA }
  });
  if (!resp.ok) throw new Error(`${url} -> HTTP ${resp.status}`);
  return resp.json();
}

function sectionIdToRegion(sectionId: number | null | undefined): string {
  switch (sectionId) {
    case 2:
      return "East";
    case 5:
      return "Midwest";
    case 4:
      return "South";
    case 3:
      return "West";
    default:
      return "";
  }
}

function isFirstFourBracketGame(bracketPositionId: number): boolean {
  return Math.floor(bracketPositionId / 100) === 1;
}

/** 0..5 => R1..R6 (round of 64 .. championship). */
function roundIndexFromBracketPositionId(bracketPositionId: number): number | null {
  const bucket = Math.floor(bracketPositionId / 100);
  if (bucket < 2 || bucket > 7) return null;
  return bucket - 2;
}

function parseBracketStartToYyyymmdd(startDate: string | null | undefined): string | null {
  if (!startDate || !/^\d{2}\/\d{2}\/\d{4}$/.test(startDate.trim())) return null;
  const [mm, dd, yyyy] = startDate.trim().split("/");
  return `${yyyy}${mm.padStart(2, "0")}${dd.padStart(2, "0")}`;
}

function norm(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function teamRoughMatch(hg: BracketTeam, espnLocation: string, espnMascot: string): boolean {
  const short = String(hg.nameShort ?? "").trim();
  const full = String(hg.nameFull ?? "").trim();
  const blob = norm([short, full].filter(Boolean).join(" "));
  const loc = norm(espnLocation);
  const mascot = norm(espnMascot);
  const combined = `${loc} ${mascot}`;

  if (!blob || !loc) return false;

  const shortNorm = norm(short);
  if (shortNorm.length >= 3 && (loc === shortNorm || loc.startsWith(shortNorm) || shortNorm.startsWith(loc)))
    return true;

  const tokens = blob.split(" ").filter((t) => t.length >= 3);
  for (const t of tokens) {
    if (loc.includes(t) || combined.includes(t) || t.includes(loc)) return true;
  }

  const firstWord = full.split(/[\s,]+/)[0];
  if (firstWord && firstWord.length >= 4 && norm(firstWord) === loc) return true;

  return false;
}

function csvEscape(cell: string | number): string {
  const s = String(cell);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

type PlayerAgg = {
  tournamentYear: number;
  playerName: string;
  team: string;
  teamSeo: string;
  position: string;
  region: string;
  seed: number | "";
  seasonPpg: string;
  r: [number, number, number, number, number, number];
};

function makeKey(tournamentYear: number, teamSeo: string, playerName: string) {
  return `${tournamentYear}|${teamSeo}|${norm(playerName)}`;
}

const scoreboardCache = new Map<string, any>();

async function getScoreboardYmd(ymd: string): Promise<any> {
  if (scoreboardCache.has(ymd)) return scoreboardCache.get(ymd);
  await sleep(250);
  const url = `https://site.api.espn.com/apis/site/v2/sports/basketball/mens-college-basketball/scoreboard?dates=${ymd}&limit=400`;
  const j = await fetchJson(url);
  scoreboardCache.set(ymd, j);
  return j;
}

function findEspnEventForBracketGame(game: BracketGame, ymd: string): { id: string } | null {
  const teams = game.teams ?? [];
  if (teams.length < 2) return null;
  const [a, b] = teams;
  const j = scoreboardCache.get(ymd);
  const events = (j?.events ?? []) as any[];
  const hits: string[] = [];
  for (const ev of events) {
    const comp = ev?.competitions?.[0];
    const comps = comp?.competitors ?? [];
    if (comps.length < 2) continue;
    const h = comps.find((x: any) => x.homeAway === "home");
    const aw = comps.find((x: any) => x.homeAway === "away");
    if (!h?.team || !aw?.team) continue;
    const pairs = [
      [h.team, aw.team],
      [aw.team, h.team]
    ] as const;
    for (const [t1, t2] of pairs) {
      const loc1 = String(t1.location ?? "");
      const nm1 = String(t1.name ?? "");
      const loc2 = String(t2.location ?? "");
      const nm2 = String(t2.name ?? "");
      if (teamRoughMatch(a, loc1, nm1) && teamRoughMatch(b, loc2, nm2)) {
        hits.push(String(ev.id));
        break;
      }
    }
  }
  if (hits.length === 1) return { id: hits[0]! };
  if (hits.length > 1) {
    console.warn(`  ambiguous ESPN match on ${ymd} contestIds=${hits.join(",")} — skipped`);
  }
  return null;
}

function pointsIndexFromEspnStatKeys(keys: string[]): number {
  const idx = keys.findIndex((k) => k === "points");
  return idx >= 0 ? idx : 1;
}

async function ingestFromEspnSummary(
  tournamentYear: number,
  eventId: string,
  roundIdx: number,
  teamBySeo: Map<string, BracketTeam & { region: string }>,
  agg: Map<string, PlayerAgg>
) {
  await sleep(250);
  const url = `https://site.api.espn.com/apis/site/v2/sports/basketball/mens-college-basketball/summary?event=${encodeURIComponent(eventId)}`;
  const summary = await fetchJson(url);
  const sides = (summary?.boxscore?.players ?? []) as any[];
  for (const side of sides) {
    const teamInfo = side?.team;
    const espnTeamId = String(teamInfo?.id ?? "");
    const displayName = String(teamInfo?.displayName ?? teamInfo?.shortDisplayName ?? "");
    const statsBlock = side?.statistics?.[0];
    if (!statsBlock?.keys || !statsBlock?.athletes) continue;
    const keys = statsBlock.keys as string[];
    const pi = pointsIndexFromEspnStatKeys(keys);

    let matchedSeo: string | null = null;
    for (const [seo, meta] of teamBySeo) {
      const blob = norm([meta.nameShort, meta.nameFull, displayName].filter(Boolean).join(" "));
      const short = norm(String(meta.nameShort ?? ""));
      const locFromEspn = norm(String(teamInfo?.location ?? ""));
      if (
        short &&
        (locFromEspn === short || locFromEspn.startsWith(short) || blob.includes(locFromEspn))
      ) {
        matchedSeo = seo;
        break;
      }
    }
    if (!matchedSeo) {
      for (const [seo, meta] of teamBySeo) {
        if (teamRoughMatch(meta, String(teamInfo?.location ?? ""), String(teamInfo?.name ?? ""))) {
          matchedSeo = seo;
          break;
        }
      }
    }
    if (!matchedSeo) continue;

    const meta = teamBySeo.get(matchedSeo)!;
    const teamLabel = String(meta.nameFull ?? meta.nameShort ?? matchedSeo).trim();
    const region = meta.region;
    const seedNum = typeof meta.seed === "number" && meta.seed >= 1 && meta.seed <= 16 ? meta.seed : "";

    for (const row of statsBlock.athletes as any[]) {
      const ath = row?.athlete;
      if (!ath?.displayName) continue;
      const stats = row?.stats as string[] | undefined;
      if (!stats || stats.length <= pi) continue;
      const minStr = String(stats[0] ?? "");
      if (minStr === "0" || minStr === "") continue;
      const pts = Number(stats[pi]);
      if (!Number.isFinite(pts) || pts < 0) continue;
      const pos = String(ath?.position?.abbreviation ?? ath?.position?.type ?? "").trim();
      const name = String(ath.displayName).trim();
      const key = makeKey(tournamentYear, matchedSeo, name);
      let p = agg.get(key);
      if (!p) {
        p = {
          tournamentYear,
          playerName: name,
          team: teamLabel,
          teamSeo: matchedSeo,
          position: pos,
          region,
          seed: seedNum,
          seasonPpg: "",
          r: [0, 0, 0, 0, 0, 0]
        };
        agg.set(key, p);
      }
      p.r[roundIdx] += pts;
      if (pos && !p.position) p.position = pos;
    }
  }
}

async function tryHenrygdBoxscore(contestId: number): Promise<any | null> {
  if (contestId < 999_999) return null;
  await sleep(200);
  try {
    const url = `https://ncaa-api.henrygd.me/game/${contestId}/boxscore`;
    const resp = await fetch(url, {
      headers: { Accept: "application/json", "User-Agent": UA }
    });
    if (!resp.ok) return null;
    const json = await resp.json();
    if (json?.type === "validation" || !Array.isArray(json?.teamBoxscore)) return null;
    return json;
  } catch {
    return null;
  }
}

function ingestFromHenrygdBoxscore(
  tournamentYear: number,
  roundIdx: number,
  box: any,
  teamBySeo: Map<string, BracketTeam & { region: string }>,
  agg: Map<string, PlayerAgg>
) {
  const teamsArr = (box?.teams ?? []) as any[];
  const teamIdToSeo = new Map<number, string>();
  for (const t of teamsArr) {
    const id = Number(t.teamId);
    const seo = String(t.seoname ?? "").trim();
    if (Number.isFinite(id) && seo) teamIdToSeo.set(id, seo);
  }

  const teamBox = (box?.teamBoxscore ?? []) as any[];
  for (const tb of teamBox) {
    const tid = Number(tb.teamId);
    const seo = teamIdToSeo.get(tid);
    if (!seo || !teamBySeo.has(seo)) continue;
    const meta = teamBySeo.get(seo)!;
    const teamLabel = String(meta.nameFull ?? meta.nameShort ?? seo).trim();
    const region = meta.region;
    const seedNum = typeof meta.seed === "number" && meta.seed >= 1 && meta.seed <= 16 ? meta.seed : "";

    const players = (tb.playerStats ?? []) as any[];
    for (const pl of players) {
      const min = String(pl.minutesPlayed ?? "0").trim();
      if (min === "0" || min === "") continue;
      const pts = Number(pl.points ?? 0);
      if (!Number.isFinite(pts)) continue;
      const fn = String(pl.firstName ?? "").trim();
      const ln = String(pl.lastName ?? "").trim();
      const name = [fn, ln].filter(Boolean).join(" ").trim();
      if (!name) continue;
      const pos = String(pl.position ?? "").trim();
      const key = makeKey(tournamentYear, seo, name);
      let p = agg.get(key);
      if (!p) {
        p = {
          tournamentYear,
          playerName: name,
          team: teamLabel,
          teamSeo: seo,
          position: pos,
          region,
          seed: seedNum,
          seasonPpg: "",
          r: [0, 0, 0, 0, 0, 0]
        };
        agg.set(key, p);
      }
      p.r[roundIdx] += pts;
      if (pos && !p.position) p.position = pos;
    }
  }
}

function buildTeamRegionMap(games: BracketGame[]): Map<string, string> {
  const regionBySeo = new Map<string, string>();
  const ordered = [...games].sort((a, b) => a.bracketPositionId - b.bracketPositionId);
  for (const g of ordered) {
    const sid = g.sectionId;
    const reg = sectionIdToRegion(sid ?? undefined);
    if (!reg) continue;
    for (const t of g.teams ?? []) {
      const seo = String(t.seoname ?? "").trim();
      if (seo && !regionBySeo.has(seo)) regionBySeo.set(seo, reg);
    }
  }
  return regionBySeo;
}

function parseArgs() {
  const argv = process.argv.slice(2);
  let from = 2013;
  let to = new Date().getFullYear();
  let out = "data/ncaa-mens-tournament-player-scoring.csv";
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--from") from = Number(argv[++i]);
    else if (argv[i] === "--to") to = Number(argv[++i]);
    else if (argv[i] === "--out") out = argv[++i] ?? out;
  }
  return { from, to, out };
}

async function main() {
  const { from, to, out } = parseArgs();
  const fs = await import("node:fs/promises");
  const path = await import("node:path");

  const agg = new Map<string, PlayerAgg>();

  for (let tournamentYear = from; tournamentYear <= to; tournamentYear++) {
    if (tournamentYear === 2020) {
      console.log(`${tournamentYear}: skipped (tournament cancelled — no official bracket completion).`);
      continue;
    }

    console.log(`Tournament ${tournamentYear}…`);
    let payload: any;
    try {
      payload = await fetchJson(
        `https://ncaa-api.henrygd.me/brackets/basketball-men/d1/${tournamentYear}`
      );
    } catch (e) {
      console.warn(`  bracket fetch failed: ${e}`);
      continue;
    }

    const games = (payload?.championships?.[0]?.games ?? []) as any[];
    const bracketGames: BracketGame[] = games.map((g) => ({
      contestId: Number(g.contestId),
      bracketPositionId: Number(g.bracketPositionId),
      sectionId: g.sectionId ?? null,
      startDate: g.startDate != null ? String(g.startDate) : null,
      teams: (g.teams ?? []) as BracketTeam[]
    }));

    const regionBySeo = buildTeamRegionMap(bracketGames);
    const teamBySeo = new Map<string, BracketTeam & { region: string }>();
    for (const g of bracketGames) {
      for (const t of g.teams ?? []) {
        const seo = String(t.seoname ?? "").trim();
        if (!seo || teamBySeo.has(seo)) continue;
        teamBySeo.set(seo, {
          ...t,
          region: regionBySeo.get(seo) ?? ""
        });
      }
    }

    let hgOk = 0;
    let espnOk = 0;
    let missed = 0;

    for (const g of bracketGames) {
      if (isFirstFourBracketGame(g.bracketPositionId)) continue;
      const roundIdx = roundIndexFromBracketPositionId(g.bracketPositionId);
      if (roundIdx === null) continue;

      const ymd = parseBracketStartToYyyymmdd(g.startDate ?? undefined);
      let usedHenrygd = false;

      const box = await tryHenrygdBoxscore(g.contestId);
      if (box && box.teamBoxscore) {
        ingestFromHenrygdBoxscore(tournamentYear, roundIdx, box, teamBySeo, agg);
        usedHenrygd = true;
        hgOk++;
      } else if (ymd) {
        await getScoreboardYmd(ymd);
        let ev = findEspnEventForBracketGame(g, ymd);
        if (!ev) {
          const d = new Date(
            Number(ymd.slice(0, 4)),
            Number(ymd.slice(4, 6)) - 1,
            Number(ymd.slice(6, 8))
          );
          d.setDate(d.getDate() - 1);
          const alt = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
          await getScoreboardYmd(alt);
          ev = findEspnEventForBracketGame(g, alt);
        }
        if (ev) {
          try {
            await ingestFromEspnSummary(tournamentYear, ev.id, roundIdx, teamBySeo, agg);
            espnOk++;
          } catch {
            missed++;
          }
        } else missed++;
      } else missed++;
    }

    console.log(`  henrygd boxscores: ${hgOk}, ESPN fallbacks: ${espnOk}, missed: ${missed}`);
  }

  const rows = [...agg.values()].sort((a, b) => {
    if (a.tournamentYear !== b.tournamentYear) return a.tournamentYear - b.tournamentYear;
    if (a.team !== b.team) return a.team.localeCompare(b.team);
    return a.playerName.localeCompare(b.playerName);
  });

  const header = [
    "Year",
    "Player Name",
    "Team",
    "Position",
    "Region",
    "Seed",
    "Season PPG",
    "R1",
    "R2",
    "R3",
    "R4",
    "R5",
    "R6",
    "Total"
  ];

  const lines = [header.join(",")];
  for (const p of rows) {
    const [r1, r2, r3, r4, r5, r6] = p.r;
    const total = r1 + r2 + r3 + r4 + r5 + r6;
    lines.push(
      [
        p.tournamentYear,
        csvEscape(p.playerName),
        csvEscape(p.team),
        csvEscape(p.position),
        csvEscape(p.region),
        p.seed === "" ? "" : p.seed,
        csvEscape(p.seasonPpg),
        r1,
        r2,
        r3,
        r4,
        r5,
        r6,
        total
      ].join(",")
    );
  }

  const bom = "\uFEFF";
  const target = path.isAbsolute(out) ? out : path.join(process.cwd(), out);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, bom + lines.join("\n"), "utf8");
  console.log(`Wrote ${rows.length} rows -> ${target}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
