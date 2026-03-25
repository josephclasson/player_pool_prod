import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Upserts `public.profiles` for `userId`.
 * After migration `0013_profiles_drop_auth_users_fkey`, this no longer depends on FK timing with `auth.users`.
 */
export async function ensureProfileForAuthUser(
  supabase: SupabaseClient,
  userId: string,
  displayName: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  const id = userId.trim();
  const name = displayName.trim().slice(0, 200) || "Commissioner";

  const { error } = await supabase.from("profiles").upsert(
    { id, display_name: name },
    { onConflict: "id" }
  );

  if (error) {
    return {
      ok: false,
      error: `${error.message} If this mentions profiles_id_fkey, run migration 0013_profiles_drop_auth_users_fkey on this Supabase project.`
    };
  }

  return { ok: true };
}
