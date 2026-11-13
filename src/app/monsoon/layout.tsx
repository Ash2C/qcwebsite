import type { Metadata, Viewport } from "next";

export const metadata: Metadata = {
  title: "Monsoon",
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
    { media: "(prefers-color-scheme: dark)", color: "#000000" },
  ],
};

export default function MonsoonLayout({ children }: { children: React.ReactNode }) {
  return children;
}
