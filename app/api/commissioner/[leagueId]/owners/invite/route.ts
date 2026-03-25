import { NextResponse } from "next/server";
import { z } from "zod";
import { createSupabaseAdminClientSafe } from "@/lib/supabase/admin";
import { resolveLeagueFromCommissionerParam } from "@/lib/commissioner/resolve-league";
import { requireLeagueOfficer } from "@/lib/commissioner/require-league-officer";
import { inviteLeagueOwners } from "@/lib/commissioner/invite-league-owners";

const ownerRow = z.object({
  fullName: z.string().min(1).max(80),
  username: z.string().min(2).max(24),
  email: z.string().email().max(120)
});

const bodySchema = z.object({
  owners: z.array(ownerRow).min(1).max(24)
});

function appBaseUrlFromRequest(req: Request) {
  const env = process.env.NEXT_PUBLIC_SITE_URL?.trim();
  if (env) return env.replace(/\/$/, "");
  const origin = req.headers.get("origin")?.trim();
  if (origin) return origin.replace(/\/$/, "");
  const host = req.headers.get("host");
  if (host) {
    const proto = host.includes("localhost") ? "http" : "https";
    return `${proto}://${host}`.replace(/\/$/, "");
  }
  return "http://localhost:3000";
}

export async function POST(req: Request, { params }: { params: Promise<{ leagueId: string }> }) {
  const { leagueId } = await params;
  if (!leagueId) return NextResponse.json({ error: "leagueId required" }, { status: 400 });

  const supabase = createSupabaseAdminClientSafe();
  if (!supabase) {
    return NextResponse.json({ error: "Supabase not configured" }, { status: 503 });
  }

  const resolved = await resolveLeagueFromCommissionerParam(supabase, leagueId);
  if (!resolved.ok) {
    return NextResponse.json({ error: resolved.error }, { status: resolved.status });
  }
  const id = resolved.league.id;

  const officer = await requireLeagueOfficer(req, supabase, id);
  if (!officer.ok) {
    return NextResponse.json({ error: officer.error }, { status: officer.status });
  }

  const { data: leagueRow } = await supabase
    .from("leagues")
    .select("code, name")
    .eq("id", id)
    .maybeSingle();
  const code = (leagueRow as { code?: string } | null)?.code;
  const name = (leagueRow as { name?: string } | null)?.name ?? "Your league";
  if (!code) {
    return NextResponse.json({ error: "league code missing" }, { status: 500 });
  }

  let raw: unknown = {};
  try {
    raw = await req.json();
  } catch {
    raw = {};
  }
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  try {
    const appBaseUrl = appBaseUrlFromRequest(req);
    const result = await inviteLeagueOwners({
      supabase,
      leagueId: id,
      leagueCode: code,
      leagueName: name,
      appBaseUrl,
      owners: parsed.data.owners
    });
    return NextResponse.json({
      status: "ok",
      leagueCode: code,
      joinUrl: `${appBaseUrl}/join`,
      ...result
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 400 });
  }
}
