// What the three import routes share: the save route's error shapes.
import { NextResponse } from "next/server";
import { readJson } from "../body";

export function invalid(error: string, status = 400): NextResponse {
  return NextResponse.json({ outcome: "invalid", error }, { status });
}

/** The JSON body as an object, or the response to send instead (400 or 413, in the save route's shape). */
export async function readObject(
  request: Request,
  maxBytes: number,
): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false; response: NextResponse }> {
  const read = await readJson(request, maxBytes);
  if (!read.ok) {
    const tooLarge = read.response.status === 413;
    return { ok: false, response: invalid(tooLarge ? "Request too large" : "Invalid JSON", read.response.status) };
  }
  const body = read.body;
  if (typeof body !== "object" || body === null || Array.isArray(body)) return { ok: false, response: invalid("Invalid body") };
  return { ok: true, body: body as Record<string, unknown> };
}

/** Logs a failure by name and code only: the message can carry connection details or contact data. */
export function logFailure(what: string, err: unknown): void {
  const code = (err as { code?: unknown } | null)?.code;
  const status = (err as { status?: unknown } | null)?.status;
  console.error(
    `monsoon: ${what}`,
    err instanceof Error ? err.name : "error",
    typeof code === "string" && code.length === 5 ? code : typeof status === "number" ? status : "",
  );
}
