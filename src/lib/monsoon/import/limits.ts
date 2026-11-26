// Bulk import: how large a request may be, shared by the routes that refuse a larger one and the
// browser that builds them. No database and no Node-only imports here.

/** The check route: its body limit in bytes and the most rows it takes. */
export const CHECK_MAX_BODY = 524_288;
export const CHECK_MAX_ROWS = 200;

/** The save route: its body limit in bytes and the most rows it takes. */
export const SAVE_MAX_BODY = 262_144;
export const SAVE_MAX_ROWS = 100;

/** The browser fills a request to at most this share of the route's body limit. */
export const BODY_SHARE = 0.6;

/** The most bytes the browser puts in one request to a route with this body limit. */
export const requestBudget = (maxBody: number): number => Math.floor(maxBody * BODY_SHARE);

/** How many bytes a string takes as UTF-8. */
export function utf8Bytes(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      // Two halves of one character outside the basic plane: four bytes together.
      bytes += 4;
      i++;
    } else bytes += 3;
  }
  return bytes;
}

/** How many bytes a value takes in a JSON request body. */
export const jsonBytes = (value: unknown): number => utf8Bytes(JSON.stringify(value) ?? "null");

/**
 * Splits `items` into requests, in order: each holds at most `maxCount` items and at most
 * `maxBytes` bytes, counting `baseBytes` for what the request carries besides its items and one
 * byte for the comma between two items. An item that does not fit in a request of its own is not
 * put in any: it comes back in `tooLarge`.
 */
export function bySize<T>(
  items: T[],
  bytesOf: (item: T) => number,
  o: { maxCount: number; maxBytes: number; baseBytes: number },
): { chunks: T[][]; tooLarge: T[] } {
  const chunks: T[][] = [];
  const tooLarge: T[] = [];
  let current: T[] = [];
  let used = o.baseBytes;
  for (const item of items) {
    const bytes = bytesOf(item) + 1;
    if (o.baseBytes + bytes > o.maxBytes) {
      tooLarge.push(item);
      continue;
    }
    if (current.length > 0 && (current.length >= o.maxCount || used + bytes > o.maxBytes)) {
      chunks.push(current);
      current = [];
      used = o.baseBytes;
    }
    current.push(item);
    used += bytes;
  }
  if (current.length > 0) chunks.push(current);
  return { chunks, tooLarge };
}
