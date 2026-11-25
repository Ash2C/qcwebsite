"use client";

import { useEffect, useRef, useState } from "react";
import styles from "./AlphaSignup.module.css";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
// Paused until email and phone verification are built.
const OPEN = false;

type Status = "idle" | "sending" | "done";

function useRain(canvasRef: React.RefObject<HTMLCanvasElement | null>) {
  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext?.("2d") ?? null;
    if (!canvas || !ctx) return;
    const still = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    let drops: { x: number; y: number; l: number; v: number; a: number }[] = [];
    let w = 0;
    let h = 0;
    let frame = 0;

    const resize = () => {
      w = canvas.clientWidth;
      h = canvas.clientHeight;
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const n = Math.round((w * h) / 9000);
      drops = Array.from({ length: n }, () => ({
        x: Math.random() * w,
        y: Math.random() * h,
        l: 8 + Math.random() * 18,
        v: 2 + Math.random() * 3.5,
        a: 0.05 + Math.random() * 0.13,
      }));
    };
    const draw = () => {
      ctx.clearRect(0, 0, w, h);
      ctx.lineWidth = 1;
      for (const d of drops) {
        ctx.strokeStyle = `rgba(106,230,255,${d.a})`;
        ctx.beginPath();
        ctx.moveTo(d.x, d.y);
        ctx.lineTo(d.x - d.l * 0.18, d.y + d.l);
        ctx.stroke();
        if (!still) {
          d.y += d.v;
          d.x -= d.v * 0.18;
          if (d.y > h) {
            d.y = -d.l;
            d.x = Math.random() * (w + 40);
          }
        }
      }
      if (!still) frame = requestAnimationFrame(draw);
    };
    const onResize = () => {
      resize();
      if (still) draw();
    };
    resize();
    draw();
    window.addEventListener("resize", onResize);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", onResize);
    };
  }, [canvasRef]);
}

export default function AlphaSignup({
  fontClass = "",
  google = false,
  signups = false,
}: {
  fontClass?: string;
  /** Sign in with Google is on: the button stands in for the paused email form. */
  google?: boolean;
  /** New requests can be taken and approved: only then does the page invite a request. */
  signups?: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [email, setEmail] = useState("");
  const [website, setWebsite] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);
  useRain(canvasRef);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!OPEN || status === "sending") return;
    const value = email.trim();
    if (!EMAIL_RE.test(value)) {
      setError("Enter an email we can send your invite to.");
      return;
    }
    setError(null);
    setStatus("sending");
    try {
      const res = await fetch("/api/monsoon/alpha", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: value, website }),
      });
      if (res.ok) {
        setStatus("done");
        return;
      }
      const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
      setError(typeof body?.error === "string" ? body.error : "Could not save your email. Try again in a moment.");
    } catch {
      setError("Could not reach us. Check your connection and try again.");
    }
    setStatus("idle");
  }

  return (
    <div className={`${styles.page} ${fontClass}`}>
      <canvas ref={canvasRef} className={styles.rain} aria-hidden="true" />
      <main className={styles.main}>
        <div className={styles.col}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img className={styles.logo} src="/monsoon/brand/monsoon-logo-on-dark.svg" alt="Monsoon" width={240} height={44} />
          <h1 className={styles.line}>Make it rain.</h1>
          <p className={styles.sub}>Private alpha</p>
          {google ? (
            <div className={styles.form}>
              <a className={styles.google} href="/api/monsoon/google/start">
                Sign in with Google
              </a>
              {signups && <p className={styles.note}>Sign in with Google to request access.</p>}
            </div>
          ) : status === "done" ? (
            <p className={styles.done} role="status">
              You&apos;re on the list.
            </p>
          ) : (
            <form className={styles.form} onSubmit={submit} noValidate>
              <div className={styles.row}>
                <label htmlFor="alpha-email" className={styles.srOnly}>
                  Email
                </label>
                <input
                  id="alpha-email"
                  className={styles.input}
                  type="email"
                  name="email"
                  autoComplete="email"
                  inputMode="email"
                  placeholder="Your email"
                  maxLength={254}
                  disabled={!OPEN}
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
                <button className={styles.button} type="submit" disabled={!OPEN || status === "sending"}>
                  {!OPEN ? "Opening soon" : status === "sending" ? "Sending..." : "Request access"}
                </button>
              </div>
              <div className={styles.honeypot} aria-hidden="true">
                <label htmlFor="alpha-website">Website</label>
                <input
                  id="alpha-website"
                  name="website"
                  tabIndex={-1}
                  autoComplete="off"
                  value={website}
                  onChange={(e) => setWebsite(e.target.value)}
                />
              </div>
              <p className={`${styles.msg} ${error ? styles.err : ""}`} aria-live="polite">
                {error ?? ""}
              </p>
            </form>
          )}
        </div>
      </main>
      <a className={styles.signin} href="/monsoon">
        Sign in
      </a>
    </div>
  );
}
