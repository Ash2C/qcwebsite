"use client";

import { motion } from "framer-motion";
import { Brain, Workflow, Database } from "lucide-react";

const capabilities = [
  {
    icon: Brain,
    title: "Research agents",
    body: "Analyst-grade agents that ingest filings, transcripts, and market data to produce memo-ready outputs, built to the rigour of the desk that will read them.",
  },
  {
    icon: Workflow,
    title: "Workflow automation",
    body: "Tool-using agents that operate internal systems end-to-end: Bloomberg pulls, Excel model updates, CRM sync, outreach drafting, document production.",
  },
  {
    icon: Database,
    title: "Data infrastructure",
    body: "Pipelines and storage patterns designed for finance-grade data: auditable, versioned, permissioned, and suited to both deterministic queries and agentic use.",
  },
];

export default function Capabilities() {
  return (
    <section id="capabilities" className="relative py-32">
      <div className="mx-auto max-w-content px-6">
        <div className="mb-16 max-w-2xl">
          <p className="mb-4 font-mono text-xs uppercase tracking-widest text-qc-cyan">
            / Capabilities
          </p>
          <h2 className="text-4xl font-semibold tracking-tight text-qc-text sm:text-5xl">
            Built for the way finance teams actually work.
          </h2>
        </div>

        <div className="grid gap-px overflow-hidden rounded-xl bg-qc-line md:grid-cols-3">
          {capabilities.map((cap, i) => (
            <motion.div
              key={cap.title}
              initial={{ opacity: 0, y: 12 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, margin: "-80px" }}
              transition={{ duration: 0.5, delay: i * 0.08, ease: "easeOut" }}
              className="group relative bg-qc-ink-soft p-8 transition-colors hover:bg-qc-ink-soft/60"
            >
              <div className="mb-6 inline-flex h-10 w-10 items-center justify-center rounded-md border border-qc-cyan/30 bg-qc-cyan/5 text-qc-cyan">
                <cap.icon className="h-5 w-5" />
              </div>
              <h3 className="mb-3 text-xl font-semibold text-qc-text">
                {cap.title}
              </h3>
              <p className="text-sm leading-relaxed text-qc-text-dim">
                {cap.body}
              </p>
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  );
}
