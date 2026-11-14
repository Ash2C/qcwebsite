const DAY_MS = 86_400_000;

/** The client's date when it is within one day of the server's UTC date, else the server's. */
export function resolveToday(value: unknown, nowMs: number): string {
  const server = new Date(nowMs).toISOString().slice(0, 10);
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return server;
  const t = Date.parse(`${value}T00:00:00Z`);
  if (Number.isNaN(t) || new Date(t).toISOString().slice(0, 10) !== value) return server;
  return Math.abs(t - Date.parse(`${server}T00:00:00Z`)) <= DAY_MS ? value : server;
}
