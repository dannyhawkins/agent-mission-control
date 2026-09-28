// Typed failures from hub calls, so components can handle the recoverable ones specially.

/**
 * Answer failures the UI handles specially rather than as a generic "Transmit failed":
 * - not_waiting (409): the session stopped waiting (hook gone, hub restarted). The card is dead.
 * - undeliverable (502 delivery_failed, 409 not_answerable): a prose reply cannot reach the session.
 */
export class AnswerError extends Error {
  constructor(
    readonly kind: "not_waiting" | "undeliverable",
    message: string,
  ) {
    super(message);
  }
}

/**
 * unreachable: 409 no_socket or 502 delivery_failed, no live message route right now.
 * rate_limited: 429, the hub allows one message per 2s per session.
 */
export class MessageError extends Error {
  constructor(
    readonly kind: "unreachable" | "rate_limited" | "other",
    message: string,
  ) {
    super(message);
  }
}
