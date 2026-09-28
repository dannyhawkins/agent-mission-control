import fs from "node:fs";

/**
 * Delivering a message into a live Claude Code session through its messaging
 * socket. UNDOCUMENTED INTERFACE: observed on Claude Code 2.1.280 by a spike,
 * not a published API, so everything about it stays in this module.
 *
 * Every session binds a unix socket (CLAUDE_CODE_MESSAGING_SOCKET, e.g.
 * /tmp/cc-socks/<pid>.sock). The protocol is newline-delimited JSON: an optional
 * {"type":"auth","token":<CLAUDE_CODE_MESSAGING_TOKEN>} line, then
 * {"type":"user","message":{"role":"user","content":<text>}}. The server sends
 * no reply and closes connections that idle before the first line, so the lines
 * are written straight away. A delivered message starts a new turn if the
 * session is idle. Sessions running with bypassPermissions may hold such
 * messages for approval instead; nothing we can do about that from here.
 *
 * The content is plain text headed by one line saying it came from the user via
 * Mission Control; it must never be dressed up as input the user typed.
 */

const CONNECT_TIMEOUT_MS = 2_000;
/** Time for the lines to leave the buffer before we close; delivery takes ~50ms. */
const LINGER_MS = 100;

/**
 * Plain text with one honest header line. Claude Code wraps whatever arrives on
 * the socket in its own genuine <cross-session-message> envelope (with the
 * sender's verified pid), so adding a look-alike of our own would nest and read
 * like injection.
 */
const envelope = (heading: string, body: string) => `${heading}\n${body}`;

export function wrapAnswer(answer: string, note?: string): string {
  const body = note?.trim() ? `${answer}\nNote: ${note.trim()}` : answer;
  return envelope("The user answered your open questions in Mission Control:", body);
}

/** A free message the operator typed on a station. */
export function wrapMessage(text: string): string {
  return envelope("Message from the user via Mission Control:", text);
}

const EXISTS_TTL_MS = 5_000;
const existsCache = new Map<string, { ok: boolean; at: number }>();

/**
 * The socket file exists and is a socket (the session may still be gone).
 * Cached for a few seconds: it is checked every time a session is published.
 */
export function socketExists(socketPath: string | undefined, now = Date.now()): boolean {
  if (!socketPath) return false;
  const hit = existsCache.get(socketPath);
  if (hit && now - hit.at < EXISTS_TTL_MS) return hit.ok;
  let ok = false;
  try {
    ok = fs.statSync(socketPath).isSocket();
  } catch {
    ok = false;
  }
  existsCache.set(socketPath, { ok, at: now });
  return ok;
}

/** Resolves once the message is written; rejects if the socket cannot be reached. */
export async function deliverToSession(
  socketPath: string,
  text: string,
  token?: string,
): Promise<void> {
  const lines: string[] = [];
  if (token) lines.push(JSON.stringify({ type: "auth", token }));
  lines.push(JSON.stringify({ type: "user", message: { role: "user", content: text } }));
  const payload = `${lines.join("\n")}\n`;

  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const timer = setTimeout(
    () => reject(new Error("timed out connecting to the session socket")),
    CONNECT_TIMEOUT_MS,
  );
  try {
    await Bun.connect({
      unix: socketPath,
      socket: {
        open(s) {
          s.write(payload);
          setTimeout(() => {
            clearTimeout(timer);
            s.end();
            resolve();
          }, LINGER_MS);
        },
        data() {},
        error(_s, err) {
          clearTimeout(timer);
          reject(err);
        },
        connectError(_s, err) {
          clearTimeout(timer);
          reject(err);
        },
      },
    });
  } catch (err) {
    clearTimeout(timer);
    reject(err);
  }
  return promise;
}
