"use client";

import { claudeFailureText } from "./claudeFailure";
import ClaudeChip from "./ClaudeChip";
import ClaudeKeyPanel from "./ClaudeKeyPanel";
import { onClaudeStatus, type ClaudeChipStatus } from "./claudeStatus";
import UpdateBanner from "./UpdateBanner";
import UserPanel, { EMPTY_USER_DRAFT, type UserDraft } from "./UserPanel";
import MonsoonLoader from "./MonsoonLoader";
import MonsoonLogo from "./MonsoonLogo";
import { useCallback, useEffect, useRef, useState } from "react";
import type { CardFields, CardKind } from "@/lib/monsoon/extract";
import type { CardMatch } from "@/lib/monsoon/match";
import type { CaptureResult } from "@/lib/monsoon/capture";
import type { RefineOutput } from "@/lib/monsoon/refine";
import { loadEstates, loadSignInOptions, readCards, saveCard, signIn, type EstateInfo, type SaveBody } from "./api";
import { downsizeImage } from "./image";
import AskPanel, { EMPTY_ASK, type AskState, type AskViewing } from "./AskPanel";
import AskSheet from "./AskSheet";
import ContactsPanel, { EMPTY_CONTACTS, withOpen, withOpenResearch, type ContactsState, type ContactTarget } from "./ContactsPanel";
import BatchReview, { makeBatch, type Batch } from "./BatchReview";
import { describeResult, type SavePrompt } from "./outcomes";
import ContactFormFields, { type FormKey } from "./ContactFormFields";
import PromptButtons from "./PromptButtons";
import MatchLine, { type MatchChoice } from "./MatchLine";
import { changeOf, choiceAfter, confidentId, NEEDS_CHOICE_HINT, needsChoice } from "./matchState";
import { mergeRefine, type Snapshot } from "./merge";
import SpeakNotes from "./SpeakNotes";
import { card, fieldInput, fieldLabel, primaryButton, primaryLink, secondaryButton } from "./styles";

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

const EMPTY_FORM: Form = {
  name: "",
  title: "",
  org: "",
  email: "",
  phone: "",
  linkedin: "",
  notes: "",
};
const EMPTY_CARD: CardFields = {
  name: "",
  title: "",
  org: "",
  email: "",
  phone: "",
  linkedin: "",
  raw_text: "",
  kind: "card",
};

type Phase = "loading" | "locked" | "failed" | "app";
// `open` is the person a save line is about, in the estate it was saved to: the line then opens their contact card.
type Message = { tone: "ok" | "info" | "error"; text: string; open?: { estate: string; personId: string; name: string } };

function readStoredEstate(): string {
  try {
    return localStorage.getItem(STORAGE_KEY) || DEFAULT_ESTATE;
  } catch {
    return DEFAULT_ESTATE;
  }
}

// The default role when the estate offers it, else its first role, so the dropdown and the saved role agree.
function startRole(e: EstateInfo): string {
  return e.roles.some((r) => r.key === e.defaultRole) ? e.defaultRole : (e.roles[0]?.key ?? e.defaultRole);
}

function storeEstate(key: string) {
  try {
    localStorage.setItem(STORAGE_KEY, key);
  } catch {
    // Private mode: the choice just is not remembered.
  }
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-dvh bg-[#f2f2f7] text-neutral-900 dark:bg-[#07090C] dark:text-white">
      <UpdateBanner />
      {children}
    </div>
  );
}

