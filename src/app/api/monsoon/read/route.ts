import { NextResponse } from "next/server";
import { requireSession } from "@/lib/monsoon/auth";
import { extractCard } from "@/lib/monsoon/extract";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const MAX_BYTES = 4_000_000;
// Allowance for multipart boundaries and headers around the file.
const MULTIPART_OVERHEAD = 100_000;
const TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
type MediaType = (typeof TYPES)[number];

export async function POST(request: Request) {
  const denied = requireSession(request);
  if (denied) return denied;

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
    const fields = await extractCard({
      base64,
      mediaType: file.type as MediaType,
    });
    return NextResponse.json({ fields });
  } catch (err) {
    // Error name only: never the photo, the base64 or the card details.
    console.error("monsoon: read failed", err instanceof Error ? err.name : "error");
    return NextResponse.json({ error: "Could not read the photo" }, { status: 502 });
  }
}
