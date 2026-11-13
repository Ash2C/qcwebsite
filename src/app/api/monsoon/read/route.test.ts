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

async function post(
  form: FormData | null,
  authenticated = true,
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
  if (authenticated) headers.Cookie = `monsoon_session=${signSession()}`;
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
    const res = await POST(await post(formWith(new Blob(["a"], { type: "image/jpeg" })), false)
    );
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
    expect(extractCard).not.toHaveBeenCalled();
  });

  it("returns 400 when the image field is missing", async () => {
    const res = await POST(await post(null));
    expect(res.status).toBe(400);
    expect(extractCard).not.toHaveBeenCalled();
  });

  it("returns 415 for a type that is not jpeg, png or webp", async () => {
    const res = await POST(await post(formWith(new Blob(["a"], { type: "text/plain" }))));
    expect(res.status).toBe(415);
    expect(extractCard).not.toHaveBeenCalled();
  });

  it("returns 413 for a file over 4,000,000 bytes", async () => {
    const big = new Blob([new Uint8Array(4_000_001)], { type: "image/jpeg" });
    const res = await POST(await post(formWith(big)));
    expect(res.status).toBe(413);
    expect(extractCard).not.toHaveBeenCalled();
  });

  it("returns 411 when Content-Length is missing or not a number", async () => {
    const file = formWith(new Blob(["a"], { type: "image/jpeg" }));
    expect((await POST(await post(file, true, null))).status).toBe(411);
    expect((await POST(await post(file, true, "abc"))).status).toBe(411);
    expect(extractCard).not.toHaveBeenCalled();
  });

  it("returns 413 from Content-Length alone, before parsing the body", async () => {
    const file = formWith(new Blob(["a"], { type: "image/jpeg" }));
    const req = await post(file, true, "4100001");
    const spy = vi.spyOn(req, "formData");
    const res = await POST(req);
    expect(res.status).toBe(413);
    expect(spy).not.toHaveBeenCalled();
    expect(extractCard).not.toHaveBeenCalled();
  });

  it("returns the extracted fields for a small jpeg", async () => {
    extractCard.mockResolvedValue(FIELDS);
    const res = await POST(await post(formWith(new Blob(["ABC"], { type: "image/jpeg" }))));
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
    const res = await POST(await post(formWith(new Blob(["ABC"], { type: "image/png" }))));
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "Could not read the photo" });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(spy.mock.calls)).not.toContain("secret detail");
  });
});
