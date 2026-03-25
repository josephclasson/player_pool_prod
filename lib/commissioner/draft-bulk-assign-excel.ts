import ExcelJS from "exceljs";

export const DRAFT_BULK_ASSIGN_SHEET_ROSTERS = "Rosters";
export const DRAFT_BULK_ASSIGN_SHEET_INSTRUCTIONS = "Instructions";
export const DRAFT_BULK_ASSIGN_SHEET_PLAYER_POOL = "Player_pool";

const HEADER_LEAGUE_TEAM_ID = "league_team_id";
const HEADER_SNAKE_ORDER = "snake_pick_order";
const HEADER_OWNER = "owner_display";

function roundHeader(round: number): string {
  return `round_${round}_player_id`;
}

function normalizeHeaderCell(v: unknown): string {
  return String(v ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_");
}

export type DraftBulkAssignTemplateTeamRow = {
  leagueTeamId: string;
  snakePickOrder: number;
  ownerDisplay: string;
};

export type DraftBulkAssignPlayerPoolRow = {
  playerId: number;
  playerName: string;
  collegeTeam: string;
  seasonPpg: number | null;
};

/**
 * Build the commissioner bulk-assign workbook: instructions, roster grid (fill player ids per round), optional pool reference.
 */
export async function buildDraftBulkAssignTemplateWorkbook(opts: {
  leagueLabel: string;
  totalRounds: number;
  teamRows: DraftBulkAssignTemplateTeamRow[];
  playerPool: DraftBulkAssignPlayerPoolRow[];
}): Promise<ArrayBuffer> {
  const { leagueLabel, totalRounds, teamRows, playerPool } = opts;
  if (totalRounds < 1 || totalRounds > 32) {
    throw new Error(`totalRounds out of range: ${totalRounds}`);
  }

  const wb = new ExcelJS.Workbook();
  wb.creator = "player-pool";
  wb.created = new Date();

  const inst = wb.addWorksheet(DRAFT_BULK_ASSIGN_SHEET_INSTRUCTIONS, {
    properties: { tabColor: { argb: "FF4472C4" } }
  });
  inst.getColumn(1).width = 92;
  const lines = [
    `League: ${leagueLabel}`,
    "",
    "1. Do not change league_team_id (UUID) — one row per fantasy team, in draft / snake order.",
    `2. Fill the yellow columns: ${roundHeader(1)} … ${roundHeader(totalRounds)} with integer player ids from the "${DRAFT_BULK_ASSIGN_SHEET_PLAYER_POOL}" sheet (or your records).`,
    "3. Each team must have exactly one player id per round column. No blanks.",
    "4. The same player id cannot appear twice anywhere in the grid.",
    "5. Save as .xlsx, then use Commissioner → Assign rosters from Excel. Snake order is applied server-side from your draft room; this grid is per-owner picks in round order (round 1 = first pick for that owner, etc.)."
  ];
  lines.forEach((line, i) => {
    inst.getCell(i + 1, 1).value = line;
    inst.getCell(i + 1, 1).alignment = { vertical: "top", wrapText: true };
  });

  const fillInput: ExcelJS.Fill = {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: "FFFFFFCC" }
  };

  const ws = wb.addWorksheet(DRAFT_BULK_ASSIGN_SHEET_ROSTERS, {
    properties: { tabColor: { argb: "FF70AD47" } }
  });

  const metaHeaders = [HEADER_LEAGUE_TEAM_ID, HEADER_SNAKE_ORDER, HEADER_OWNER];
  const roundHeaders = Array.from({ length: totalRounds }, (_, i) => roundHeader(i + 1));
  const allHeaders = [...metaHeaders, ...roundHeaders];

  const headerRow = ws.addRow(allHeaders);
  headerRow.font = { bold: true };
  headerRow.eachCell((cell, colNumber) => {
    cell.fill =
      colNumber <= metaHeaders.length
        ? { type: "pattern", pattern: "solid", fgColor: { argb: "FFD9D9D9" } }
        : fillInput;
  });

  for (const t of teamRows) {
    const row = ws.addRow([
      t.leagueTeamId,
      t.snakePickOrder,
      t.ownerDisplay,
      ...Array.from({ length: totalRounds }, () => "")
    ]);
    for (let c = 4; c <= 3 + totalRounds; c++) {
      row.getCell(c).fill = fillInput;
    }
  }

  allHeaders.forEach((_, i) => {
    const col = ws.getColumn(i + 1);
    col.width = i === 0 ? 40 : i === 2 ? 28 : i < 3 ? 12 : 18;
  });

  const pool = wb.addWorksheet(DRAFT_BULK_ASSIGN_SHEET_PLAYER_POOL, {
    properties: { tabColor: { argb: "FFFFC000" } }
  });
  pool.addRow(["player_id", "player_name", "college_team", "season_ppg"]);
  pool.getRow(1).font = { bold: true };
  for (const p of playerPool) {
    pool.addRow([p.playerId, p.playerName, p.collegeTeam, p.seasonPpg ?? ""]);
  }
  pool.columns = [{ width: 12 }, { width: 28 }, { width: 26 }, { width: 12 }];

  const buf = await wb.xlsx.writeBuffer();
  return buf as ArrayBuffer;
}

