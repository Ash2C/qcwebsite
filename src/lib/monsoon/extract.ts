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
  "You read one photo of a business card or conference name badge. Respond once with a JSON object containing the seven fields. Copy each value exactly as printed. If a value is not printed on the card, leave that field as an empty string; never guess or infer one. `name` is the person's name only. `org` is the company or organisation. `linkedin` is a LinkedIn URL or handle if printed. `raw_text` is all legible text on the card, line by line. If the photo is not a card or badge, or nothing is legible, return every field empty.";

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
  const client = new Anthropic({ timeout: 25_000, maxRetries: 1 });

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
          properties: Object.fromEntries(KEYS.map((k) => [k, { type: "string" }])),
          required: [...KEYS],
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
          { type: "text", text: "Read this card." },
        ],
      },
    ],
  });

  // A refusal, a max_tokens stop or unparseable JSON all read as "nothing found".
  let input: Record<string, unknown> = {};
  if (response.stop_reason !== "refusal" && response.stop_reason !== "max_tokens") {
    const text = response.content
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("");
    try {
      const parsed: unknown = JSON.parse(text);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        input = parsed as Record<string, unknown>;
      }
    } catch {
      // fall through with empty input
    }
  }

  const out = {} as CardFields;
  for (const k of KEYS) {
    const v = input[k];
    out[k] = typeof v === "string" ? v.trim() : "";
  }
  return out;
}
