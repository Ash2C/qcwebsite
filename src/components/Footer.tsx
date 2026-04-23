import { siteConfig } from "@/lib/config";

export default function Footer() {
  const year = new Date().getFullYear();
  return (
    <footer className="border-t border-white/5 py-10">
      <div className="mx-auto flex max-w-content flex-col gap-4 px-6 text-sm text-qc-text-muted md:flex-row md:items-center md:justify-between">
        <div className="flex items-center gap-2 font-mono text-xs uppercase tracking-widest">
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-qc-cyan" />
          {siteConfig.name}
        </div>
        <p className="font-mono text-xs uppercase tracking-widest">
          Sister company of{" "}
          <a
            href="https://01.co"
            target="_blank"
            rel="noreferrer"
            className="text-qc-text-dim transition-colors hover:text-qc-text"
          >
            Zero One
          </a>
        </p>
        <p className="font-mono text-xs uppercase tracking-widest">
          © {year} {siteConfig.name}
        </p>
      </div>
    </footer>
  );
}
