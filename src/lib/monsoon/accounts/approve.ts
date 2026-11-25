// Approving a request to join: the one place a sign-up turns into a company, a person and a CRM.
// Nothing exists for a request before this runs. Every step can be run again: a failure at any
// point leaves the request pending (and nobody able to sign in), and calling again finishes it
// without making a second company, person, pipeline or CRM. The person is created last, in the
// same transaction that marks the request approved, so nobody gets in to a half-built account.
// Nothing here logs a name, an email, a Google id or an address: only which step failed.
import { createHash, randomBytes } from "node:crypto";
import type { Client } from "pg";
import { APPROVED_NOTE, recordAlphaSignup } from "../alpha";
import { withCustomerPipelineDb } from "./account";
import { encryptSecret } from "./crypto";
import { ProvisionError, provisionSharedCrm } from "./provision";
import type { SetupVocabulary } from "./setup-script";
import { recordActivity, withAccountsDb } from "./store";

export type ApproveResult =
  | { ok: true; customerId: string; already: boolean }
  | { ok: false; reason: "not_found" | "declined" | "busy" | "failed" };

export type ApproveDeps = {
  /** Builds the client's CRM in the shared database. Replaced in tests. */
  provision?: typeof provisionSharedCrm;
  /** Best effort: tells Vincent's own CRM about the new client. Replaced in tests. */
  recordInCrm?: (who: { email: string; name: string }) => Promise<void>;
  /** How long the approval waits for `recordInCrm` before moving on. */
  crmCapMs?: number;
  /** Who approved, for the activity record. */
  approver?: { customerId: string; personId: string };
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CRM_CAP_MS = 3000;
const CODE_TRIES = 5;

/** A sign-up is one person, one company, one pipeline. */
export const DEFAULT_PIPELINE = { key: "pipeline", label: "Pipeline", defaultRole: "prospect" } as const;

/** A general sales vocabulary: what the client's stages and roles tables start with. */
export const DEFAULT_VOCABULARY: Pick<SetupVocabulary, "stages" | "roles"> = {
  stages: [
    { key: "new", ord: 0, label: "New", terminal: false },
    { key: "contacted", ord: 1, label: "Contacted", terminal: false },
    { key: "talking", ord: 2, label: "In conversation", terminal: false },
    { key: "proposal", ord: 3, label: "Proposal", terminal: false },
    { key: "won", ord: 4, label: "Won", terminal: true },
    { key: "lost", ord: 5, label: "Lost", terminal: true },
  ],
  roles: [
    { key: "prospect", label: "Prospect" },
    { key: "customer", label: "Customer" },
    { key: "partner", label: "Partner" },
    { key: "other", label: "Other" },
  ],
};

const plain = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "");

/**
 * A company code for a new client: a slug of the name, a dash and four random characters. Always
 * matches the code check, and always ends in the random part, so it can never be an existing
 * customer's plain code (such as `quantcloud`).
 */
export function customerCode(name: string): string {
  const slug =
    plain(String(name))
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 27)
      .replace(/-+$/g, "") || "client";
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  let suffix = "";
  for (const b of randomBytes(4)) suffix += alphabet[b % alphabet.length];
  return `${slug}-${suffix}`;
}

/**
 * The person's owner key: their initials, two to four capital letters (one word gives its first
 * two letters). A name without two Latin letters gets three letters worked out from the customer
 * id, so a second run for the same customer gives the same key.
 */
export function ownerKeyFor(name: string, customerId: string): string {
  const words = plain(String(name))
    .toUpperCase()
    .split(/[\s-]+/)
    .map((w) => w.replace(/[^A-Z]/g, ""))
    .filter(Boolean);
  if (words.length >= 2) return words.map((w) => w[0]).join("").slice(0, 4);
  if (words.length === 1 && words[0].length >= 2) return words[0].slice(0, 2);
  const hash = createHash("sha256").update(`owner-key:${customerId.toLowerCase()}`).digest();
  return [0, 1, 2].map((i) => String.fromCharCode(65 + (hash[i] % 26))).join("");
}

/** A step that failed, by name only. */
class StepFailed extends Error {
  constructor(readonly step: string) {
    super(step);
    this.name = "StepFailed";
  }
}

