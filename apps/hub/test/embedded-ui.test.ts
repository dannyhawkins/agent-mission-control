import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../src/config";
import { createHub, startServer } from "../src/hub";
import { runHub } from "../src/index";
import { VERSION } from "../src/version";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "amc-ui-"));
  cleanups.push(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}

const quietEnv = (dataDir: string) => ({
  AMC_LOG: "quiet",
  AMC_DATA_DIR: dataDir,
  AMC_CLAUDE_HOME: path.join(dataDir, "claude-home"),
});

describe("embedded UI (the amc binary)", () => {
  test("serves the asset map with types from the URL, SPA fallback, API untouched", async () => {
    const dir = tmp();
    // Embedded files carry a hash in their name, like Bun's /$bunfs copies.
    const index = path.join(dir, "index-abc123.html");
    const png = path.join(dir, "badge-x1y2.png");
    fs.writeFileSync(index, "<!doctype html><title>amc</title>");
    fs.writeFileSync(png, "PNG");
    const hub = createHub(loadConfig(quietEnv(tmp())));
    const server = startServer(hub, {
      port: 0,
      host: "127.0.0.1",
      webAssets: { "/index.html": index, "/assets/badge.png": png },
    });
    cleanups.push(() => {
      server.stop(true);
      hub.stop();
    });
    const base = `http://127.0.0.1:${server.port}`;

    const root = await fetch(`${base}/`);
    expect(root.headers.get("content-type")).toContain("text/html");
    expect(await root.text()).toContain("<title>amc</title>");

    const img = await fetch(`${base}/assets/badge.png`);
    expect(img.headers.get("content-type")).toBe("image/png");
    expect(await img.text()).toBe("PNG");

    const deep = await fetch(`${base}/some/route`);
    expect(deep.headers.get("content-type")).toContain("text/html");

    const health = (await (await fetch(`${base}/api/health`)).json()) as { version: string };
    expect(health.version).toBe(VERSION);
  });

  test("an empty asset map says the UI is not built", async () => {
    const hub = createHub(loadConfig(quietEnv(tmp())));
    const server = startServer(hub, { port: 0, host: "127.0.0.1", webAssets: {} });
    cleanups.push(() => {
      server.stop(true);
      hub.stop();
    });
    const res = await fetch(`http://127.0.0.1:${server.port}/`);
    expect(res.status).toBe(404);
    expect(await res.text()).toContain("UI is not built");
  });
});

describe("runHub", () => {
  test("starts on the requested port with the given environment", async () => {
    const dataDir = tmp();
    const { hub, server, config } = runHub({ port: 0, env: quietEnv(dataDir), signals: false });
    cleanups.push(() => {
      server.stop(true);
      hub.stop();
    });
    expect(config.dataDir).toBe(dataDir);
    const res = await fetch(`http://127.0.0.1:${server.port}/api/health`);
    expect(res.ok).toBe(true);
  });
});
