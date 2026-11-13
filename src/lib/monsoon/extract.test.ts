import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const create = vi.fn();
vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    constructor() {
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

function toolUse(input: unknown) {
  return { content: [{ type: "tool_use", name: "record_card", id: "t1", input }] };
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
  it("sends the image with a forced record_card tool call", async () => {
    create.mockResolvedValue(toolUse({}));
    await extractCard({ base64: "QUJD", mediaType: "image/png" });
    expect(create).toHaveBeenCalledTimes(1);
    const args = create.mock.calls[0][0];
    expect(args.model).toBe("claude-haiku-5-5");
    const blocks = args.messages[0].content;
    expect(blocks).toContainEqual({
      type: "image",
      source: { type: "base64", media_type: "image/png", data: "QUJD" },
    });
    expect(args.tools).toHaveLength(1);
    expect(args.tools[0].name).toBe("record_card");
    const props = args.tools[0].input_schema.properties;
    expect(Object.keys(props).sort()).toEqual([...KEYS].sort());
    for (const k of KEYS) expect(props[k].type).toBe("string");
    expect(args.tool_choice).toEqual({ type: "tool", name: "record_card" });
  });

  it("trims values and fills absent keys with empty strings", async () => {
    create.mockResolvedValue(toolUse({ name: " Jane Tan ", org: "Acme" }));
    const out = await extractCard({ base64: "x", mediaType: "image/jpeg" });
    expect(out).toEqual({ ...EMPTY, name: "Jane Tan", org: "Acme" });
  });

  it("returns empty fields when the model finds nothing", async () => {
    create.mockResolvedValue(toolUse({}));
    expect(await extractCard({ base64: "x", mediaType: "image/jpeg" })).toEqual(EMPTY);
    create.mockResolvedValue({ content: [{ type: "text", text: "no card" }] });
    expect(await extractCard({ base64: "x", mediaType: "image/jpeg" })).toEqual(EMPTY);
  });

  it("turns non-string values into empty strings", async () => {
    create.mockResolvedValue(toolUse({ name: 5, title: null, org: "Acme" }));
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
