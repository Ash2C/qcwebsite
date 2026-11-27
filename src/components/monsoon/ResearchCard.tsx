"use client";

import { useId, useState } from "react";
import type { SignedProposal } from "@/lib/monsoon/ask/proposal";
import { DETAIL_LABELS, MAX_NOTE } from "./ChangeCard";
import { card as cardClass, primaryButton, secondaryButton } from "./styles";
import type { AskCard } from "./useCardConfirm";

type Research = Extract<SignedProposal["proposal"], { kind: "apply_research" }>;

/** The host of an https URL, or null when it does not parse or is not https (then nothing is clickable). */
function httpsHost(url: string): string | null {
  try {
    const u = new URL(url);
    return u.protocol === "https:" ? u.host : null;
  } catch {
    return null;
  }
}

function SourceLink({ url, text }: { url: string; text: string }) {
  const host = httpsHost(url);
  if (!host) return <span className="break-all">{text}</span>;
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="break-all text-[#0E7FA6] underline dark:text-[#6AE6FF]"
    >
      {text}
    </a>
  );
}

export default function ResearchCard({
  signed,
  summary,
  roleLabel,
  state,
  message,
  onSave,
  onDiscard,
  blocked = false,
}: {
  signed: SignedProposal;
  summary: string;
  roleLabel?: string;
  state: AskCard["state"];
  message?: string;
  onSave: (ticked: string[], summary: string) => void;
  onDiscard: () => void;
  /** Another write is in flight elsewhere (Ask): Save waits for it. */
  blocked?: boolean;
}) {
  const ids = useId();
  const p = signed.proposal as Research;
  // Rows that fill an empty field start ticked; rows that change an existing value do not.
  // Work email and phone never start ticked: they are contact details, so they need a deliberate tap.
  const [ticked, setTicked] = useState<string[]>(() =>
    p.findings.filter((f) => f.from === null && f.field !== "email" && f.field !== "phone").map((f) => f.id),
  );
  const [text, setText] = useState(summary);
  const hasSummary = p.summarySources.length > 0;
  const summaryText = hasSummary ? text : "";
  const working = state === "working";
  const open = state === "open" || working;
  const tooLong = summaryText.trim().length > MAX_NOTE;
  const empty = ticked.length === 0 && summaryText.trim() === "";
  // A message on an open card is a failed save; on a failed card it is the expiry. Both are errors.
  const isError = state === "failed" || state === "open";
  const tone = isError ? "text-red-600 dark:text-red-400" : "text-neutral-600 dark:text-neutral-300";

  function toggle(id: string) {
    setTicked((t) => (t.includes(id) ? t.filter((x) => x !== id) : [...t, id]));
  }

  return (
    <div className={`${cardClass} flex min-w-0 flex-col gap-3 p-4`}>
      <p className="text-xs font-medium uppercase tracking-wide text-neutral-500 dark:text-neutral-400">
        {`Research: ${p.person.name}`}
      </p>
      <p className="break-words text-[15px] text-neutral-600 dark:text-neutral-300">{p.identity}</p>
      <ul className="flex flex-col gap-3">
        {p.findings.map((f) => {
          const label = DETAIL_LABELS[f.field];
          const line = f.from === null ? `${label}: ${f.to}` : `${label}: ${f.from} → ${f.to}`;
          const host = httpsHost(f.source);
          return (
            <li key={f.id} className="flex min-w-0 items-start gap-3">
              <input
                id={`${ids}-${f.id}`}
                type="checkbox"
                className="mt-1 h-5 w-5 shrink-0"
                checked={ticked.includes(f.id)}
                disabled={!open || working}
                onChange={() => toggle(f.id)}
              />
              <div className="flex min-w-0 flex-col">
                <label htmlFor={`${ids}-${f.id}`} className="break-words text-[17px]">
                  {line}
                </label>
                <span className="break-all text-[14px] text-neutral-500 dark:text-neutral-400">
                  {"source: "}
                  <SourceLink url={f.source} text={host ?? f.source} />
                </span>
              </div>
            </li>
          );
        })}
      </ul>
      {hasSummary && (
        <>
          <label htmlFor={`${ids}-summary`} className="text-[15px] font-medium">
            Summary (added to the timeline)
          </label>
          <textarea
            id={`${ids}-summary`}
            rows={5}
            value={text}
            disabled={!open || working}
            onChange={(e) => setText(e.target.value)}
            className="block w-full break-words rounded-xl bg-neutral-100 px-4 py-2.5 text-[17px] text-neutral-900 focus:outline-none dark:bg-white/10 dark:text-white"
          />
          {tooLong && (
            <p role="alert" className="text-[15px] font-medium text-red-600 dark:text-red-400">
              {`Notes can be up to ${MAX_NOTE} characters.`}
            </p>
          )}
          <div className="flex min-w-0 flex-col gap-1 text-[14px] text-neutral-500 dark:text-neutral-400">
            <p>{`sources: ${p.summarySources.length} ${p.summarySources.length === 1 ? "link" : "links"}`}</p>
            <ul className="flex flex-col gap-1">
              {p.summarySources.map((u) => (
                <li key={u}>
                  <SourceLink url={u} text={httpsHost(u) ?? u} />
                </li>
              ))}
            </ul>
          </div>
        </>
      )}
      {p.addsToPipeline && (
        <p className="break-words text-[15px] text-neutral-600 dark:text-neutral-300">
          {`This also adds ${p.person.name} to the pipeline as ${roleLabel ?? p.addsToPipeline.replace(/_/g, " ")}.`}
        </p>
      )}
      {message && (
        <p role={isError ? "alert" : "status"} className={`break-words text-[15px] font-medium ${tone}`}>
          {message}
        </p>
      )}
      {open && (
        <div className="grid grid-cols-2 gap-2">
          <button type="button" className={secondaryButton} disabled={working} onClick={onDiscard}>
            Discard
          </button>
          <button
            type="button"
            className={primaryButton + " !min-h-[44px] !rounded-xl !text-[16px]"}
            disabled={working || blocked || empty || tooLong}
            onClick={() =>
              onSave(
                p.findings.map((f) => f.id).filter((id) => ticked.includes(id)),
                summaryText,
              )
            }
          >
            Save selected
          </button>
        </div>
      )}
    </div>
  );
}
