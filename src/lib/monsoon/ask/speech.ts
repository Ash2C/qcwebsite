// Spoken answers for Ask: one ElevenLabs voice, plus caption timings so the
// page can show each sentence while it is spoken. Nothing here logs a question
// or an answer, and nothing here ever throws to the caller.

export const SPEECH_TIMEOUT_MS = 8_000;

/** Added to the reader's question for a spoken reply. */
export const SPOKEN_REPLY_INSTRUCTION =
  "Spoken reply: this answer is read aloud and shown as captions. Answer in at most 70 words, in two to four short spoken sentences. No lists, headings, markdown or brackets. Say names in full and dates the way they are spoken. When there are more than three items, give the three that matter most and say how many more there are. If you propose a change, say that a card is waiting to be confirmed, and never say the change is done.";

export type Caption = { text: string; start: number; end: number };
export type Alignment = {
  characters: string[];
  character_start_times_seconds: number[];
  character_end_times_seconds: number[];
};

/** Plain text for speaking: no markdown emphasis and no bullet markers. */
export function cleanForSpeech(text: string): string {
  return text
    .replace(/\*\*|__|`/g, "")
    .replace(/^\s*[-*]\s+/gm, "")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
}

/** Sentences split on . ! ? followed by whitespace, so "1.2" stays whole. */
export function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * One caption per sentence. With an alignment, sentence i ends at the end time
 * of its last character and starts where the previous one ended. Without one,
 * captions share total = characters / 15 seconds in proportion to length.
 */
export function captionsFor(answer: string, alignment: Alignment | null): Caption[] {
  const sentences = splitSentences(answer);
  if (sentences.length === 0) return [];
  const ends = alignment?.character_end_times_seconds ?? [];
  if (ends.length) {
    const out: Caption[] = [];
    let cursor = 0;
    let start = 0;
    for (const s of sentences) {
      const idx = answer.indexOf(s, cursor);
      const endIdx = Math.min((idx >= 0 ? idx : cursor) + s.length - 1, ends.length - 1);
      cursor = endIdx + 1;
      const end = ends[endIdx];
      out.push({ text: s, start, end });
      start = end;
    }
    return out;
  }
  const chars = sentences.reduce((n, s) => n + s.length, 0);
  const total = chars / 15;
  let t = 0;
  return sentences.map((s) => {
    const d = (s.length / chars) * total;
    const c = { text: s, start: t, end: t + d };
    t += d;
    return c;
  });
}

export function spokenText(question: string): string {
  return `${question}\n\n(${SPOKEN_REPLY_INSTRUCTION})`;
}

class HttpError extends Error {
  constructor(readonly status: number) {
    super("http");
  }
}

/** True only with both ELEVENLABS_API_KEY and MONSOON_VOICE_ID set: without either, answers are captions only. */
export function speechConfigured(
  env: Record<string, string | undefined>,
): env is Record<string, string | undefined> & { ELEVENLABS_API_KEY: string; MONSOON_VOICE_ID: string } {
  return Boolean(env.ELEVENLABS_API_KEY && env.MONSOON_VOICE_ID);
}

/** Never throws. audio is null without both env values, on any failure, or on timeout. */
export async function speak(
  answer: string,
  deps: { env: Record<string, string | undefined>; fetchFn?: typeof fetch; timeoutMs?: number },
): Promise<{ audio: string | null; captions: Caption[] }> {
  let text = answer;
  try {
    text = cleanForSpeech(answer);
  } catch {
    // keep the raw answer
  }
  const env = deps.env;
  if (!speechConfigured(env) || !text) return { audio: null, captions: safeCaptions(text, null) };
  const key = env.ELEVENLABS_API_KEY;
  const voice = env.MONSOON_VOICE_ID;

  const fetchFn = deps.fetchFn ?? fetch;
  const timeoutMs = deps.timeoutMs ?? SPEECH_TIMEOUT_MS;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(Object.assign(new Error("timeout"), { name: "TimeoutError" }));
      }, timeoutMs);
    });
    const work = (async () => {
      const res = await fetchFn(`https://api.elevenlabs.io/v1/text-to-speech/${voice}/with-timestamps`, {
        method: "POST",
        headers: { "xi-api-key": key, "Content-Type": "application/json" },
        body: JSON.stringify({
          text,
          model_id: "eleven_multilingual_v2",
          voice_settings: { stability: 0.8, similarity_boost: 0.75 },
        }),
        signal: controller.signal,
      });
      if (!res.ok) throw new HttpError(res.status);
      const j = (await res.json()) as {
        audio_base64?: string;
        alignment?: Alignment | null;
        normalized_alignment?: Alignment | null;
      };
      if (!j.audio_base64) throw new Error("no audio");
      return { audio: j.audio_base64, alignment: j.alignment ?? j.normalized_alignment ?? null };
    })();
    work.catch(() => {}); // a late failure after a timeout is already handled
    const r = await Promise.race([work, timeout]);
    return { audio: r.audio, captions: safeCaptions(text, r.alignment) };
  } catch (e) {
    console.error("monsoon: speech failed", e instanceof HttpError ? e.status : e instanceof Error ? e.name : "Error");
    return { audio: null, captions: safeCaptions(text, null) };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function safeCaptions(text: string, alignment: Alignment | null): Caption[] {
  try {
    return captionsFor(text, alignment);
  } catch {
    return captionsFor(text, null);
  }
}
