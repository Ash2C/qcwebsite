// Shared by the user-page routes (this folder and notes/): one way to answer, to log, to name who
// is asking and to read the estate key, so the two route files cannot drift apart.
import type { Account } from "@/lib/monsoon/accounts/account";
import type { UserPage, Who } from "@/lib/monsoon/accounts/profile";

/** The page holds personal details: no cache anywhere may keep an answer. */
export function reply(body: Record<string, unknown>, status = 200): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

export function logError(where: string, err: unknown): Response {
  // Name and code only: the message can carry connection details or what the person wrote.
  const code = (err as { code?: unknown })?.code;
  console.error(`monsoon: me ${where} failed`, err instanceof Error ? err.name : "error", typeof code === "string" ? code.slice(0, 5) : "");
  return reply({ error: "Could not reach the accounts database" }, 502);
}

/** Who is asking: always the session's customer and person, never anything the request carries. */
export const whoIs = (account: Account): Who => ({ customerId: account.customer.id, personId: account.person.id });

// Longer than any pipeline key; it only keeps junk out of the query.
const MAX_ESTATE_KEY = 200;

/** The estate key as sent, or null. Whether it is this customer's is settled in SQL by the library. */
export function estateKey(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_ESTATE_KEY ? value : null;
}

export const unknownEstate = (): Response => reply({ error: "Unknown estate" }, 400);

/** The library answers null only for a pipeline that is not this customer's. */
export const pageReply = (page: UserPage | null): Response => (page === null ? unknownEstate() : reply({ page }));
