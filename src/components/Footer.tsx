import { siteConfig } from "@/lib/config";

export default function Footer() {
  return (
    <footer className="border-t border-white/5 py-10">
      <div className="mx-auto max-w-content px-6 text-sm text-qc-text-muted">
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div className="flex items-center gap-2 font-mono text-xs uppercase tracking-widest">
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-qc-cyan" />
            {siteConfig.name}
          </div>
          <p className="font-mono text-xs uppercase tracking-widest">
            Research systems, built for serious use
          </p>
        </div>

        <div className="mt-8 grid gap-7 border-t border-white/5 pt-8 md:grid-cols-2 md:gap-12">
          <address className="not-italic">
            <p className="font-mono text-[10px] uppercase tracking-widest text-qc-cyan">
              Based in
            </p>
            <p className="mt-2 font-medium text-qc-text">Boston, USA</p>
            <a
              href="tel:+16176228038"
              className="mt-1 inline-block transition-colors hover:text-qc-text"
            >
              617 622 8038
            </a>
            <p className="mt-1">60 State Street, Suite 1400, Boston, MA 02109</p>
          </address>

          <div className="md:text-right">
            <p className="font-mono text-[10px] uppercase tracking-widest text-qc-cyan">
              Legal entity
            </p>
            <p className="mt-2 font-medium text-qc-text">
              Clearsight Systems Pte. Ltd.
            </p>
            <p className="mt-1">© 2026 Clearsight Systems Pte. Ltd.</p>
          </div>
        </div>
      </div>
    </footer>
  );
}
