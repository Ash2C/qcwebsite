import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { signSession } from "@/lib/monsoon/auth";

const extractCard = vi.fn();
vi.mock("@/lib/monsoon/extract", () => ({
  extractCard: (...args: unknown[]) => extractCard(...args),
}));

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

function post(form: FormData | null, authenticated = true): Request {
  return new Request("http://localhost/api/monsoon/read", {
    method: "POST",
    body: form ?? new FormData(),
    headers: authenticated
      ? { Cookie: `monsoon_session=${signSession()}` }
      : {},
  });
}

function formWith(file: Blob, name = "card"): FormData {
  const form = new FormData();
  form.append("image", file, name);
  return form;
}

beforeEach(() => {
  extractCard.mockReset();
  vi.stubEnv("MONSOON_PASSCODE", "correct-horse-battery-staple");
  vi.stubEnv("MONSOON_SESSION_SECRET", "x".repeat(32));
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("POST /api/monsoon/read", () => {
  it("returns 401 without a session and does not extract", async () => {
    const res = await POST(
      post(formWith(new Blob(["a"], { type: "image/jpeg" })), false)
    );
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
    expect(extractCard).not.toHaveBeenCalled();
  });

  it("returns 400 when the image field is missing", async () => {
    const res = await POST(post(null));
    expect(res.status).toBe(400);
    expect(extractCard).not.toHaveBeenCalled();
  });

  it("returns 415 for a type that is not jpeg, png or webp", async () => {
    const res = await POST(post(formWith(new Blob(["a"], { type: "text/plain" }))));
    expect(res.status).toBe(415);
    expect(extractCard).not.toHaveBeenCalled();
  });

  it("returns 413 for a file over 4,000,000 bytes", async () => {
    const big = new Blob([new Uint8Array(4_000_001)], { type: "image/jpeg" });
    const res = await POST(post(formWith(big)));
    expect(res.status).toBe(413);
    expect(extractCard).not.toHaveBeenCalled();
  });

  it("returns the extracted fields for a small jpeg", async () => {
    extractCard.mockResolvedValue(FIELDS);
    const res = await POST(post(formWith(new Blob(["ABC"], { type: "image/jpeg" }))));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ fields: FIELDS });
    expect(extractCard).toHaveBeenCalledWith({
      base64: Buffer.from("ABC").toString("base64"),
      mediaType: "image/jpeg",
    });
  });

  it("returns 502 with a generic body when extraction fails, logging only the error name", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    extractCard.mockRejectedValue(new TypeError("secret detail"));
    const res = await POST(post(formWith(new Blob(["ABC"], { type: "image/png" }))));
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "Could not read the photo" });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(spy.mock.calls)).not.toContain("secret detail");
  });
});
