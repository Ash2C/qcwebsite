"use client";

import Link from "next/link";
import { siteConfig } from "@/lib/config";

export default function Nav() {
  return (
    <header className="fixed inset-x-0 top-0 z-40 border-b border-white/5 bg-qc-ink/80 backdrop-blur-md">
      <div className="mx-auto flex h-16 max-w-content items-center justify-between px-6">
        <Link
          href="/"
          className="flex items-center gap-2 font-mono text-sm uppercase tracking-widest text-qc-text"
        >
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-qc-cyan shadow-[0_0_12px_rgba(106,230,255,0.9)]" />
          {siteConfig.name}
        </Link>

        <nav className="hidden items-center gap-8 text-sm text-qc-text-dim md:flex">
          <a href="#capabilities" className="hover:text-qc-text transition-colors">
            Capabilities
          </a>
          <a href="#who-we-serve" className="hover:text-qc-text transition-colors">
            Who we serve
          </a>
          <a href="#contact" className="hover:text-qc-text transition-colors">
            Contact
          </a>
        </nav>

        <a
          href="#contact"
          className="rounded-md border border-qc-cyan/40 bg-qc-cyan/10 px-3.5 py-1.5 font-mono text-xs uppercase tracking-wider text-qc-cyan transition-colors hover:bg-qc-cyan/20"
        >
          Get in touch
        </a>
      </div>
    </header>
  );
}