export default function MonsoonApp() {
  const [phase, setPhase] = useState<Phase>("loading");
  // The header chip: the last real Claude result, from the server at load and from each call after.
  const [claude, setClaude] = useState<ClaudeChipStatus | null>(null);
  const [keyOpen, setKeyOpen] = useState(false);
  useEffect(() => onClaudeStatus(setClaude), []);
  const [estates, setEstates] = useState<EstateInfo[]>([]);
  const [estateKey, setEstateKey] = useState(DEFAULT_ESTATE);
  const [role, setRole] = useState("");
  const [form, setForm] = useState<Form>(EMPTY_FORM);
  const [extracted, setExtracted] = useState<CardFields | null>(null);
  const [captureId, setCaptureId] = useState<string | null>(null);
  const [newOrg, setNewOrg] = useState(false);
  const [message, setMessage] = useState<Message | null>(null);
  const [prompt, setPrompt] = useState<SavePrompt | null>(null);
  const [reading, setReading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [code, setCode] = useState("");
  const [personName, setPersonName] = useState<string | null>(null);
  // The user's own page: whether it is open and what is typed on it and not yet saved. Both live
  // here so they survive the passcode screen. They belong to one person: when someone else signs in
  // on this phone, the page is closed and the draft dropped.
  const [userOpen, setUserOpen] = useState(false);
  const [userDraft, setUserDraft] = useState<UserDraft>(EMPTY_USER_DRAFT);
  const personIdRef = useRef<string | null>(null);
  const [passcode, setPasscode] = useState("");
  const [passError, setPassError] = useState<string | null>(null);
  const [signingIn, setSigningIn] = useState(false);
  // Whether the server says Sign in with Google is on: the passcode screen then offers it too.
  const [googleOn, setGoogleOn] = useState(false);
  const [samePerson, setSamePerson] = useState<string | false | undefined>(undefined);
  const [batch, setBatch] = useState<Batch | null>(null);
  // Match before save: whether the person read from the photo is already on file, the choice made
  // about it, and the kind of photo (sent with the save; nothing for a hand-typed entry).
  const [match, setMatch] = useState<CardMatch | null>(null);
  const [choice, setChoice] = useState<MatchChoice>(null);
  const [kind, setKind] = useState<CardKind | undefined>(undefined);
  // Spoken notes: the draft survives a 401; the snapshot lets Undo restore the form, and
  // `changed` lists the fields still highlighted (a hand edit drops just that field).
  const [spokenDraft, setSpokenDraft] = useState("");
  const [beforeRefine, setBeforeRefine] = useState<{ form: Form; changed: FormKey[] } | null>(null);
  const [tidying, setTidying] = useState(false);
  // Bumped whenever the form is cleared or replaced; a tidy result stamped with an older value is dropped.
  const genRef = useRef(0);
  const tidyGenRef = useRef(0);
  const savingRef = useRef(false);
  // The estate an open batch was started in; a reload of estates must not move it.
  const batchEstateRef = useRef<string | null>(null);
  // True while a batch save run is in flight (reported by BatchReview).
  const [batchRunning, setBatchRunning] = useState(false);
  // Ask is a sheet over whatever is on screen, not a mode. Its conversation lives here so it survives
  // closing the sheet and the passcode screen; askBusy is reported by AskPanel.
  const [mode, setMode] = useState<"capture" | "contacts">("capture");
  const [askOpen, setAskOpen] = useState(false);
  // The loaded profile underneath, reported by ContactsPanel; null whenever none is on screen.
  const [viewing, setViewing] = useState<AskViewing | null>(null);
  // A change confirmed in Ask makes the profile underneath stale: closing the sheet re-reads it.
  const askChangedRef = useRef(false);
  const [profileReload, setProfileReload] = useState(0);
  // Closing the sheet hands the keyboard focus back to the button that opened it.
  const askButtonRef = useRef<HTMLButtonElement>(null);
  const askWasOpenRef = useRef(false);
  useEffect(() => {
    if (askWasOpenRef.current && !askOpen) askButtonRef.current?.focus({ preventScroll: true });
    askWasOpenRef.current = askOpen;
  }, [askOpen]);
  function closeAsk() {
    setAskOpen(false);
    if (askChangedRef.current) {
      askChangedRef.current = false;
      setProfileReload((n) => n + 1);
    }
  }
  // Contacts mode: search text and the open profile live here too, so they survive tab switches and the passcode screen.
  const [contacts, setContacts] = useState<ContactsState>(EMPTY_CONTACTS);
  const [ask, setAsk] = useState<AskState>(EMPTY_ASK);
  const [askBusy, setAskBusy] = useState(false);
  // A "Run research" tap is only good while Contacts is showing; leaving it, or opening Ask over it, withdraws the request.
  useEffect(() => {
    if (mode !== "contacts" || askOpen) setContacts((c) => (c.autoResearch ? { ...c, autoResearch: false } : c));
  }, [mode, askOpen]);
  // True while a profile action (proposing or confirming a change) is in flight; reported by ProfileActions.
  const [profileBusy, setProfileBusy] = useState(false);
  // "Ask about this contact" asks the Ask panel to focus its question box once it opens.
  const [focusAsk, setFocusAsk] = useState(false);
  // The Ask conversation belongs to one estate: any path that changes the estate clears it.
  const askEstateRef = useRef(estateKey);
  useEffect(() => {
    if (askEstateRef.current !== estateKey) {
      askEstateRef.current = estateKey;
      setAsk(EMPTY_ASK);
      setContacts(EMPTY_CONTACTS);
      // The user's page is about one CRM too: its work fields and notes do not carry over.
      setUserOpen(false);
      setUserDraft(EMPTY_USER_DRAFT);
    }
  }, [estateKey]);
  const formRef = useRef(form);
  formRef.current = form;

  const estate = estates.find((e) => e.key === estateKey);
  const batchStarted = batch?.rows.some((r) => r.status === "saved") ?? false;

  const load = useCallback(async () => {
    try {
      const res = await loadEstates();
      if (res.status === 200 && "estates" in res.body) {
        const list = res.body.estates;
        const stored = readStoredEstate();
        const kept = batchEstateRef.current;
        const pick =
          (kept ? list.find((e) => e.key === kept) : undefined) ??
          list.find((e) => e.key === stored && e.available) ??
          list.find((e) => e.available) ??
          list[0];
        setEstates(list);
        setPersonName(res.body.person?.name ?? null);
        // Someone else has signed in: nothing of the last person's page is left for them to see.
        const personId = res.body.person?.id ?? null;
        if (personIdRef.current !== null && personIdRef.current !== personId) {
          setUserOpen(false);
          setUserDraft(EMPTY_USER_DRAFT);
          // Nor their Ask conversation (its answers can restate their page), draft or open contact.
          setAsk(EMPTY_ASK);
          setAskOpen(false);
          setContacts(EMPTY_CONTACTS);
          setMode("capture");
          setKeyOpen(false);
        }
        personIdRef.current = personId;
        setClaude(res.body.claude?.status ?? null);
        if (pick) {
          setEstateKey(pick.key);
          // A reload keeps the role the user already chose when this estate still offers it.
          setRole((current) => (pick.roles.some((r) => r.key === current) ? current : startRole(pick)));
        }
        setPhase("app");
        return;
      }
      if (res.status === 401) {
        setPhase("locked");
        return;
      }
    } catch {
      // network error: fall through to the retry screen
    }
    setPhase("failed");
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // The passcode screen asks the server whether Sign in with Google is on. Until it clearly says
  // yes (and if it never answers) the screen is the passcode screen alone.
  useEffect(() => {
    if (phase !== "locked") return;
    let stopped = false;
    void (async () => {
      try {
        const options = await loadSignInOptions();
        if (!stopped) setGoogleOn(options?.google === true);
      } catch {
        // no answer: no Google button
      }
    })();
    return () => {
      stopped = true;
    };
  }, [phase]);

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem("monsoon.code");
      if (saved) setCode(saved);
    } catch {
      // storage unavailable: the field simply starts empty
    }
  }, []);

  // The match describes the name, company and email that were read; once any changes it no longer applies.
  function dropMatch() {
    setMatch(null);
    setChoice(null);
  }

  // After an edit to who the card is: the match always goes. A positive choice goes too; "Different
  // person" survives a company edit, so adding the company asked for does not ask the question again.
  function matchStale(prev: Form, next: Form) {
    const change = changeOf(prev, next);
    if (change === "same") return;
    setMatch(null);
    setChoice((c) => {
      const kept = choiceAfter(c?.samePerson, change);
      return kept === undefined ? null : { samePerson: kept };
    });
  }

  function edit(key: keyof Form, value: string) {
    matchStale(formRef.current, { ...formRef.current, [key]: value });
    setForm((f) => ({ ...f, [key]: value }));
    setBeforeRefine((b) => (b ? { ...b, changed: b.changed.filter((k) => k !== key) } : b));
    dropPrompt();
    setNewOrg(false);
    setSamePerson(undefined);
  }

  function clearRefine() {
    genRef.current += 1;
    setBeforeRefine(null);
    setSpokenDraft("");
  }

  // Nothing is saved here. The first snapshot is kept across repeated applies.
  function applyRefine(result: RefineOutput, sent: Snapshot) {
    if (tidyGenRef.current !== genRef.current) return;
    const cur = formRef.current;
    const { notes: curNotes, ...curFields } = cur;
    const next = mergeRefine({ fields: curFields, notes: curNotes }, sent, result);
    const merged: Form = { ...cur, ...next.fields, notes: next.notes };
    setForm(merged);
    matchStale(cur, merged);
    setBeforeRefine((prev) => {
      const base = prev?.form ?? cur;
      const keys = Object.keys(merged) as FormKey[];
      return { form: base, changed: keys.filter((k) => merged[k] !== base[k]) };
    });
    dropPrompt();
    setNewOrg(false);
    setSamePerson(undefined);
  }

  function undoRefine() {
    if (!beforeRefine) return;
    setForm(beforeRefine.form);
    matchStale(form, beforeRefine.form);
    setBeforeRefine(null);
    dropPrompt();
    setNewOrg(false);
    setSamePerson(undefined);
  }

  // Clears a showing lookalike / same-name prompt together with its message text.
  function dropPrompt() {
    if (prompt) setMessage(null);
    setPrompt(null);
  }

  function chooseEstate(e: EstateInfo) {
    if (!e.available || batchStarted || askBusy || profileBusy) return;
    setEstateKey(e.key);
    setRole(startRole(e));
    // Cards not yet saved follow the new estate: its start role, and no per-card role left over.
    // The matches describe the other CRM: no row keeps one, nor a person id from it.
    setBatch((b) =>
      b
        ? {
            ...b,
            role: startRole(e),
            rows: b.rows.map((r) => ({ ...r, role: undefined, match: null, choice: undefined, samePerson: undefined })),
          }
        : b,
    );
    storeEstate(e.key);
    if (batchEstateRef.current) batchEstateRef.current = e.key;
    dropPrompt();
    setSamePerson(undefined);
    dropMatch();
  }

  // A chip in an answer: Contacts with that profile open; the Ask conversation stays as it is.
  function openContact(target: ContactTarget) {
    if (askBusy || profileBusy) return;
    setContacts((c) => withOpen(c, target));
    setKeyOpen(false);
    setUserOpen(false);
    setMode("contacts");
    closeAsk();
  }

  // "Run research" on an offer: the person's profile opens in Contacts and research starts there.
  function openAndResearch(personId: string) {
    if (askBusy || profileBusy) return;
    setContacts((c) => withOpenResearch(c, personId));
    setKeyOpen(false);
    setUserOpen(false);
    setMode("contacts");
    closeAsk();
  }

  // Ask about the open profile: the draft is prefilled, never sent, and never overwrites typed text.
  function askAbout(text: string) {
    if (profileBusy) return;
    // The draft already has a line that starts with this text: leave it as it is.
    const has = (a: AskState) => a.draft.split("\n").some((l) => l.startsWith(text) || l.trimEnd() === text.trimEnd());
    setAsk((a) => (has(a) ? a : { ...a, draft: (a.draft.trim() === "" ? text : a.draft + "\n" + text).slice(0, 2000) }));
    setFocusAsk(true);
    setAskOpen(true);
  }

  async function onPhoto(event: React.ChangeEvent<HTMLInputElement>) {
    const input = event.currentTarget;
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;
    setCaptureId(crypto.randomUUID());
    setExtracted(null);
    setKind(undefined);
    dropMatch();
    clearRefine();
    setPrompt(null);
    setNewOrg(false);
    setSamePerson(undefined);
    setMessage(null);
    setReading(true);
    try {
      const blob = await downsizeImage(file);
      const res = await readCards(blob, estateKey);
      if (res.status === 401) {
        setPhase("locked");
        return;
      }
      if (res.status === 200 && "cards" in res.body) {
        const cards = res.body.cards;
        if (cards.length >= 2) {
          setCaptureId(null);
          batchEstateRef.current = estateKey;
          setBatch(makeBatch(cards, res.body.matches ?? null, role, form.notes));
          return;
        }
        // One card fills the form. No card found reads as an empty card, so the form
        // is cleared for typing by hand.
        const f = cards[0] ?? EMPTY_CARD;
        setExtracted(f);
        if (cards.length === 0) {
          setMessage({ tone: "info", text: "No name found in that photo." });
        } else {
          setKind(f.kind);
          const found = res.body.matches?.[0] ?? null;
          setMatch(found);
          const only = confidentId(found);
          setChoice(only ? { samePerson: only } : null);
        }
        setForm((prev) => ({
          name: f.name ?? "",
          title: f.title ?? "",
          org: f.org ?? "",
          email: f.email ?? "",
          phone: f.phone ?? "",
          linkedin: f.linkedin ?? "",
          notes: prev.notes,
        }));
      } else {
        // When the account's Claude key, not the photo, is the problem, say so.
        const claude = claudeFailureText(res.body, "Photos cannot be read");
        setMessage({
          tone: "error",
          text: claude
            ? `${claude} You can type the details instead.`
            : "Could not read the photo. Try again or type the details.",
        });
      }
    } catch {
      setMessage({
        tone: "error",
        text: "Could not read the photo. Try again or type the details.",
      });
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
      ...(kind ? { kind } : {}),
    };
    const wantNewOrg = overrides?.newOrg ?? newOrg;
    if (wantNewOrg) body.newOrg = true;
    // An earlier same-name answer survives a later company-lookalike re-save.
    const answer = overrides?.samePerson ?? samePerson;
    if (answer !== undefined) setSamePerson(answer);
    // No answer to a prompt: the choice on the match line, else nothing (the server asks if needed).
    const sent = answer ?? choice?.samePerson;
    if (sent !== undefined) body.samePerson = sent;

    try {
      const res = await saveCard(body);
      if (res.status === 401) {
        setPhase("locked");
        return;
      }
      if (res.status === 200 && "outcome" in res.body && res.body.outcome === "invalid") {
        setMessage({ tone: "error", text: res.body.error });
        return;
      }
      if (res.status === 400) {
        const error = (res.body as { error?: string }).error;
        setMessage({
          tone: "error",
          text: error || "Could not save. Check the details and try again.",
        });
        return;
      }
      if (res.status !== 200 || !("outcome" in res.body)) {
        setMessage({
          tone: "error",
          text: "Could not save. Check signal and try again.",
        });
        return;
      }
      applyResult(res.body as Exclude<CaptureResult, { outcome: "invalid" }>, estate, fields.org, wantNewOrg);
    } catch {
      setMessage({
        tone: "error",
        text: "Could not save. Check signal and try again.",
      });
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }

  function finish(text: string, open?: Message["open"]) {
    clearRefine();
    setForm(EMPTY_FORM);
    setExtracted(null);
    setKind(undefined);
    dropMatch();
    setCaptureId(null);
    setNewOrg(false);
    setSamePerson(undefined);
    setPrompt(null);
    setMessage({ tone: "ok", text, ...(open ? { open } : {}) });
  }

  function applyResult(
    result: Exclude<CaptureResult, { outcome: "invalid" }>,
    e: EstateInfo,
    org: string,
    wantNewOrg: boolean,
  ) {
    const name = form.name.trim();
    const out = describeResult(result, {
      name,
      org,
      estateLabel: e.label,
      roleLabel,
    });
    if (out.kind === "done") {
      // Every saved outcome names the person on file, so the line can open their contact card.
      const onFile = "name" in result && result.name ? result.name : name;
      finish(out.text, "person" in result && result.person ? { estate: e.key, personId: result.person, name: onFile } : undefined);
      return;
    }
    if (out.kind === "prompt") {
      if (out.prompt.kind === "same_name") setNewOrg(wantNewOrg);
      setPrompt(out.prompt);
    }
    setMessage({ tone: "info", text: out.text });
    // They said "different person" but gave no company: the cursor goes to Company.
    if (result.outcome === "needs_company") document.getElementById("f-org")?.focus();
  }

  function onBatchChange(next: Batch | ((prev: Batch) => Batch)) {
    setBatch((prev) => (prev ? (typeof next === "function" ? next(prev) : next) : prev));
  }

  // Done (summary) or Discard (null): back to the single form, cleared.
  function closeBatch(summary: string | null) {
    batchEstateRef.current = null;
    setBatch(null);
    if (summary) {
      finish(summary);
    } else {
      clearRefine();
      setForm(EMPTY_FORM);
      setExtracted(null);
      setKind(undefined);
      dropMatch();
      setCaptureId(null);
      setMessage(null);
    }
  }

  async function onSignIn(event: React.FormEvent) {
    event.preventDefault();
    const cleanCode = code.trim().toLowerCase();
    if (signingIn || !cleanCode || !passcode) return;
    setSigningIn(true);
    setPassError(null);
    try {
      const res = await signIn(cleanCode, passcode);
      if (res.status === 200) {
        try {
          window.localStorage.setItem("monsoon.code", cleanCode);
        } catch {
          // storage unavailable: nothing to remember
        }
        setPasscode("");
        setPhase("loading");
        await load();
      } else {
        setPassError((res.body as { error?: string }).error ?? "Wrong company code or passcode.");
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
        <div role="status" className="flex flex-col items-center px-6 pt-[max(9rem,env(safe-area-inset-top))]">
          <MonsoonLoader variant="rise" className="h-28 w-28" />
          <span className="sr-only">Loading…</span>
        </div>
      </Shell>
    );
  }

  if (phase === "failed") {
    return (
      <Shell>
        <div className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-5 px-6">
          <MonsoonLogo className="h-10" />
          <p role="alert" className="text-[17px] font-medium text-red-600 dark:text-red-400">
            Could not load. Check signal.
          </p>
          <button
            type="button"
            className={primaryButton}
            onClick={() => {
              setPhase("loading");
              void load();
            }}
          >
            Retry
          </button>
        </div>
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
          <MonsoonLogo className="h-10" />
          {googleOn && (
            <>
              {/* A real link: the browser itself goes to the server, which sends it on to Google. */}
              <a href="/api/monsoon/google/start" className={primaryLink}>
                Sign in with Google
              </a>
              <p className="text-center text-[14px] text-neutral-600 dark:text-neutral-400">or use a company code</p>
            </>
          )}
          <div className={card}>
            <label htmlFor="company-code" className={fieldLabel}>
              Company code
            </label>
            <input
              id="company-code"
              type="text"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              autoComplete="organization"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              className={fieldInput}
            />
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
          <button type="submit" disabled={signingIn || !code.trim() || !passcode} className={primaryButton}>
            {signingIn ? "Unlocking…" : "Unlock"}
          </button>
        </form>
      </Shell>
    );
  }

  const busy = reading || saving || tidying;
  // A name-only match with no company: saving would silently reuse the namesake.
  const waitingForChoice = needsChoice(match, form.org, choice?.samePerson, samePerson);
  const messageColour =
    message?.tone === "ok"
      ? "text-green-700 dark:text-green-400"
      : message?.tone === "error"
        ? "text-red-600 dark:text-red-400"
        : "text-neutral-900 dark:text-white";

  const askBlocked = reading || saving || tidying || batchRunning || profileBusy;
  const askButton = estate ? (
    <div className="pointer-events-none fixed inset-x-0 bottom-0 z-10 flex justify-center px-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
      <button
        type="button"
        ref={askButtonRef}
        aria-label="Ask Monsoon"
        disabled={askBlocked}
        onClick={() => setAskOpen(true)}
        className="pointer-events-auto flex min-h-[60px] w-[62%] max-w-[280px] items-center justify-center gap-2.5 rounded-full bg-[#0E7FA6] px-6 text-[19px] font-semibold text-white shadow-lg shadow-black/25 active:bg-[#0D6A8F] disabled:bg-neutral-400 disabled:text-white dark:bg-[#6AE6FF] dark:text-[#04121A] dark:active:bg-[#3FB8D4] dark:disabled:bg-neutral-700 dark:disabled:text-neutral-400"
      >
        <svg aria-hidden="true" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
          <path d="M4 5.5h16v10.5H10.5L6 20v-4H4z" />
        </svg>
        Ask
      </button>
    </div>
  ) : null;
  const roomForAsk = "pb-[calc(6rem+env(safe-area-inset-bottom))]";
  const askSheet =
    askOpen && estate ? (
      <AskSheet busy={askBusy} onClose={closeAsk}>
        <AskPanel
          estate={estate}
          state={ask}
          onChange={setAsk}
          onUnauthorized={() => setPhase("locked")}
          onBusy={setAskBusy}
          onOpenContact={openContact}
          onResearch={openAndResearch}
          focusOnOpen={focusAsk}
          onFocused={() => setFocusAsk(false)}
          suggested={message?.open && message.open.estate === estateKey ? [`Tell me about ${message.open.name}`] : []}
          viewing={viewing}
          onChanged={() => {
            askChangedRef.current = true;
          }}
        />
      </AskSheet>
    ) : null;

  if (keyOpen) {
    return (
      <Shell>
        {askSheet ?? askButton}
        <main className={`mx-auto flex min-h-dvh max-w-md flex-col gap-4 px-4 pt-[max(1rem,env(safe-area-inset-top))] ${askButton ? roomForAsk : "pb-4"}`}>
          <ClaudeKeyPanel
            onBack={() => setKeyOpen(false)}
            onUnauthorized={() => {
              setKeyOpen(false);
              setPhase("locked");
            }}
            onStatus={setClaude}
          />
        </main>
      </Shell>
    );
  }

  // The user's own page, for the CRM in use. A 401 keeps it open: it is there again after sign-in.
  if (userOpen && estate?.available) {
    return (
      <Shell>
        {askSheet ?? askButton}
        <main className={`mx-auto flex min-h-dvh max-w-md flex-col gap-4 px-4 pt-[max(1rem,env(safe-area-inset-top))] ${askButton ? roomForAsk : "pb-4"}`}>
          <UserPanel
            estate={estate}
            draft={userDraft}
            onDraft={setUserDraft}
            onBack={() => setUserOpen(false)}
            onUnauthorized={() => setPhase("locked")}
            onName={setPersonName}
          />
        </main>
      </Shell>
    );
  }

  return (
    <Shell>
      {askSheet ?? askButton}
      <main
        className={`mx-auto flex min-h-dvh max-w-md flex-col gap-4 px-4 pt-[max(1rem,env(safe-area-inset-top))] ${
          askButton ? roomForAsk : "pb-4"
        }`}
      >
        <div className="flex items-center justify-between gap-3 pt-2">
          <MonsoonLogo className="h-8 px-1" />
          <ClaudeChip
            status={claude}
            disabled={busy || batchRunning || askBusy || profileBusy}
            onClick={() => setKeyOpen(true)}
          />
        </div>
        {/* The person's name and, only for an account with more than one estate, the estates as small
            text beside it: the one in use is marked, a tap on another switches. One estate needs no chooser. */}
        {(personName || estates.length > 1) && (
          <div className="-my-1 flex flex-wrap items-center px-1 text-[13px] text-neutral-500 dark:text-neutral-400">
            {personName &&
              (estate?.available ? (
                // The tap target is 44px tall; the negative margin keeps the row as slim as the text.
                <button
                  type="button"
                  aria-label={`${personName}, your page`}
                  disabled={busy || batchRunning || askBusy || profileBusy}
                  onClick={() => setUserOpen(true)}
                  className="-my-2 flex min-h-[44px] items-center gap-1 rounded-md pr-2 text-left text-[13px] disabled:opacity-40"
                >
                  <span>{personName}</span>
                  <span aria-hidden="true" className="text-[15px] leading-none text-[#0E7FA6] dark:text-[#6AE6FF]">
                    ›
                  </span>
                </button>
              ) : (
                <p>{personName}</p>
              ))}
            {estates.length > 1 && (
              <div role="group" aria-label="Estate" className="flex flex-wrap items-center">
                {personName && (
                  <span aria-hidden="true" className="pl-2">
                    ·
                  </span>
                )}
                {estates.map((e) => {
                  const selected = e.key === estateKey;
                  return (
                    <button
                      key={e.key}
                      type="button"
                      aria-pressed={selected}
                      disabled={!e.available || batchStarted || tidying || reading || batchRunning || askBusy || profileBusy}
                      onClick={() => chooseEstate(e)}
                      className={`min-h-[40px] rounded-md px-2 text-[13px] disabled:opacity-40 ${
                        selected
                          ? "font-semibold text-[#0E7FA6] underline underline-offset-4 dark:text-[#6AE6FF]"
                          : "text-neutral-500 dark:text-neutral-400"
                      }`}
                    >
                      {e.available ? e.label : `${e.label} (unavailable)`}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        )}

        <div
          role="group"
          aria-label="Mode"
          className="grid grid-cols-2 gap-1 rounded-xl bg-neutral-200/80 p-1 dark:bg-white/10"
        >
          {(["capture", "contacts"] as const).map((m) => (
            <button
              key={m}
              type="button"
              aria-pressed={mode === m}
              disabled={
                m === "capture"
                  ? askBusy || profileBusy
                  : reading || saving || tidying || batchRunning || profileBusy || askBusy
              }
              onClick={() => {
                // Contacts tapped while a contact is open: back to the list, with its search and filters.
                if (m === "contacts" && mode === "contacts") setContacts((c) => withOpen(c, null));
                setMode(m);
              }}
              className={`min-h-[44px] rounded-lg px-2 text-[16px] font-semibold disabled:opacity-40 ${
                mode === m
                  ? "bg-white text-neutral-900 shadow-sm dark:bg-[#1F3A4A] dark:text-white"
                  : "text-neutral-600 dark:text-neutral-300"
              }`}
            >
              {m === "capture" ? "Capture" : "Contacts"}
            </button>
          ))}
        </div>

        {mode === "contacts" && estate ? (
          <ContactsPanel
            estate={estate}
            state={contacts}
            onChange={setContacts}
            onUnauthorized={() => setPhase("locked")}
            onBusy={setProfileBusy}
            onAsk={askAbout}
            onViewing={setViewing}
            reloadSignal={profileReload}
          />
        ) : batch && estate ? (
          <BatchReview
            estate={estate}
            batch={batch}
            onChange={onBatchChange}
            onUnauthorized={() => setPhase("locked")}
            onClose={closeBatch}
            onRunning={setBatchRunning}
            onOpenProfile={(personId) => openContact({ personId })}
          />
        ) : (
          <>
            <label
              className={`flex min-h-[64px] cursor-pointer items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-[#0E7FA6]/50 bg-[#0E7FA6]/5 text-[19px] font-semibold text-[#0E7FA6] active:bg-[#0E7FA6]/10 dark:border-[#6AE6FF]/50 dark:bg-[#6AE6FF]/10 dark:text-[#6AE6FF] ${
                busy ? "pointer-events-none opacity-50" : ""
              }`}
            >
              {reading ? (
                <MonsoonLoader className="h-7 w-7" />
              ) : (
                <svg
                  aria-hidden="true"
                  viewBox="0 0 24 24"
                  className="h-6 w-6"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M4 8h3l1.5-2h7L17 8h3v11H4z" />
                  <circle cx="12" cy="13" r="3.5" />
                </svg>
              )}
              <span>{reading ? "Reading photo…" : "Snap or choose a photo"}</span>
              <input type="file" accept="image/*" hidden disabled={busy} onChange={onPhoto} />
            </label>

            {/* The server's same-name question is the same question as the match line: ask it once. */}
            {match && prompt?.kind !== "same_name" && (
              <MatchLine
                match={match}
                choice={choice}
                onChoose={(c) => {
                  // A tap on the match line replaces any earlier prompt answer.
                  setChoice(c);
                  setSamePerson(undefined);
                }}
                onOpen={(personId) => openContact({ personId })}
                disabled={busy}
                roleLabel={roleLabel}
              />
            )}

            {message && (
              <div
                role={message.tone === "error" ? "alert" : "status"}
                className={`${card} flex flex-col gap-3 p-4`}
              >
                {message.open && message.open.estate === estateKey ? (
                  <button
                    type="button"
                    disabled={busy || askBusy || profileBusy}
                    onClick={() => openContact({ personId: message.open!.personId })}
                    className={`flex min-h-[44px] w-full items-center justify-between gap-3 text-left text-[17px] font-medium leading-snug disabled:opacity-50 ${messageColour}`}
                  >
                    <span>{message.text}</span>
                    <span className="flex shrink-0 items-center gap-1 text-[15px] text-[#0E7FA6] dark:text-[#6AE6FF]">
                      Open contact
                      <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M9 5l7 7-7 7" />
                      </svg>
                    </span>
                  </button>
                ) : (
                  <p className={`text-[17px] font-medium leading-snug ${messageColour}`}>{message.text}</p>
                )}
                {prompt && (
                  <PromptButtons
                    prompt={prompt}
                    disabled={busy}
                    onUseOrg={(org) => {
                      setForm((f) => ({ ...f, org }));
                      void doSave({ org, newOrg: false });
                    }}
                    onDifferentCompany={() => {
                      setNewOrg(true);
                      void doSave({ newOrg: true });
                    }}
                    onSamePerson={(personId) => void doSave({ samePerson: personId })}
                  />
                )}
              </div>
            )}

            <ContactFormFields
              form={form}
              roles={estate?.roles ?? []}
              role={role}
              was={beforeRefine?.form ?? null}
              changed={beforeRefine?.changed ?? []}
              onEdit={edit}
              onRole={setRole}
              locked={tidying}
              hints={
                extracted?.name && !extracted.org.trim() && !form.org.trim()
                  ? { org: "Add their company if you know it." }
                  : undefined
              }
              speak={
                <div className="flex flex-col gap-2">
                  <SpeakNotes
                    fields={{
                      name: form.name,
                      title: form.title,
                      org: form.org,
                      email: form.email,
                      phone: form.phone,
                      linkedin: form.linkedin,
                    }}
                    notes={form.notes}
                    draft={spokenDraft}
                    onDraft={setSpokenDraft}
                    onApply={applyRefine}
                    onUnauthorized={() => setPhase("locked")}
                    onBusy={(b) => {
                      if (b) tidyGenRef.current = genRef.current;
                      setTidying(b);
                    }}
                    disabled={busy}
                  />
                  {beforeRefine && (
                    <button type="button" disabled={tidying} className={secondaryButton} onClick={undoRefine}>
                      Undo
                    </button>
                  )}
                </div>
              }
            />

            <div className="sticky bottom-0 -mx-4 mt-auto bg-[#f2f2f7]/90 px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-3 backdrop-blur dark:bg-[#07090C]/90">
              {waitingForChoice && (
                <p className="pb-2 text-[14px] text-neutral-500 dark:text-neutral-400">{NEEDS_CHOICE_HINT}</p>
              )}
              <button
                type="button"
                className={primaryButton}
                disabled={busy || !form.name.trim() || waitingForChoice}
                onClick={() => void doSave()}
              >
                {saving ? "Saving…" : "Save"}
              </button>
            </div>
          </>
        )}
      </main>
    </Shell>
  );
}
