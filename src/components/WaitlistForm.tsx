"use client";

import React, { useState } from "react";
import { AlertCircle, CheckCircle2 } from "lucide-react";

type Phase = "email" | "detail" | "done";

const ORGANIZATION_TYPES = [
  ["investment_firm", "Investment firm"],
  ["research_advisory", "Research or advisory firm"],
  ["corporate", "Corporate team"],
  ["publisher", "Research publisher"],
  ["independent", "Independent professional"],
  ["other", "Other organization"],
] as const;

const UNIVERSE_SIZES = [
  ["under-10", "Under 10 subjects"],
  ["10-30", "10 to 30 subjects"],
  ["30-75", "30 to 75 subjects"],
  ["75-plus", "75 or more subjects"],
] as const;

const DELIVERY_CHANNELS = [
  ["secure_app", "Secure app"],
  ["whatsapp", "WhatsApp"],
  ["telegram", "Telegram"],
  ["undecided", "Not sure yet"],
] as const;

export default function WaitlistForm() {
  const [phase, setPhase] = useState<Phase>("email");
  const [email, setEmail] = useState("");
  const [website, setWebsite] = useState("");
  const [firmType, setFirmType] = useState("");
  const [universeSize, setUniverseSize] = useState("");
  const [channel, setChannel] = useState("");
  const [currentProcess, setCurrentProcess] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function send(payload: Record<string, unknown>) {
    const response = await fetch("/api/analysts-waitlist", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      const data = await response.json().catch(() => null);
      throw new Error(data?.error || "Access requests are temporarily unavailable.");
    }
  }

  async function submitEmail(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await send({ step: 1, email, website });
      setPhase("detail");
    } catch (submissionError) {
      setError(
        submissionError instanceof Error
          ? submissionError.message
          : "Access requests are temporarily unavailable."
      );
    } finally {
      setBusy(false);
    }
  }

  async function submitDetails() {
    setBusy(true);
    setError("");
    try {
      await send({
        step: 2,
        email,
        firmType,
        universeSize,
        channel,
        currentProcess,
      });
      setPhase("done");
    } catch {
      setError(
        "Your email is saved, but those details did not send. Try again or finish without them."
      );
    } finally {
      setBusy(false);
    }
  }

  const fieldClass =
    "w-full rounded-md border border-white/15 bg-white/[0.055] px-4 py-3 text-sm text-qc-text outline-none transition placeholder:text-qc-text-muted focus:border-qc-cyan focus:ring-2 focus:ring-qc-cyan/15";

  if (phase === "done") {
    return (
      <div className="flex items-start gap-3" role="status">
        <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-qc-cyan" />
        <div>
          <p className="font-semibold text-qc-text">Your request is in.</p>
          <p className="mt-1 text-sm leading-relaxed text-qc-text-dim">
            The Quant Cloud team will review your requirements and be in touch to discuss fit and implementation.
          </p>
        </div>
      </div>
    );
  }

  if (phase === "detail") {
    return (
      <div>
        <div className="mb-5 flex items-start gap-3">
          <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-qc-cyan" />
          <div>
            <p className="font-semibold text-qc-text">
              Your access request is received.
            </p>
            <p className="mt-1 text-sm text-qc-text-dim">
              A few optional details help us understand the right configuration for your organization.
            </p>
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <select
            aria-label="Organization type"
            value={firmType}
            onChange={(event) => setFirmType(event.target.value)}
            className={fieldClass}
          >
            <option value="">Organization type</option>
            {ORGANIZATION_TYPES.map(([value, label]) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </select>
          <select
            aria-label="Research universe size"
            value={universeSize}
            onChange={(event) => setUniverseSize(event.target.value)}
            className={fieldClass}
          >
            <option value="">Research universe size</option>
            {UNIVERSE_SIZES.map(([value, label]) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </select>
        </div>
        <select
          aria-label="Preferred delivery channel"
          value={channel}
          onChange={(event) => setChannel(event.target.value)}
          className={`${fieldClass} mt-3`}
        >
          <option value="">Preferred delivery channel</option>
          {DELIVERY_CHANNELS.map(([value, label]) => (
            <option key={value} value={value}>{label}</option>
          ))}
        </select>
        <textarea
          aria-label="Describe the research you want to produce"
          value={currentProcess}
          onChange={(event) => setCurrentProcess(event.target.value)}
          placeholder="What do you cover, and what research do you want the analyst to produce?"
          className={`${fieldClass} mt-3 min-h-24 resize-y`}
        />

        {error && (
          <div className="mt-3 flex items-start gap-2 text-sm text-red-300" role="alert">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        <div className="mt-5 flex flex-wrap items-center gap-4">
          <button
            type="button"
            disabled={busy}
            onClick={submitDetails}
            className="rounded-md bg-qc-cyan px-5 py-3 text-sm font-semibold text-qc-ink-deep transition hover:bg-qc-cyan-dim disabled:opacity-50"
          >
            {busy ? "Sending..." : "Send details"}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => setPhase("done")}
            className="text-sm text-qc-text-dim underline decoration-white/20 underline-offset-4 transition hover:text-qc-text"
          >
            {error ? "Finish without details" : "Skip for now"}
          </button>
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={submitEmail}>
      <input
        type="text"
        name="website"
        value={website}
        onChange={(event) => setWebsite(event.target.value)}
        tabIndex={-1}
        autoComplete="off"
        aria-hidden="true"
        className="absolute -left-[9999px]"
      />
      <label htmlFor="waitlist-email" className="mb-2 block font-mono text-[11px] uppercase tracking-widest text-qc-text-dim">
        Work email
      </label>
      <div className="flex flex-col gap-3 sm:flex-row">
        <input
          id="waitlist-email"
          type="email"
          required
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          placeholder="you@yourfirm.com"
          className={fieldClass}
        />
        <button
          type="submit"
          disabled={busy}
          className="shrink-0 rounded-md bg-qc-cyan px-5 py-3 text-sm font-semibold text-qc-ink-deep transition hover:bg-qc-cyan-dim disabled:opacity-50"
        >
          {busy ? "Sending..." : "Request access"}
        </button>
      </div>
      {error && (
        <div className="mt-3 flex items-center gap-2 text-sm text-red-300" role="alert">
          <AlertCircle className="h-4 w-4" />
          <span>{error}</span>
        </div>
      )}
      <p className="mt-3 text-xs leading-relaxed text-qc-text-muted">
        Tell us about your research needs. The Quant Cloud team will follow up to discuss fit and implementation.
      </p>
      <p className="sr-only">Quant Cloud access request form</p>
    </form>
  );
}
