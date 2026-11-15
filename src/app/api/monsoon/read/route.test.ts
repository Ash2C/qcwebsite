import type { MockInstance } from "vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const extractCards = vi.fn();
vi.mock("@/lib/monsoon/extract", () => ({
  extractCards: (...args: unknown[]) => extractCards(...args),
}));

const matchCards = vi.fn();
vi.mock("@/lib/monsoon/match", () => ({
  matchCards: (...args: unknown[]) => matchCards(...args),
}));
const FAKE_DB = { fake: true };
const FAKE_CLAUDE = { fake: "claude" };
const PIPELINES = [
  { key: "traxo", label: "Traxo", defaultRole: "lp_prospect", connected: true },
  { key: "zeroone", label: "Zero One", defaultRole: "investor", connected: true },
];
let withDb: MockInstance<Account["withDb"]>;

vi.mock("@/lib/monsoon/accounts/account", async () =>
  (await import("@/lib/monsoon/testing/account")).mockRequireAccount(),
);
import type { Account } from "@/lib/monsoon/accounts/account";
import { fakeAccount, signInAs, signOut } from "@/lib/monsoon/testing/account";
import { POST } from "./route";

const FIELDS = {
  name: "Jane Tan",
  title: "",
  org: "Acme",
  email: "",
  phone: "",
  linkedin: "",
  raw_text: "JANE TAN",
};

async function post(
  form: FormData | null,
  contentLength?: string | null
): Promise<Request> {
  // Serialise once to get the real multipart body, type and length.
  const probe = new Request("http://localhost/api/monsoon/read", {
    method: "POST",
    body: form ?? new FormData(),
  });
  const body = await probe.arrayBuffer();
  const headers: Record<string, string> = {
    "Content-Type": probe.headers.get("content-type") ?? "",
  };
  if (contentLength !== null) {
    headers["Content-Length"] = contentLength ?? String(body.byteLength);
  }
  return new Request("http://localhost/api/monsoon/read", {
    method: "POST",
    body,
    headers,
  });
}

function formWith(file: Blob, name = "card"): FormData {
  const form = new FormData();
  form.append("image", file, name);
  return form;
}

