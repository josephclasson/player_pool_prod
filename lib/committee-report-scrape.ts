import { load } from "cheerio";
import type { OfficialSeedEntry } from "@/lib/official-seeds";

/**
 * Fetch + parse CBS/SI articles that publish the NCAA committee **1–68 S-curve** order
 * (`teams.overall_seed`). This is the commissioner “Apply seeds from CBS/SI article” path.
 *
 * **Year-over-year:** Each tournament, paste the current article URL that lists all 68 teams
 * numbered `1.` … `68.` (same article shape as SI’s “official 1–68 seed rankings” posts, e.g.
 * `https://www.si.com/college-basketball/.../official-1-68-seed-rankings-...`). Optionally
 * send `seasonYear` in `POST /api/commissioner/.../official-seeds` when it differs from the league’s row.
 */
const MAX_HTML_BYTES = 5_000_000;

let lastCommitteeScrapeMs = 0;
const MIN_COMMITTEE_SCRAPE_INTERVAL_MS = 60_000;

export function assertCommitteeScrapeRateLimit(): void {
  const now = Date.now();
  if (now - lastCommitteeScrapeMs < MIN_COMMITTEE_SCRAPE_INTERVAL_MS) {
    throw new Error(
      `Rate limit: wait ${Math.ceil(
        (MIN_COMMITTEE_SCRAPE_INTERVAL_MS - (now - lastCommitteeScrapeMs)) / 1000
      )}s between committee article scrapes`
    );
  }
  lastCommitteeScrapeMs = now;
}

/** Hostnames allowed for server-side fetch (SSRF guard). */
const ALLOWED_COMMITTEE_HOSTS = new Set([
  "www.cbssports.com",
  "cbssports.com",
  "www.si.com",
  "si.com"
]);

export function isAllowedCommitteeReportUrl(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return false;
  }
  if (u.protocol !== "https:") return false;
  return ALLOWED_COMMITTEE_HOSTS.has(u.hostname.toLowerCase());
}

export function cleanCommitteeTeamLine(raw: string): string {
  let s = raw.replace(/\s+/g, " ").trim();
  const stop = s.split(/\s+(?:Read more|Next:|Previous:|Join the conversation)/i)[0];
  s = (stop ?? s).trim();

  // "Duke (32–2), ACC champion" / "Prairie View (18–17), SWAC champion, First Four"
  const beforeComma = s.split(",")[0]?.trim() ?? s;
  s = beforeComma;

  // Win–loss in parentheses (ASCII hyphen or Unicode en/em dash). Not location lines like "(Fla.)".
  s = s.replace(/\s*\(\d+[\u2013\u2014-]\d+\)\s*/g, " ").trim();
  s = s.replace(/\s*\(\d+-\d+\)\s*/g, " ").trim();

  s = s.replace(/\s*\d+-\d+\s*$/, "").trim();
  s = s.replace(/[*†‡]\s*$/, "").trim();
  s = s.replace(/^[,.\s]+|[,.\s]+$/g, "").trim();
  return s;
}

/**
 * SI (and some CBS builds) concatenate list items with no space: "...champion2. Arizona".
 * Insert a newline before "N. " (N = 1–68) when glued to a letter or closing paren.
 */
export function insertNewlinesBeforeGluedSeedLines(text: string): string {
  return text.replace(
    /([\p{L}\)])(?=(?:[1-9]|[1-5][0-9]|6[0-8])\.(?:\s|\u00a0))/gu,
    "$1\n"
  );
}

function dedupeByRank(entries: OfficialSeedEntry[]): OfficialSeedEntry[] {
  const byRank = new Map<number, OfficialSeedEntry>();
  for (const e of entries) {
    if (!byRank.has(e.overallSeed)) byRank.set(e.overallSeed, e);
  }
  return Array.from(byRank.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([, e]) => e);
}

