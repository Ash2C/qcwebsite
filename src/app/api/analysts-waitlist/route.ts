import { NextResponse } from "next/server";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ERROR_MESSAGE =
  "Registration is temporarily unavailable. Please try again.";

function cleanString(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : undefined;
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (typeof body !== "object" || body === null) {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const input = body as Record<string, unknown>;
  if (
    typeof input.website === "string" &&
    input.website.trim().length > 0
  ) {
    return NextResponse.json({ ok: true });
  }

  if (input.step !== 1 && input.step !== 2) {
    return NextResponse.json({ error: "Invalid step" }, { status: 400 });
  }

  const email =
    typeof input.email === "string" ? input.email.trim().toLowerCase() : "";
  if (!EMAIL_RE.test(email) || email.length > 320) {
    return NextResponse.json({ error: "Invalid email" }, { status: 400 });
  }

  const upstreamUrl = process.env.ANALYSTS_WAITLIST_API_URL;
  const secret = process.env.ANALYSTS_INGEST_SECRET;
  if (!upstreamUrl || !secret) {
    return NextResponse.json({ error: ERROR_MESSAGE }, { status: 503 });
  }

  const upstreamBody: Record<string, string | number> = {
    step: input.step,
    email,
    source: "qc-website",
  };

  if (input.step === 2) {
    const optionalFields = {
      firmType: cleanString(input.firmType, 50),
      universeSize: cleanString(input.universeSize, 50),
      channel: cleanString(input.channel, 50),
      currentProcess: cleanString(input.currentProcess, 2000),
    };
    for (const [key, value] of Object.entries(optionalFields)) {
      if (value !== undefined) upstreamBody[key] = value;
    }
  }

  try {
    const upstream = await fetch(upstreamUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-analysts-ingest-secret": secret,
      },
      body: JSON.stringify(upstreamBody),
      cache: "no-store",
    });

    if (!upstream.ok) {
      return NextResponse.json(
        { error: ERROR_MESSAGE },
        { status: upstream.status >= 500 ? 502 : upstream.status }
      );
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("qc analysts waitlist upstream failed", error);
    return NextResponse.json({ error: ERROR_MESSAGE }, { status: 502 });
  }
}
