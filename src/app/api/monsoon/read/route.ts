import { NextResponse } from "next/server";
import { requireAccount } from "@/lib/monsoon/accounts/account";
import { extractCards } from "@/lib/monsoon/extract";
import { matchCards, type CardMatch } from "@/lib/monsoon/match";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const MAX_BYTES = 3_700_000;
// Allowance for multipart boundaries and headers around the file.
const MULTIPART_OVERHEAD = 100_000;
// The photo is read by now (the model call has its own 25 s limit), so the lookup gets a short budget.
const MATCH_TIMEOUT_MS = 3000;
const TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
type MediaType = (typeof TYPES)[number];

export async function POST(request: Request) {
  const auth = await requireAccount(request);
  if (!auth.ok) return auth.response;
  const { account } = auth;

  // Refuse oversized bodies before formData() buffers them.
  const header = request.headers.get("content-length");
  const length = header !== null && /^\d+$/.test(header.trim()) ? Number(header) : NaN;
  if (Number.isNaN(length)) {
    return NextResponse.json({ error: "Length required" }, { status: 411 });
  }
  if (length > MAX_BYTES + MULTIPART_OVERHEAD) {
    return NextResponse.json({ error: "Image too large" }, { status: 413 });
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: "Invalid form data" }, { status: 400 });
  }
  const file = form.get("image");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "image is required" }, { status: 400 });
  }
  if (!(TYPES as readonly string[]).includes(file.type)) {
    return NextResponse.json({ error: "Unsupported image type" }, { status: 415 });
  }
  // Checked from file.size, before the bytes are read into memory.
  if (file.size > MAX_BYTES) {
    return NextResponse.json({ error: "Image too large" }, { status: 413 });
  }

  try {
    const base64 = Buffer.from(await file.arrayBuffer()).toString("base64");
    // Resolved per request: the customer's own key and model (NotConnected without a key).
    const cards = await extractCards(account.anthropic({ timeout: 25_000 }), account.model(), {
      base64,
      mediaType: file.type as MediaType,
    });
    let matches: CardMatch[] | null = null;
    const estate = account.pipeline(form.get("estate"));
    if (estate && cards.length > 0) {
      try {
        const asked = cards.map((c) => ({ name: c.name, org: c.org, email: c.email }));
        // Race the whole lookup (connect included) against the budget, so a hung connection
        // cannot push the request past maxDuration.
        const lookup = account.withDb(estate.key, (db) => matchCards(db, asked, { timeoutMs: MATCH_TIMEOUT_MS }));
        lookup.catch(() => {}); // an abandoned lookup must not become an unhandled rejection
        let timer: ReturnType<typeof setTimeout> | undefined;
        const budget = new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("match timeout")), MATCH_TIMEOUT_MS);
        });
        try {
          matches = await Promise.race([lookup, budget]);
        } finally {
          clearTimeout(timer);
        }
      } catch (err) {
        // A failed match never fails the read. Name and code only: the message can carry
        // connection details or contact data.
        const status = (err as { status?: unknown })?.status;
        const code = (err as { code?: unknown })?.code;
        console.error(
          `monsoon: match failed for ${estate.key}`,
          err instanceof Error ? err.name : "error",
          typeof code === "string" && code.length === 5 ? code : typeof status === "number" ? status : ""
        );
      }
    }
    return NextResponse.json({ cards, matches });
  } catch (err) {
    // Error name only: never the photo, the base64 or the card details.
    const status = (err as { status?: unknown })?.status;
    console.error(
      "monsoon: read failed",
      err instanceof Error ? err.name : "error",
      typeof status === "number" ? status : ""
    );
    return NextResponse.json({ error: "Could not read the photo" }, { status: 502 });
  }
}
