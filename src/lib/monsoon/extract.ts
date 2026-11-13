import Anthropic from "@anthropic-ai/sdk";

// Upper bound on cards kept from one photo.
export const MAX_CARDS = 12;

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
  "You read one photo that may show one or several business cards or conference name badges. Return one entry in `cards` for each separate card or badge, in reading order: top to bottom, then left to right. Never merge two cards into one entry and never split one card into two. Copy each value exactly as printed on that card. If a value is not printed on that card, leave that field as an empty string; never guess, infer, or borrow a value from another card. `name` is the person's name only. `org` is the company or organisation. `linkedin` is a LinkedIn URL or handle if printed. `raw_text` is all legible text on that card, line by line. If the photo shows no card or badge, or nothing is legible, return an empty `cards` list.";

export function resolveModel(): string {
  const model = process.env.MONSOON_MODEL || "claude-haiku-5-5";
  if (/opus|fable/i.test(model)) {
    throw new Error("MONSOON_MODEL must not be an Opus or Fable model");
  }
  return model;
}

export async function extractCards(image: {
  base64: string;
  mediaType: "image/jpeg" | "image/png" | "image/webp";
}): Promise<CardFields[]> {
  // Resolved per call so a bad MONSOON_MODEL fails the read, not the build.
  const model = resolveModel();
  const client = new Anthropic({ timeout: 25_000, maxRetries: 0 });

  const response = await client.messages.create({
    model,
    // Thinking tokens count against max_tokens on these models; leave room.
    max_tokens: 8192,
    system: SYSTEM_PROMPT,
    // Native structured output: no forced tool_choice (400s on several models).
    output_config: {
      format: {
        type: "json_schema",
        schema: {
          type: "object",
          properties: {
            cards: {
              type: "array",
              items: {
                type: "object",
                properties: Object.fromEntries(KEYS.map((k) => [k, { type: "string" }])),
                required: [...KEYS],
                additionalProperties: false,
              },
            },
          },
          required: ["cards"],
          additionalProperties: false,
        },
      },
    },
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
          { type: "text", text: "Read every card in this photo." },
        ],
      },
    ],
  });

  // A truncated reply on a crowded photo would silently lose cards: fail the read instead.
  if (response.stop_reason === "max_tokens") {
    throw new Error("extract stopped: max_tokens");
  }
  // A refusal or unparseable JSON reads as "no cards found".
  if (response.stop_reason === "refusal") return [];
  const text = response.content.map((b) => (b.type === "text" ? b.text : "")).join("");
  let list: unknown;
  try {
    const parsed: unknown = JSON.parse(text);
    list =
      typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
        ? (parsed as { cards?: unknown }).cards
        : undefined;
  } catch {
    return [];
  }
  if (!Array.isArray(list)) return [];

  const cards: CardFields[] = [];
  for (const item of list) {
    if (cards.length >= MAX_CARDS) break;
    if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
    const input = item as Record<string, unknown>;
    const card = {} as CardFields;
    for (const k of KEYS) {
      const v = input[k];
      card[k] = typeof v === "string" ? v.trim() : "";
    }
    // A card with all seven fields empty carries nothing; drop it.
    if (KEYS.some((k) => card[k] !== "")) cards.push(card);
  }
  return cards;
}
