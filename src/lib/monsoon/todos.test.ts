import type { ClientBase } from "pg";
import { describe, expect, it } from "vitest";
import { todosReady } from "./todos";

function failing(code: string | undefined, message = "boom"): ClientBase {
  return {
    query: async () => {
      throw Object.assign(new Error(message), code ? { code } : {});
    },
  } as unknown as ClientBase;
}

describe("todosReady", () => {
  it("is false when the version table is missing (42P01)", async () => {
    expect(await todosReady(failing("42P01"))).toBe(false);
  });

  it("rethrows any other database error instead of reading it as not ready", async () => {
    await expect(todosReady(failing("57014", "statement timeout"))).rejects.toThrow("statement timeout");
    await expect(todosReady(failing(undefined, "connection lost"))).rejects.toThrow("connection lost");
  });

  it("is false below version 2 and true from version 2", async () => {
    const at = (v: number) => ({ query: async () => ({ rows: [{ v }] }) }) as unknown as ClientBase;
    expect(await todosReady(at(1))).toBe(false);
    expect(await todosReady(at(2))).toBe(true);
  });
});
