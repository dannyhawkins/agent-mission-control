// End to end through the UI: <App/> in ?mock=1 mode runs the in-browser simulator, so the whole
// floor (header, stations, cards, crew, mission log) renders from the same event stream the hub
// would send, with no network.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { App } from "../src/App";

const g = globalThis as Record<string, unknown>;
const realAudio = g.AudioContext;
const realFetch = g.fetch;
const realWs = g.WebSocket;
let played = 0;

/** Just enough Web Audio for synth.ts: counts oscillators started. */
class FakeAudioContext {
  currentTime = 0;
  destination = {};
  resume() {
    return Promise.resolve();
  }
  createGain() {
    const param = { value: 0, setValueAtTime() {}, linearRampToValueAtTime() {} };
    return { gain: param, connect: (n: unknown) => n };
  }
  createOscillator() {
    return {
      type: "",
      frequency: { value: 0 },
      connect: (n: unknown) => n,
      start: () => {
        played++;
      },
      stop() {},
    };
  }
}

beforeAll(() => {
  g.AudioContext = FakeAudioContext;
  // Mock mode must never touch the network; fail loudly if it tries.
  g.fetch = () => {
    throw new Error("network used in mock mode");
  };
  g.WebSocket = class {
    constructor() {
      throw new Error("socket opened in mock mode");
    }
  };
});

afterAll(() => {
  g.AudioContext = realAudio;
  g.fetch = realFetch;
  g.WebSocket = realWs;
});

beforeEach(() => {
  window.happyDOM.setURL("http://127.0.0.1:4242/?mock=1");
  localStorage.clear();
});

afterEach(() => {
  window.happyDOM.setURL("http://127.0.0.1:4242/");
});

const station = (name: string) =>
  screen
    .getAllByRole("article")
    .find((a) => a.getAttribute("aria-label")?.startsWith(`${name} on`));

describe("App in mock mode", () => {
  test("renders the simulated floor with header, stations, cards and log", () => {
    const { unmount } = render(<App />);
    expect(screen.getByText("SIM")).toBeDefined();
    expect(screen.getByText("SIMULATED")).toBeDefined();
    for (const name of ["NOVA", "RASCAL", "CIPHER", "MOTH"]) expect(station(name)).toBeDefined();
    // The nested session folds into NOVA's crew bay instead of getting a station.
    const names = screen.getAllByRole("article").map((a) => a.getAttribute("aria-label"));
    expect(names.some((n) => n?.startsWith("KID"))).toBe(false);

    // Every card kind appears on its asking station.
    const rascal = station("RASCAL");
    if (!rascal) throw new Error("no RASCAL");
    expect(within(rascal).getByText(/Which Postgres driver/)).toBeDefined();
    const cipher = station("CIPHER");
    if (!cipher) throw new Error("no CIPHER");
    expect(within(cipher).getByText("rm -rf dist && bun run build")).toBeDefined();

    const pending = screen.getByText("PENDING").nextElementSibling?.textContent;
    expect(Number(pending)).toBeGreaterThan(3);
    expect(screen.getByRole("complementary", { name: "Mission log" })).toBeDefined();
    expect(screen.getByText("Online. Try to keep up.")).toBeDefined();
    unmount();
  });

  test("answering a card transmits it, stamps the station and logs the answer", async () => {
    const { unmount } = render(<App />);
    const rascal = station("RASCAL");
    if (!rascal) throw new Error("no RASCAL");
    const before = Number(screen.getByText("PENDING").nextElementSibling?.textContent);

    fireEvent.click(within(rascal).getByRole("button", { name: /Keep pg/ }));
    fireEvent.change(within(rascal).getByPlaceholderText("note to agent (optional)"), {
      target: { value: "shared pool please" },
    });
    fireEvent.click(within(rascal).getByRole("button", { name: "Send" }));

    await waitFor(() => expect(within(rascal).getByText("TRANSMITTED")).toBeDefined());
    expect(within(rascal).queryByText(/Which Postgres driver/)).toBeNull();
    expect(Number(screen.getByText("PENDING").nextElementSibling?.textContent)).toBe(before - 1);
    // The log shows the answer and note next to the persona's ack.
    expect(screen.getByText("Keep pg (shared pool please)")).toBeDefined();
    unmount();
  });

  test("the audio button unlocks sound, then mutes and unmutes", async () => {
    const { unmount } = render(<App />);
    const btn = screen.getByRole("button", { name: /Enable audio/ });
    await act(async () => {
      fireEvent.click(btn);
    });
    await waitFor(() => expect(screen.getByRole("button", { name: /Audio on/ })).toBeDefined());
    fireEvent.click(screen.getByRole("button", { name: /Audio on/ }));
    expect(screen.getByRole("button", { name: /Audio off/ })).toBeDefined();
    expect(localStorage.getItem("amc.muted")).toBe("1");
    fireEvent.click(screen.getByRole("button", { name: /Audio off/ }));
    expect(screen.getByRole("button", { name: /Audio on/ }).getAttribute("aria-pressed")).toBe(
      "true",
    );

    // With sound on, transmitting a card plays the transmitted cue.
    const rascal = station("RASCAL");
    if (!rascal) throw new Error("no RASCAL");
    const n = played;
    fireEvent.click(within(rascal).getByRole("button", { name: /Keep pg/ }));
    fireEvent.click(within(rascal).getByRole("button", { name: "Send" }));
    await waitFor(() => expect(within(rascal).getByText("TRANSMITTED")).toBeDefined());
    expect(played).toBeGreaterThan(n);
    unmount();
  });

  test("the mission log filters and hides crew entries", () => {
    const { unmount } = render(<App />);
    const log = screen.getByRole("complementary", { name: "Mission log" });
    const rows = () => within(log).getAllByRole("listitem").length;
    const all = rows();
    fireEvent.click(within(log).getByRole("tab", { name: "DECISIONS" }));
    const decisions = rows();
    expect(decisions).toBeLessThan(all);
    for (const li of within(log).getAllByRole("listitem")) {
      expect(li.getAttribute("data-kind")).toMatch(/^decision_/);
    }
    fireEvent.click(within(log).getByRole("tab", { name: "ALL" }));
    expect(
      within(log)
        .getAllByRole("listitem")
        .some((li) => li.hasAttribute("data-crew")),
    ).toBe(true);
    fireEvent.click(within(log).getByRole("button", { name: "CREW" }));
    expect(
      within(log)
        .getAllByRole("listitem")
        .some((li) => li.hasAttribute("data-crew")),
    ).toBe(false);
    unmount();
  });
});
