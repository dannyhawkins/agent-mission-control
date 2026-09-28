import { describe, expect, test } from "bun:test";
import { parseOtlpLogs, parseOtlpMetrics, SumTracker, usageFromMetrics } from "../src/otlp";

const attr = (key: string, value: Record<string, unknown>) => ({ key, value });

describe("otlp logs", () => {
  test("extracts event.name, session.id and typed attributes", () => {
    const body = {
      resourceLogs: [
        {
          resource: { attributes: [attr("service.name", { stringValue: "claude-code" })] },
          scopeLogs: [
            {
              logRecords: [
                {
                  body: { stringValue: "claude_code.api_request" },
                  attributes: [
                    attr("event.name", { stringValue: "claude_code.api_request" }),
                    attr("session.id", { stringValue: "sess-1" }),
                    attr("model", { stringValue: "claude-sonnet-5" }),
                    attr("input_tokens", { intValue: "1200" }),
                    attr("cost_usd", { doubleValue: 0.0123 }),
                    attr("success", { boolValue: true }),
                  ],
                },
                { attributes: [attr("event.name", { stringValue: "claude_code.tool_result" })] },
                { body: { stringValue: "no event name here" }, attributes: [] },
              ],
            },
          ],
        },
      ],
    };
    const events = parseOtlpLogs(body);
    expect(events).toHaveLength(3);
    expect(events[0]).toMatchObject({
      eventName: "claude_code.api_request",
      sessionId: "sess-1",
      attrs: {
        model: "claude-sonnet-5",
        input_tokens: 1200,
        cost_usd: 0.0123,
        success: true,
        "service.name": "claude-code",
      },
    });
    expect(events[1]?.sessionId).toBeUndefined();
    expect(events[2]?.eventName).toBe("no event name here");
  });

  test("tolerates garbage", () => {
    expect(parseOtlpLogs(null)).toEqual([]);
    expect(parseOtlpLogs({ resourceLogs: "nope" })).toEqual([]);
    expect(parseOtlpLogs({ resourceLogs: [{ scopeLogs: [{ logRecords: [42] }] }] })).toEqual([]);
  });
});

describe("otlp metrics", () => {
  const metricsBody = (temporality: number, input: number, output: number, cost: number) => ({
    resourceMetrics: [
      {
        scopeMetrics: [
          {
            metrics: [
              {
                name: "claude_code.token.usage",
                sum: {
                  aggregationTemporality: temporality,
                  dataPoints: [
                    {
                      asInt: String(input),
                      attributes: [
                        attr("session.id", { stringValue: "s" }),
                        attr("type", { stringValue: "input" }),
                      ],
                    },
                    {
                      asInt: String(output),
                      attributes: [
                        attr("session.id", { stringValue: "s" }),
                        attr("type", { stringValue: "output" }),
                      ],
                    },
                  ],
                },
              },
              {
                name: "claude_code.cost.usage",
                sum: {
                  aggregationTemporality: temporality,
                  dataPoints: [
                    { asDouble: cost, attributes: [attr("session.id", { stringValue: "s" })] },
                  ],
                },
              },
              { name: "claude_code.some.gauge", gauge: { dataPoints: [{ asInt: "5" }] } },
            ],
          },
        ],
      },
    ],
  });

  test("cache tokens count as input", () => {
    const body = metricsBody(1, 100, 10, 0.5);
    const dp = body.resourceMetrics[0]?.scopeMetrics[0]?.metrics[0]?.sum?.dataPoints as unknown[];
    dp.push({
      asInt: "900",
      attributes: [
        attr("session.id", { stringValue: "s" }),
        attr("type", { stringValue: "cacheRead" }),
      ],
    });
    const u = usageFromMetrics(parseOtlpMetrics(body), new SumTracker());
    expect(u.get("s")?.inputTokens).toBe(1000);
  });

  test("delta sums are used as-is", () => {
    const tracker = new SumTracker();
    const a = usageFromMetrics(parseOtlpMetrics(metricsBody(1, 100, 10, 0.5)), tracker);
    const b = usageFromMetrics(parseOtlpMetrics(metricsBody(1, 50, 5, 0.25)), tracker);
    expect(a.get("s")).toEqual({ inputTokens: 100, outputTokens: 10, costUsd: 0.5 });
    expect(b.get("s")).toEqual({ inputTokens: 50, outputTokens: 5, costUsd: 0.25 });
  });

  test("cumulative sums are diffed per series and handle resets", () => {
    const tracker = new SumTracker();
    const a = usageFromMetrics(parseOtlpMetrics(metricsBody(2, 100, 10, 0.5)), tracker);
    const b = usageFromMetrics(parseOtlpMetrics(metricsBody(2, 160, 12, 0.8)), tracker);
    const c = usageFromMetrics(parseOtlpMetrics(metricsBody(2, 20, 1, 0.1)), tracker); // restart
    expect(a.get("s")).toEqual({ inputTokens: 100, outputTokens: 10, costUsd: 0.5 });
    expect(b.get("s")?.inputTokens).toBe(60);
    expect(b.get("s")?.outputTokens).toBe(2);
    expect(b.get("s")?.costUsd).toBeCloseTo(0.3);
    expect(c.get("s")).toEqual({ inputTokens: 20, outputTokens: 1, costUsd: 0.1 });
  });
});
