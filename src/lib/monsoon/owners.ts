import type { ClientBase } from "pg";

/** Adds the person's owner key to a CRM if missing. Never changes an existing owner's name. */
export async function ensureOwner(db: ClientBase, ownerKey: string, displayName: string): Promise<void> {
  await db.query("INSERT INTO owners (key, display_name) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING", [
    ownerKey,
    displayName,
  ]);
}
