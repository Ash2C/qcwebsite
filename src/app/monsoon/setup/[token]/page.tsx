// The one-time setup page. Looking at it never uses the link up; only a successful submission does.
import type { Metadata } from "next";
import MonsoonLogo from "@/components/monsoon/MonsoonLogo";
import SetupForm from "@/components/monsoon/SetupForm";
import { SETUP_EXPIRED, loadSetupPage, type SetupPage } from "@/lib/monsoon/accounts/setup-link";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "Monsoon setup",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

const shell =
  "mx-auto flex min-h-dvh max-w-xl flex-col gap-5 px-5 pb-[max(1.5rem,env(safe-area-inset-bottom))] pt-[max(1.5rem,env(safe-area-inset-top))]";

export default async function SetupLinkPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  let page: SetupPage | "unavailable";
  try {
    page = await loadSetupPage(token);
  } catch (err) {
    console.error("monsoon: setup page lookup failed", err instanceof Error ? err.name : "error");
    page = "unavailable";
  }

  return (
    <main className={shell}>
      <MonsoonLogo className="h-10" />
      {page === "unavailable" ? (
        <p role="alert" className="text-[17px] font-medium text-red-600 dark:text-red-400">
          Monsoon can&apos;t open this setup link right now. Try again in a few minutes.
        </p>
      ) : page.kind === "expired" ? (
        <p role="alert" className="text-[17px] font-medium text-red-600 dark:text-red-400">
          {SETUP_EXPIRED}
        </p>
      ) : (
        <SetupForm token={token} purpose="connect" claudeKeyOnFile={page.claudeKeyOnFile} />
      )}
    </main>
  );
}
