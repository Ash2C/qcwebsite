"use client";

// The setup link's form: just the Claude key. The server tests the key before storing it;
// the field is cleared and the form hidden once it succeeds.
import { useState, type FormEvent } from "react";
import { card, fieldInput, fieldLabel, primaryButton } from "./styles";

export default function SetupForm({ token }: { token: string }) {
  const [claudeKey, setClaudeKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; ok: boolean } | null>(null);
  const [done, setDone] = useState(false);

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
        body: JSON.stringify({ token, claudeKey }),
      });
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; message?: string; error?: string };
      if (res.ok && body.ok) {
        setClaudeKey("");
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
          <div className={card}>
            <label htmlFor="setup-claudeKey" className={fieldLabel}>
              Claude API key
            </label>
            <input
              id="setup-claudeKey"
              name="claudeKey"
              type="password"
              autoComplete="new-password"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              required
              value={claudeKey}
              onChange={(ev) => setClaudeKey(ev.target.value)}
              className={fieldInput}
            />
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
