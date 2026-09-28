import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { VoiceStatus } from "@amc/shared";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { updateVoiceSettings, useVoiceSettings } from "../src/audio/voice";
import { VoiceControls } from "../src/components/VoiceControls";

const realFetch = globalThis.fetch;

function status(configured: boolean, extra: Partial<VoiceStatus> = {}): VoiceStatus {
  return {
    providers: { browser: true, elevenlabs: { configured } },
    dailyCharsUsed: 1234,
    dailyCharsCap: 20000,
    ...extra,
  };
}

/** Stubs the hub: GET /api/voice/status answers `body`, POST /api/voice/assign is recorded. */
function stubHub(body: VoiceStatus | null) {
  const calls: { url: string; init?: RequestInit }[] = [];
  globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    if (String(url) === "/api/voice/status") {
      return body ? Response.json(body) : new Response("down", { status: 503 });
    }
    return new Response(null, { status: 204 });
  }) as unknown as typeof fetch;
  return calls;
}

/** The real header wiring: settings come from the store the popover writes to. */
function Harness(p: { on?: boolean; onTest?: () => void; callsigns?: Record<string, string> }) {
  const settings = useVoiceSettings();
  return (
    <VoiceControls
      on={p.on ?? true}
      settings={settings}
      onToggle={() => {}}
      onTest={p.onTest ?? (() => {})}
      callsigns={p.callsigns ?? {}}
    />
  );
}

const open = () => fireEvent.click(screen.getByRole("button", { name: "Voice settings" }));
const select = () => screen.getByRole("combobox") as HTMLSelectElement;
const elevenOption = () =>
  [...select().options].find((o) => o.value === "elevenlabs") as HTMLOptionElement;

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  globalThis.fetch = realFetch;
  // The popover is still mounted here (the preload's cleanup runs later), so reset inside act.
  act(() => updateVoiceSettings({ provider: "browser", rate: 1 }));
  localStorage.clear();
});

describe("VoiceControls", () => {
  test("without a key the ElevenLabs option is disabled and the hint says how to enable it", async () => {
    stubHub(status(false));
    render(<Harness />);
    open();
    expect(screen.getByText("Checking the hub...")).toBeDefined();
    await screen.findByText("Set ELEVENLABS_API_KEY for the hub to enable ElevenLabs.");
    expect(elevenOption().disabled).toBe(true);
    expect(select().value).toBe("browser");
  });

  test("hub unreachable falls back to browser voice only", async () => {
    stubHub(null);
    render(<Harness />);
    open();
    await screen.findByText("Hub unreachable. Browser voice only.");
    expect(elevenOption().disabled).toBe(true);
  });

  test("with a key the provider switches to ElevenLabs and persists", async () => {
    stubHub(status(true));
    render(<Harness />);
    open();
    await screen.findByText("ElevenLabs today: 1,234 / 20,000 chars");
    expect(elevenOption().disabled).toBe(false);

    fireEvent.change(select(), { target: { value: "elevenlabs" } });
    await waitFor(() => expect(select().value).toBe("elevenlabs"));
    expect(JSON.parse(localStorage.getItem("amc.voice") ?? "{}").provider).toBe("elevenlabs");

    fireEvent.change(select(), { target: { value: "browser" } });
    await waitFor(() => expect(select().value).toBe("browser"));
  });

  test("ElevenLabs shows each station's voice and rerolls it", async () => {
    updateVoiceSettings({ provider: "elevenlabs" });
    const calls = stubHub(
      status(true, {
        assignments: [
          { sessionId: "s1", voiceName: "Callum - Husky Trickster" },
          { sessionId: "gone", voiceName: "Nobody" },
        ],
      }),
    );
    render(<Harness callsigns={{ s1: "NOVA" }} />);
    open();
    const list = await screen.findByRole("list", { name: "Station voices" });
    expect(list.querySelectorAll("li")).toHaveLength(1);
    expect(screen.getByText("NOVA")).toBeDefined();
    expect(screen.getByText("Callum")).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "reroll" }));
    await waitFor(() => expect(calls.some((c) => c.url === "/api/voice/assign")).toBe(true));
    const assign = calls.find((c) => c.url === "/api/voice/assign");
    expect(JSON.parse(String(assign?.init?.body))).toEqual({ sessionId: "s1", next: true });
    // Status is fetched again after the reroll.
    await waitFor(() =>
      expect(calls.filter((c) => c.url === "/api/voice/status").length).toBeGreaterThan(1),
    );
  });

  test("a key error from the hub is shown as a warning", async () => {
    stubHub({
      ...status(true),
      providers: { browser: true, elevenlabs: { configured: true, error: "invalid api key" } },
    });
    render(<Harness />);
    open();
    await screen.findByText("invalid api key");
  });

  test("event toggles, rate and test button", async () => {
    stubHub(status(false));
    const onTest = mock(() => {});
    render(<Harness on={false} onTest={onTest} />);
    open();
    expect(screen.getByText("Voice is off. Only the test line plays.")).toBeDefined();

    const cards = screen.getByRole("checkbox", { name: "New cards" }) as HTMLInputElement;
    expect(cards.checked).toBe(true);
    fireEvent.click(cards);
    await waitFor(() => expect(cards.checked).toBe(false));
    fireEvent.click(cards);

    fireEvent.change(screen.getByRole("slider"), { target: { value: "1.25" } });
    await screen.findByText("1.25x");

    fireEvent.click(screen.getByRole("button", { name: "Test voice" }));
    expect(onTest).toHaveBeenCalledTimes(1);
  });

  test("Escape and a click outside close the popover", async () => {
    stubHub(status(false));
    render(<Harness />);
    open();
    expect(screen.getByRole("dialog")).toBeDefined();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();

    open();
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("dialog")).toBeNull();
    await Promise.resolve();
  });
});
