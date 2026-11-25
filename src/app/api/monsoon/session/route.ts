import { NextResponse } from "next/server";
import { accountsConfigured } from "@/lib/monsoon/auth";
import { buildAccount } from "@/lib/monsoon/accounts/account";
import { DUMMY_PASSCODE_HASH, hashAddress, verifyPasscode } from "@/lib/monsoon/accounts/crypto";
import {
  evictAccount,
  failuresSince,
  findCustomerByCode,
  loadAccountRows,
  beginAttempt,
  recordActivity,
  settleAttempt,
  withAccountsDb,
  type CustomerRow,
  type PersonRow,
} from "@/lib/monsoon/accounts/store";
import { readJson } from "@/lib/monsoon/body";
import { ensureOwner } from "@/lib/monsoon/owners";
import { clearSessionCookie, networkAddress, setSessionCookie } from "@/lib/monsoon/session-cookie";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const FAILURE_DELAY_MS = 1000;
// Adding the owner key to every CRM must never hold sign-in past this (the client gives up at 15 s).
const ENSURE_CAP_MS = 2000;
const MAX_BODY = 4096;
const MAX_CODE = 64;
const WINDOW_MS = 15 * 60 * 1000;
const PAIR_LIMIT = 5;
const CODE_LIMIT = 50;
const WRONG = "Wrong company code or passcode.";
const LOCKED = "Wrong company code or passcode. Try again later.";

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
    // Recorded first and counted with the others, so parallel attempts cannot all slip under a limit.
    const attemptId = await beginAttempt(db, { code, addressHash });
    const failures = await failuresSince(db, code, addressHash, Date.now() - WINDOW_MS);
    // The per-address limit is a hard lock. The code-wide limit alone must not lock out a correct
    // passcode (anyone who knows the company code could otherwise lock the whole company out), so
    // it only turns a wrong passcode into "locked".
    if (failures.pair > PAIR_LIMIT) {
      await settleAttempt(db, attemptId, null);
      return { kind: "locked" };
    }
    const codeLocked = failures.code > CODE_LIMIT;

    const found = await findCustomerByCode(db, code);
    // A person who signed up with Google has no passcode and is never a candidate here.
    const people =
      found && found.customer.status === "active"
        ? found.people.filter((p) => p.status === "active" && p.passcodeHash !== null)
        : [];
    let match: PersonRow | undefined;
    if (people.length === 0) {
      // Same work as a real check, so an unknown code cannot be told apart by timing.
      await verifyPasscode(passcode, DUMMY_PASSCODE_HASH);
    } else {
      for (const person of people) {
        if (person.passcodeHash !== null && (await verifyPasscode(passcode, person.passcodeHash))) {
          match = person;
          break;
        }
      }
    }

    if (match && found) {
      await settleAttempt(db, attemptId, true, match.id);
      return { kind: "ok", customer: found.customer, person: match };
    }
    return { kind: codeLocked ? "locked" : "wrong" };
  });
}

/** Waits for `work` but never longer than `ms`; the work carries on (and logs its own errors). */
async function capped(work: Promise<void>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([work, new Promise<void>((resolve) => (timer = setTimeout(resolve, ms)))]);
  } finally {
    clearTimeout(timer);
  }
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
  // A cached row may carry the session number from before a passcode reset or resume.
  evictAccount(customer.id, person.id);
  await capped(ensureOwnerEverywhere(customer.id, person), ENSURE_CAP_MS);
  await recordActivity({ customerId: customer.id, personId: person.id, pipelineKey: null, action: "sign_in" });

  const response = NextResponse.json({ ok: true });
  setSessionCookie(response, { customerId: customer.id, personId: person.id, sessionNo: person.sessionNo });
  return response;
}

export async function DELETE() {
  const response = NextResponse.json({ ok: true });
  clearSessionCookie(response);
  return response;
}
