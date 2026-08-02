"use client";

import { motion } from "framer-motion";

const teams = [
  {
    label: "Investment teams",
    detail: "Funds, family offices, diligence, and portfolio research",
  },
  {
    label: "Research firms",
    detail: "Advisory teams, specialists, and independent research houses",
  },
  {
    label: "Corporate teams",
    detail: "Strategy, competitive intelligence, investor relations, and M&A",
  },
  {
    label: "Research publishers",
    detail: "Organizations building recurring, public-facing research verticals",
  },
];

export default function Audience() {
  return (
    <section id="who-we-serve" className="relative border-y border-white/5 py-32">
      <div className="pointer-events-none absolute inset-0 grid-bg opacity-30" aria-hidden />
      <div className="relative mx-auto max-w-content px-6">
        <div className="mb-14 flex flex-col gap-6 md:flex-row md:items-end md:justify-between">
          <div className="max-w-2xl">
            <p className="mb-4 font-mono text-xs uppercase tracking-widest text-qc-cyan">
              / Who it is for
            </p>
            <h2 className="text-4xl font-semibold tracking-tight text-qc-text sm:text-5xl">
              One analyst system. Many research mandates.
            </h2>
          </div>
          <p className="max-w-md text-sm leading-relaxed text-qc-text-dim">
            If your team repeatedly turns fragmented information into a
            defensible point of view, we can configure an analyst around that work.
          </p>
        </div>

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {teams.map((team, index) => (
            <motion.article
              key={team.label}
              initial={{ opacity: 0, y: 10 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, margin: "-60px" }}
              transition={{ duration: 0.45, delay: index * 0.06, ease: "easeOut" }}
              className="rounded-lg border border-white/5 bg-qc-ink-soft/60 p-6"
            >
              <p className="font-mono text-[11px] uppercase tracking-widest text-qc-cyan-dim">
                {String(index + 1).padStart(2, "0")}
              </p>
              <h3 className="mt-2 text-xl font-semibold text-qc-text">
                {team.label}
              </h3>
              <p className="mt-2 text-sm leading-relaxed text-qc-text-dim">
                {team.detail}
              </p>
            </motion.article>
          ))}
        </div>
      </div>
    </section>
  );
}
