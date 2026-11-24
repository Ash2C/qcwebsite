"use client";

import { useEffect, useState } from "react";

// The build this page was made from, baked in at build time (next.config.ts).
const MINE = process.env.NEXT_PUBLIC_MONSOON_BUILD ?? "dev";
// A home-screen app that was left open resumes its old page: ask again when it comes back, at most this often.
const EVERY_MS = 60_000;

/** True when the server's build differs from this page's. Unknown on either side is "no". */
export function isNewer(mine: string, live: unknown): boolean {
  return typeof live === "string" && live !== "" && live !== "dev" && mine !== "dev" && live !== mine;
}

/** A bar that appears when a newer Monsoon is live. "Update" reloads the page; nothing reloads by itself. */
export default function UpdateBanner({ mine = MINE }: { mine?: string }) {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let last = 0;
    let stopped = false;
    async function check() {
      if (document.visibilityState !== "visible" || Date.now() - last < EVERY_MS) return;
      last = Date.now();
      try {
        const res = await fetch("/api/monsoon/version", { cache: "no-store" });
        if (!res.ok) return;
        const body: unknown = await res.json();
        if (!stopped && isNewer(mine, (body as { build?: unknown } | null)?.build)) setReady(true);
      } catch {
        // offline: ask again next time
      }
    }
    void check();
    const onChange = () => void check();
    document.addEventListener("visibilitychange", onChange);
    window.addEventListener("focus", onChange);
    return () => {
      stopped = true;
      document.removeEventListener("visibilitychange", onChange);
      window.removeEventListener("focus", onChange);
    };
  }, [mine]);

  if (!ready) return null;
  return (
    <div
      role="status"
      className="sticky top-0 z-20 flex items-center justify-between gap-3 bg-[#0E7FA6] px-4 pb-2 pt-[max(0.5rem,env(safe-area-inset-top))] text-white dark:bg-[#123847]"
    >
      <span className="text-[15px] font-medium">A new version of Monsoon is ready.</span>
      <button
        type="button"
        onClick={() => window.location.reload()}
        className="min-h-[44px] shrink-0 rounded-xl bg-white px-4 text-[15px] font-semibold text-[#0B4F68]"
      >
        Update
      </button>
    </div>
  );
}
