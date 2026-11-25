import { requireAccount } from "@/lib/monsoon/accounts/account";
import { canApprove } from "@/lib/monsoon/accounts/approver";
import { loadUserPage, parsePageInput, saveUserPage } from "@/lib/monsoon/accounts/profile";
import { googleLinked } from "@/lib/monsoon/accounts/signups";
import { readJson } from "@/lib/monsoon/body";
import { googleConfigured } from "@/lib/monsoon/google";
import { estateKey, logError, pageReply, reply, unknownEstate, whoIs } from "./respond";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

// Role and objectives may be 4,000 characters, each up to four bytes; nothing larger is a page.
const MAX_BODY = 16_000;

/** The signed-in person's own page for one estate: their details, their work there, their notes. */
export async function GET(request: Request): Promise<Response> {
  const auth = await requireAccount(request);
  if (!auth.ok) return auth.response;
  const estate = estateKey(new URL(request.url).searchParams.get("estate"));
  if (estate === null) return unknownEstate();
  try {
    const who = whoIs(auth.account);
    const google = googleConfigured();
    // The link is looked up fresh (the signed-in account is cached for a minute, and the person may
    // have linked a moment ago) and only when Google is on. If the lookup fails the page still
    // loads and says "not linked": linking again is harmless.
    const [page, linked] = await Promise.all([loadUserPage(who, estate), google ? googleLinked(who).catch(() => false) : false]);
    if (page === null) return unknownEstate();
    // True or false only: the Google id never leaves the server.
    return reply({ page, googleConfigured: google, googleLinked: linked === true, canApprove: canApprove(auth.account) });
  } catch (err) {
    return logError("read", err);
  }
}

/**
 * Saves the details and this estate's work fields. Body: `{ estate, name, phone, email, company,
 * website, roleObjectives }`; any id in it is ignored. The tap on Save is the user's confirm.
 */
export async function PUT(request: Request): Promise<Response> {
  const auth = await requireAccount(request);
  if (!auth.ok) return auth.response;

  const read = await readJson(request, MAX_BODY);
  if (!read.ok) return reply({ error: "Invalid request" }, 400);
  if (typeof read.body !== "object" || read.body === null || Array.isArray(read.body)) return reply({ error: "Invalid request" }, 400);
  const estate = estateKey((read.body as Record<string, unknown>).estate);
  if (estate === null) return unknownEstate();
  const input = parsePageInput(read.body);
  if (!input.ok) return reply({ error: input.error }, 400);

  try {
    return pageReply(await saveUserPage(whoIs(auth.account), estate, input.value));
  } catch (err) {
    return logError("save", err);
  }
}
