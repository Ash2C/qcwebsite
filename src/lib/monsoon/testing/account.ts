// Route-test helpers for the signed-in Account. In a route test:
//
//   vi.mock("@/lib/monsoon/accounts/account", async () =>
//     (await import("@/lib/monsoon/testing/account")).mockRequireAccount(),
//   );
//   import { fakeAccount, signInAs, signOut } from "@/lib/monsoon/testing/account";
//
//   signInAs(fakeAccount({ db, claude }));   // requireAccount now returns this account
//   signOut();                               // requireAccount now answers 401
import type Anthropic from "@anthropic-ai/sdk";
import type { Client } from "pg";
import { vi } from "vitest";
import type { Account, PipelineInfo } from "../accounts/account";
import { NotConnected } from "../accounts/not-connected";

type Refusal = () => Response;

const unauthorized: Refusal = () => Response.json({ error: "unauthorized" }, { status: 401 });

// What the mocked requireAccount answers next. A function, so each call gets a fresh Response.
let current: Account | Refusal = unauthorized;

export type FakeAccountOptions = {
  customer?: Partial<Account["customer"]>;
  person?: Partial<Account["person"]>;
  pipelines?: PipelineInfo[];
  /** Passed to every withDb callback (for a connected pipeline). */
  db?: unknown;
  /** Returned by anthropic(). Without it anthropic() throws NotConnected. */
  claude?: unknown;
  model?: string;
  /** Whether this person may change the Claude key (default false). */
  canChangeKey?: boolean;
};

export function fakeAccount(over: FakeAccountOptions = {}): Account {
  const pipelines = over.pipelines ?? [{ key: "main", label: "Main", defaultRole: "investor", connected: true }];
  const model = over.model ?? "claude-haiku-5-5";
  const pipeline = (key: unknown) => (typeof key === "string" ? pipelines.find((p) => p.key === key) : undefined);
  return {
    customer: { id: "00000000-0000-4000-8000-000000000001", code: "test-co", name: "Test Co", model, ...over.customer },
    person: { id: "00000000-0000-4000-8000-000000000002", name: "Vincent", ownerKey: "VF", ...over.person },
    pipelines,
    pipeline,
    async withDb<T>(key: string, fn: (db: Client) => Promise<T>): Promise<T> {
      if (!pipeline(key)?.connected) throw new NotConnected("Pipeline");
      return fn(over.db as Client);
    },
    anthropic() {
      if (over.claude === undefined) throw new NotConnected("Claude key");
      return over.claude as Anthropic;
    },
    model: () => model,
    record: vi.fn(async () => undefined),
    canChangeKey: over.canChangeKey ?? false,
    noteClaude: vi.fn(async () => undefined),
  };
}

/** Makes the mocked requireAccount return this account. Returns it for convenience. */
export function signInAs(account: Account = fakeAccount()): Account {
  current = account;
  return account;
}

/** Makes the mocked requireAccount refuse (401 by default). */
export function signOut(refusal: Refusal = unauthorized): void {
  current = refusal;
}

/** The module replacement for `@/lib/monsoon/accounts/account` (use as a vi.mock factory result). */
export function mockRequireAccount() {
  return {
    NotConnected,
    CRM_SCHEMA_VERSION: 1,
    requireAccount: vi.fn(async (_request: Request) =>
      typeof current === "function"
        ? { ok: false as const, response: current() }
        : { ok: true as const, account: current },
    ),
  };
}
