// Sign up with Google: requests waiting for approval, and the Google id on a person. Everything is
// matched on Google's permanent account id (`sub`), never on an email. Nothing here creates a
// customer, a database object or a session: a request is one row until it is approved elsewhere.
// A request is never removed; declining and re-opening are status changes.
import type { Client } from "pg";
import {
  CUSTOMER_COLUMNS,
  PERSON_COLUMNS,
  beginAttempt,
  failuresSince,
  recordActivity,
  settleAttempt,
  toCustomer,
  toPerson,
  withAccountsDb,
  type CustomerRow,
  type PersonRow,
} from "./store";

export type SignupStatus = "pending" | "approved" | "declined";

export type SignupRow = {
  id: string;
  sub: string;
  email: string;
  name: string;
  status: SignupStatus;
  customerId: string | null;
  createdAt: string;
};

/** Google's account id: digits only. */
export const GOOGLE_SUB = /^\d{1,64}$/;
export const MAX_PENDING_SIGNUPS = 200;
export const MAX_SIGNUPS_PER_ADDRESS = 5;
const MAX_LISTED = 300;
const MAX_EMAIL = 320;
const MAX_NAME = 200;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// One lock for every write that decides who a Google id belongs to (a new request, a link), taken
// for the length of its transaction: parallel calls run one after another, so none can slip past
// the pending cap or the address limit, and one id can never land on both a person and a request.
const LOCK = "SELECT pg_advisory_xact_lock(hashtext('monsoon:signups'))";

const SIGNUP_COLUMNS = "id, google_sub, email, name, status, customer_id, created_at";

function toSignup(r: Record<string, unknown>): SignupRow {
  return {
    id: r.id as string,
    sub: r.google_sub as string,
    email: r.email as string,
    name: r.name as string,
    status: r.status as SignupStatus,
    customerId: (r.customer_id as string | null) ?? null,
    createdAt: (r.created_at as Date).toISOString(),
  };
}

async function locked<T>(fn: (db: Client) => Promise<T>): Promise<T> {
  return withAccountsDb(async (db) => {
    await db.query("BEGIN");
    try {
      await db.query(LOCK);
      const result = await fn(db);
      await db.query("COMMIT");
      return result;
    } catch (err) {
      await db.query("ROLLBACK").catch(() => undefined);
      throw err;
    }
  });
}

/** The active person (of an active customer) who has this Google id, or null. */
export async function findPersonByGoogleSub(sub: string): Promise<{ customer: CustomerRow; person: PersonRow } | null> {
  if (typeof sub !== "string" || !GOOGLE_SUB.test(sub)) return null;
  return withAccountsDb(async (db) => {
    const p = await db.query(`SELECT ${PERSON_COLUMNS} FROM people WHERE google_sub = $1 AND status = 'active'`, [sub]);
    if (p.rowCount !== 1) return null;
    const person = toPerson(p.rows[0]);
    const c = await db.query(`SELECT ${CUSTOMER_COLUMNS} FROM customers WHERE id = $1 AND status = 'active'`, [person.customerId]);
    if (c.rowCount !== 1) return null;
    return { customer: toCustomer(c.rows[0]), person };
  });
}

export async function findSignup(sub: string): Promise<SignupRow | null> {
  if (typeof sub !== "string" || !GOOGLE_SUB.test(sub)) return null;
  return withAccountsDb(async (db) => {
    const r = await db.query(`SELECT ${SIGNUP_COLUMNS} FROM signups WHERE google_sub = $1`, [sub]);
    return r.rowCount === 1 ? toSignup(r.rows[0]) : null;
  });
}

/**
 * Records a request to join. `too_many`: five rows already came from this address in the last 24
 * hours. `paused`: 200 requests are already waiting. A Google id that already has a request, or
 * already belongs to a person, adds nothing and changes nothing (the answer is still `created`).
 * Throws on a `sub` that is not a Google id, and when the database cannot be reached.
 */
export async function requestSignup(input: {
  sub: string;
  email: string;
  name: string;
  addressHash: string;
}): Promise<"created" | "paused" | "too_many"> {
  if (typeof input.sub !== "string" || !GOOGLE_SUB.test(input.sub)) throw new Error("not a Google id");
  const email = String(input.email).slice(0, MAX_EMAIL);
  const name = String(input.name).slice(0, MAX_NAME);
  return locked(async (db) => {
    const known = await db.query(
      "SELECT 1 FROM signups WHERE google_sub = $1 UNION ALL SELECT 1 FROM people WHERE google_sub = $1 LIMIT 1",
      [input.sub],
    );
    if (known.rowCount) return "created";
    const counts = await db.query(
      `SELECT count(*) FILTER (WHERE address_hash = $1 AND created_at > now() - interval '24 hours')::int AS address,
              count(*) FILTER (WHERE status = 'pending')::int AS pending
         FROM signups`,
      [input.addressHash],
    );
    if (counts.rows[0].address >= MAX_SIGNUPS_PER_ADDRESS) return "too_many";
    if (counts.rows[0].pending >= MAX_PENDING_SIGNUPS) return "paused";
    await db.query("INSERT INTO signups (google_sub, email, name, address_hash) VALUES ($1, $2, $3, $4)", [
      input.sub,
      email,
      name,
      input.addressHash,
    ]);
    return "created";
  });
}

