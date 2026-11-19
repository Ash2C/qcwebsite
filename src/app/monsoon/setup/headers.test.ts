import { describe, expect, it } from "vitest";
import nextConfig from "../../../../next.config";

describe("setup page headers", () => {
  it("are never cached or framed, and win over the site-wide entry", async () => {
    const entries = await nextConfig.headers!();
    const at = entries.findIndex((e) => e.source === "/monsoon/setup/:path*");
    expect(at).toBeGreaterThan(entries.findIndex((e) => e.source === "/:path*"));
    const h = Object.fromEntries(entries[at].headers.map((x) => [x.key, x.value]));
    expect(h["Cache-Control"]).toBe("no-store");
    expect(h["X-Frame-Options"]).toBe("DENY");
    expect(h["Content-Security-Policy"]).toBe("frame-ancestors 'none'");
  });
});
