"use client";

import { motion } from "framer-motion";

const segments = [
  { label: "Buy-side", detail: "Hedge funds, long-only, multi-strategy" },
  { label: "Sell-side", detail: "Research, sales, and trading desks" },
  { label: "Banks", detail: "Investment banking and corporate advisory" },
  { label: "Issuer & IR", detail: "Investor relations and equity capital markets" },
];

export default function Audience() {
  return (
    <section id="who-we-serve" className="relative border-y border-white/5 py-32">
      <div
        className="pointer-events-none absolute inset-0 grid-bg opacity-30"
        aria-hidden
      />
      <div className="relative mx-auto max-w-content px-6">
        <div className="mb-14 flex flex-col gap-6 md:flex-row md:items-end md:justify-between">
          <div className="max-w-2xl">
            <p className="mb-4 font-mono text-xs uppercase tracking-widest text-qc-cyan">
              / Who we serve
            </p>
            <h2 className="text-4xl font-semibold tracking-tight text-qc-text sm:text-5xl">
              Institutional-grade AI, deployed where capital moves.
            </h2>
          </div>
          <p className="max-w-sm text-sm text-qc-text-dim">
            We partner with teams that need AI built to the standards of the
            investment process, not a generic productivity overlay.
          </p>
        </div>

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {segments.map((s, i) => (
            <motion.div
              key={s.label}
              initial={{ opacity: 0, y: 10 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, margin: "-60px" }}
              transition={{ duration: 0.45, delay: i * 0.06, ease: "easeOut" }}
              className="rounded-lg border border-white/5 bg-qc-ink-soft/50 p-6"
            >
              <p className="font-mono text-[11px] uppercase tracking-widest text-qc-cyan-dim">
                {`0${i + 1}`}
              </p>
              <p className="mt-2 text-xl font-semibold text-qc-text">
                {s.label}
              </p>
              <p className="mt-2 text-sm text-qc-text-dim">{s.detail}</p>
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  );
}
