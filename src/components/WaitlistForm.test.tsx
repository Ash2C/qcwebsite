// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import WaitlistForm from "./WaitlistForm";

const fetchMock = vi.fn();

function okResponse() {
  return Promise.resolve(
    new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })
  );
}

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockImplementation(okResponse);
  vi.stubGlobal("fetch", fetchMock);
});

async function completeEmailStep() {
  const user = userEvent.setup();
  await user.type(screen.getByLabelText("Work email"), "pm@fund.com");
  await user.click(
    screen.getByRole("button", { name: "Request early access" })
  );
  await screen.findByText("You are on the early-access list.");
  return user;
}

describe("Quant Cloud waitlist form", () => {
  it("registers email without exposing a client-controlled source", async () => {
    const { container } = render(<WaitlistForm />);
    const user = await completeEmailStep();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({
      step: 1,
      email: "pm@fund.com",
      website: "",
    });
    expect(screen.getByLabelText("Organization type")).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/Zero One|The Blade/i);
    expect(user).toBeDefined();
  });

  it("sends optional research details and reaches the QC confirmation", async () => {
    render(<WaitlistForm />);
    const user = await completeEmailStep();

    await user.selectOptions(
      screen.getByLabelText("Organization type"),
      "research_advisory"
    );
    await user.selectOptions(
      screen.getByLabelText("Research universe size"),
      "30-75"
    );
    await user.selectOptions(
      screen.getByLabelText("Preferred delivery channel"),
      "secure_app"
    );
    await user.type(
      screen.getByLabelText("Describe the research you want to produce"),
      "Private-company and industry research for public distribution"
    );
    await user.click(screen.getByRole("button", { name: "Send details" }));

    expect(await screen.findByText("Your request is in.")).toBeInTheDocument();
    expect(screen.getByText(/Quant Cloud team will be in touch/i)).toBeInTheDocument();
    const [, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({
      step: 2,
      email: "pm@fund.com",
      firmType: "research_advisory",
      universeSize: "30-75",
      channel: "secure_app",
      currentProcess:
        "Private-company and industry research for public distribution",
    });
  });

  it("lets an already-registered visitor skip optional questions", async () => {
    render(<WaitlistForm />);
    const user = await completeEmailStep();

    await user.click(screen.getByRole("button", { name: "Skip for now" }));

    expect(screen.getByText("Your request is in.")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps optional answers available when the detail request fails", async () => {
    fetchMock
      .mockImplementationOnce(okResponse)
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "Unavailable" }), {
          status: 502,
          headers: { "Content-Type": "application/json" },
        })
      );
    render(<WaitlistForm />);
    const user = await completeEmailStep();

    const research = screen.getByLabelText(
      "Describe the research you want to produce"
    );
    await user.type(research, "Industry research");
    await user.click(screen.getByRole("button", { name: "Send details" }));

    expect(
      await screen.findByText(
        "Your email is saved, but those details did not send. Try again or finish without them."
      )
    ).toBeInTheDocument();
    expect(research).toHaveValue("Industry research");
    expect(screen.getByRole("button", { name: "Send details" })).toBeEnabled();
  });

  it("uses Quant Cloud language in the email, detail, and done phases", async () => {
    const { container } = render(<WaitlistForm />);
    expect(container.textContent).toMatch(/Quant Cloud/i);
    expect(container.textContent).not.toMatch(/Zero One|The Blade/i);

    const user = await completeEmailStep();
    expect(container.textContent).not.toMatch(/Zero One|The Blade/i);

    await user.click(screen.getByRole("button", { name: "Skip for now" }));
    expect(container.textContent).not.toMatch(/Zero One|The Blade/i);
  });
});