beforeEach(() => {
  extractCards.mockReset();
  matchCards.mockReset();
  const account = fakeAccount({ pipelines: PIPELINES, db: FAKE_DB, claude: FAKE_CLAUDE, model: "claude-test-1" });
  withDb = vi.spyOn(account, "withDb");
  signInAs(account);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("POST /api/monsoon/read", () => {
  it("returns 401 when requireAccount refuses and does not extract", async () => {
    signOut();
    const res = await POST(await post(formWith(new Blob(["a"], { type: "image/jpeg" }))));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
    expect(extractCards).not.toHaveBeenCalled();
  });

  it("returns 400 when the image field is missing", async () => {
    const res = await POST(await post(null));
    expect(res.status).toBe(400);
    expect(extractCards).not.toHaveBeenCalled();
  });

  it("returns 415 for a type that is not jpeg, png or webp", async () => {
    const res = await POST(await post(formWith(new Blob(["a"], { type: "text/plain" }))));
    expect(res.status).toBe(415);
    expect(extractCards).not.toHaveBeenCalled();
  });

  it("returns 413 for a file over 3,700,000 bytes", async () => {
    const big = new Blob([new Uint8Array(3_700_001)], { type: "image/jpeg" });
    const res = await POST(await post(formWith(big)));
    expect(res.status).toBe(413);
    expect(extractCards).not.toHaveBeenCalled();
  });

  it("returns 411 when Content-Length is missing or not a number", async () => {
    const file = formWith(new Blob(["a"], { type: "image/jpeg" }));
    expect((await POST(await post(file, null))).status).toBe(411);
    expect((await POST(await post(file, "abc"))).status).toBe(411);
    expect(extractCards).not.toHaveBeenCalled();
  });

  it("returns 413 from Content-Length alone, before parsing the body", async () => {
    const file = formWith(new Blob(["a"], { type: "image/jpeg" }));
    const req = await post(file, "3800001");
    const spy = vi.spyOn(req, "formData");
    const res = await POST(req);
    expect(res.status).toBe(413);
    expect(spy).not.toHaveBeenCalled();
    expect(extractCards).not.toHaveBeenCalled();
  });

  it("returns 200 with an empty list when no card is found", async () => {
    extractCards.mockResolvedValue([]);
    const res = await POST(await post(formWith(new Blob(["ABC"], { type: "image/jpeg" }))));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ cards: [], matches: null });
  });

  it("returns the extracted cards for a small jpeg", async () => {
    extractCards.mockResolvedValue([FIELDS]);
    const res = await POST(await post(formWith(new Blob(["ABC"], { type: "image/jpeg" }))));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ cards: [FIELDS], matches: null });
    // The account's own client and model, never a client built from the environment.
    expect(extractCards).toHaveBeenCalledWith(FAKE_CLAUDE, "claude-test-1", {
      base64: Buffer.from("ABC").toString("base64"),
      mediaType: "image/jpeg",
    });
  });

  it("returns 502 with the generic body when the customer has no Claude key, without reading", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    signInAs(fakeAccount({ pipelines: PIPELINES, db: FAKE_DB }));
    const res = await POST(await post(formWith(new Blob(["ABC"], { type: "image/png" }))));
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "Could not read the photo" });
    expect(extractCards).not.toHaveBeenCalled();
  });

  it("returns 502 with the generic body when the model is refused", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const account = fakeAccount({ pipelines: PIPELINES, claude: FAKE_CLAUDE });
    account.model = () => {
      throw new Error("This model is not allowed for this customer");
    };
    signInAs(account);
    const res = await POST(await post(formWith(new Blob(["ABC"], { type: "image/png" }))));
    expect(res.status).toBe(502);
    expect(extractCards).not.toHaveBeenCalled();
  });

  it("returns 502 with a generic body when extraction fails, logging only the error name", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    extractCards.mockRejectedValue(new TypeError("secret detail"));
    const res = await POST(await post(formWith(new Blob(["ABC"], { type: "image/png" }))));
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "Could not read the photo" });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(spy.mock.calls)).not.toContain("secret detail");
  });

  it("logs the numeric status when the error has one, still without the message", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    extractCards.mockRejectedValue(Object.assign(new Error("secret detail"), { status: 429 }));
    const res = await POST(await post(formWith(new Blob(["ABC"], { type: "image/png" }))));
    expect(res.status).toBe(502);
    expect(spy.mock.calls[0]).toContain(429);
    expect(JSON.stringify(spy.mock.calls)).not.toContain("secret detail");
  });

  it("accepts a file of exactly 3,700,000 bytes", async () => {
    extractCards.mockResolvedValue([FIELDS]);
    const ok = new Blob([new Uint8Array(3_700_000)], { type: "image/jpeg" });
    expect((await POST(await post(formWith(ok)))).status).toBe(200);
  });

  describe("match before save", () => {
    const MATCH = { match: "exact", candidates: [] };
    const photo = (estate?: string) => {
      const form = formWith(new Blob(["ABC"], { type: "image/jpeg" }));
      if (estate !== undefined) form.append("estate", estate);
      return form;
    };

    it("answers matches: null and opens no database when no estate is sent", async () => {
      extractCards.mockResolvedValue([FIELDS]);
      const res = await POST(await post(photo()));
      expect(await res.json()).toEqual({ cards: [FIELDS], matches: null });
      expect(withDb).not.toHaveBeenCalled();
      expect(matchCards).not.toHaveBeenCalled();
    });

    it("matches each card's name, org and email for a valid estate and returns the result", async () => {
      const second = { ...FIELDS, name: "Omar Reyes", org: "Northwind", email: "o@n.example" };
      extractCards.mockResolvedValue([FIELDS, second]);
      matchCards.mockResolvedValue([MATCH, { match: "none", candidates: [] }]);
      const res = await POST(await post(photo("traxo")));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ cards: [FIELDS, second], matches: [MATCH, { match: "none", candidates: [] }] });
      expect(withDb).toHaveBeenCalledTimes(1);
      expect(withDb.mock.calls[0][0]).toBe("traxo");
      expect(matchCards).toHaveBeenCalledWith(
        FAKE_DB,
        [
          { name: "Jane Tan", org: "Acme", email: "" },
          { name: "Omar Reyes", org: "Northwind", email: "o@n.example" },
        ],
        { timeoutMs: 3000 }
      );
    });

    it("answers matches: null for an estate that is not one of the account's pipelines", async () => {
      extractCards.mockResolvedValue([FIELDS]);
      signInAs(fakeAccount({ pipelines: [PIPELINES[0]], db: FAKE_DB, claude: FAKE_CLAUDE }));
      const res = await POST(await post(photo("zeroone")));
      expect(await res.json()).toEqual({ cards: [FIELDS], matches: null });
    });

    it("records no activity for a read", async () => {
      const account = fakeAccount({ pipelines: PIPELINES, db: FAKE_DB, claude: FAKE_CLAUDE });
      signInAs(account);
      extractCards.mockResolvedValue([FIELDS]);
      matchCards.mockResolvedValue([{ match: "none", candidates: [] }]);
      await POST(await post(photo("traxo")));
      expect(account.record).not.toHaveBeenCalled();
    });

    it("answers matches: null for an unknown estate", async () => {
      extractCards.mockResolvedValue([FIELDS]);
      const res = await POST(await post(photo("nowhere")));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ cards: [FIELDS], matches: null });
      expect(withDb).not.toHaveBeenCalled();
    });

    it("answers matches: null and opens no database when no card was read", async () => {
      extractCards.mockResolvedValue([]);
      const res = await POST(await post(photo("traxo")));
      expect(await res.json()).toEqual({ cards: [], matches: null });
      expect(withDb).not.toHaveBeenCalled();
    });

    it("keeps the cards when the match fails, logging only the error name and code", async () => {
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      extractCards.mockResolvedValue([FIELDS]);
      withDb.mockRejectedValue(Object.assign(new TypeError("password=secret detail"), { code: "28P01" }));
      const res = await POST(await post(photo("traxo")));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ cards: [FIELDS], matches: null });
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0]).toContain("TypeError");
      expect(spy.mock.calls[0]).toContain("28P01");
      expect(JSON.stringify(spy.mock.calls)).not.toContain("secret detail");
    });

    it("keeps the cards when matchCards itself rejects", async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      extractCards.mockResolvedValue([FIELDS]);
      matchCards.mockRejectedValue(new Error("boom"));
      const res = await POST(await post(photo("zeroone")));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ cards: [FIELDS], matches: null });
    });

    it("gives up on a hung lookup after 3,000 ms and keeps the cards", async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      extractCards.mockResolvedValue([FIELDS]);
      withDb.mockImplementation(() => new Promise(() => {}));
      const req = await post(photo("traxo"));
      vi.useFakeTimers();
      try {
        const pending = POST(req);
        // The budget timer exists only once the lookup has started: wait for that, then run it out.
        await vi.waitFor(() => expect(withDb).toHaveBeenCalled());
        await vi.advanceTimersByTimeAsync(3000);
        const res = await pending;
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ cards: [FIELDS], matches: null });
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
