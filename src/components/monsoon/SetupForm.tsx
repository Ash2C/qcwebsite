"use client";

// The setup link's form: database address, monsoon_app password and Claude key. The server tests
// everything before storing it; the fields are cleared and the form hidden once it succeeds.
import { useState, type FormEvent } from "react";
import { card, fieldInput, fieldLabel, primaryButton } from "./styles";

type Fields = { projectRef: string; poolerHost: string; password: string; claudeKey: string };
const EMPTY: Fields = { projectRef: "", poolerHost: "", password: "", claudeKey: "" };

const ROWS: { key: keyof Fields; label: string; type: "text" | "password"; placeholder?: string }[] = [
  { key: "projectRef", label: "Project reference", type: "text", placeholder: "20 letters and digits" },
  { key: "poolerHost", label: "Pooler host", type: "text", placeholder: "aws-0-region.pooler.supabase.com" },
  { key: "password", label: "monsoon_app password", type: "password" },
  { key: "claudeKey", label: "Claude API key", type: "password" },
];

export default function SetupForm({ token, purpose }: { token: string; purpose: "connect" | "replace" }) {
  const [fields, setFields] = useState<Fields>(EMPTY);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; ok: boolean } | null>(null);
  const [done, setDone] = useState(false);
  const optional = purpose === "replace";

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch("/api/monsoon/setup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        cache: "no-store",
        body: JSON.stringify({ token, ...fields }),
      });
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; message?: string; error?: string };
      if (res.ok && body.ok) {
        setFields(EMPTY);
        setDone(true);
        setMessage({ text: body.message ?? "Connected. You can close this page.", ok: true });
      } else {
        setMessage({ text: body.error ?? "Something went wrong. Try again.", ok: false });
      }
    } catch {
      setMessage({ text: "Could not reach Monsoon. Check your connection and try again.", ok: false });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {!done && (
        <form onSubmit={onSubmit} className="flex flex-col gap-4" autoComplete="off">
          {optional && (
            <p className="text-[15px] text-neutral-600 dark:text-neutral-400">
              Leave blank to keep the current one. To change the database, fill in all three database fields.
            </p>
          )}
          <div className={`${card} divide-y divide-black/5 dark:divide-white/10`}>
            {ROWS.map((row) => (
              <div key={row.key}>
                <label htmlFor={`setup-${row.key}`} className={fieldLabel}>
                  {row.label}
                </label>
                <input
                  id={`setup-${row.key}`}
                  name={row.key}
                  type={row.type}
                  autoComplete={row.type === "password" ? "new-password" : "off"}
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  required={!optional}
                  placeholder={optional ? "Leave blank to keep the current one" : row.placeholder}
                  value={fields[row.key]}
                  onChange={(ev) => setFields((f) => ({ ...f, [row.key]: ev.target.value }))}
                  className={fieldInput}
                />
              </div>
            ))}
          </div>
          <button type="submit" disabled={busy} className={primaryButton}>
            {busy ? "Testing…" : "Test and connect"}
          </button>
        </form>
      )}
      {message && (
        <p
          role={message.ok ? "status" : "alert"}
          className={`text-[17px] font-medium ${message.ok ? "text-[#0E7FA6] dark:text-[#6AE6FF]" : "text-red-600 dark:text-red-400"}`}
        >
          {message.text}
        </p>
      )}
    </div>
  );
}

/** The setup script in a selectable block with a copy button. */
export function SetupScript({ script }: { script: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className={`${card} overflow-hidden`}>
      <div className="flex items-center justify-between px-4 pt-2">
        <span className="text-xs font-medium uppercase tracking-wide text-neutral-500 dark:text-neutral-400">Setup script</span>
        <button
          type="button"
          className="min-h-[36px] rounded-lg px-3 text-[15px] font-medium text-[#0E7FA6] dark:text-[#6AE6FF]"
          onClick={() => {
            void navigator.clipboard?.writeText(script).then(
              () => setCopied(true),
              () => setCopied(false),
            );
          }}
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre className="max-h-72 select-all overflow-auto whitespace-pre px-4 pb-4 pt-2 font-mono text-[12px] leading-snug text-neutral-800 dark:text-neutral-200">
        {script}
      </pre>
    </div>
  );
}
