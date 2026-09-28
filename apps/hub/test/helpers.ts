import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { HookPayload, StateSnapshot } from "@amc/shared";
import { loadConfig } from "../src/config";
import { createHub, type Hub, type HubDeps, startServer } from "../src/hub";

export interface TestHub {
  hub: Hub;
  base: string;
  dataDir: string;
  hook(
    event: string,
    pid: number | undefined,
    payload: Partial<HookPayload> & { session_id: string },
    headers?: Record<string, string>,
  ): Promise<void>;
  state(): Promise<StateSnapshot>;
  post<T = unknown>(path: string, body: unknown): Promise<{ status: number; body: T }>;
  get<T = unknown>(path: string): Promise<{ status: number; body: T }>;
  stop(opts?: { keepData?: boolean }): void;
}

/** Simulates a hub restart: same data dir, new process state. */
export function restartTestHub(previous: TestHub, env: Record<string, string> = {}): TestHub {
  previous.stop({ keepData: true });
  return startTestHub(env, previous.dataDir);
}

/** Fresh temp data dir per test so sqlite state never leaks between cases. */
export function startTestHub(
  env: Record<string, string> = {},
  reuseDataDir?: string,
  deps: HubDeps = {},
): TestHub {
  const dataDir = reuseDataDir ?? fs.mkdtempSync(path.join(os.tmpdir(), "amc-test-"));
  // Never read the real ~/.claude/teams from a test.
  const config = loadConfig({
    AMC_LOG: "quiet",
    AMC_CLAUDE_HOME: path.join(dataDir, "claude-home"),
    ...env,
    AMC_DATA_DIR: dataDir,
  });
  const hub = createHub(config, deps);
  const server = startServer(hub, { port: 0, host: "127.0.0.1" });
  const base = `http://127.0.0.1:${server.port}`;

  const post = async <T>(p: string, body: unknown, headers: Record<string, string> = {}) => {
    const res = await fetch(base + p, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as T };
  };

  return {
    hub,
    base,
    dataDir,
    async hook(event, pid, payload, extraHeaders = {}) {
      const headers: Record<string, string> = pid ? { "x-claude-pid": String(pid) } : {};
      await post(
        `/api/hooks/${event}`,
        { hook_event_name: event, ...payload },
        { ...headers, ...extraHeaders },
      );
    },
    async state() {
      const res = await fetch(`${base}/api/state`);
      return (await res.json()) as StateSnapshot;
    },
    post: (p, body) => post(p, body),
    async get(p) {
      const res = await fetch(base + p);
      return { status: res.status, body: (await res.json()) as never };
    },
    stop(opts = {}) {
      server.stop(true);
      hub.stop();
      if (!opts.keepData) fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
