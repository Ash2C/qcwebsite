// The Monsoon logo (drop mark and lowercase wordmark). The dark-background version is shown when the
// phone is in dark mode, the light one otherwise. Wrapped in the page's h1 so the screen keeps its heading.
export default function MonsoonLogo({ className = "" }: { className?: string }) {
  return (
    <h1 className={`m-0 ${className}`}>
      <picture>
        <source srcSet="/monsoon/brand/monsoon-logo-on-dark.svg" media="(prefers-color-scheme: dark)" />
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/monsoon/brand/monsoon-logo-on-light.svg" alt="Monsoon" className="block h-full w-auto" />
      </picture>
    </h1>
  );
}
