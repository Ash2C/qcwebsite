import type { NextConfig } from "next";

const securityHeaders = [
  { key: "X-Frame-Options", value: "SAMEORIGIN" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Strict-Transport-Security",
    value: "max-age=31536000; includeSubDomains",
  },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), interest-cohort=()",
  },
];

// The one-time setup page carries a secret token in its address: never cached, framed or referred.
// Listed after the site-wide entry so its X-Frame-Options and Referrer-Policy win.
const setupHeaders = [
  { key: "Cache-Control", value: "no-store" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
  { key: "Referrer-Policy", value: "no-referrer" },
];

const nextConfig: NextConfig = {
  // The commit this build was made from; the Monsoon app compares it with /api/monsoon/version.
  env: { NEXT_PUBLIC_MONSOON_BUILD: process.env.VERCEL_GIT_COMMIT_SHA ?? "dev" },
  async headers() {
    return [
      { source: "/:path*", headers: securityHeaders },
      { source: "/monsoon/setup/:path*", headers: setupHeaders },
    ];
  },
};

export default nextConfig;
