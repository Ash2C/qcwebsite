import { NextResponse } from "next/server";
import {
  SESSION_COOKIE,
  SESSION_SECONDS,
  authConfigured,
  checkPasscode,
  signSession,
} from "@/lib/monsoon/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const FAILURE_DELAY_MS = 1000;

export async function POST(request: Request) {
  if (!authConfigured()) {
    return NextResponse.json(
      { error: "Monsoon is not configured" },
      { status: 500 }
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const candidate =
    typeof body === "object" && body !== null
      ? (body as Record<string, unknown>).passcode
      : undefined;

  if (typeof candidate !== "string" || !checkPasscode(candidate)) {
    await new Promise((resolve) => setTimeout(resolve, FAILURE_DELAY_MS));
    return NextResponse.json({ error: "Wrong passcode" }, { status: 401 });
  }

  const response = NextResponse.json({ ok: true });
  response.cookies.set(SESSION_COOKIE, signSession(), {
    path: "/",
    httpOnly: true,
    secure: true,
    sameSite: "strict",
    maxAge: SESSION_SECONDS,
  });
  return response;
}

export async function DELETE() {
  const response = NextResponse.json({ ok: true });
  response.cookies.set(SESSION_COOKIE, "", {
    path: "/",
    httpOnly: true,
    secure: true,
    sameSite: "strict",
    maxAge: 0,
  });
  return response;
}
