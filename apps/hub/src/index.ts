import { loadConfig } from "./config";
import { createHub, startServer, type WebAssets } from "./hub";

/** Starts the hub and wires graceful shutdown. `amc start` and `bun apps/hub/src/index.ts` both land here. */
export function runHub(
  opts: { port?: number; webAssets?: WebAssets; env?: NodeJS.ProcessEnv; signals?: boolean } = {},
) {
  const config = loadConfig(opts.env);
  if (opts.port !== undefined) config.port = opts.port;
  const hub = createHub(config);
  const server = startServer(hub, { webAssets: opts.webAssets });

  console.log(
    `[hub] mission control on http://${server.hostname}:${server.port}  data=${config.dataDir}  sessions=${hub.sessions.all().length}`,
  );

  async function shutdown() {
    // Open gate hooks get {} now, so their terminals show the normal prompt
    // instead of waiting on a connection that is about to drop.
    hub.releaseGates();
    await Bun.sleep(100);
    server.stop(true);
    hub.stop();
    process.exit(0);
  }
  if (opts.signals !== false) {
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  }
  return { hub, server, config };
}

if (import.meta.main) runHub();