/** Line-based list: "1. UConn" or "1) Duke" per line. */
function extractNumberedSeedsLineByLine(text: string): OfficialSeedEntry[] {
  const entries: OfficialSeedEntry[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([1-9]|[1-5][0-9]|6[0-8])[.)]\s+(.+)$/);
    if (!m) continue;
    const rank = parseInt(m[1], 10);
    const name = cleanCommitteeTeamLine(m[2]);
    if (!name) continue;
    entries.push({ overallSeed: rank, displayName: name });
  }
  return dedupeByRank(entries);
}

/**
 * Pulls numbered 1–68 lines from article text (CBS/SI often use "1. Duke" or "1.Duke2.Arizona" blobs).
 */
export function extractNumberedSeedsFromText(text: string): OfficialSeedEntry[] {
  const normalized = text.replace(/\r\n/g, "\n");
  const entries: OfficialSeedEntry[] = [];
  const re = /(\d{1,2})\.\s*([\s\S]*?)(?=\d{1,2}\.|$)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(normalized)) !== null) {
    const rank = parseInt(m[1], 10);
    if (rank < 1 || rank > 68) continue;
    const name = cleanCommitteeTeamLine(m[2]);
    if (!name || name.length < 2) continue;
    entries.push({ overallSeed: rank, displayName: name });
  }

  const blob = dedupeByRank(entries);
  if (blob.length >= 60) return blob;

  const lines = extractNumberedSeedsLineByLine(normalized);
  return lines.length > blob.length ? lines : blob;
}

function articlePlainTextFromHtml(html: string): string {
  const $ = load(html);
  $("script, style, nav, header, footer, iframe, noscript, svg").remove();
  const selectors = [
    "[data-module='ArticleBody']",
    "[data-module='article-body']",
    ".duet--article--article-body-component",
    "article .Article-body",
    "article [class*='ArticleBody']",
    "article [class*='article-body']",
    "article .Article__Content",
    ".Article__Content",
    "article .paragraph",
    "article p",
    "article",
    "main",
    "[role='main']"
  ];
  for (const sel of selectors) {
    const el = $(sel).first();
    const t = el.text();
    if (t && t.replace(/\s+/g, " ").trim().length > 400) {
      return t;
    }
  }
  return $("body").text();
}

export type ScrapeCommitteeReportResult = {
  entries: OfficialSeedEntry[];
  sourceLabel: string;
  warnings: string[];
};

export async function scrapeCommitteeReportFromUrl(
  url: string,
  opts?: { skipRateLimit?: boolean }
): Promise<ScrapeCommitteeReportResult> {
  const trimmed = url.trim();
  if (!isAllowedCommitteeReportUrl(trimmed)) {
    throw new Error("URL must be https:// on cbssports.com or si.com");
  }
  if (!opts?.skipRateLimit) {
    assertCommitteeScrapeRateLimit();
  }

  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 30_000);
  let resp: Response;
  try {
    resp = await fetch(trimmed, {
      signal: ac.signal,
      redirect: "follow",
      headers: {
        Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36 player-pool/committee-seeds"
      }
    });
  } finally {
    clearTimeout(t);
  }

  if (!resp.ok) {
    throw new Error(`Committee article fetch failed: HTTP ${resp.status}`);
  }

  const buf = await resp.arrayBuffer();
  if (buf.byteLength > MAX_HTML_BYTES) {
    throw new Error(`Response too large (${buf.byteLength} bytes)`);
  }

  const html = new TextDecoder("utf-8").decode(buf);
  const plain = articlePlainTextFromHtml(html);
  const entries = extractNumberedSeedsFromText(plain);

  const warnings: string[] = [];
  if (entries.length < 68) {
    warnings.push(
      `Parsed ${entries.length} seeds (expected 68). Article layout may have changed — paste JSON manually or fix selectors.`
    );
  }

  let hostname = "unknown";
  try {
    hostname = new URL(trimmed).hostname;
  } catch {
    /* ignore */
  }

  return {
    entries,
    sourceLabel: `committee_scrape_${hostname.replace(/[^a-z0-9.-]/gi, "_")}`,
    warnings
  };
}
