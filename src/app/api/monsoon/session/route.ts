import { NextResponse } from "next/server";
import { SESSION_COOKIE, SESSION_SECONDS, accountsConfigured, signSession } from "@/lib/monsoon/auth";
import { buildAccount } from "@/lib/monsoon/accounts/account";
import { DUMMY_PASSCODE_HASH, hashAddress, verifyPasscode } from "@/lib/monsoon/accounts/crypto";
import {
  failuresSince,
  findCustomerByCode,
  loadAccountRows,
  recordActivity,
  recordAttempt,
  withAccountsDb,
  type CustomerRow,
  type PersonRow,
} from "@/lib/monsoon/accounts/store";
import { readJson } from "@/lib/monsoon/body";
import { ensureOwner } from "@/lib/monsoon/owners";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const FAILURE_DELAY_MS = 1000;
const MAX_BODY = 4096;
const MAX_CODE = 64;
const WINDOW_MS = 15 * 60 * 1000;
const PAIR_LIMIT = 5;
const CODE_LIMIT = 50;
const WRONG = "Wrong company code or passcode.";
const LOCKED = "Wrong company code or passcode. Try again later.";

function networkAddress(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  if (forwarded) return forwarded;
  const real = request.headers.get("x-real-ip")?.trim();
  return real || "unknown";
}

function errorClass(err: unknown): string {
  return err instanceof Error ? err.name : "error";
}

async function failAfterDelay(error: string, status: number): Promise<NextResponse> {
  await new Promise((resolve) => setTimeout(resolve, FAILURE_DELAY_MS));
  return NextResponse.json({ error }, { status });
}

type Outcome =
  | { kind: "locked" }
  | { kind: "wrong" }
  | { kind: "ok"; customer: CustomerRow; person: PersonRow };

async function signIn(code: string, passcode: string, addressHash: string): Promise<Outcome> {
  return withAccountsDb(async (db) => {
    const failures = await failuresSince(db, code, addressHash, Date.now() - WINDOW_MS);
    if (failures.pair >= PAIR_LIMIT || failures.code >= CODE_LIMIT) return { kind: "locked" };

    const found = await findCustomerByCode(db, code);
    const people =
      found && found.customer.status === "active" ? found.people.filter((p) => p.status === "active") : [];
    let match: PersonRow | undefined;
    if (people.length === 0) {
      // Same work as a real check, so an unknown code cannot be told apart by timing.
      await verifyPasscode(passcode, DUMMY_PASSCODE_HASH);
    } else {
      for (const person of people) {
        if (await verifyPasscode(passcode, person.passcodeHash)) {
          match = person;
          break;
        }
      }
    }

    await recordAttempt(db, { code, personId: match?.id ?? null, addressHash, ok: !!match });
    return match && found ? { kind: "ok", customer: found.customer, person: match } : { kind: "wrong" };
  });
}

/** Best effort: a CRM (or the accounts database) that cannot be reached must not block sign-in. */
async function ensureOwnerEverywhere(customerId: string, person: PersonRow): Promise<void> {
  const log = (err: unknown) => console.error("monsoon: ensureOwner failed", errorClass(err));
  try {
    const rows = await loadAccountRows(customerId, person.id);
    if (!rows) return;
    const account = buildAccount(rows);
    await Promise.all(
      account.pipelines
        .filter((p) => p.connected)
        .map((p) => account.withDb(p.key, (db) => ensureOwner(db, person.ownerKey, person.displayName)).catch(log)),
    );
  } catch (err) {
    log(err);
  }
}

export async function POST(request: Request) {
  if (!accountsConfigured()) {
    return NextResponse.json({ error: "Monsoon is not configured" }, { status: 500 });
  }

  const read = await readJson(request, MAX_BODY);
  if (!read.ok) return read.response;
  const body = typeof read.body === "object" && read.body !== null ? (read.body as Record<string, unknown>) : {};
  const code = typeof body.code === "string" ? body.code.trim().toLowerCase().slice(0, MAX_CODE) : "";
  const passcode = typeof body.passcode === "string" ? body.passcode : "";

  let outcome: Outcome;
  try {
    outcome = await signIn(code, passcode, hashAddress(networkAddress(request)));
  } catch (err) {
    console.error("monsoon: sign-in failed", errorClass(err), (err as { code?: string })?.code ?? "");
    return NextResponse.json({ error: "Could not reach the accounts database" }, { status: 502 });
  }
  if (outcome.kind === "locked") return failAfterDelay(LOCKED, 429);
  if (outcome.kind === "wrong") return failAfterDelay(WRONG, 401);

  const { customer, person } = outcome;
  await ensureOwnerEverywhere(customer.id, person);
  await recordActivity({ customerId: customer.id, personId: person.id, pipelineKey: null, action: "sign_in" });

  const response = NextResponse.json({ ok: true });
  response.cookies.set(
    SESSION_COOKIE,
    signSession({ customerId: customer.id, personId: person.id, sessionNo: person.sessionNo }),
    { path: "/", httpOnly: true, secure: true, sameSite: "strict", maxAge: SESSION_SECONDS },
  );
  return response;
}

export async function DELETE() {
  const response = NextResponse.json({ ok: true });
  response.cookies.set(SESSION_COOKIE, "", {
    path: "/",
    httpOnly: true,
    secure: true,
    sameSite: "strict",
    maxAge: 0,
  });
  return response;
}
