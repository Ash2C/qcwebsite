"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { CardFields } from "@/lib/monsoon/extract";
import type { CaptureResult } from "@/lib/monsoon/capture";
import { loadEstates, readCard, saveCard, signIn, type EstateInfo, type SaveBody } from "./api";
import { downsizeImage } from "./image";

const STORAGE_KEY = "monsoon.estate";
const DEFAULT_ESTATE = "traxo";

type Form = {
  name: string;
  title: string;
  org: string;
  email: string;
  phone: string;
  linkedin: string;
  notes: string;
};

const EMPTY_FORM: Form = { name: "", title: "", org: "", email: "", phone: "", linkedin: "", notes: "" };

type Phase = "loading" | "locked" | "app";
type Message = { tone: "ok" | "info" | "error"; text: string };
type Prompt =
  | { kind: "org"; org: string; similar: string[] }
  | { kind: "same"; name: string; matches: { personId: string; org: string | null }[] }
  | null;

function readStoredEstate(): string {
  try {
    return localStorage.getItem(STORAGE_KEY) || DEFAULT_ESTATE;
  } catch {
    return DEFAULT_ESTATE;
  }
}

function storeEstate(key: string) {
  try {
    localStorage.setItem(STORAGE_KEY, key);
  } catch {
    // Private mode: the choice just is not remembered.
  }
}

const card =
  "rounded-2xl bg-white dark:bg-[#1c1c1e] shadow-sm ring-1 ring-black/5 dark:ring-white/10";
const fieldInput =
  "block w-full min-h-[44px] bg-transparent px-4 py-2.5 text-[17px] text-neutral-900 dark:text-white placeholder:text-neutral-400 dark:placeholder:text-neutral-500 focus:outline-none focus-visible:outline-none";
const fieldLabel =
  "block px-4 pt-2 text-xs font-medium uppercase tracking-wide text-neutral-500 dark:text-neutral-400";
const primaryButton =
  "min-h-[52px] w-full rounded-2xl bg-blue-600 px-6 text-[17px] font-semibold text-white active:bg-blue-700 disabled:bg-neutral-300 disabled:text-neutral-500 dark:bg-blue-500 dark:active:bg-blue-600 dark:disabled:bg-neutral-700 dark:disabled:text-neutral-500";
const secondaryButton =
  "min-h-[44px] w-full rounded-xl bg-neutral-100 px-4 text-[16px] font-medium text-blue-700 active:bg-neutral-200 disabled:opacity-50 dark:bg-white/10 dark:text-blue-300 dark:active:bg-white/20";

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-dvh bg-[#f2f2f7] text-neutral-900 dark:bg-black dark:text-white">
      {children}
    </div>
  );
}