async function inTransaction<T>(db: Client, fn: () => Promise<T>): Promise<T> {
  await db.query("BEGIN");
  try {
    const result = await fn();
    await db.query("COMMIT");
    return result;
  } catch (err) {
    await db.query("ROLLBACK").catch(() => undefined);
    throw err;
  }
}

type Outcome = ApproveResult & { email?: string; name?: string; personId?: string };

async function run(db: Client, id: string, provision: typeof provisionSharedCrm): Promise<Outcome> {
  const found = await db.query("SELECT google_sub, email, name, status, customer_id FROM signups WHERE id = $1", [id]);
  if (found.rowCount !== 1) return { ok: false, reason: "not_found" };
  const signup = found.rows[0] as { google_sub: string; email: string; name: string; status: string; customer_id: string | null };
  if (signup.status === "declined") return { ok: false, reason: "declined" };
  // Its Google id now belongs to a person who already had an account: there is nothing to approve.
  if (signup.status === "linked") return { ok: false, reason: "not_found" };
  if (signup.status === "approved" && signup.customer_id) return { ok: true, customerId: signup.customer_id, already: true };
  if (signup.status !== "pending") throw new StepFailed("state");

  // 1. The company, tied to the request in the same transaction: a second run finds it here.
  let customerId = signup.customer_id;
  for (let attempt = 0; customerId === null; attempt++) {
    try {
      customerId = await inTransaction(db, async () => {
        const c = await db.query("INSERT INTO customers (code, name) VALUES ($1, $2) RETURNING id", [customerCode(signup.name), signup.name]);
        const linked = await db.query("UPDATE signups SET customer_id = $2 WHERE id = $1 AND customer_id IS NULL AND status = 'pending'", [id, c.rows[0].id]);
        if (linked.rowCount !== 1) throw new StepFailed("customer");
        return c.rows[0].id as string;
      });
    } catch (err) {
      if (err instanceof StepFailed) {
        // The request stopped waiting between the two looks at it. Nothing was made (the company went with the transaction).
        const now = await db.query("SELECT status FROM signups WHERE id = $1", [id]);
        if (now.rows[0]?.status === "linked") return { ok: false, reason: "not_found" };
        if (now.rows[0]?.status === "declined") return { ok: false, reason: "declined" };
        throw err;
      }
      // The random code was taken: try another. Anything else is a failure.
      if ((err as { code?: string }).code !== "23505" || attempt >= CODE_TRIES - 1) throw err instanceof StepFailed ? err : new StepFailed("customer");
    }
  }

  // 2. The pipeline, not yet connected.
  await db.query(
    `INSERT INTO pipelines (customer_id, key, label, default_role, position, vocab)
     VALUES ($1, $2, $3, $4, 0, $5::jsonb) ON CONFLICT (customer_id, key) DO NOTHING`,
    [customerId, DEFAULT_PIPELINE.key, DEFAULT_PIPELINE.label, DEFAULT_PIPELINE.defaultRole, JSON.stringify(DEFAULT_VOCABULARY)],
  );
  const pipeline = (await db.query("SELECT id, db_url_enc FROM pipelines WHERE customer_id = $1 AND key = $2", [customerId, DEFAULT_PIPELINE.key]))
    .rows[0] as { id: string; db_url_enc: string | null } | undefined;
  if (!pipeline) throw new StepFailed("pipeline");

  // 3. The CRM in the shared database, unless an earlier run already built and stored it.
  const ownerKey = ownerKeyFor(signup.name, customerId);
  if (pipeline.db_url_enc === null) {
    const built = await provision({
      customerId,
      vocabulary: { ...DEFAULT_VOCABULARY, owners: [{ key: ownerKey, name: signup.name }] },
      defaultRole: DEFAULT_PIPELINE.defaultRole,
    });
    const stored = await db.query(
      "UPDATE pipelines SET db_url_enc = $1, shared_schema = $2, connected_at = now() WHERE id = $3 AND customer_id = $4",
      [encryptSecret(built.dbUrl, customerId, `pipeline:${pipeline.id}`), built.schema, pipeline.id, customerId],
    );
    if (stored.rowCount !== 1) throw new StepFailed("store");
  }

  // 4. The person and the approval together, under the lock every Google-id decision takes.
  return inTransaction(db, async (): Promise<Outcome> => {
    await db.query("SELECT pg_advisory_xact_lock(hashtext('monsoon:signups'))");
    const approved = await db.query("UPDATE signups SET status = 'approved', decided_at = now() WHERE id = $1 AND status = 'pending' AND customer_id = $2", [
      id,
      customerId,
    ]);
    if (approved.rowCount !== 1) {
      // Declined, or its Google id linked to an existing person, while the CRM was being built.
      // Nothing was changed here and nothing is removed; nobody gets in through this request.
      const now = await db.query("SELECT status FROM signups WHERE id = $1", [id]);
      if (now.rows[0]?.status === "linked") return { ok: false, reason: "not_found" };
      if (now.rows[0]?.status !== "declined") throw new StepFailed("state");
      return { ok: false, reason: "declined" };
    }
    const holder = await db.query("SELECT id, customer_id FROM people WHERE google_sub = $1", [signup.google_sub]);
    let personId: string;
    if (holder.rowCount) {
      if (holder.rows[0].customer_id !== customerId) throw new StepFailed("person");
      personId = holder.rows[0].id as string;
    } else {
      const p = await db.query("INSERT INTO people (customer_id, display_name, owner_key, google_sub) VALUES ($1, $2, $3, $4) RETURNING id", [
        customerId,
        signup.name,
        ownerKey,
        signup.google_sub,
      ]);
      personId = p.rows[0].id as string;
    }
    await db.query("UPDATE customers SET key_person_id = $2 WHERE id = $1", [customerId, personId]);
    return { ok: true, customerId: customerId as string, already: false, email: signup.email, name: signup.name, personId };
  });
}

