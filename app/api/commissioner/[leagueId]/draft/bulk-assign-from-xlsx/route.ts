import { NextResponse } from "next/server";
import { createSupabaseAdminClientSafe } from "@/lib/supabase/admin";
import { resolveLeagueFromCommissionerParam } from "@/lib/commissioner/resolve-league";
import { requireLeagueOfficer } from "@/lib/commissioner/require-league-officer";
import { bulkAssignSnakeDraft } from "@/lib/commissioner/bulk-assign-rosters";
import { parseDraftBulkAssignWorkbook } from "@/lib/commissioner/draft-bulk-assign-excel";
import { captureLeagueOriginalProjectionsIfNeeded } from "@/lib/projections";
import { persistLeagueLiveScoreboard } from "@/lib/scoring/persist-league-scoreboard";

export const runtime = "nodejs";

const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;

export async function POST(req: Request, { params }: { params: Promise<{ leagueId: string }> }) {
  const { leagueId } = await params;
  if (!leagueId) {
    return NextResponse.json({ error: "leagueId required" }, { status: 400 });
  }

  const supabase = createSupabaseAdminClientSafe();
  if (!supabase) {
    return NextResponse.json({ error: "Supabase not configured" }, { status: 503 });
  }

  const resolved = await resolveLeagueFromCommissionerParam(supabase, leagueId);
  if (!resolved.ok) {
    return NextResponse.json({ error: resolved.error }, { status: resolved.status });
  }
  const canonicalId = resolved.league.id;

  const officer = await requireLeagueOfficer(req, supabase, canonicalId);
  if (!officer.ok) {
    return NextResponse.json({ error: officer.error }, { status: officer.status });
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "Expected multipart form data with a file field." }, { status: 400 });
  }

  const file = form.get("file");
  if (!file || typeof (file as Blob).arrayBuffer !== "function") {
    return NextResponse.json({ error: 'Missing file: use field name "file".' }, { status: 400 });
  }

  const blob = file as File;
  if (blob.size > MAX_UPLOAD_BYTES) {
    return NextResponse.json({ error: "File too large (max 8 MB)." }, { status: 400 });
  }

  const ab = await blob.arrayBuffer();
  const parsed = await parseDraftBulkAssignWorkbook(Buffer.from(ab));
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }

  const { data: draftRoom } = await supabase
    .from("draft_rooms")
    .select("draft_order, total_rounds")
    .eq("league_id", canonicalId)
    .maybeSingle();
  if (!draftRoom) {
    return NextResponse.json({ error: "Draft room not found." }, { status: 404 });
  }

  const draftOrder = (draftRoom.draft_order ?? []) as string[];
  const totalRounds = Math.max(1, Math.min(32, Number(draftRoom.total_rounds ?? 6) || 6));
  const expected = new Set(draftOrder);
  const got = new Set(Object.keys(parsed.assignments));

  if (got.size !== expected.size || ![...expected].every((id) => got.has(id))) {
    return NextResponse.json(
      {
        error:
          "Roster rows must match the league draft order exactly (same league_team_id set as the template). Re-download the template after draft order changes."
      },
      { status: 400 }
    );
  }

  for (const id of draftOrder) {
    const list = parsed.assignments[id];
    if (!list || list.length !== totalRounds) {
      return NextResponse.json(
        {
          error: `Team ${id.slice(0, 8)}…: expected ${totalRounds} player id columns (round_1 … round_${totalRounds}), got ${list?.length ?? 0}.`
        },
        { status: 400 }
      );
    }
  }

  try {
    const { picksInserted } = await bulkAssignSnakeDraft({
      supabase,
      leagueId: canonicalId,
      assignments: parsed.assignments
    });
    try {
      await captureLeagueOriginalProjectionsIfNeeded(supabase, canonicalId);
    } catch {
      /* optional */
    }
    try {
      await persistLeagueLiveScoreboard(supabase, canonicalId);
    } catch {
      /* optional */
    }
    return NextResponse.json({ status: "ok", picksInserted });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 400 });
  }
}
