/**
 * OTLP/HTTP JSON parsing for what Claude Code emits. We only need a handful of
 * attributes, so this is a tolerant walk over the JSON rather than a full
 * OTLP model. Anything we do not recognise is ignored.
 *
 * Claude Code env to point it here:
 *   CLAUDE_CODE_ENABLE_TELEMETRY=1 OTEL_EXPORTER_OTLP_PROTOCOL=http/json
 *   OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4242
 *   OTEL_LOGS_EXPORTER=otlp OTEL_METRICS_EXPORTER=otlp
 */

export type AttrValue = string | number | boolean;
export type Attrs = Record<string, AttrValue>;

export interface OtlpLogEvent {
  eventName: string;
  sessionId?: string;
  attrs: Attrs;
}

export interface OtlpSumPoint {
  metric: string;
  sessionId?: string;
  attrs: Attrs;
  value: number;
  temporality: "delta" | "cumulative" | "unknown";
}

type Json = Record<string, unknown>;

function asObj(x: unknown): Json | undefined {
  return x && typeof x === "object" && !Array.isArray(x) ? (x as Json) : undefined;
}
function asArr(x: unknown): unknown[] {
  return Array.isArray(x) ? x : [];
}

/** OTLP JSON encodes attribute values as { stringValue } | { intValue: "123" } | { doubleValue } | { boolValue }. */
export function parseAttrs(list: unknown): Attrs {
  const out: Attrs = {};
  for (const item of asArr(list)) {
    const kv = asObj(item);
    const key = kv?.key;
    const v = asObj(kv?.value);
    if (typeof key !== "string" || !v) continue;
    if (typeof v.stringValue === "string") out[key] = v.stringValue;
    else if (v.intValue !== undefined) out[key] = Number(v.intValue);
    else if (typeof v.doubleValue === "number") out[key] = v.doubleValue;
    else if (typeof v.boolValue === "boolean") out[key] = v.boolValue;
  }
  return out;
}

function sessionIdOf(attrs: Attrs): string | undefined {
  const v = attrs["session.id"] ?? attrs.session_id ?? attrs.sessionId;
  return typeof v === "string" && v ? v : undefined;
}

export function parseOtlpLogs(body: unknown): OtlpLogEvent[] {
  const events: OtlpLogEvent[] = [];
  for (const rl of asArr(asObj(body)?.resourceLogs)) {
    const resourceAttrs = parseAttrs(asObj(asObj(rl)?.resource)?.attributes);
    for (const sl of asArr(asObj(rl)?.scopeLogs)) {
      for (const lr of asArr(asObj(sl)?.logRecords)) {
        const rec = asObj(lr);
        if (!rec) continue;
        const attrs = { ...resourceAttrs, ...parseAttrs(rec.attributes) };
        const body = asObj(rec.body);
        const eventName =
          (typeof attrs["event.name"] === "string" && attrs["event.name"]) ||
          (typeof rec.eventName === "string" && rec.eventName) ||
          (typeof body?.stringValue === "string" && body.stringValue) ||
          "";
        if (!eventName) continue;
        events.push({ eventName, sessionId: sessionIdOf(attrs), attrs });
      }
    }
  }
  return events;
}

export function parseOtlpMetrics(body: unknown): OtlpSumPoint[] {
  const points: OtlpSumPoint[] = [];
  for (const rm of asArr(asObj(body)?.resourceMetrics)) {
    const resourceAttrs = parseAttrs(asObj(asObj(rm)?.resource)?.attributes);
    for (const sm of asArr(asObj(rm)?.scopeMetrics)) {
      for (const m of asArr(asObj(sm)?.metrics)) {
        const metric = asObj(m);
        const name = metric?.name;
        if (typeof name !== "string") continue;
        // Only sums matter to us (token/cost counters). Gauges/histograms are skipped.
        const sum = asObj(metric?.sum);
        if (!sum) continue;
        const temporality = temporalityOf(sum.aggregationTemporality);
        for (const dp of asArr(sum.dataPoints)) {
          const point = asObj(dp);
          if (!point) continue;
          const attrs = { ...resourceAttrs, ...parseAttrs(point.attributes) };
          const value =
            point.asInt !== undefined
              ? Number(point.asInt)
              : typeof point.asDouble === "number"
                ? point.asDouble
                : Number.NaN;
          if (!Number.isFinite(value)) continue;
          points.push({ metric: name, sessionId: sessionIdOf(attrs), attrs, value, temporality });
        }
      }
    }
  }
  return points;
}

function temporalityOf(v: unknown): OtlpSumPoint["temporality"] {
  // Enum is 1 = DELTA, 2 = CUMULATIVE; JSON encoders may also spell the name out.
  if (v === 1 || v === "AGGREGATION_TEMPORALITY_DELTA" || v === "DELTA") return "delta";
  if (v === 2 || v === "AGGREGATION_TEMPORALITY_CUMULATIVE" || v === "CUMULATIVE")
    return "cumulative";
  return "unknown";
}

/**
 * Turns sum data points into increments. Cumulative counters are diffed
 * against the last value seen for the same series (a drop means the process
 * restarted, so the new value is the increment). Delta counters are used as-is.
 */
export class SumTracker {
  private last = new Map<string, number>();

  increment(p: OtlpSumPoint): number {
    if (p.temporality === "delta") return p.value;
    const key = `${p.sessionId ?? ""}|${p.metric}|${seriesKey(p.attrs)}`;
    const prev = this.last.get(key);
    this.last.set(key, p.value);
    if (prev === undefined) return p.value;
    return p.value >= prev ? p.value - prev : p.value;
  }
}

function seriesKey(attrs: Attrs): string {
  return Object.keys(attrs)
    .filter((k) => k !== "session.id")
    .sort()
    .map((k) => `${k}=${String(attrs[k])}`)
    .join(",");
}

/** Per-session usage deltas derived from one metrics export. */
export function usageFromMetrics(
  points: OtlpSumPoint[],
  tracker: SumTracker,
): Map<string, { inputTokens: number; outputTokens: number; costUsd: number }> {
  const out = new Map<string, { inputTokens: number; outputTokens: number; costUsd: number }>();
  for (const p of points) {
    if (!p.sessionId) continue;
    if (p.metric !== "claude_code.token.usage" && p.metric !== "claude_code.cost.usage") continue;
    const inc = tracker.increment(p);
    const u = out.get(p.sessionId) ?? { inputTokens: 0, outputTokens: 0, costUsd: 0 };
    if (p.metric === "claude_code.cost.usage") u.costUsd += inc;
    // Cache reads/creations are input-side tokens and dominate cost on long sessions,
    // so they count as input rather than vanishing.
    else if (
      p.attrs.type === "input" ||
      p.attrs.type === "cacheRead" ||
      p.attrs.type === "cacheCreation"
    )
      u.inputTokens += inc;
    else if (p.attrs.type === "output") u.outputTokens += inc;
    out.set(p.sessionId, u);
  }
  return out;
}