export type ParseDraftBulkAssignResult =
  | { ok: true; assignments: Record<string, number[]> }
  | { ok: false; error: string };

/**
 * Read Rosters sheet; expects header row with league_team_id and round_N_player_id columns.
 */
function unwrapExcelCellValue(v: unknown): unknown {
  if (v && typeof v === "object" && v !== null && "result" in v) {
    const r = (v as { result?: unknown }).result;
    if (r !== undefined && r !== null) return r;
  }
  return v;
}

export async function parseDraftBulkAssignWorkbook(buffer: Buffer | ArrayBuffer): Promise<ParseDraftBulkAssignResult> {
  const wb = new ExcelJS.Workbook();
  const nodeBuf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  // ExcelJS declares `load(buffer: Buffer)`; Node's `Buffer` is generic and does not assign to that parameter.
  await wb.xlsx.load(nodeBuf as never);

  const sheet =
    wb.getWorksheet(DRAFT_BULK_ASSIGN_SHEET_ROSTERS) ??
    wb.worksheets.find((w) => w.name.toLowerCase() === DRAFT_BULK_ASSIGN_SHEET_ROSTERS.toLowerCase()) ??
    wb.worksheets[0];

  if (!sheet) {
    return { ok: false, error: "Workbook has no worksheets." };
  }

  const headerRow = sheet.getRow(1);
  const colByHeader = new Map<string, number>();
  headerRow.eachCell({ includeEmpty: false }, (cell, colNumber) => {
    const key = normalizeHeaderCell(cell.value);
    if (key) colByHeader.set(key, colNumber);
  });

  const idCol = colByHeader.get(normalizeHeaderCell(HEADER_LEAGUE_TEAM_ID));
  if (!idCol) {
    return {
      ok: false,
      error: `Missing required column "${HEADER_LEAGUE_TEAM_ID}" in row 1 of sheet "${sheet.name}".`
    };
  }

  const roundCols: number[] = [];
  for (let r = 1; r <= 32; r++) {
    const h = normalizeHeaderCell(roundHeader(r));
    const c = colByHeader.get(h);
    if (c != null) roundCols.push(c);
    else break;
  }
  if (roundCols.length === 0) {
    return {
      ok: false,
      error: `No round columns found (expected ${roundHeader(1)}, ${roundHeader(2)}, …).`
    };
  }

  const uuidRe =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

  function cellToPositiveInt(cell: ExcelJS.Cell): number | null {
    const v = unwrapExcelCellValue(cell.value);
    if (v == null || v === "") return null;
    if (typeof v === "number" && Number.isFinite(v)) {
      const n = Math.trunc(v);
      return n > 0 ? n : null;
    }
    const s = String(v)
      .trim()
      .replace(/[, \u00A0]/g, "");
    if (!s) return null;
    const n = Math.trunc(Number(s));
    return Number.isFinite(n) && n > 0 ? n : null;
  }

  const assignments: Record<string, number[]> = {};

  for (let ri = 2; ri <= sheet.rowCount; ri++) {
    const row = sheet.getRow(ri);
    const idCell = row.getCell(idCol);
    const rawId = String(unwrapExcelCellValue(idCell.value) ?? "").trim();
    if (!rawId) continue;
    if (!uuidRe.test(rawId)) {
      return { ok: false, error: `Row ${ri}: invalid league_team_id "${rawId.slice(0, 48)}…".` };
    }

    const picks: number[] = [];
    for (const col of roundCols) {
      const pid = cellToPositiveInt(row.getCell(col));
      if (pid == null) {
        return {
          ok: false,
          error: `Row ${ri} (${rawId.slice(0, 8)}…): missing or invalid player id in column ${col}.`
        };
      }
      picks.push(pid);
    }
    if (assignments[rawId]) {
      return { ok: false, error: `Duplicate league_team_id row for ${rawId.slice(0, 8)}….` };
    }
    assignments[rawId] = picks;
  }

  if (Object.keys(assignments).length === 0) {
    return { ok: false, error: "No data rows with league_team_id found under the header." };
  }

  return { ok: true, assignments };
}
