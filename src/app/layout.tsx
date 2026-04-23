import type { Metadata } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import "./globals.css";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
});

const jetbrains = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-jetbrains",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Quant Cloud · Agentic AI for capital markets",
  description:
    "Quant Cloud builds agentic AI systems for finance. Research, workflow, and data infrastructure for capital markets.",
  metadataBase: new URL("https://quantcloud.com"),
  openGraph: {
    title: "Quant Cloud",
    description: "Agentic AI systems for capital markets.",
    url: "https://quantcloud.com",
    siteName: "Quant Cloud",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Quant Cloud",
    description: "Agentic AI systems for capital markets.",
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={`${inter.variable} ${jetbrains.variable}`}>
      <body>{children}</body>
    </html>
  );
}
