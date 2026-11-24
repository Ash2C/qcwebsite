import { beforeEach, describe, expect, it, vi } from "vitest";

const lib = { addUserNote: vi.fn(), saveUserPage: vi.fn(), loadUserPage: vi.fn() };
// The parser is the real one: the route must pass its messages through untouched.
vi.mock("@/lib/monsoon/accounts/profile", async (original) => ({
  ...(await original<typeof import("@/lib/monsoon/accounts/profile")>()),
  loadUserPage: (...a: unknown[]) => lib.loadUserPage(...a),
  saveUserPage: (...a: unknown[]) => lib.saveUserPage(...a),
  addUserNote: (...a: unknown[]) => lib.addUserNote(...a),
}));
vi.mock("@/lib/monsoon/accounts/account", async () =>
  (await import("@/lib/monsoon/testing/account")).mockRequireAccount(),
);
import { fakeAccount, signInAs, signOut } from "@/lib/monsoon/testing/account";
import { POST } from "./route";

const CUSTOMER = "00000000-0000-4000-8000-000000000001";
const PERSON = "00000000-0000-4000-8000-000000000002";
const WHO = { customerId: CUSTOMER, personId: PERSON };
const OTHER = "99999999-9999-4999-8999-999999999999";
const PAGE = {
  person: { name: "Vincent", phone: null, email: null },
  work: { company: null, website: null, roleObjectives: null },
  notes: [{ id: "n1", body: "Focus on Asia", at: "2026-11-24T10:00:00.000Z" }],
  notesTotal: 1,
};

const post = (body: unknown) =>
  new Request("http://localhost/api/monsoon/me/notes", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

beforeEach(() => {
  vi.restoreAllMocks();
  for (const f of Object.values(lib)) f.mockReset();
  lib.addUserNote.mockResolvedValue(PAGE);
  signInAs(fakeAccount());
});

describe("POST /api/monsoon/me/notes", () => {
  it("answers 401 when signed out, and adds nothing", async () => {
    signOut();
    expect((await POST(post({ estate: "main", body: "Focus on Asia" }))).status).toBe(401);
    expect(lib.addUserNote).not.toHaveBeenCalled();
  });

  it("adds the trimmed note for the signed-in person and returns the page, uncached", async () => {
    const res = await POST(post({ estate: "main", body: "  Focus on Asia\nthis quarter  " }));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ page: PAGE });
    expect(lib.addUserNote).toHaveBeenCalledTimes(1);
    expect(lib.addUserNote).toHaveBeenCalledWith(WHO, "main", "Focus on Asia\nthis quarter");
    expect(lib.saveUserPage).not.toHaveBeenCalled();
  });

  it("takes the person and customer from the session, whatever ids the body carries", async () => {
    await POST(post({ estate: "main", body: "Focus on Asia", personId: OTHER, customerId: OTHER, id: OTHER }));
    expect(lib.addUserNote).toHaveBeenCalledWith(WHO, "main", "Focus on Asia");
    expect(JSON.stringify(lib.addUserNote.mock.calls)).not.toContain(OTHER);
  });

  it("answers 400 for an estate that is not this customer's", async () => {
    lib.addUserNote.mockResolvedValue(null);
    const res = await POST(post({ estate: "someone-elses", body: "Focus on Asia" }));
    expect(res.status).toBe(400);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ error: "Unknown estate" });
  });

  it("answers 400 without adding when the estate is missing or not text", async () => {
    for (const estate of [undefined, "", 7, null, "k".repeat(201)]) {
      const res = await POST(post({ estate, body: "Focus on Asia" }));
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "Unknown estate" });
    }
    expect(lib.addUserNote).not.toHaveBeenCalled();
  });

  it("answers 400 with the parser's own message for an invalid note, and adds nothing", async () => {
    const cases: [unknown, string][] = [
      ["", "Write a note first"],
      ["   \n  ", "Write a note first"],
      [undefined, "Write a note first"],
      [{ text: "a note" }, "Write a note first"],
      ["n".repeat(2001), "The note is too long (2,000 characters at most)"],
    ];
    for (const [body, error] of cases) {
      const res = await POST(post({ estate: "main", body }));
      expect(res.status).toBe(400);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(await res.json()).toEqual({ error });
    }
    expect(lib.addUserNote).not.toHaveBeenCalled();
  });

  it("answers 400 for a body that is not a JSON object, or is over 16,000 bytes", async () => {
    for (const body of ["{not json", "[]", "null", JSON.stringify({ estate: "main", body: "n".repeat(16_001) })]) {
      const res = await POST(post(body));
      expect(res.status).toBe(400);
      expect(res.headers.get("cache-control")).toBe("no-store");
    }
    expect(lib.addUserNote).not.toHaveBeenCalled();
  });

  it("answers 502 and logs no message text when adding fails", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    lib.addUserNote.mockRejectedValue(new Error("insert failed: Focus on Asia"));
    const res = await POST(post({ estate: "main", body: "Focus on Asia" }));
    expect(res.status).toBe(502);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ error: "Could not reach the accounts database" });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(spy.mock.calls)).not.toContain("Focus on Asia");
  });
});

describe("route config", () => {
  it("runs on node, uncached, capped at 30 seconds", async () => {
    const mod = await import("./route");
    expect(mod.runtime).toBe("nodejs");
    expect(mod.dynamic).toBe("force-dynamic");
    expect(mod.maxDuration).toBe(30);
  });
});
