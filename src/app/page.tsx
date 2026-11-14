import type { Metadata, Viewport } from "next";
import { Sora } from "next/font/google";
import AlphaSignup from "@/components/alpha/AlphaSignup";

// quantcloud.com is the Monsoon private-alpha sign-up page. The earlier Quant Cloud marketing page is
// kept as the git tag quantcloud-homepage-2026-11-13.

const sora = Sora({ subsets: ["latin"], weight: ["400", "500", "600"], display: "swap" });

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
  return <AlphaSignup fontClass={sora.className} />;
}
