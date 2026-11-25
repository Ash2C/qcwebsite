// Where the Google callback sends someone who is not signed in yet: one plain message, picked from a
// fixed list by the `status` in the address, and a link back. Nothing from the address is shown.
import type { Metadata } from "next";
import MonsoonLogo from "@/components/monsoon/MonsoonLogo";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "Monsoon",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

const ERROR = "Something went wrong. Try again.";
const MESSAGES: Record<string, string> = {
  received: "Request received. You will get in as soon as it is approved. Come back and tap Sign in with Google.",
  waiting: "Waiting for approval.",
  declined: "This request was not approved.",
  paused: "Sign-ups are paused for now. Try again later.",
  taken: "That Google account is already linked to another Monsoon account.",
  error: ERROR,
};

const shell =
  "mx-auto flex min-h-dvh max-w-xl flex-col gap-5 px-5 pb-[max(1.5rem,env(safe-area-inset-bottom))] pt-[max(1.5rem,env(safe-area-inset-top))]";

export default async function RequestPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { status } = await searchParams;
  const message = typeof status === "string" && Object.hasOwn(MESSAGES, status) ? MESSAGES[status] : ERROR;

  return (
    <main className={shell}>
      <MonsoonLogo className="h-10" />
      <p role="status" className="text-[17px] font-medium text-neutral-800 dark:text-neutral-200">
        {message}
      </p>
      <p>
        <a href="/monsoon" className="text-[17px] font-medium text-blue-600 underline dark:text-blue-400">
          Back to Monsoon
        </a>
      </p>
    </main>
  );
}
