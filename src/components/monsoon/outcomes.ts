// Wording for a save result, shared by the single form and the batch review. Pure: no React.
import type { CaptureResult } from "@/lib/monsoon/capture";

export type SavePrompt =
  | { kind: "org_lookalike"; similar: string[] }
  | { kind: "same_name"; matches: { personId: string; org: string | null }[] };

export type Outcome =
  | { kind: "done"; text: string } // added | existing | filed | duplicate
  | { kind: "prompt"; text: string; prompt: SavePrompt } // org_lookalike | same_name
  | { kind: "info"; text: string }; // ambiguous | needs_company

export function describeResult(
  result: Exclude<CaptureResult, { outcome: "invalid" }>,
  ctx: { name: string; org: string; estateLabel: string; roleLabel: (key: string) => string },
): Outcome {
  // The name on file when the server says it (a match by email can carry another spelling).
  const typed = ctx.name.trim();
  const name = "name" in result && result.name ? result.name : typed;
  const org = ctx.org.trim();
  const estate = ctx.estateLabel;
  switch (result.outcome) {
    case "added":
      return { kind: "done", text: `${name} added to ${estate}.` };
    case "existing": {
      const r = ctx.roleLabel(result.role);
      return {
        kind: "done",
        text:
          result.filled.length > 0
            ? `${name} is already in ${estate} as ${r}; filled in ${result.filled.join(", ")}.`
            : `${name} is already in ${estate} as ${r}; nothing new.`,
      };
    }
    case "filed": {
      const filledText = result.filled.length > 0 ? `; filled in ${result.filled.join(", ")}` : "";
      return {
        kind: "done",
        text: result.created
          ? `${name} filed under ${result.org}.`
          : `${name} is already on file under ${result.org}; meeting logged${filledText}.`,
      };
    }
    case "duplicate":
      return { kind: "done", text: `${typed} saved to ${estate}.` };
    case "org_lookalike":
      return {
        kind: "prompt",
        prompt: { kind: "org_lookalike", similar: result.similar },
        text:
          result.similar.length === 1
            ? `${org} looks like ${result.similar[0]}, already on file.`
            : `${org} looks like a company already on file.`,
      };
    case "same_name":
      return {
        kind: "prompt",
        prompt: { kind: "same_name", matches: result.matches },
        text: `${typed} is already on file at ${result.matches[0]?.org ?? "no company"}. Same person?`,
      };
    case "ambiguous":
      return { kind: "info", text: `Several people are named ${typed}. Add the company to say which one.` };
    case "needs_company":
      return { kind: "info", text: "Add their company so I can tell them apart." };
  }
}
