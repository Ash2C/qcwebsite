// Reads a JSON request body under a byte cap. The cap holds even when Content-Length is missing
// or understated: the stream is read chunk by chunk and abandoned as soon as it is exceeded.
export type JsonResult = { ok: true; body: unknown } | { ok: false; response: Response };

function fail(error: string, status: number): { ok: false; response: Response } {
  return { ok: false, response: Response.json({ error }, { status }) };
}

export async function readJson(request: Request, maxBytes: number): Promise<JsonResult> {
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    if (!/^\d+$/.test(declared.trim()) || Number(declared) > maxBytes) return fail("Request too large", 413);
  }

  const chunks: Uint8Array[] = [];
  let total = 0;
  if (request.body) {
    const reader = request.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel().catch(() => undefined);
          return fail("Request too large", 413);
        }
        chunks.push(value);
      }
    } catch {
      return fail("Invalid JSON", 400);
    }
  }

  const bytes = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  try {
    return { ok: true, body: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) };
  } catch {
    return fail("Invalid JSON", 400);
  }
}
