import { beforeEach, describe, expect, it, vi } from "vitest";

const create = vi.fn();
const client = { messages: { create: (...args: unknown[]) => create(...args) } } as unknown as Anthropic;

import type Anthropic from "@anthropic-ai/sdk";
import { extractCards as extract } from "./extract";

const MODEL = "claude-haiku-5-5";
const extractCards = (image: Parameters<typeof extract>[2]) => extract(client, MODEL, image);

const TEXT_KEYS = ["name", "title", "org", "email", "phone", "linkedin", "raw_text"];
const KEYS = [...TEXT_KEYS, "kind"];
const EMPTY = {
  name: "",
  title: "",
  org: "",
  email: "",
  phone: "",
  linkedin: "",
  raw_text: "",
  kind: "other",
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
});

const IMG = { base64: "x", mediaType: "image/jpeg" } as const;

describe("extractCards", () => {
  it("sends the image with a cards-list JSON schema and no forced tool", async () => {
    create.mockResolvedValue(reply({ cards: [] }));
    await extractCards({ base64: "QUJD", mediaType: "image/png" });
    expect(create).toHaveBeenCalledTimes(1);
    const args = create.mock.calls[0][0];
    expect(args.model).toBe("claude-haiku-5-5");
    expect(args.max_tokens).toBe(8192);
    const blocks = args.messages[0].content;
    expect(blocks).toContainEqual({
      type: "image",
      source: { type: "base64", media_type: "image/png", data: "QUJD" },
    });
    expect(blocks).toContainEqual({ type: "text", text: "Find every person named in this image." });
    expect(args.tools).toBeUndefined();
    expect(args.tool_choice).toBeUndefined();
    expect(args.output_config.format.type).toBe("json_schema");
    const schema = args.output_config.format.schema;
    expect(schema.type).toBe("object");
    expect(Object.keys(schema.properties)).toEqual(["cards"]);
    expect(schema.required).toEqual(["cards"]);
    const cards = schema.properties.cards;
    expect(cards.type).toBe("array");
    const item = cards.items;
    expect(item.type).toBe("object");
    expect(Object.keys(item.properties).sort()).toEqual([...KEYS].sort());
    for (const k of KEYS) expect(item.properties[k].type).toBe("string");
    expect(item.properties.kind.enum).toEqual(["card", "badge", "screen", "other"]);
    expect([...item.required].sort()).toEqual([...KEYS].sort());
    expect(item.additionalProperties).toBe(false);
  });

  it("passes through each card separately", async () => {
    create.mockResolvedValue(
      reply({
        cards: [
          { name: " Jane Tan ", org: "Acme", kind: "card" },
          { name: "Raj Mehta", email: "raj@corvane.example", kind: "card" },
        ],
      })
    );
    expect(await extractCards(IMG)).toEqual([
      { ...EMPTY, name: "Jane Tan", org: "Acme", kind: "card" },
      { ...EMPTY, name: "Raj Mehta", email: "raj@corvane.example", kind: "card" },
    ]);
  });

  it("reads a name tag as one badge entry with only the name set", async () => {
    create.mockResolvedValue(reply({ cards: [{ name: "Priya", kind: "badge" }] }));
    expect(await extractCards(IMG)).toEqual([{ ...EMPTY, name: "Priya", kind: "badge" }]);
  });

  it("reads a web page with three people in order as screen entries", async () => {
    create.mockResolvedValue(
      reply({
        cards: ["Ann", "Bo", "Cy"].map((name) => ({ name, kind: "screen" })),
      })
    );
    const out = await extractCards(IMG);
    expect(out.map((c) => c.name)).toEqual(["Ann", "Bo", "Cy"]);
    expect(out.every((c) => c.kind === "screen")).toBe(true);
  });

  it.each([
    ["missing", {}],
    ["unknown", { kind: "poster" }],
    ["non-string", { kind: 3 }],
  ])("turns a %s kind into other", async (_label, extra) => {
    create.mockResolvedValue(reply({ cards: [{ name: "A", ...extra }] }));
    expect(await extractCards(IMG)).toEqual([{ ...EMPTY, name: "A", kind: "other" }]);
  });

  it("drops an entry that has only a kind", async () => {
    create.mockResolvedValue(reply({ cards: [{ kind: "badge" }, { name: "A", kind: "card" }] }));
    expect(await extractCards(IMG)).toEqual([{ ...EMPTY, name: "A", kind: "card" }]);
  });

  it("caps at 12 and drops empty or malformed entries", async () => {
    const many = Array.from({ length: 15 }, (_, i) => ({ name: `P${i}` }));
    create.mockResolvedValue(reply({ cards: many }));
    const out = await extractCards(IMG);
    expect(out).toHaveLength(12);
    expect(out[0].name).toBe("P0");
    expect(out[11].name).toBe("P11");

    create.mockResolvedValue(reply({ cards: [{}, { name: "" }, "x", null, 5, { name: "A" }] }));
    expect(await extractCards(IMG)).toEqual([{ ...EMPTY, name: "A" }]);
  });

  it("turns non-string values into empty strings", async () => {
    create.mockResolvedValue(reply({ cards: [{ name: 5, title: null, org: "Acme" }] }));
    expect(await extractCards(IMG)).toEqual([{ ...EMPTY, org: "Acme" }]);
  });

  it.each([
    ["an empty list", reply({ cards: [] })],
    ["no cards key", reply({})],
    ["a non-array cards value", reply({ cards: "x" })],
    ["a top-level array", reply([{ name: "Jane" }])],
    ["unparseable text", reply("no card here")],
    ["no text block", { stop_reason: "end_turn", content: [] }],
    ["a refusal", reply({ cards: [{ name: "Jane" }] }, "refusal")],
  ])("returns an empty list for %s", async (_label, response) => {
    create.mockResolvedValue(response);
    expect(await extractCards(IMG)).toEqual([]);
  });

  it("throws on a max_tokens stop so a truncated reply never loses cards silently", async () => {
    create.mockResolvedValue(reply('{"cards": [{"name": "Ja', "max_tokens"));
    await expect(extractCards(IMG)).rejects.toThrow("max_tokens");
  });

  it("lets an API error throw", async () => {
    create.mockRejectedValue(new Error("boom"));
    await expect(extractCards(IMG)).rejects.toThrow("boom");
  });
});
