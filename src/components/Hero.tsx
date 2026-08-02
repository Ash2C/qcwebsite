"use client";

import { motion } from "framer-motion";
import { ArrowDownRight } from "lucide-react";
import WaitlistForm from "@/components/WaitlistForm";

const coverage = ["Public companies", "Private companies", "Industries", "Themes"];

export default function Hero() {
  return (
    <section className="relative isolate flex min-h-screen items-center overflow-hidden pb-20 pt-28">
      <div className="absolute inset-0 grid-bg radial-fade opacity-60" aria-hidden />
      <div
        className="absolute left-1/3 top-1/3 h-[680px] w-[920px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-qc-cyan/10 blur-[150px]"
        aria-hidden
      />

      <div className="relative mx-auto grid w-full max-w-content gap-14 px-6 lg:grid-cols-[1.08fr_0.92fr] lg:items-center">
        <motion.div
          initial={{ opacity: 0, y: 14 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.65, ease: "easeOut" }}
        >
          <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-1 font-mono text-[11px] uppercase tracking-widest text-qc-text-dim">
            <span className="h-1.5 w-1.5 rounded-full bg-qc-cyan shadow-[0_0_12px_rgba(106,230,255,0.9)]" />
            AI analysts · Early access
          </div>

          <h1 className="max-w-3xl text-5xl font-semibold leading-[1.02] tracking-[-0.045em] text-qc-text sm:text-6xl md:text-7xl">
            AI analysts built around
            <span className="block text-qc-cyan">your research universe.</span>
          </h1>

          <p className="mt-7 max-w-2xl text-lg leading-relaxed text-qc-text-dim">
            Cover public companies, private companies, industries, or themes.
            Quant Cloud analysts track the work, maintain the analysis, and
            produce research in your method and house format—for internal use
            or public distribution.
          </p>

          <a
            href="#capabilities"
            className="group mt-8 inline-flex items-center gap-2 text-sm font-medium text-qc-text-dim transition hover:text-qc-text"
          >
            See what your analyst can do
            <ArrowDownRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5 group-hover:translate-y-0.5" />
          </a>

          <div className="mt-10 flex flex-wrap gap-2" aria-label="Example research coverage">
            {coverage.map((item) => (
              <span key={item} className="rounded-full border border-white/10 bg-white/[0.035] px-3 py-1.5 font-mono text-[10px] uppercase tracking-wider text-qc-text-muted">
                {item}
              </span>
            ))}
          </div>
        </motion.div>

        <motion.div
          id="early-access"
          initial={{ opacity: 0, y: 18 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.7, delay: 0.12, ease: "easeOut" }}
          className="relative scroll-mt-24 rounded-2xl border border-white/10 bg-qc-ink-soft/90 p-6 shadow-[0_30px_100px_rgba(0,0,0,0.35)] backdrop-blur sm:p-8"
        >
          <div className="absolute inset-x-8 top-0 h-px bg-gradient-to-r from-transparent via-qc-cyan/80 to-transparent" aria-hidden />
          <p className="font-mono text-[11px] uppercase tracking-widest text-qc-cyan">
            / Founding cohort
          </p>
          <h2 className="mt-3 text-2xl font-semibold tracking-tight text-qc-text">
            Build your first AI analyst.
          </h2>
          <p className="mb-7 mt-3 text-sm leading-relaxed text-qc-text-dim">
            We are onboarding a small group of teams and configuring each
            analyst around a real research workflow.
          </p>
          <WaitlistForm />
        </motion.div>
      </div>
    </section>
  );
}
