import Link from "next/link";

/**
 * Legacy route: invites used to land here for Supabase PIN setup.
 * Pools now use the site header: league id → pick owner → optional commissioner password.
 */
export default function JoinPage() {
  return (
    <div className="pool-page-stack max-w-md mx-auto py-12 px-4 space-y-4">
      <div className="pool-text-title">Join your pool</div>
      <p className="pool-text-muted-sm text-sm leading-relaxed">
        Open the main app link your commissioner shared. At the top, enter your <strong>league id</strong> (UUID or
        code), click <strong>Load owners</strong>, choose <strong>who you are</strong>, then{" "}
        <strong>Continue as this owner</strong>. Everything stays in this browser session — no email login or PIN.
      </p>
      <p className="text-sm">
        <Link href="/draft" className="pool-link font-semibold">
          Go to Draft tab →
        </Link>
      </p>
      <p className="pool-text-muted-sm text-[12px]">
        Commissioners: use <strong>Act as commissioner</strong> in the header and enter the same password as{" "}
        <code className="pool-code">COMMISSIONER_API_SECRET</code> on the server.
      </p>
    </div>
  );
}
