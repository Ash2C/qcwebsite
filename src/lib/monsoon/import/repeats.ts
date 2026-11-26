// Bulk import: which rows of a file repeat an earlier row, and what a row is compared by. The
// browser works this out over the whole file, because the check sees the file a request at a time.
// The rule is the server's own (`judge` in classify.ts, used by the check and the save alike):
// repeats.test.ts holds the two together. No database and no Node-only imports here.
import { nameKey } from "../rules";
import type { ImportContact } from "./mapping";

/** What a row or a person on file is compared by. A missing company or email is null. */
export type Keys = { nameKey: string; orgKey: string | null; email: string | null };

export function contactKeys(contact: ImportContact): Keys {
  return {
    nameKey: nameKey(contact.name),
    orgKey: contact.org ? nameKey(contact.org) : null,
    email: contact.email ? contact.email.trim().toLowerCase() : null,
  };
}

// Keys hold no line breaks, so a line break keeps two of them apart; a missing company is its own value.
const pair = (a: string, b: string | null): string => `${a}\n${b === null ? "\n" : b}`;

/**
 * One answer per row: true when the row repeats an earlier row of the file. It does when an
 * earlier row has the same name and the same email, or the same name at the same company (or with
 * no company on either side). A row whose email was first seen under another name is a possible
 * match instead, so it is not a repeat. Rows with no name are never repeats and never repeated.
 */
export function fileRepeats(contacts: (ImportContact | null)[]): boolean[] {
  const emails = new Set<string>();
  const emailNames = new Set<string>();
  const nameOrgs = new Set<string>();
  return contacts.map((contact) => {
    if (contact === null) return false;
    const keys = contactKeys(contact);
    if (keys.nameKey === "") return false;
    const atCompany = pair(keys.nameKey, keys.orgKey);
    let repeat: boolean;
    if (keys.email !== null && emails.has(keys.email)) repeat = emailNames.has(pair(keys.email, keys.nameKey));
    else repeat = nameOrgs.has(atCompany);
    if (keys.email !== null) {
      emails.add(keys.email);
      emailNames.add(pair(keys.email, keys.nameKey));
    }
    nameOrgs.add(atCompany);
    return repeat;
  });
}
