import type Anthropic from "@anthropic-ai/sdk";

// Upper bound on cards kept from one photo.
export const MAX_CARDS = 12;

export type CardKind = "card" | "badge" | "screen" | "other";

const KINDS: CardKind[] = ["card", "badge", "screen", "other"];

export type CardFields = {
  name: string;
  title: string;
  org: string;
  email: string;
  phone: string;
  linkedin: string;
  raw_text: string;
  kind: CardKind;
};

const KEYS: Exclude<keyof CardFields, "kind">[] = [
  "name",
  "title",
  "org",
  "email",
  "phone",
  "linkedin",
  "raw_text",
];

const SYSTEM_PROMPT =
  "You are given one image. It may be a business card, a conference badge, a name tag on clothing, a screenshot of a website, a LinkedIn profile, an email signature, a slide, an attendee or team list, or anything else that shows people's names. Return one entry in `cards` for each person you can identify by a visible name, in reading order: top to bottom, then left to right. Never merge two people into one entry and never split one person into two. For each person, copy only the details that are visibly attached to that person, exactly as shown: `name` is the person's name only; `title` their job title; `org` their company or organisation; `email`, `phone` and `linkedin` only if shown for that person. If a detail is not shown for that person, leave that field as an empty string; never guess, infer, or borrow a detail from another person or from elsewhere in the image. A company logo or page header may be used as `org` only when the image is clearly about that one company (a card, a badge, a company's own team page). `raw_text` is the text belonging to that person, line by line. `kind` is `card` for a business card, `badge` for a badge or name tag, `screen` for a screenshot, slide or other image of a screen or document, and `other` for anything else. If the image names no person, or nothing is legible, return an empty `cards` list.";

export async function extractCards(
  client: Anthropic,
  model: string,
  image: {
    base64: string;
    mediaType: "image/jpeg" | "image/png" | "image/webp";
  },
): Promise<CardFields[]> {
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
                properties: {
                  ...Object.fromEntries(KEYS.map((k) => [k, { type: "string" }])),
                  kind: { type: "string", enum: [...KINDS] },
                },
                required: [...KEYS, "kind"],
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
          { type: "text", text: "Find every person named in this image." },
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
    const kind = input.kind;
    card.kind = KINDS.includes(kind as CardKind) ? (kind as CardKind) : "other";
    // An entry with all seven text fields empty carries nothing, whatever its kind; drop it.
    if (KEYS.some((k) => card[k] !== "")) cards.push(card);
  }
  return cards;
}
