"use client";

import { motion } from "framer-motion";
import { FileOutput, Radar, SlidersHorizontal } from "lucide-react";

const capabilities = [
  {
    icon: Radar,
    title: "Covers the universe you define",
    body: "Assign public companies, private companies, industries, technologies, or themes. Your analyst monitors the sources that matter and keeps the full coverage set moving, not only the loudest names.",
  },
  {
    icon: SlidersHorizontal,
    title: "Works your way",
    body: "Configure the evidence hierarchy, analytical method, peer sets, review gates, and house style. It can maintain models and structured datasets alongside the written research.",
  },
  {
    icon: FileOutput,
    title: "Produces research ready to use",
    body: "Commission monitoring notes, decision briefs, deep-dive reports, or recurring research series. Outputs can stay inside the firm or move through human review into publication-ready form.",
  },
];

export default function Capabilities() {
  return (
    <section id="capabilities" className="relative py-32">
      <div className="mx-auto max-w-content px-6">
        <div className="mb-16 grid gap-6 md:grid-cols-[1fr_0.65fr] md:items-end">
          <div className="max-w-3xl">
            <p className="mb-4 font-mono text-xs uppercase tracking-widest text-qc-cyan">
              / What your analyst does
            </p>
            <h2 className="text-4xl font-semibold tracking-tight text-qc-text sm:text-5xl">
              Research capacity that keeps working between assignments.
            </h2>
          </div>
          <p className="max-w-md text-sm leading-relaxed text-qc-text-dim md:justify-self-end">
            The system follows a standing mandate: what to watch, how to assess
            it, what to maintain, and when to produce an output for review.
          </p>
        </div>

        <div className="grid gap-px overflow-hidden rounded-xl bg-qc-line md:grid-cols-3">
          {capabilities.map((capability, index) => (
            <motion.article
              key={capability.title}
              initial={{ opacity: 0, y: 12 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, margin: "-80px" }}
              transition={{ duration: 0.5, delay: index * 0.08, ease: "easeOut" }}
              className="group relative bg-qc-ink-soft p-8 transition-colors hover:bg-[#13161b]"
            >
              <div className="mb-6 inline-flex h-10 w-10 items-center justify-center rounded-md border border-qc-cyan/30 bg-qc-cyan/5 text-qc-cyan">
                <capability.icon className="h-5 w-5" />
              </div>
              <h3 className="mb-3 text-xl font-semibold text-qc-text">
                {capability.title}
              </h3>
              <p className="text-sm leading-relaxed text-qc-text-dim">
                {capability.body}
              </p>
            </motion.article>
          ))}
        </div>

        <div className="mt-6 grid items-center gap-3 rounded-xl border border-white/5 bg-white/[0.025] p-4 font-mono text-[10px] uppercase tracking-wider text-qc-text-muted sm:grid-cols-[1fr_auto_1fr_auto_1fr]">
          <div className="rounded-md border border-white/10 px-4 py-3 text-center">Your sources</div>
          <span className="hidden text-qc-cyan sm:block" aria-hidden>→</span>
          <div className="rounded-md border border-qc-cyan/30 bg-qc-cyan/5 px-4 py-3 text-center text-qc-cyan">Configured analyst</div>
          <span className="hidden text-qc-cyan sm:block" aria-hidden>→</span>
          <div className="rounded-md border border-white/10 px-4 py-3 text-center">Your research output</div>
        </div>
      </div>
    </section>
  );
}
