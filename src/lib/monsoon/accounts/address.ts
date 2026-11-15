// Monsoon only ever connects to Supabase pooler hosts (or, in development, local ones).
const POOLER_HOST = /^[a-z0-9-]+\.pooler\.supabase\.com$/;
const PROJECT_REF = /^[a-z0-9]{20}$/;
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

export function assertAllowedDbUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new AddressError("not_allowed");
  }
  const host = parsed.hostname.toLowerCase();
  if (
    process.env.MONSOON_ALLOW_LOCAL_DB === "1" &&
    process.env.NODE_ENV !== "production" &&
    LOCAL_HOSTS.has(host)
  ) {
    return;
  }
  const port = parsed.port === "" ? "5432" : parsed.port;
  if (!POOLER_HOST.test(host) || !ALLOWED_PORTS.has(port)) {
    throw new AddressError("not_allowed");
  }
}
