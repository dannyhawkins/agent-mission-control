// Test preload (bunfig.toml): gives every test file a happy-dom `window`/`document`
// so React components can be rendered with @testing-library/react.
import { afterEach } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

// happy-dom overwrites globals Bun already has. Its fetch goes through node:http and
// chokes on Bun.serve responses, and its timers and streams are not Bun's, so the hub
// tests (same process) break. Keep Bun's own versions of everything that is not DOM.
const KEEP_NATIVE = [
  "fetch",
  "Request",
  "Response",
  "Headers",
  "FormData",
  "Blob",
  "File",
  "URL",
  "URLSearchParams",
  "WebSocket",
  "AbortController",
  "AbortSignal",
  "TextEncoder",
  "TextDecoder",
  "ReadableStream",
  "WritableStream",
  "TransformStream",
  "setTimeout",
  "clearTimeout",
  "setInterval",
  "clearInterval",
  "queueMicrotask",
  "structuredClone",
  "crypto",
  "performance",
  "console",
] as const;

const g = globalThis as Record<string, unknown>;
const saved = KEEP_NATIVE.map((k) => [k, Object.getOwnPropertyDescriptor(g, k)] as const);
GlobalRegistrator.register();
for (const [k, d] of saved) if (d) Object.defineProperty(g, k, d);

// Testing Library must load after register(); a static import would be evaluated first
// and its `screen` would bind to a missing document.
const { cleanup } = await import("@testing-library/react");
afterEach(() => cleanup());
