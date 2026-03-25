import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { type NextRequest, NextResponse } from "next/server";

const ALLOWED_OTP_TYPES = new Set([
  "signup",
  "invite",
  "magiclink",
  "recovery",
  "email_change",
  "email"
]);

function safeNextPath(raw: string | null, fallback: string) {
  if (!raw || !raw.startsWith("/") || raw.startsWith("//")) return fallback;
  return raw;
}

/**
 * Server-side finish for email magic links. Reads PKCE verifier from **cookies** set by
 * `createBrowserClient` when the user requested the link, then exchanges `code` or runs `verifyOtp`.
 */
export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const origin = url.origin;

  const errParam =
    url.searchParams.get("error_description")?.replace(/\+/g, " ") ??
    url.searchParams.get("error") ??
    null;
  if (errParam) {
    return NextResponse.redirect(
      new URL(`/commissioner?auth_error=${encodeURIComponent(errParam)}`, origin)
    );
  }

  const next = safeNextPath(url.searchParams.get("next"), "/commissioner");
  const code = url.searchParams.get("code");
  const token_hash = url.searchParams.get("token_hash");
  const typeRaw = url.searchParams.get("type");

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseAnon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!supabaseUrl || !supabaseAnon) {
    return NextResponse.redirect(
      new URL(`/commissioner?auth_error=${encodeURIComponent("Supabase is not configured")}`, origin)
    );
  }

  let response = NextResponse.redirect(new URL(next, origin));

  const supabase = createServerClient(supabaseUrl, supabaseAnon, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet: { name: string; value: string; options: CookieOptions }[]) {
        cookiesToSet.forEach(({ name, value, options }: { name: string; value: string; options: CookieOptions }) => {
          response.cookies.set(name, value, options);
        });
      }
    }
  });

  if (token_hash && typeRaw) {
    if (!ALLOWED_OTP_TYPES.has(typeRaw)) {
      return NextResponse.redirect(
        new URL(`/commissioner?auth_error=${encodeURIComponent("Invalid auth type in link")}`, origin)
      );
    }
    const { error } = await supabase.auth.verifyOtp({
      token_hash,
      type: typeRaw as "signup" | "invite" | "magiclink" | "recovery" | "email_change" | "email"
    });
    if (error) {
      const dest = next.startsWith("/join") ? "/join" : "/commissioner";
      return NextResponse.redirect(
        new URL(`${dest}?auth_error=${encodeURIComponent(error.message)}`, origin)
      );
    }
    return response;
  }

  if (code) {
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (error) {
      const dest = next.startsWith("/join") ? "/join" : "/commissioner";
      return NextResponse.redirect(
        new URL(`${dest}?auth_error=${encodeURIComponent(error.message)}`, origin)
      );
    }
    return response;
  }

  return NextResponse.redirect(
    new URL(`/commissioner?auth_error=${encodeURIComponent("Missing sign-in code")}`, origin)
  );
}
