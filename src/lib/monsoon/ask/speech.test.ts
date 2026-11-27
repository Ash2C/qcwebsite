import { describe, it, expect, vi, afterEach } from "vitest";
import {
  SPEECH_TIMEOUT_MS,
  SPOKEN_REPLY_INSTRUCTION,
  captionsFor,
  cleanForSpeech,
  speak,
  speechConfigured,
  splitSentences,
  spokenText,
  type Alignment,
} from "./speech";

const ENV = { ELEVENLABS_API_KEY: "test-key", MONSOON_VOICE_ID: "voice123" };

function alignmentFor(text: string): Alignment {
  const characters = text.split("");
  const ends = characters.map((_, i) => (i + 1) * 0.1);
  return {
    characters,
    character_start_times_seconds: ends.map((e) => e - 0.1),
    character_end_times_seconds: ends,
  };
}

afterEach(() => vi.restoreAllMocks());

describe("speech helpers", () => {
  it("has an 8 second default timeout", () => {
    expect(SPEECH_TIMEOUT_MS).toBe(8000);
  });
  it("strips markdown and bullets before speaking", () => {
    expect(cleanForSpeech("**Anna Lee** and `Northwind` __rose__.")).toBe("Anna Lee and Northwind rose.");
    expect(cleanForSpeech("- one\n* two")).toBe("one\ntwo");
  });
  it("keeps decimals inside one sentence", () => {
    expect(splitSentences("Revenue was 1.2 billion. It rose 45.6% too!")).toEqual([
      "Revenue was 1.2 billion.",
      "It rose 45.6% too!",
    ]);
  });
  it("returns no captions for an empty answer", () => {
    expect(captionsFor("", null)).toEqual([]);
  });
  it("gives one caption starting at 0 for a sentence without a full stop", () => {
    const caps = captionsFor("No full stop here", null);
    expect(caps).toHaveLength(1);
    expect(caps[0].start).toBe(0);
  });
  it("times each caption from the audio's character timings", () => {
    const answer = "Anna grew. Prices fell.";
    const al = alignmentFor(answer);
    const caps = captionsFor(answer, al);
    expect(caps.map((c) => c.text)).toEqual(["Anna grew.", "Prices fell."]);
    expect(caps[0].start).toBe(0);
    expect(caps[0].end).toBeCloseTo(1.0, 5);
    expect(caps[1].start).toBeCloseTo(caps[0].end, 5);
    expect(caps[1].end).toBeCloseTo(al.character_end_times_seconds.at(-1)!, 5);
  });
  it("spreads captions by length when there is no alignment", () => {
    const caps = captionsFor("One. Two two.", null);
    expect(caps).toHaveLength(2);
    expect(caps[0].start).toBe(0);
    expect(caps[1].start).toBeCloseTo(caps[0].end, 5);
    expect(caps[1].end).toBeGreaterThan(caps[0].end);
  });
  it("puts the instruction in brackets after the question", () => {
    const t = spokenText("Who is next?");
    expect(t.startsWith("Who is next?\n\n(")).toBe(true);
    expect(t.endsWith(`(${SPOKEN_REPLY_INSTRUCTION})`)).toBe(true);
  });
});

describe("speechConfigured", () => {
  it("is true only with both env values", () => {
    expect(speechConfigured(ENV)).toBe(true);
    for (const env of [{}, { ELEVENLABS_API_KEY: "k" }, { MONSOON_VOICE_ID: "v" }, { ELEVENLABS_API_KEY: "", MONSOON_VOICE_ID: "v" }]) {
      expect(speechConfigured(env)).toBe(false);
    }
  });
});

describe("speak", () => {
  it("makes no request without both env values", async () => {
    const fetchFn = vi.fn();
    for (const env of [{}, { ELEVENLABS_API_KEY: "k" }, { MONSOON_VOICE_ID: "v" }]) {
      const r = await speak("One. Two two.", { env, fetchFn: fetchFn as unknown as typeof fetch });
      expect(r.audio).toBeNull();
      expect(r.captions).toHaveLength(2);
    }
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("returns audio and aligned captions, sending only text, model and voice settings", async () => {
    const answer = "Anna grew. Prices fell.";
    const al = alignmentFor(answer);
    const fetchFn = vi.fn(async () =>
      new Response(JSON.stringify({ audio_base64: "QUJD", alignment: al }), { status: 200 }),
    );
    const r = await speak(`**${answer}**`, { env: ENV, fetchFn: fetchFn as unknown as typeof fetch });
    expect(r.audio).toBe("QUJD");
    expect(r.captions[0].end).toBeCloseTo(1.0, 5);
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.elevenlabs.io/v1/text-to-speech/voice123/with-timestamps");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["xi-api-key"]).toBe("test-key");
    const body = JSON.parse(init.body as string);
    expect(Object.keys(body).sort()).toEqual(["model_id", "text", "voice_settings"]);
    expect(body.text).toBe(answer);
    expect(body.model_id).toBe("eleven_multilingual_v2");
    expect(body.voice_settings).toEqual({ stability: 0.8, similarity_boost: 0.75 });
  });

  it("falls back to length-timed captions on a rejected fetch and logs only the error name", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchFn = vi.fn(async () => {
      throw new TypeError("secret question text");
    });
    const r = await speak("One. Two two.", { env: ENV, fetchFn: fetchFn as unknown as typeof fetch });
    expect(r.audio).toBeNull();
    expect(r.captions).toHaveLength(2);
    expect(err).toHaveBeenCalledWith("monsoon: speech failed", "TypeError");
  });

  it("returns null audio on HTTP 500 and logs the status", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchFn = vi.fn(async () => new Response("nope", { status: 500 }));
    const r = await speak("One.", { env: ENV, fetchFn: fetchFn as unknown as typeof fetch });
    expect(r.audio).toBeNull();
    expect(r.captions).toHaveLength(1);
    expect(err).toHaveBeenCalledWith("monsoon: speech failed", 500);
  });

  it("returns null audio when the request never resolves within the timeout", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchFn = vi.fn(
      (_u: string, init: RequestInit) =>
        new Promise<Response>((_res, rej) => {
          init.signal?.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" })));
        }),
    );
    const r = await speak("One. Two.", { env: ENV, fetchFn: fetchFn as unknown as typeof fetch, timeoutMs: 20 });
    expect(r.audio).toBeNull();
    expect(r.captions).toHaveLength(2);
  });

  it("times out even if fetch ignores the abort signal", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchFn = vi.fn(() => new Promise<Response>(() => {}));
    const r = await speak("One.", { env: ENV, fetchFn: fetchFn as unknown as typeof fetch, timeoutMs: 20 });
    expect(r.audio).toBeNull();
  });

  it("returns null audio when the body is malformed", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchFn = vi.fn(async () => new Response("not json", { status: 200 }));
    const r = await speak("One.", { env: ENV, fetchFn: fetchFn as unknown as typeof fetch });
    expect(r.audio).toBeNull();
  });
});
