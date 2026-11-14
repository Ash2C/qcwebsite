import type { Metadata, Viewport } from "next";
import { Sora } from "next/font/google";

// The wordmark's typeface, used across the app.
const sora = Sora({ subsets: ["latin"], weight: ["400", "500", "600", "700"], display: "swap" });

export const metadata: Metadata = {
  title: "Monsoon",
  // Replace (not merge with) the marketing Open Graph and Twitter cards inherited from the root layout.
  openGraph: { title: "Monsoon", siteName: "Monsoon", type: "website" },
  twitter: { card: "summary", title: "Monsoon" },
  robots: { index: false, follow: false },
  manifest: "/monsoon/manifest.webmanifest",
  appleWebApp: { capable: true, title: "Monsoon", statusBarStyle: "default" },
  icons: { apple: "/monsoon/apple-touch-icon.png" },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f2f2f7" },
    { media: "(prefers-color-scheme: dark)", color: "#07090C" },
  ],
};

export default function MonsoonLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className={`min-h-dvh bg-[#f2f2f7] dark:bg-[#07090C] ${sora.className}`}>
      {/* The root body is dark; paint the canvas too so iOS overscroll shows no dark band. */}
      <style>{`html,body{background:#f2f2f7}@media (prefers-color-scheme:dark){html,body{background:#07090C}}`}</style>
      {children}
    </div>
  );
}