export default function MonsoonApp() {
  const [phase, setPhase] = useState<Phase>("loading");
  const [estates, setEstates] = useState<EstateInfo[]>([]);
  const [estateKey, setEstateKey] = useState(DEFAULT_ESTATE);
  const [role, setRole] = useState("");
  const [form, setForm] = useState<Form>(EMPTY_FORM);
  const [extracted, setExtracted] = useState<CardFields | null>(null);
  const [captureId, setCaptureId] = useState<string | null>(null);
  const [newOrg, setNewOrg] = useState(false);
  const [message, setMessage] = useState<Message | null>(null);
  const [prompt, setPrompt] = useState<Prompt>(null);
  const [reading, setReading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [passcode, setPasscode] = useState("");
  const [passError, setPassError] = useState<string | null>(null);
  const [signingIn, setSigningIn] = useState(false);
  const savingRef = useRef(false);

  const estate = estates.find((e) => e.key === estateKey);

  const load = useCallback(async () => {
    try {
      const res = await loadEstates();
      if (res.status === 200 && "estates" in res.body) {
        const list = res.body.estates;
        const stored = readStoredEstate();
        const pick =
          list.find((e) => e.key === stored && e.available) ?? list.find((e) => e.available) ?? list[0];
        setEstates(list);
        if (pick) {
          setEstateKey(pick.key);
          setRole(pick.defaultRole);
        }
        setPhase("app");
        return;
      }
    } catch {
      // fall through to the passcode screen
    }
    setPhase("locked");
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  function edit(key: keyof Form, value: string) {
    setForm((f) => ({ ...f, [key]: value }));
    setPrompt(null);
    setNewOrg(false);
  }

  function chooseEstate(e: EstateInfo) {
    if (!e.available) return;
    setEstateKey(e.key);
    setRole(e.defaultRole);
    storeEstate(e.key);
    setPrompt(null);
  }

  async function onPhoto(event: React.ChangeEvent<HTMLInputElement>) {
    const input = event.currentTarget;
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;
    setCaptureId(crypto.randomUUID());
    setExtracted(null);
    setPrompt(null);
    setNewOrg(false);
    setMessage(null);
    setReading(true);
    try {
      const blob = await downsizeImage(file);
      const res = await readCard(blob);
      if (res.status === 401) {
        setPhase("locked");
        return;
      }
      if (res.status === 200 && "fields" in res.body) {
        const f = res.body.fields;
        setExtracted(f);
        setForm({
          name: f.name ?? "",
          title: f.title ?? "",
          org: f.org ?? "",
          email: f.email ?? "",
          phone: f.phone ?? "",
          linkedin: f.linkedin ?? "",
          notes: "",
        });
      } else {
        setMessage({ tone: "error", text: "Could not read the photo. Try again or type the details." });
      }
    } catch {
      setMessage({ tone: "error", text: "Could not read the photo. Try again or type the details." });
    } finally {
      setReading(false);
    }
  }

  function roleLabel(key: string): string {
    return estate?.roles.find((r) => r.key === key)?.label ?? key;
  }

  async function doSave(overrides?: { org?: string; newOrg?: boolean; samePerson?: string | false }) {
    if (savingRef.current || !estate || !form.name.trim()) return;
    savingRef.current = true;
    setSaving(true);
    setMessage(null);
    setPrompt(null);
    const id = captureId ?? crypto.randomUUID();
    if (!captureId) setCaptureId(id);
    const fields = { ...form, org: overrides?.org ?? form.org };
    const body: SaveBody = {
      estate: estate.key,
      role,
      captureId: id,
      fields,
      ...(extracted ? { extracted } : {}),
    };
    const wantNewOrg = overrides?.newOrg ?? newOrg;
    if (wantNewOrg) body.newOrg = true;
    if (overrides?.samePerson !== undefined) body.samePerson = overrides.samePerson;

    try {
      const res = await saveCard(body);
      if (res.status === 401) {
        setPhase("locked");
        return;
      }
      if (res.status === 400) {
        const error = (res.body as { error?: string }).error;
        setMessage({ tone: "error", text: error || "Could not save. Check the details and try again." });
        return;
      }
      if (res.status !== 200 || !("outcome" in res.body)) {
        setMessage({ tone: "error", text: "Could not save. Check signal and try again." });
        return;
      }
      applyResult(res.body as CaptureResult, estate, fields.org, wantNewOrg);
    } catch {
      setMessage({ tone: "error", text: "Could not save. Check signal and try again." });
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }

  function finish(text: string) {
    setForm(EMPTY_FORM);
    setExtracted(null);
    setCaptureId(null);
    setNewOrg(false);
    setPrompt(null);
    setMessage({ tone: "ok", text });
  }

  function applyResult(result: CaptureResult, e: EstateInfo, org: string, wantNewOrg: boolean) {
    const name = form.name.trim();
    switch (result.outcome) {
      case "added":
        finish(`${name} added to ${e.label}.`);
        break;
      case "existing": {
        const r = roleLabel(result.role);
        finish(
          result.filled.length > 0
            ? `${name} is already in ${e.label} as ${r}; filled in ${result.filled.join(", ")}.`
            : `${name} is already in ${e.label} as ${r}; nothing new.`,
        );
        break;
      }
      case "duplicate":
        finish(`${name} saved to ${e.label}.`);
        break;
      case "org_lookalike":
        setPrompt({ kind: "org", org: org.trim(), similar: result.similar });
        setMessage({ tone: "info", text: `${org.trim()} looks like a company already on file.` });
        break;
      case "same_name":
        setNewOrg(wantNewOrg);
        setPrompt({ kind: "same", name, matches: result.matches });
        setMessage({
          tone: "info",
          text: `${name} is already on file at ${result.matches[0]?.org ?? "no company"}. Same person?`,
        });
        break;
      case "ambiguous":
        setMessage({
          tone: "info",
          text: `Several people are named ${name}. Add the company to say which one.`,
        });
        break;
      case "invalid":
        setMessage({ tone: "error", text: result.error });
        break;
    }
  }

  async function onSignIn(event: React.FormEvent) {
    event.preventDefault();
    if (signingIn || !passcode) return;
    setSigningIn(true);
    setPassError(null);
    try {
      const res = await signIn(passcode);
      if (res.status === 200) {
        setPasscode("");
        setPhase("loading");
        await load();
      } else {
        setPassError((res.body as { error?: string }).error ?? "Could not sign in");
      }
    } catch {
      setPassError("Could not sign in. Check signal and try again.");
    } finally {
      setSigningIn(false);
    }
  }

  if (phase === "loading") {
    return (
      <Shell>
        <p className="px-6 pt-[max(6rem,env(safe-area-inset-top))] text-center text-neutral-500">Loading…</p>
      </Shell>
    );
  }

  if (phase === "locked") {
    return (
      <Shell>
        <form
          onSubmit={onSignIn}
          className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-5 px-6 pb-[max(1.5rem,env(safe-area-inset-bottom))] pt-[max(1.5rem,env(safe-area-inset-top))]"
        >
          <h1 className="text-4xl font-bold tracking-tight">Monsoon</h1>
          <div className={card}>
            <label htmlFor="passcode" className={fieldLabel}>
              Passcode
            </label>
            <input
              id="passcode"
              type="password"
              autoComplete="current-password"
              value={passcode}
              onChange={(e) => setPasscode(e.target.value)}
              className={fieldInput}
            />
          </div>
          {passError && (
            <p role="alert" className="text-[15px] font-medium text-red-600 dark:text-red-400">
              {passError}
            </p>
          )}
          <button type="submit" disabled={signingIn || !passcode} className={primaryButton}>
            {signingIn ? "Unlocking…" : "Unlock"}
          </button>
        </form>
      </Shell>
    );
  }

  const busy = reading || saving;
  const messageColour =
    message?.tone === "ok"
      ? "text-green-700 dark:text-green-400"
      : message?.tone === "error"
        ? "text-red-600 dark:text-red-400"
        : "text-neutral-900 dark:text-white";

  const rows: { key: keyof Form; label: string; type?: string; mode?: "email" | "tel" | "url"; auto?: string }[] = [
    { key: "name", label: "Name", auto: "off" },
    { key: "title", label: "Title", auto: "off" },
    { key: "org", label: "Company", auto: "off" },
    { key: "email", label: "Email", type: "email", mode: "email", auto: "off" },
    { key: "phone", label: "Phone", type: "tel", mode: "tel", auto: "off" },
    { key: "linkedin", label: "LinkedIn", type: "url", mode: "url", auto: "off" },
  ];

  return (
    <Shell>
      <main className="mx-auto flex min-h-dvh max-w-md flex-col gap-4 px-4 pb-4 pt-[max(1rem,env(safe-area-inset-top))]">
        <h1 className="px-1 pt-2 text-4xl font-bold tracking-tight">Monsoon</h1>

        <div role="group" aria-label="Estate" className="grid grid-cols-2 gap-1 rounded-xl bg-neutral-200/80 p-1 dark:bg-white/10">
          {estates.map((e) => {
            const selected = e.key === estateKey;
            return (
              <button
                key={e.key}
                type="button"
                aria-pressed={selected}
                disabled={!e.available}
                onClick={() => chooseEstate(e)}
                className={`min-h-[44px] rounded-lg px-2 text-[16px] font-semibold disabled:opacity-40 ${
                  selected
                    ? "bg-white text-neutral-900 shadow-sm dark:bg-[#636366] dark:text-white"
                    : "text-neutral-600 dark:text-neutral-300"
                }`}
              >
                {e.available ? e.label : `${e.label} (unavailable)`}
              </button>
            );
          })}
        </div>

        <label
          className={`flex min-h-[64px] cursor-pointer items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-blue-600/50 bg-blue-600/5 text-[19px] font-semibold text-blue-700 active:bg-blue-600/10 dark:border-blue-400/50 dark:bg-blue-400/10 dark:text-blue-300 ${
            busy ? "pointer-events-none opacity-50" : ""
          }`}
        >
          <svg aria-hidden="true" viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M4 8h3l1.5-2h7L17 8h3v11H4z" />
            <circle cx="12" cy="13" r="3.5" />
          </svg>
          <span>{reading ? "Reading card…" : "Take photo"}</span>
          <input type="file" accept="image/*" capture="environment" hidden disabled={busy} onChange={onPhoto} />
        </label>

        {message && (
          <div
            role={message.tone === "error" ? "alert" : "status"}
            className={`${card} flex flex-col gap-3 p-4`}
          >
            <p className={`text-[17px] font-medium leading-snug ${messageColour}`}>{message.text}</p>
            {prompt?.kind === "org" && (
              <div className="flex flex-col gap-2">
                {prompt.similar.map((s) => (
                  <button
                    key={s}
                    type="button"
                    disabled={saving}
                    className={secondaryButton}
                    onClick={() => {
                      setForm((f) => ({ ...f, org: s }));
                      void doSave({ org: s, newOrg: false });
                    }}
                  >
                    Use {s}
                  </button>
                ))}
                <button
                  type="button"
                  disabled={saving}
                  className={secondaryButton}
                  onClick={() => {
                    setNewOrg(true);
                    void doSave({ newOrg: true });
                  }}
                >
                  It&apos;s a different company
                </button>
              </div>
            )}
            {prompt?.kind === "same" && (
              <div className="flex flex-col gap-2">
                {prompt.matches.map((m) => (
                  <button
                    key={m.personId}
                    type="button"
                    disabled={saving}
                    className={secondaryButton}
                    onClick={() => void doSave({ samePerson: m.personId })}
                  >
                    Same person ({m.org ?? "no company"})
                  </button>
                ))}
                <button
                  type="button"
                  disabled={saving}
                  className={secondaryButton}
                  onClick={() => void doSave({ samePerson: false })}
                >
                  Different person
                </button>
              </div>
            )}
          </div>
        )}

        <div className={`${card} divide-y divide-neutral-200 overflow-hidden dark:divide-white/10`}>
          {rows.map((r) => (
            <div key={r.key}>
              <label htmlFor={`f-${r.key}`} className={fieldLabel}>
                {r.label}
              </label>
              <input
                id={`f-${r.key}`}
                type={r.type ?? "text"}
                inputMode={r.mode}
                autoComplete={r.auto}
                autoCapitalize={r.key === "name" || r.key === "title" || r.key === "org" ? "words" : "off"}
                autoCorrect="off"
                value={form[r.key]}
                onChange={(e) => edit(r.key, e.target.value)}
                className={fieldInput}
              />
            </div>
          ))}
          <div>
            <label htmlFor="f-role" className={fieldLabel}>
              Role
            </label>
            <select
              id="f-role"
              value={role}
              onChange={(e) => setRole(e.target.value)}
              className={`${fieldInput} appearance-none`}
            >
              {(estate?.roles ?? []).map((r) => (
                <option key={r.key} value={r.key}>
                  {r.label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="f-notes" className={fieldLabel}>
              Notes
            </label>
            <textarea
              id="f-notes"
              rows={3}
              value={form.notes}
              onChange={(e) => edit("notes", e.target.value)}
              className={`${fieldInput} resize-none`}
            />
          </div>
        </div>

        <div className="sticky bottom-0 -mx-4 mt-auto bg-[#f2f2f7]/90 px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-3 backdrop-blur dark:bg-black/90">
          <button
            type="button"
            className={primaryButton}
            disabled={busy || !form.name.trim()}
            onClick={() => void doSave()}
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </main>
    </Shell>
  );
}
