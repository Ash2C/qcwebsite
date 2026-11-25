// The free trial: a new client's AI features run on one Claude key held by the server
// (MONSOON_TRIAL_CLAUDE_KEY) for 14 days or 150 AI uses, whichever comes first. With that setting
// empty there is no trial for anyone. The clock starts at the first sign-in made while the key is
// set, or else at the first AI request. The key is read from the environment where it is used and is
// never stored, returned, shown (not even in part) or logged. A customer whose trial_uses_limit is
// NULL (everyone from before sign-up) never has a trial.
import type { Client } from "pg";
import { TrialPaused } from "./not-connected";
import { withAccountsDb, type ClaudeStatus } from "./store";

export const TRIAL_USES = 150;
export const TRIAL_DAYS = 14;

/** One AI request by a person. All kinds count the same. */
export type AiKind = "read" | "ask" | "tidy" | "research";

/** A failing trial key is tried again (by one request) only this often; a healthy one is re-noted this often. */
const HEALTH_INTERVAL = "1 minute";
const OK_NOTE_MS = 60_000;

/** The trial key, or null when there is no trial. For the one place that builds the Claude client. */
export function trialKey(): string | null {
  const key = (process.env.MONSOON_TRIAL_CLAUDE_KEY ?? "").trim();
  return key === "" ? null : key;
}

// A customer ($1) whose trial is live right now: active, no key of its own, given a trial, the
// clock started and not run out, and uses left. An own key always wins.
const LIVE = `c.id = $1 AND c.status = 'active' AND c.claude_key_enc IS NULL
  AND c.trial_uses_limit IS NOT NULL AND c.trial_started_at IS NOT NULL
  AND c.trial_started_at <= now() AND now() < c.trial_ends_at
  AND (SELECT count(*) FROM trial_uses u WHERE u.customer_id = c.id) < c.trial_uses_limit`;

const NOT_ON_TRIAL = { granted: false, probe: false } as const;

/** Never throws; logs the error class name only. */
function logFailure(what: string, err: unknown): void {
  console.error(`monsoon: ${what} failed (${err instanceof Error ? err.constructor.name : "Error"})`);
}

// Starts the clock once only, and only for a customer ($1) who was given a trial.
const START_CLOCK = `UPDATE customers
    SET trial_started_at = now(), trial_ends_at = now() + make_interval(days => $2)
  WHERE id = $1 AND trial_uses_limit IS NOT NULL AND trial_started_at IS NULL`;

/**
 * Starts the trial clock at a person's sign-in: once only, and only for a customer who was given a
 * trial. Does nothing while there is no trial key, so the days do not run before the AI works (a
 * client who signed in before there was a key gets the clock started by beginTrialUse instead).
 * Never throws: a failure here must not stop a sign-in.
 */
export async function startTrialClock(customerId: string): Promise<void> {
  if (trialKey() === null) return;
  try {
    await withAccountsDb((db) => db.query(START_CLOCK, [customerId, TRIAL_DAYS]));
  } catch (err) {
    logFailure("startTrialClock", err);
  }
}

/**
 * The step before a Claude call for a customer with no key of its own. When the customer's trial is
 * live it records one use and answers `granted`; otherwise it records nothing and the caller carries
 * on as for a missing key. The use is written first and counted after, so parallel requests cannot
 * all slip under the limit (the last few in flight may; never more).
 *
 * A client who signed in before there was a trial key has no clock yet: their first AI request
 * starts it here, once only.
 *
 * While the trial key is known to be failing this throws TrialPaused without recording a use, except
 * for one request a minute, which is let through to try the key again (`probe`).
 */
