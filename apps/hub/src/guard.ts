import type { HubConfig } from "./config";
import type { HubLogger } from "./hublog";

/**
 * Request guard, run before any route, the /ws upgrade or static files.
 *
 * The hub binds loopback and has no auth, but any web page open in the user's
 * browser can still reach it. Legitimate callers (curl hooks, the MCP server,
 * Claude Code's OTLP exporter, the served UI, the Vite dev proxy) look like
 * this: Host is a loopback name with the hub's port (or the Vite dev host), no
 * Origin or one of our own, and JSON bodies labelled application/json. Pages
 * on other sites fail at least one of:
 *
 * - Host: blocks DNS rebinding (evil.example resolving to 127.0.0.1).
 * - Origin: browsers always send it on WebSocket upgrades and cross-origin
 *   fetches, and WebSockets get no CORS protection at all.
 * - Content-Type: a cross-site "simple" POST (text/plain, form) skips the CORS
 *   preflight; requiring application/json forces one, which we never grant.
 *
 * Rejections are plain text so a gate hook's curl (no -f) never prints JSON
 * that Claude Code could read as an answer; the terminal prompt stays up.
 */
export type Guard = (req: Request, port: number) => Response | undefined;

/** Cap on remembered (reason, subject) pairs so a flood of junk Hosts cannot grow memory. */
const MAX_LOGGED = 256;

export function createGuard(config: HubConfig, logger: HubLogger): Guard {
  const byPort = new Map<number, { hosts: Set<string>; origins: Set<string> }>();
  const logged = new Set<string>();

  const allowed = (port: number) => {
    let entry = byPort.get(port);
    if (!entry) {
      const names = ["127.0.0.1", "localhost", "[::1]"];
      const configured = config.host.includes(":") ? `[${config.host}]` : config.host;
      if (!["0.0.0.0", "[::]"].includes(configured)) names.push(configured.toLowerCase());
      const hosts = new Set(names.map((n) => `${n}:${port}`));
      const origins = new Set(names.map((n) => `http://${n}:${port}`));
      // The Vite dev proxy forwards the browser's Host (127.0.0.1:5173) and Origin unchanged.
      for (const o of config.corsOrigins) {
        origins.add(o);
        hosts.add(new URL(o).host);
      }
      entry = { hosts, origins };
      byPort.set(port, entry);
    }
    return entry;
  };

  // Header values are attacker-controlled: printable ASCII only, bounded length.
  const clean = (v: string) => v.replace(/[^\x20-\x7e]/g, "?").slice(0, 120) || "(none)";

  const reject = (
    status: number,
    reason: string,
    subject: string,
    message: string,
    detail = "",
  ) => {
    const key = `${reason}|${clean(subject)}`;
    if (!logged.has(key) && logged.size < MAX_LOGGED) {
      logged.add(key);
      logger.info("blocked", reason, clean(subject), detail && clean(detail));
    }
    return new Response(`${message}\n`, { status, headers: { "content-type": "text/plain" } });
  };

  return (req, port) => {
    const { hosts, origins } = allowed(port);
    const host = req.headers.get("host")?.toLowerCase() ?? "";
    if (!hosts.has(host)) return reject(421, "host", host, "unexpected Host header");

    // No Origin means a local non-browser caller (curl, Bun fetch, OTLP exporter).
    const origin = req.headers.get("origin");
    if (origin !== null && !origins.has(origin)) {
      return reject(403, "origin", origin, "cross-origin requests are not allowed");
    }

    if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) {
      const type = req.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
      if (type !== "application/json") {
        return reject(
          415,
          "content-type",
          origin ?? host,
          "content-type must be application/json",
          type ?? "(none)",
        );
      }
    }
    return undefined;
  };
}
