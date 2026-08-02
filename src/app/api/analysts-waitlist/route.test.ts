import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route";

const fetchMock = vi.fn();

function post(body: unknown): Request {
  return new Request("http://localhost/api/analysts-waitlist", {
    method: "POST",
    body: typeof body === "string" ? body : JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv(
    "ANALYSTS_WAITLIST_API_URL",
    "https://01.co/api/analysts-waitlist"
  );
  vi.stubEnv("ANALYSTS_INGEST_SECRET", "shared-secret");
});

describe("validation", () => {
  it("rejects invalid JSON without contacting the upstream service", async () => {
    const response = await POST(post("{"));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Invalid JSON" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects invalid steps and malformed email", async () => {
    expect((await POST(post({ step: 3, email: "a@b.co" }))).status).toBe(400);
    expect(
      (await POST(post({ step: 1, email: "not-an-email" }))).status
    ).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("silently accepts a filled honeypot without forwarding", async () => {
    const response = await POST(
      post({ step: 1, email: "bot@example.com", website: "spam" })
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("forwarding", () => {
  it("normalizes email, fixes the QC source, and authenticates step one", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );

    const response = await POST(
      post({
        step: 1,
        email: "  PM@Fund.com ",
        source: "spoofed-source",
        unexpected: "drop me",
      })
    );

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://01.co/api/analysts-waitlist");
    expect(init.cache).toBe("no-store");
    expect(init.headers).toEqual(
      expect.objectContaining({
        "Content-Type": "application/json",
        "x-analysts-ingest-secret": "shared-secret",
      })
    );
    expect(JSON.parse(init.body as string)).toEqual({
      step: 1,
      email: "pm@fund.com",
      source: "qc-website",
    });
  });

  it("forwards only allow-listed optional qualification fields", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );

    await POST(
      post({
        step: 2,
        email: "pm@fund.com",
        firmType: "research_advisory",
        universeSize: "30-75",
        channel: "secure_app",
        currentProcess: "Private-company and industry research",
        source: "zero-one",
        wantsBlade: true,
      })
    );

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({
      step: 2,
      email: "pm@fund.com",
      firmType: "research_advisory",
      universeSize: "30-75",
      channel: "secure_app",
      currentProcess: "Private-company and industry research",
      source: "qc-website",
    });
  });

  it("returns brand-neutral errors for upstream failure and missing config", async () => {
    fetchMock.mockRejectedValue(new Error("network down"));
    const unavailable = await POST(post({ step: 1, email: "pm@fund.com" }));
    expect(unavailable.status).toBe(502);
    expect(await unavailable.json()).toEqual({
      error: "Registration is temporarily unavailable. Please try again.",
    });

    vi.stubEnv("ANALYSTS_INGEST_SECRET", "");
    const missingConfig = await POST(post({ step: 1, email: "pm@fund.com" }));
    expect(missingConfig.status).toBe(503);
  });
});
