// Rules for the "already on file?" match, shared by the single form and the batch. Pure.
import type { CardMatch } from "@/lib/monsoon/match";

// A person id = "this is that person"; false = "a different person"; undefined = not chosen.
export type Choice = string | false | undefined;

/** The person to preselect: a match by name and company, or by email when the name agrees too. */
export function confidentId(match: CardMatch | null): string | undefined {
  if (match?.match !== "exact") return undefined;
  const c = match.candidates[0];
  if (!c) return undefined;
  return c.by === "name_company" || (c.by === "email" && c.nameAgrees) ? c.personId : undefined;
}

/** The small tag on a batch row. "On file" only when the match is confident. */
export function matchTag(match: CardMatch | null): string | null {
  if (!match) return null;
  if (match.match === "none") return "New";
  return confidentId(match) ? "On file" : "Check";
}

/** A name-only match with no company on the card: saving would silently reuse the namesake. */
export function needsChoice(match: CardMatch | null, org: string, choice: Choice, answer: Choice): boolean {
  return match?.match === "same_name" && org.trim() === "" && choice === undefined && answer === undefined;
}

export const NEEDS_CHOICE_HINT = 'Choose a match or "Different person" first.';

type Identity = { name: string; org: string; email: string };

/** What an edit did to who the card describes: a name or email change is a new person; a company
 *  change only makes the match stale. */
export function changeOf(prev: Identity, next: Identity): "same" | "company" | "person" {
  if (prev.name !== next.name || prev.email !== next.email) return "person";
  return prev.org !== next.org ? "company" : "same";
}

/** The choice that survives an edit. "Different person" survives a company edit (the company is what
 *  was asked for); a positive choice never survives one. */
export function choiceAfter(choice: Choice, change: "same" | "company" | "person"): Choice {
  if (change === "same") return choice;
  if (change === "company" && choice === false) return false;
  return undefined;
}
