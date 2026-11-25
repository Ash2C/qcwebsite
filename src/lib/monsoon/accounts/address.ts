// Monsoon only ever connects to Supabase pooler hosts (or, in development, local ones).
export const POOLER_HOST = /^[a-z0-9-]+\.pooler\.supabase\.com$/;
export const PROJECT_REF = /^[a-z0-9]{20}$/;
const ALLOWED_PORTS = new Set(["6543", "5432"]);
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

export type AddressErrorCode = "bad_ref" | "bad_host" | "bad_password" | "not_allowed";

const MESSAGES: Record<AddressErrorCode, string> = {
  bad_ref: "Invalid project reference",
  bad_host: "Invalid pooler host",
  bad_password: "Invalid database password",
  not_allowed: "Database address is not allowed",
};

export class AddressError extends Error {
  readonly code: AddressErrorCode;
  constructor(code: AddressErrorCode) {
    super(MESSAGES[code]);
    this.name = "AddressError";
    this.code = code;
  }
}

export function buildPoolerUrl(input: {
  projectRef: string;
  poolerHost: string;
  password: string;
}): string {
  const { projectRef, poolerHost, password } = input;
  if (!PROJECT_REF.test(projectRef)) throw new AddressError("bad_ref");
  if (!POOLER_HOST.test(poolerHost.toLowerCase())) throw new AddressError("bad_host");
  // eslint-disable-next-line no-control-regex
  if (!password || password.length > 200 || /[\u0000-\u001f\u007f]/.test(password)) {
    throw new AddressError("bad_password");
  }
  return `postgresql://monsoon_app.${projectRef}:${encodeURIComponent(password)}@${poolerHost.toLowerCase()}:6543/postgres`;
}

/** A client's login in the shared database: derived from the customer id, never from user text. */
export const SHARED_ROLE = /^monsoon_c_[0-9a-f]{32}$/;
/** A client's schema in the shared database. */
export const SHARED_SCHEMA = /^c_[0-9a-f]{32}$/;

/**
 * The address a client's own login uses in the shared database: transaction mode (6543) for
 * `<role>.<ref>` on the pooler host of the owner's address. The project and host come only from the
 * owner's address, which must itself be an allowed address for `postgres.<ref>`. In development a
 * local owner address gives the role on that same local database. The owner's password is never
 * carried over, and no error names any part of either address.
 */
export function buildSharedPoolerUrl(input: { adminUrl: string; role: string; password: string }): string {
  const { adminUrl, role, password } = input;
  if (typeof role !== "string" || !SHARED_ROLE.test(role)) throw new AddressError("not_allowed");
  const admin = parseAllowedDbUrl(adminUrl);
  // eslint-disable-next-line no-control-regex
  if (typeof password !== "string" || !password || password.length > 200 || /[\u0000-\u001f\u007f]/.test(password)) {
    throw new AddressError("bad_password");
  }
  const host = admin.hostname.toLowerCase();
  if (LOCAL_HOSTS.has(host)) {
    // parseAllowedDbUrl lets a local host through only in development.
    return `postgresql://${role}:${encodeURIComponent(password)}@${admin.host}${admin.pathname}`;
  }
  let user: string;
  try {
    user = decodeURIComponent(admin.username);
  } catch {
    throw new AddressError("bad_ref");
  }
  const ref = user.startsWith("postgres.") ? user.slice("postgres.".length) : "";
  if (!PROJECT_REF.test(ref)) throw new AddressError("bad_ref");
  if (!POOLER_HOST.test(host)) throw new AddressError("not_allowed");
  return `postgresql://${role}.${ref}:${encodeURIComponent(password)}@${host}:6543/postgres`;
}

export function assertAllowedDbUrl(url: string): void {
  parseAllowedDbUrl(url);
}

// Validates the address and returns the parsed URL. The caller must connect using
// fields taken from this parse, never by handing the raw string to pg.
export function parseAllowedDbUrl(url: string): URL {
  // Whitespace/non-ASCII make pg re-encode the string differently than we parse it;
  // "?" and "#" let query params override host, port, user or the socket path.
  if (typeof url !== "string" || /[^!-~]/.test(url) || /[?#]/.test(url)) {
    throw new AddressError("not_allowed");
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new AddressError("not_allowed");
  }
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new AddressError("not_allowed");
  }
  if (parsed.search !== "" || parsed.hash !== "") throw new AddressError("not_allowed");
  const host = parsed.hostname.toLowerCase();
  if (
    process.env.MONSOON_ALLOW_LOCAL_DB === "1" &&
    process.env.NODE_ENV !== "production" &&
    LOCAL_HOSTS.has(host)
  ) {
    return parsed;
  }
  const port = parsed.port === "" ? "5432" : parsed.port;
  if (!POOLER_HOST.test(host) || !ALLOWED_PORTS.has(port)) {
    throw new AddressError("not_allowed");
  }
  return parsed;
}