/** Pending first, then newest first; at most 300. */
export async function listSignups(): Promise<SignupRow[]> {
  return withAccountsDb(async (db) => {
    const r = await db.query(
      `SELECT ${SIGNUP_COLUMNS} FROM signups ORDER BY (status = 'pending') DESC, created_at DESC, id LIMIT ${MAX_LISTED}`,
    );
    return r.rows.map(toSignup);
  });
}

/** Pending to declined. False when there is no such pending request. Removes nothing. */
export async function declineSignup(id: string): Promise<boolean> {
  if (typeof id !== "string" || !UUID.test(id)) return false;
  return withAccountsDb(async (db) => {
    const r = await db.query("UPDATE signups SET status = 'declined', decided_at = now() WHERE id = $1 AND status = 'pending'", [id]);
    return r.rowCount === 1;
  });
}

/** Declined back to pending. False when there is no such declined request. */
export async function reopenSignup(id: string): Promise<boolean> {
  if (typeof id !== "string" || !UUID.test(id)) return false;
  return withAccountsDb(async (db) => {
    const r = await db.query("UPDATE signups SET status = 'pending', decided_at = NULL WHERE id = $1 AND status = 'declined'", [id]);
    return r.rowCount === 1;
  });
}

/**
 * Puts a Google id on a signed-in person. `taken` when the id is on another person or on any
 * request, when this person already has a different Google id (a link is never replaced here), or
 * when there is no such person in that customer.
 */
export async function linkGoogle(who: { customerId: string; personId: string }, sub: string): Promise<"linked" | "taken"> {
  if (typeof sub !== "string" || !GOOGLE_SUB.test(sub)) return "taken";
  if (!UUID.test(who.customerId) || !UUID.test(who.personId)) return "taken";
  const outcome = await locked(async (db): Promise<"linked" | "already" | "taken"> => {
    const signup = await db.query("SELECT 1 FROM signups WHERE google_sub = $1", [sub]);
    if (signup.rowCount) return "taken";
    const holder = await db.query("SELECT id, customer_id FROM people WHERE google_sub = $1", [sub]);
    if (holder.rowCount) {
      const h = holder.rows[0] as { id: string; customer_id: string };
      return h.id === who.personId.toLowerCase() && h.customer_id === who.customerId.toLowerCase() ? "already" : "taken";
    }
    const r = await db.query(
      `UPDATE people SET google_sub = $3
        WHERE id = $1 AND customer_id = $2 AND status = 'active' AND google_sub IS NULL
          AND EXISTS (SELECT 1 FROM customers c WHERE c.id = $2 AND c.status = 'active')`,
      [who.personId, who.customerId, sub],
    );
    return r.rowCount === 1 ? "linked" : "taken";
  });
  if (outcome === "taken") return "taken";
  if (outcome === "linked") {
    await recordActivity({ customerId: who.customerId, personId: who.personId, pipelineKey: null, action: "google_link" });
  }
  return "linked";
}

// Returns from Google are counted per network address in sign_in_attempts, like passcode sign-ins,
// under a code no company can have (a company code has no colon).
export const GOOGLE_ATTEMPT_CODE = "google:callback";
export const GOOGLE_ATTEMPT_LIMIT = 10;
const GOOGLE_ATTEMPT_WINDOW_MS = 15 * 60 * 1000;

/**
 * Call before asking Google who someone is. Records the attempt as a failure until it is settled
 * and returns its id, or null when this address already has more than ten failures in the last
 * fifteen minutes (that refusal is kept as a record but not counted).
 */
export async function beginGoogleAttempt(addressHash: string): Promise<string | null> {
  return withAccountsDb(async (db) => {
    const id = await beginAttempt(db, { code: GOOGLE_ATTEMPT_CODE, addressHash });
    const failures = await failuresSince(db, GOOGLE_ATTEMPT_CODE, addressHash, Date.now() - GOOGLE_ATTEMPT_WINDOW_MS);
    if (failures.pair > GOOGLE_ATTEMPT_LIMIT) {
      await settleAttempt(db, id, null);
      return null;
    }
    return id;
  });
}

/** Google answered for this attempt: it no longer counts as a failure. */
export async function settleGoogleAttempt(id: string): Promise<void> {
  await withAccountsDb((db) => settleAttempt(db, id, true));
}