/** The default `recordInCrm`: a contact with a note in the Zero One CRM, as the alpha sign-up made. */
async function recordInZeroOne(who: { email: string; name: string }): Promise<void> {
  await withCustomerPipelineDb("quantcloud", "zeroone", async (db) => {
    await recordAlphaSignup(db, who.email, "VF", { name: who.name, note: APPROVED_NOTE });
  });
}

function logFailure(err: unknown): void {
  // The step, or the provisioning failure and Postgres's code. Never a message: it can carry an address.
  const what =
    err instanceof ProvisionError ? `${err.failure}${err.sqlState ? ` ${err.sqlState}` : ""}`
    : err instanceof StepFailed ? err.step
    : `${err instanceof Error ? err.name : "error"} ${String((err as { code?: unknown })?.code ?? "").slice(0, 5)}`.trim();
  console.error(`monsoon: approve failed (${what})`);
}

/**
 * Approves the request `id`. `busy` when another approval of the same request is running right now
 * (it is not waited for). `failed` leaves the request pending; calling again finishes it.
 */
export async function approveSignup(id: string, deps: ApproveDeps = {}): Promise<ApproveResult> {
  if (typeof id !== "string" || !UUID.test(id)) return { ok: false, reason: "not_found" };
  const provision = deps.provision ?? provisionSharedCrm;

  let outcome: Outcome;
  try {
    // One connection holds a transaction-long lock for this request while a second does the work,
    // so each step is committed as it finishes and a second caller is turned away at once.
    outcome = await withAccountsDb(async (lock) => {
      await lock.query("BEGIN");
      try {
        const got = await lock.query("SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS got", [`monsoon:approve:${id.toLowerCase()}`]);
        if (got.rows[0].got !== true) return { ok: false, reason: "busy" } as Outcome;
        return await withAccountsDb((db) => run(db, id, provision));
      } finally {
        await lock.query("ROLLBACK").catch(() => undefined);
      }
    });
  } catch (err) {
    logFailure(err);
    return { ok: false, reason: "failed" };
  }
  if (!outcome.ok) return { ok: false, reason: outcome.reason };
  if (outcome.already) return { ok: true, customerId: outcome.customerId, already: true };

  await recordActivity({
    customerId: deps.approver?.customerId ?? outcome.customerId,
    personId: deps.approver?.personId ?? outcome.personId ?? null,
    pipelineKey: null,
    action: "approve",
  });

  // Best effort, and never for long: the approval is already done.
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const record = (deps.recordInCrm ?? recordInZeroOne)({ email: outcome.email ?? "", name: outcome.name ?? "" });
    record.catch(() => undefined);
    await Promise.race([
      record,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, deps.crmCapMs ?? CRM_CAP_MS);
      }),
    ]);
  } catch {
    console.error("monsoon: approve could not record the contact");
  } finally {
    if (timer) clearTimeout(timer);
  }

  return { ok: true, customerId: outcome.customerId, already: false };
}
