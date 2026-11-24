import { requireAccount } from "@/lib/monsoon/accounts/account";
import { addUserNote, parseNote } from "@/lib/monsoon/accounts/profile";
import { readJson } from "@/lib/monsoon/body";
import { estateKey, logError, pageReply, reply, unknownEstate, whoIs } from "../respond";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

// A note may be 2,000 characters, each up to four bytes; same cap as the page itself.
const MAX_BODY = 16_000;

/**
 * Adds one note about the signed-in person for one estate. Body: `{ estate, body }`. Notes only
 * accumulate: there is no way here to change or remove one. The tap on Add is the user's confirm.
 */
export async function POST(request: Request): Promise<Response> {
  const auth = await requireAccount(request);
  if (!auth.ok) return auth.response;

  const read = await readJson(request, MAX_BODY);
  if (!read.ok) return reply({ error: "Invalid request" }, 400);
  if (typeof read.body !== "object" || read.body === null || Array.isArray(read.body)) return reply({ error: "Invalid request" }, 400);
  const json = read.body as Record<string, unknown>;
  const estate = estateKey(json.estate);
  if (estate === null) return unknownEstate();
  const note = parseNote(json.body);
  if (!note.ok) return reply({ error: note.error }, 400);

  try {
    return pageReply(await addUserNote(whoIs(auth.account), estate, note.value));
  } catch (err) {
    return logError("note", err);
  }
}
