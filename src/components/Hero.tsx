"use client";

import { motion } from "framer-motion";
import { ArrowRight } from "lucide-react";
import { siteConfig } from "@/lib/config";

export default function Hero() {
  return (
    <section className="relative isolate flex min-h-screen items-center overflow-hidden pt-16">
      <div className="absolute inset-0 grid-bg radial-fade opacity-60" aria-hidden />
      <div
        className="absolute left-1/2 top-1/3 h-[600px] w-[900px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-qc-cyan/10 blur-[140px]"
        aria-hidden
      />

      <div className="relative mx-auto w-full max-w-content px-6">
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, ease: "easeOut" }}
          className="mb-6 inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-1 font-mono text-[11px] uppercase tracking-widest text-qc-text-dim"
        >
          <span className="h-1.5 w-1.5 rounded-full bg-qc-cyan" />
          Agentic AI · Capital Markets
        </motion.div>

        <motion.h1
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.7, delay: 0.05, ease: "easeOut" }}
          className="max-w-4xl text-5xl font-semibold tracking-tight text-qc-text sm:text-6xl md:text-7xl"
        >
          Agentic AI systems
          <br />
          for <span className="text-qc-cyan">capital markets.</span>
        </motion.h1>

        <motion.p
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.7, delay: 0.15, ease: "easeOut" }}
          className="mt-6 max-w-xl text-lg text-qc-text-dim"
        >
          Quant Cloud builds production-grade AI agents that sit inside the
          research, data, and workflow stack of institutional finance teams.
        </motion.p>

        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.7, delay: 0.25, ease: "easeOut" }}
          className="mt-10 flex flex-wrap items-center gap-4"
        >
          <a
            href="#contact"
            className="group inline-flex items-center gap-2 rounded-md bg-qc-cyan px-5 py-3 font-medium text-qc-ink-deep transition-colors hover:bg-qc-cyan-dim"
          >
            Start a conversation
            <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
          </a>
          <a
            href="#capabilities"
            className="inline-flex items-center gap-2 rounded-md border border-white/10 px-5 py-3 font-medium text-qc-text-dim transition-colors hover:border-white/30 hover:text-qc-text"
          >
            What we build
          </a>
        </motion.div>

        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 1, delay: 0.6 }}
          className="mt-20 flex items-center gap-3 font-mono text-xs uppercase tracking-widest text-qc-text-muted"
        >
          <span className="h-px w-8 bg-qc-text-muted/40" />
          {siteConfig.domain}
        </motion.div>
      </div>
    </section>
  );
}
