export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The build that is live now (the commit it was made from; the repository is public). The app
 * compares it with its own to offer "Update" when it was left open across a release. No sign-in:
 * the passcode screen offers the update too.
 */
export function GET(): Response {
  return Response.json(
    { build: process.env.VERCEL_GIT_COMMIT_SHA ?? "dev" },
    { headers: { "Cache-Control": "no-store" } },
  );
}
