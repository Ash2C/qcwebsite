"use client";

import { motion } from "framer-motion";
import { ArrowRight, ArrowUpRight } from "lucide-react";
import { siteConfig } from "@/lib/config";

export default function Contact() {
  return (
    <section id="contact" className="relative py-32">
      <div className="mx-auto max-w-content px-6">
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-80px" }}
          transition={{ duration: 0.6, ease: "easeOut" }}
          className="relative overflow-hidden rounded-2xl border border-white/5 bg-gradient-to-b from-qc-ink-soft to-qc-ink-deep p-10 md:p-16"
        >
          <div className="pointer-events-none absolute -right-24 -top-24 h-72 w-72 rounded-full bg-qc-cyan/20 blur-[110px]" aria-hidden />
          <p className="mb-4 font-mono text-xs uppercase tracking-widest text-qc-cyan">
            / Built around your workflow
          </p>
          <h2 className="max-w-3xl text-4xl font-semibold tracking-tight text-qc-text sm:text-5xl">
            Bring us one research process worth multiplying.
          </h2>
          <p className="mt-6 max-w-2xl leading-relaxed text-qc-text-dim">
            We configure the sources, methods, review standards, data controls,
            and output format around a real mandate. Each engagement includes a
            hands-on implementation shaped to your organization.
          </p>
          <div className="mt-10 flex flex-wrap gap-4">
            <a
              href="#request-access"
              className="group inline-flex items-center gap-2 rounded-md bg-qc-cyan px-5 py-3 font-medium text-qc-ink-deep transition-colors hover:bg-qc-cyan-dim"
            >
              Request access
              <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
            </a>
            <a
              href={`mailto:${siteConfig.contactEmail}`}
              className="group inline-flex items-center gap-2 rounded-md border border-white/10 px-5 py-3 font-medium text-qc-text-dim transition hover:border-white/30 hover:text-qc-text"
            >
              Discuss a custom system
              <ArrowUpRight className="h-4 w-4 transition-transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5" />
            </a>
          </div>
        </motion.div>
      </div>
    </section>
  );
}
