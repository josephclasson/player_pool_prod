import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !serviceRoleKey) {
  console.error("Missing SUPABASE_SERVICE_ROLE_KEY or NEXT_PUBLIC_SUPABASE_URL in env.");
  process.exit(1);
}

const supabase = createClient(supabaseUrl, serviceRoleKey);

async function main() {
  console.log("Worker started (scaffold). TODO: implement job loop.");
  const { data, error } = await supabase.from("leagues").select("id,name").limit(1);
  if (error) {
    console.error("Supabase error:", error);
    return;
  }
  console.log("Connected. Sample league:", data?.[0] ?? null);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

