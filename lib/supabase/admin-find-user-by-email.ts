import type { SupabaseClient } from "@supabase/supabase-js";

/** Paginates `auth.admin.listUsers` until the email is found or pages are exhausted. */
export async function adminFindUserIdByEmail(
  supabase: SupabaseClient,
  email: string
): Promise<string | null> {
  const target = email.trim().toLowerCase();
  let page = 1;
  const perPage = 200;
  for (let i = 0; i < 50; i++) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage });
    if (error) throw error;
    const users = data?.users ?? [];
    const found = users.find((u) => String(u.email ?? "").toLowerCase() === target);
    if (found?.id) return found.id;
    if (users.length < perPage) break;
    page += 1;
  }
  return null;
}
