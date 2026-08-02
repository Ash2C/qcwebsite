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
  title: "Quant Cloud | AI analysts for serious research",
  description:
    "Configurable AI analysts for company, industry, thematic, and private-market research. Built around your sources, methods, and output format.",
  metadataBase: new URL("https://quantcloud.com"),
  openGraph: {
    title: "Quant Cloud | AI analysts for serious research",
    description:
      "AI analysts built around your research universe, methods, and house format.",
    url: "https://quantcloud.com",
    siteName: "Quant Cloud",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Quant Cloud | AI analysts for serious research",
    description:
      "AI analysts built around your research universe, methods, and house format.",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${inter.variable} ${jetbrains.variable}`}>
      <body>{children}</body>
    </html>
  );
}
