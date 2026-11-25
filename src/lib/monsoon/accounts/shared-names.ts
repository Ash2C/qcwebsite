// Names in the shared client database. A client's schema and login are derived from the customer's
// id and nothing else: never from a name, a code or anything a person typed.
import { SHARED_ROLE, SHARED_SCHEMA, parseAllowedDbUrl } from "./address";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ClientNames = { schema: string; role: string };

/** `c_<32 hex>` and `monsoon_c_<32 hex>` for a customer id. Throws for anything that is not a UUID. */
export function clientNames(customerId: string): ClientNames {
  if (typeof customerId !== "string" || !UUID.test(customerId)) throw new Error("invalid customer id");
  const hex = customerId.toLowerCase().replace(/-/g, "");
  const names = { schema: `c_${hex}`, role: `monsoon_c_${hex}` };
  // Belt and braces: what goes into SQL text is always these two shapes.
  if (!SHARED_SCHEMA.test(names.schema) || !SHARED_ROLE.test(names.role)) throw new Error("invalid customer id");
  return names;
}

/**
 * True only when a stored shared pipeline is this customer's own: the schema is the one derived
 * from the customer id, and the stored address signs in as the login derived from it (through the
 * pooler the user is `<login>.<project>`). Never throws.
 */
export function sharedPipelineIsOwn(customerId: string, schema: string, dbUrl: string): boolean {
  try {
    const names = clientNames(customerId);
    if (schema !== names.schema) return false;
    const user = decodeURIComponent(parseAllowedDbUrl(dbUrl).username);
    return user === names.role || user.startsWith(`${names.role}.`);
  } catch {
    return false;
  }
}