export async function beginTrialUse(customerId: string, personId: string | null, kind: AiKind): Promise<{ granted: boolean; probe: boolean }> {
  if (trialKey() === null) return NOT_ON_TRIAL;
  return withAccountsDb(async (db) => {
    await db.query(`${START_CLOCK} AND status = 'active' AND claude_key_enc IS NULL`, [customerId, TRIAL_DAYS]);
    const live = await db.query(`SELECT 1 FROM customers c WHERE ${LIVE}`, [customerId]);
    if (live.rowCount !== 1) return NOT_ON_TRIAL;

    let probe = false;
    const health = await db.query("SELECT status FROM trial_key_health WHERE id");
    if (health.rows[0] && health.rows[0].status !== "ok") {
      // One statement decides who tries the key again, so parallel requests cannot all try it.
      const claim = await db.query(
        `UPDATE trial_key_health SET checked_at = now()
          WHERE id AND status <> 'ok' AND checked_at < now() - interval '${HEALTH_INTERVAL}'`,
      );
      if (claim.rowCount !== 1) throw new TrialPaused();
      probe = true;
    }

    const use = await db.query(
      `INSERT INTO trial_uses (customer_id, person_id, kind) SELECT c.id, $2, $3 FROM customers c WHERE ${LIVE} RETURNING id`,
      [customerId, personId, kind],
    );
    if (use.rowCount !== 1) return NOT_ON_TRIAL;
    const within = await db.query(
      `SELECT count(*) <= (SELECT trial_uses_limit FROM customers WHERE id = $1) AS ok
         FROM trial_uses WHERE customer_id = $1 AND id <= $2`,
      [customerId, use.rows[0].id],
    );
    return { granted: within.rows[0]?.ok === true, probe };
  });
}

// When this server instance last wrote (or confirmed) a healthy trial key.
let okNotedAt = 0;

/** For tests: forgets when a healthy key was last noted. */
export function resetTrialMemo(): void {
  okNotedAt = 0;
}

/**
 * Records the result of a real call made with the trial key. `ok` is written at most once a minute
 * unless `force` (the call was the one trying a failing key again). Never throws.
 */
export async function noteTrialKey(status: ClaudeStatus, force = false): Promise<void> {
  if (status === "ok" && !force && Date.now() - okNotedAt < OK_NOTE_MS) return;
  try {
    await withAccountsDb((db) =>
      db.query(
        `INSERT INTO trial_key_health (id, status, checked_at) VALUES (true, $1, now())
         ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status, checked_at = now()`,
        [status],
      ),
    );
    okNotedAt = status === "ok" ? Date.now() : 0;
  } catch (err) {
    logFailure("noteTrialKey", err);
  }
}

/** For Vincent's Requests screen: `unset` with no trial key, otherwise the result of its last real call. */
export async function trialKeyHealth(): Promise<"unset" | ClaudeStatus> {
  if (trialKey() === null) return "unset";
  return withAccountsDb(async (db) => {
    const r = await db.query("SELECT status FROM trial_key_health WHERE id");
    return (r.rows[0]?.status as ClaudeStatus | undefined) ?? "ok";
  });
}

export type TrialState =
  | { state: "none" }
  | { state: "ended" }
  | { state: "live"; daysLeft: number; usesLeft: number; paused: boolean };

/**
 * Where a customer with no key of its own stands, for the key screen and the chip. `none` when
 * there is no trial key or the customer was never given a trial. A clock that has not started yet
 * (it starts at the first AI request) is the whole trial, still to come.
 */
export async function loadTrialState(db: Client, customerId: string): Promise<TrialState> {
  if (trialKey() === null) return { state: "none" };
  const r = await db.query(
    `SELECT c.trial_uses_limit AS use_limit,
            (SELECT count(*)::int FROM trial_uses u WHERE u.customer_id = c.id) AS used,
            c.trial_started_at IS NULL AS unstarted,
            extract(epoch FROM (c.trial_ends_at - now()))::float8 AS seconds_left,
            (SELECT status FROM trial_key_health WHERE id) AS health
       FROM customers c
      WHERE c.id = $1 AND c.claude_key_enc IS NULL AND c.trial_uses_limit IS NOT NULL
        AND (c.trial_started_at IS NULL OR c.trial_ends_at IS NOT NULL)`,
    [customerId],
  );
  const row = r.rows[0] as { use_limit: number; used: number; unstarted: boolean; seconds_left: number | null; health: string | null } | undefined;
  if (!row) return { state: "none" };
  const usesLeft = row.use_limit - row.used;
  const secondsLeft = row.unstarted ? TRIAL_DAYS * 86_400 : (row.seconds_left ?? 0);
  if (!(secondsLeft > 0) || usesLeft <= 0) return { state: "ended" };
  return {
    state: "live",
    daysLeft: Math.max(1, Math.ceil(secondsLeft / 86_400)),
    usesLeft,
    paused: row.health !== null && row.health !== "ok",
  };
}
