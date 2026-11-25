import type { Metadata, Viewport } from "next";
import { Sora } from "next/font/google";
import AlphaSignup from "@/components/alpha/AlphaSignup";
import { googleConfigured, signupsConfigured } from "@/lib/monsoon/google";

// quantcloud.com is the Monsoon private-alpha sign-up page. The earlier Quant Cloud marketing page is
// kept as the git tag quantcloud-homepage-2026-11-13.

const sora = Sora({ subsets: ["latin"], weight: ["400", "500", "600"], display: "swap" });

// Rendered per request: whether the Google button shows follows the server's settings as they are
// now, not as they were when the site was built.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Monsoon",
  description: "Make it rain. Monsoon is in private alpha.",
  icons: { icon: "/monsoon/icon-192.png", apple: "/monsoon/apple-touch-icon.png" },
  openGraph: {
    title: "Monsoon",
    description: "Make it rain. Monsoon is in private alpha.",
    url: "https://quantcloud.com",
    siteName: "Monsoon",
    type: "website",
    images: [{ url: "/monsoon/brand/monsoon-logo-on-dark.png", width: 1200, height: 254, alt: "Monsoon" }],
  },
  twitter: { card: "summary", title: "Monsoon", description: "Make it rain. Monsoon is in private alpha." },
};

export const viewport: Viewport = { themeColor: "#07090C", viewportFit: "cover" };

export default function Home() {
  // True or false only reaches the page; with Google off it is the page of before.
  return <AlphaSignup fontClass={sora.className} google={googleConfigured()} signups={signupsConfigured()} />;
}
