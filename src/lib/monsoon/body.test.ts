import { describe, expect, it } from "vitest";
import { readJson } from "./body";

function streamed(chunks: string[], headers: Record<string, string> = {}, onPull?: () => void): Request {
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      onPull?.();
      const next = chunks.shift();
      if (next === undefined) controller.close();
      else controller.enqueue(enc.encode(next));
    },
  });
  return new Request("http://localhost/x", {
    method: "POST",
    body: stream,
    headers,
    duplex: "half",
  } as RequestInit);
}

describe("readJson", () => {
  it("parses a small JSON body", async () => {
    const r = await readJson(new Request("http://localhost/x", { method: "POST", body: '{"a":1}' }), 100);
    expect(r).toEqual({ ok: true, body: { a: 1 } });
  });

  it("parses a body that arrives in several chunks", async () => {
    const r = await readJson(streamed(['{"a":', '"é', 'x"}']), 100);
    expect(r).toEqual({ ok: true, body: { a: "éx" } });
  });

  it("answers 413 for a declared Content-Length over the cap without reading", async () => {
    let pulled = false;
    const req = streamed(["{}"], { "content-length": "101" }, () => (pulled = true));
    await new Promise((resolve) => setTimeout(resolve, 10)); // let the stream prime itself
    pulled = false; // priming is not reading; only a read after this point counts
    const r = await readJson(req, 100);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.response.status).toBe(413);
      expect(await r.response.json()).toEqual({ error: "Request too large" });
    }
    expect(pulled).toBe(false);
  });

  it("answers 413 for a non-numeric Content-Length", async () => {
    const r = await readJson(streamed(["{}"], { "content-length": "abc" }), 100);
    expect(!r.ok && r.response.status).toBe(413);
    const r2 = await readJson(streamed(["{}"], { "content-length": "-5" }), 100);
    expect(!r2.ok && r2.response.status).toBe(413);
  });

  it("answers 413 when there is no Content-Length and the body is over the cap", async () => {
    const r = await readJson(streamed(["x".repeat(60), "x".repeat(60)]), 100);
    expect(!r.ok && r.response.status).toBe(413);
  });

  it("answers 413 for an understated Content-Length with a larger body, and stops reading", async () => {
    let pulls = 0;
    const chunks = Array.from({ length: 50 }, () => "x".repeat(10));
    const r = await readJson(streamed(chunks, { "content-length": "5" }, () => pulls++), 100);
    expect(!r.ok && r.response.status).toBe(413);
    expect(pulls).toBeLessThan(20);
  });

  it("accepts a body of exactly the cap", async () => {
    const body = JSON.stringify({ k: "x".repeat(10) });
    const cap = new TextEncoder().encode(body).length;
    const r = await readJson(new Request("http://localhost/x", { method: "POST", body }), cap);
    expect(r.ok).toBe(true);
  });

  it("answers 400 for invalid JSON and for an empty body", async () => {
    for (const body of ["{", ""]) {
      const r = await readJson(new Request("http://localhost/x", { method: "POST", body }), 100);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.response.status).toBe(400);
        expect(await r.response.json()).toEqual({ error: "Invalid JSON" });
      }
    }
    const none = await readJson(new Request("http://localhost/x", { method: "POST" }), 100);
    expect(!none.ok && none.response.status).toBe(400);
  });
});
