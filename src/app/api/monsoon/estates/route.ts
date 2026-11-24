import { NextResponse } from "next/server";
import { CRM_SCHEMA_VERSION, requireAccount } from "@/lib/monsoon/accounts/account";
import { loadClaudeKeyState } from "@/lib/monsoon/accounts/claude-key";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

type Role = { key: string; label: string };
type Reason = "not_connected" | "unreachable" | "needs_update";

export async function GET(request: Request) {
  const auth = await requireAccount(request);
  if (!auth.ok) return auth.response;
  const { account } = auth;

  const estates = await Promise.all(
    account.pipelines.map(async (pipeline) => {
      const base = { key: pipeline.key, label: pipeline.label, defaultRole: pipeline.defaultRole };
      const down = (reason: Reason) => ({ ...base, available: false, reason, roles: [] as Role[] });
      if (!pipeline.connected) return down("not_connected");
      try {
        const { roles, version } = await account.withDb(pipeline.key, async (db) => {
          const r = await db.query("SELECT key, label FROM roles ORDER BY key");
          const v = await db.query("SELECT max(version) AS max FROM schema_migrations");
          return { roles: r.rows as Role[], version: Number(v.rows[0]?.max ?? 0) };
        });
        if (!(version >= CRM_SCHEMA_VERSION)) return down("needs_update");
        return { ...base, available: true, roles };
      } catch (err) {
        // Name and code only: the message can carry connection details.
        console.error(
          `monsoon: could not list roles for ${pipeline.key}`,
          err instanceof Error ? err.name : "error",
          (err as { code?: string })?.code ?? "",
        );
        return down("unreachable");
      }
    }),
  );

  // The chip's starting state. A failed lookup leaves it out; the app then shows no chip state.
  const claude = await loadClaudeKeyState(account).catch(() => null);

  return NextResponse.json({
    estates,
    ...(claude ? { claude: { status: claude.status } } : {}),
    // The id lets the app tell when a different person has signed in on the same phone.
    person: { id: account.person.id, name: account.person.name },
    customer: { name: account.customer.name },
  });
}
