import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const create = vi.fn();
const ctorOptions: unknown[] = [];
vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    constructor(options?: unknown) {
      ctorOptions.push(options);
      // The real client throws when no API key is configured.
      if (!process.env.ANTHROPIC_API_KEY) throw new Error("missing api key");
    }
    messages = { create: (...args: unknown[]) => create(...args) };
  },
}));

import { extractCard, resolveModel } from "./extract";

const KEYS = ["name", "title", "org", "email", "phone", "linkedin", "raw_text"];
const EMPTY = {
  name: "",
  title: "",
  org: "",
  email: "",
  phone: "",
  linkedin: "",
  raw_text: "",
};

function reply(input: unknown, stop_reason = "end_turn") {
  return {
    stop_reason,
    content: [
      { type: "thinking", thinking: "", signature: "s" },
      { type: "text", text: typeof input === "string" ? input : JSON.stringify(input) },
    ],
  };
}

beforeEach(() => {
  create.mockReset();
  vi.stubEnv("ANTHROPIC_API_KEY", "test-key");
  vi.stubEnv("MONSOON_MODEL", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("resolveModel", () => {
  it("defaults to claude-haiku-5-5", () => {
    expect(resolveModel()).toBe("claude-haiku-5-5");
  });

  it("returns an override", () => {
    vi.stubEnv("MONSOON_MODEL", "claude-sonnet-5-5");
    expect(resolveModel()).toBe("claude-sonnet-5-5");
  });

  it.each(["claude-opus-5-5", "claude-fable-5-2", "CLAUDE-OPUS-X"])(
    "refuses %s",
    (id) => {
      vi.stubEnv("MONSOON_MODEL", id);
      expect(() => resolveModel()).toThrow(
        "MONSOON_MODEL must not be an Opus or Fable model"
      );
    }
  );
});

describe("extractCard", () => {
  it("sends the image with a JSON-schema output format and no forced tool", async () => {
    create.mockResolvedValue(reply({}));
    await extractCard({ base64: "QUJD", mediaType: "image/png" });
    expect(create).toHaveBeenCalledTimes(1);
    expect(ctorOptions.at(-1)).toEqual({ timeout: 25_000, maxRetries: 1 });
    const args = create.mock.calls[0][0];
    expect(args.model).toBe("claude-haiku-5-5");
    expect(args.max_tokens).toBe(8192);
    const blocks = args.messages[0].content;
    expect(blocks).toContainEqual({
      type: "image",
      source: { type: "base64", media_type: "image/png", data: "QUJD" },
    });
    expect(args.tools).toBeUndefined();
    expect(args.tool_choice).toBeUndefined();
    expect(args.output_config.format.type).toBe("json_schema");
    const schema = args.output_config.format.schema;
    expect(Object.keys(schema.properties).sort()).toEqual([...KEYS].sort());
    for (const k of KEYS) expect(schema.properties[k].type).toBe("string");
    expect([...schema.required].sort()).toEqual([...KEYS].sort());
    expect(schema.additionalProperties).toBe(false);
  });

  it("trims values and fills absent keys with empty strings", async () => {
    create.mockResolvedValue(reply({ name: " Jane Tan ", org: "Acme" }));
    const out = await extractCard({ base64: "x", mediaType: "image/jpeg" });
    expect(out).toEqual({ ...EMPTY, name: "Jane Tan", org: "Acme" });
  });

  it("returns empty fields when the model finds nothing", async () => {
    create.mockResolvedValue(reply({}));
    expect(await extractCard({ base64: "x", mediaType: "image/jpeg" })).toEqual(EMPTY);
  });

  it.each([
    ["unparseable JSON", reply("no card here")],
    ["a JSON array", reply("[1]")],
    ["a refusal", reply({ name: "Jane" }, "refusal")],
    ["a max_tokens stop", reply('{"name": "Ja', "max_tokens")],
    ["no text block", { stop_reason: "end_turn", content: [] }],
  ])("returns empty fields for %s", async (_label, response) => {
    create.mockResolvedValue(response);
    expect(await extractCard({ base64: "x", mediaType: "image/jpeg" })).toEqual(EMPTY);
  });

  it("lets an API error throw", async () => {
    create.mockRejectedValue(new Error("boom"));
    await expect(
      extractCard({ base64: "x", mediaType: "image/jpeg" })
    ).rejects.toThrow("boom");
  });

  it("turns non-string values into empty strings", async () => {
    create.mockResolvedValue(reply({ name: 5, title: null, org: "Acme" }));
    const out = await extractCard({ base64: "x", mediaType: "image/webp" });
    expect(out).toEqual({ ...EMPTY, org: "Acme" });
  });

  it("fails when MONSOON_MODEL is refused, before calling the API", async () => {
    vi.stubEnv("MONSOON_MODEL", "claude-opus-5-5");
    await expect(
      extractCard({ base64: "x", mediaType: "image/jpeg" })
    ).rejects.toThrow("Opus or Fable");
    expect(create).not.toHaveBeenCalled();
  });

  it("fails when ANTHROPIC_API_KEY is missing", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    await expect(
      extractCard({ base64: "x", mediaType: "image/jpeg" })
    ).rejects.toThrow();
    expect(create).not.toHaveBeenCalled();
  });
});
