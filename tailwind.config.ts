import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./src/pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        "qc-ink": "#08090B",
        "qc-ink-deep": "#040506",
        "qc-ink-soft": "#101216",
        "qc-line": "#1B1E24",
        "qc-cyan": "#6AE6FF",
        "qc-cyan-dim": "#3FB8D4",
        "qc-text": "#E6E8EC",
        "qc-text-dim": "#9BA1AD",
        "qc-text-muted": "#5A6170",
      },
      fontFamily: {
        sans: ["var(--font-inter)", "system-ui", "sans-serif"],
        mono: ["var(--font-jetbrains)", "monospace"],
      },
      letterSpacing: {
        nav: "0.08em",
        wider: "0.16em",
        widest: "0.24em",
      },
      maxWidth: {
        content: "1200px",
        reading: "720px",
      },
    },
  },
  plugins: [],
};

export default config;
