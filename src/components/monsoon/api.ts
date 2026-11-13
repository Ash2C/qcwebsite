// Thin client for the /api/monsoon routes. Every call resolves with { status, body }; a
// non-2xx status is data, not an exception. Only a network failure rejects.
import type { CardFields } from "@/lib/monsoon/extract";
import type { CaptureResult } from "@/lib/monsoon/capture";

export type EstateInfo = {
  key: string;
  label: string;
  defaultRole: string;
  available: boolean;
  roles: { key: string; label: string }[];
};

export type SaveBody = {
  estate: string;
  captureId: string;
  role: string;
  fields: {
    name: string;
    title?: string;
    org?: string;
    email?: string;
    phone?: string;
    linkedin?: string;
    notes?: string;
  };
  extracted?: CardFields;
  newOrg?: boolean;
  samePerson?: string | false;
};

export type ApiResult<T> = { status: number; body: T };

async function parse<T>(response: Response): Promise<ApiResult<T>> {
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  return { status: response.status, body: body as T };
}

export async function signIn(
  passcode: string,
): Promise<ApiResult<{ ok: true } | { error: string }>> {
  return parse(
    await fetch("/api/monsoon/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ passcode }),
    }),
  );
}

export async function loadEstates(): Promise<
  ApiResult<{ estates: EstateInfo[] } | { error: string }>
> {
  return parse(await fetch("/api/monsoon/estates", { cache: "no-store" }));
}

export async function readCard(
  image: Blob,
): Promise<ApiResult<{ fields: CardFields } | { error: string }>> {
  const form = new FormData();
  form.append("image", image, "card.jpg");
  return parse(await fetch("/api/monsoon/read", { method: "POST", body: form }));
}

export async function saveCard(
  body: SaveBody,
): Promise<ApiResult<CaptureResult | { error: string }>> {
  return parse(
    await fetch("/api/monsoon/save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}
