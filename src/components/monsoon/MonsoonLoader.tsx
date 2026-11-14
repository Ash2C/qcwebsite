import { useId } from "react";

// The Monsoon mark as a loading animation: the three bars light from left to right.
// "rise" (bars grow from the floor) is for the opening screen; "blink" (bars flash in turn) is for
// small in-app spinners. Decorative: the words beside it carry the status. The keyframes and the
// light and dark colours live in globals.css under .monsoon-loader.
export default function MonsoonLoader({
  variant = "blink",
  className = "h-6 w-6",
}: {
  variant?: "blink" | "rise";
  className?: string;
}) {
  const id = `ml${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  return (
    <svg
      aria-hidden="true"
      data-testid="monsoon-loader"
      viewBox="18 8 64 86"
      className={`monsoon-loader monsoon-loader-${variant} shrink-0 ${className}`}
    >
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" style={{ stopColor: "var(--ml-top)" }} />
          <stop offset=".45" style={{ stopColor: "var(--ml-mid)" }} />
          <stop offset="1" style={{ stopColor: "var(--ml-low)" }} />
        </linearGradient>
      </defs>
      <path
        d="M50 12 C50 12 23.5 44.5 23.5 63 A26.5 26.5 0 0 0 76.5 63 C76.5 44.5 50 12 50 12 Z"
        style={{ fill: "var(--ml-fill)" }}
        stroke={`url(#${id})`}
        strokeWidth="4.5"
        strokeLinejoin="round"
      />
      <g fill={`url(#${id})`}>
        <rect className="ml-bar ml-bar-1" x="35" y="65" width="8" height="14" rx="1.6" />
        <rect className="ml-bar ml-bar-2" x="46" y="57" width="8" height="22" rx="1.6" />
        <rect className="ml-bar ml-bar-3" x="57" y="47" width="8" height="32" rx="1.6" />
      </g>
    </svg>
  );
}
