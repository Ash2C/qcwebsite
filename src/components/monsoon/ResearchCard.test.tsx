// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import ResearchCard from "./ResearchCard";

afterEach(cleanup);

const base = {
  kind: "apply_research", estate: "traxo", person: { id: "p1", name: "Jane Tan" }, company: null,
  identity: "Matches her firm and city.",
  findings: [
    { id: "f1", target: "person", field: "linkedin", from: null, to: "https://linkedin.com/in/janetan", source: "https://linkedin.com/in/janetan" },
    { id: "f2", target: "person", field: "title", from: "Partner", to: "Founder", source: "https://acme.com/team" },
    { id: "f3", target: "company", field: "website", from: null, to: "acme.com", source: "http://insecure.example/x" },
  ],
  summarySources: ["https://acme.com/team", "https://news.example/a"], logMemberId: null, addsToPipeline: null, expires: 1,
};

function show(over: object = {}, props: object = {}) {
  const onSave = vi.fn();
  const onDiscard = vi.fn();
  render(
    <ResearchCard
      signed={{ proposal: { ...base, ...over } as never, signature: "s" }}
      summary="She founded Acme."
      state="open"
      onSave={onSave}
      onDiscard={onDiscard}
      {...props}
    />,
  );
  return { onSave, onDiscard };
}

describe("ResearchCard", () => {
  it("shows the title, identity, labelled rows and summary heading", () => {
    show();
    expect(screen.getByText("Research: Jane Tan")).toBeInTheDocument();
    expect(screen.getByText("Matches her firm and city.")).toBeInTheDocument();
    expect(screen.getByText("LinkedIn: https://linkedin.com/in/janetan")).toBeInTheDocument();
    expect(screen.getByText("Title: Partner → Founder")).toBeInTheDocument();
    expect(screen.getByText("Website: acme.com")).toBeInTheDocument();
    expect(screen.getByText("Summary (added to the timeline)")).toBeInTheDocument();
    expect(screen.getByText("sources: 2 links")).toBeInTheDocument();
  });

  it("ticks fills of empty fields by default and not changes", () => {
    show();
    const boxes = screen.getAllByRole("checkbox");
    expect(boxes.map((b) => (b as HTMLInputElement).checked)).toEqual([true, false, true]);
  });

  it("saves exactly the ticked ids and the edited summary", async () => {
    const user = userEvent.setup();
    const { onSave } = show();
    await user.click(screen.getAllByRole("checkbox")[1]);
    await user.click(screen.getAllByRole("checkbox")[0]);
    await user.clear(screen.getByLabelText("Summary (added to the timeline)"));
    await user.type(screen.getByLabelText("Summary (added to the timeline)"), "New");
    await user.click(screen.getByRole("button", { name: "Save selected" }));
    // Finding order, not tap order.
    expect(onSave).toHaveBeenCalledWith(["f2", "f3"], "New");
  });

  it("never ticks a work email or phone by default, even when it fills an empty field", async () => {
    const user = userEvent.setup();
    const { onSave } = show({
      findings: [
        { id: "f1", target: "person", field: "email", from: null, to: "jane@acme.example", source: "https://acme.example/team" },
        { id: "f2", target: "person", field: "phone", from: null, to: "+65 6123 4567", source: "https://acme.example/team" },
        { id: "f3", target: "person", field: "title", from: null, to: "Founder", source: "https://acme.example/team" },
      ],
    });
    expect(screen.getAllByRole("checkbox").map((b) => (b as HTMLInputElement).checked)).toEqual([false, false, true]);
    await user.click(screen.getAllByRole("checkbox")[0]);
    await user.click(screen.getByRole("button", { name: "Save selected" }));
    expect(onSave).toHaveBeenCalledWith(["f1", "f3"], "She founded Acme.");
  });

  it("counts the summary length after trimming", () => {
    show({}, { summary: "x".repeat(2000) + "   " });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("button", { name: "Save selected" })).toBeEnabled();
    cleanup();
    show({}, { summary: "x".repeat(2001) });
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save selected" })).toBeDisabled();
  });

  it("shows a save failure as an alert and a finished save as a status", () => {
    show({}, { message: "Could not save. Check signal and try again." });
    expect(screen.getByRole("alert")).toHaveTextContent("Could not save. Check signal and try again.");
    cleanup();
    show({}, { state: "done", message: "Done. Research saved for Jane Tan." });
    expect(screen.getByRole("status")).toHaveTextContent("Done. Research saved for Jane Tan.");
  });

  it("disables Save when nothing is ticked and the summary is empty", async () => {
    const user = userEvent.setup();
    show();
    await user.click(screen.getAllByRole("checkbox")[0]);
    await user.click(screen.getAllByRole("checkbox")[2]);
    expect(screen.getByRole("button", { name: "Save selected" })).toBeEnabled();
    await user.clear(screen.getByLabelText("Summary (added to the timeline)"));
    expect(screen.getByRole("button", { name: "Save selected" })).toBeDisabled();
  });

  it("Discard calls onDiscard only", async () => {
    const user = userEvent.setup();
    const { onSave, onDiscard } = show();
    await user.click(screen.getByRole("button", { name: "Discard" }));
    expect(onDiscard).toHaveBeenCalledTimes(1);
    expect(onSave).not.toHaveBeenCalled();
  });

  it("renders https sources as safe links showing the host, and non-https as plain text", () => {
    show();
    const link = screen.getAllByRole("link", { name: "linkedin.com" })[0];
    expect(link).toHaveAttribute("href", "https://linkedin.com/in/janetan");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
    expect(screen.queryByRole("link", { name: /insecure/ })).toBeNull();
    expect(screen.getByText("http://insecure.example/x")).toBeInTheDocument();
  });

  it("shows the pipeline line only with addsToPipeline", () => {
    show({ addsToPipeline: "lp_prospect" }, { roleLabel: "LP prospect" });
    expect(screen.getByText("This also adds Jane Tan to the pipeline as LP prospect.")).toBeInTheDocument();
    cleanup();
    show();
    expect(screen.queryByText(/to the pipeline/)).toBeNull();
  });

  it("hides the summary block when there are no summary sources", () => {
    show({ summarySources: [] });
    expect(screen.queryByText("Summary (added to the timeline)")).toBeNull();
  });
});
