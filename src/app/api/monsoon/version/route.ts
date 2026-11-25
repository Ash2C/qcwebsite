import { googleConfigured, signupsConfigured } from "@/lib/monsoon/google";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The build that is live now (the commit it was made from; the repository is public). The app
 * compares it with its own to offer "Update" when it was left open across a release. No sign-in:
 * the passcode screen offers the update too. It also says, as true or false only, whether Sign in
 * with Google is on and whether new sign-ups can be taken, so the passcode screen knows whether to
 * show the Google button.
 */
export function GET(): Response {
  return Response.json(
    { build: process.env.VERCEL_GIT_COMMIT_SHA ?? "dev", google: googleConfigured(), signups: signupsConfigured() },
    { headers: { "Cache-Control": "no-store" } },
  );
}
