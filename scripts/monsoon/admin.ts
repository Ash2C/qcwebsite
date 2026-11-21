// Thin entry for the Monsoon admin tool: npm run monsoon:admin -- <command>
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Client } from "pg";
import { clientConfig } from "../../src/lib/monsoon/db";
import { runAdmin } from "./admin-commands";

function loadEnvFile(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(path)) return out;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#") || !t.includes("=")) continue;
    const i = t.indexOf("=");
    out[t.slice(0, i).trim()] = t.slice(i + 1).trim().replace(/^["']|["']$/g, "");
  }
  return out;
}

async function main(): Promise<number> {
  const dir = join(homedir(), ".quantcloud");
  const file = loadEnvFile(join(dir, "monsoon-accounts.env"));
  const get = (k: string) => process.env[k] ?? file[k];
  let url = process.env.MONSOON_ACCOUNTS_DATABASE_URL;
  if (!url) {
    const ref = get("MONSOON_ACCOUNTS_DB_REF");
    const pw = get("MONSOON_ACCOUNTS_DB_PASSWORD");
    const host = get("MONSOON_ACCOUNTS_DB_HOST");
    const port = get("MONSOON_ACCOUNTS_DB_PORT") ?? "6543";
    if (!ref || !pw || !host) {
      console.log("Error: accounts database settings missing in ~/.quantcloud/monsoon-accounts.env");
      return 1;
    }
    url = `postgresql://postgres.${ref}:${encodeURIComponent(pw)}@${host}:${port}/postgres`;
  }
  const caPath = join(dir, "supabase-ca-2021.crt");
  if (!process.env.MONSOON_DB_CA_CERT && existsSync(caPath)) process.env.MONSOON_DB_CA_CERT = readFileSync(caPath, "utf8");

  const db = new Client(clientConfig(url));
  try {
    await db.connect();
  } catch (err) {
    console.log(`Error: could not connect (${(err as Error).name})`);
    return 1;
  }
  try {
    return await runAdmin(process.argv.slice(2), {
      db,
      out: (l) => console.log(l),
      env: process.env,
      connectOwner: async (ownerUrl) => {
        // The setup script runs in one statement; allow it longer than the app's 10 s query limit.
        const owner = new Client({ ...clientConfig(ownerUrl), query_timeout: 60_000 });
        try {
          await owner.connect();
        } catch (err) {
          await owner.end().catch(() => undefined);
          throw err;
        }
        return owner;
      },
      post: async (postUrl, body) => {
        const res = await fetch(postUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(70_000),
        });
        const parsed = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; failure?: string };
        return { status: res.status, body: parsed && typeof parsed === "object" ? parsed : {} };
      },
    });
  } finally {
    await db.end();
  }
}

main().then((code) => process.exit(code));
