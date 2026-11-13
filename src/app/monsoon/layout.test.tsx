import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import MonsoonLayout, { metadata, viewport } from "./layout";

describe("monsoon layout", () => {
  it("overrides the inherited social previews with a bare Monsoon card", () => {
    expect(metadata.openGraph).toMatchObject({ title: "Monsoon" });
    expect(metadata.openGraph?.description).toBeUndefined();
    expect(metadata.openGraph?.images).toBeUndefined();
    expect(metadata.twitter).toMatchObject({ card: "summary", title: "Monsoon" });
    expect((metadata.twitter as { description?: string }).description).toBeUndefined();
  });

  it("sets light and dark theme colours", () => {
    expect(viewport.themeColor).toEqual([
      { media: "(prefers-color-scheme: light)", color: "#f2f2f7" },
      { media: "(prefers-color-scheme: dark)", color: "#000000" },
    ]);
  });

  it("paints its own background on the outer element and the canvas", () => {
    const html = renderToStaticMarkup(
      <MonsoonLayout>
        <p>x</p>
      </MonsoonLayout>,
    );
    expect(html).toMatch(/^<div class="[^"]*bg-\[#f2f2f7\][^"]*dark:bg-black/);
    expect(html).toContain("html,body{background:#f2f2f7}");
    expect(html).toContain("prefers-color-scheme:dark");
  });
});
