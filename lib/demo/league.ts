export type DemoOwner = {
  username: string;
  role: "owner";
};

export function normalizeEmailFragment(username: string) {
  // Supabase auth requires a valid email; we create a deterministic demo email.
  return username
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ".");
}

