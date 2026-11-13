import Anthropic from "@anthropic-ai/sdk";

export type CardFields = {
  name: string;
  title: string;
  org: string;
  email: string;
  phone: string;
  linkedin: string;
  raw_text: string;
};

const KEYS: (keyof CardFields)[] = [
  "name",
  "title",
  "org",
  "email",
  "phone",
  "linkedin",
  "raw_text",
];

const SYSTEM_PROMPT =
  "You read one photo of a business card or conference name badge. Call record_card once. Copy each value exactly as printed. If a value is not printed on the card, leave that field as an empty string; never guess or infer one. `name` is the person's name only. `org` is the company or organisation. `linkedin` is a LinkedIn URL or handle if printed. `raw_text` is all legible text on the card, line by line. If the photo is not a card or badge, or nothing is legible, return every field empty.";

export function resolveModel(): string {
  const model = process.env.MONSOON_MODEL || "claude-haiku-5-5";
  if (/opus|fable/i.test(model)) {
    throw new Error("MONSOON_MODEL must not be an Opus or Fable model");
  }
  return model;
}

export async function extractCard(image: {
  base64: string;
  mediaType: "image/jpeg" | "image/png" | "image/webp";
}): Promise<CardFields> {
  // Resolved per call so a bad MONSOON_MODEL fails the read, not the build.
  const model = resolveModel();
  const client = new Anthropic();

  const response = await client.messages.create({
    model,
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    tools: [
      {
        name: "record_card",
        description: "Record the fields printed on the card or badge.",
        input_schema: {
          type: "object",
          properties: Object.fromEntries(KEYS.map((k) => [k, { type: "string" }])),
          required: [...KEYS],
        },
      },
    ],
    tool_choice: { type: "tool", name: "record_card" },
    messages: [
      {
        role: "user",
        content: [
          {
            type: "image",
            source: {
              type: "base64",
              media_type: image.mediaType,
              data: image.base64,
            },
          },
          { type: "text", text: "Read this card." },
        ],
      },
    ],
  });

  const block = response.content.find(
    (b) => b.type === "tool_use" && b.name === "record_card"
  );
  const input =
    block && block.type === "tool_use" && typeof block.input === "object" && block.input
      ? (block.input as Record<string, unknown>)
      : {};

  const out = {} as CardFields;
  for (const k of KEYS) {
    const v = input[k];
    out[k] = typeof v === "string" ? v.trim() : "";
  }
  return out;
}
