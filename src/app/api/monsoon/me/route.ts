import { requireAccount } from "@/lib/monsoon/accounts/account";
import { loadUserPage, parsePageInput, saveUserPage } from "@/lib/monsoon/accounts/profile";
import { readJson } from "@/lib/monsoon/body";
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
    return pageReply(await loadUserPage(whoIs(auth.account), estate));
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
