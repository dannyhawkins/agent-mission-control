import { describe, expect, test } from "bun:test";
import { formatAnswer } from "./format";

const options = [{ label: "Postgres" }, { label: "SQLite" }];

describe("formatAnswer", () => {
  test("a picked option is a plain DECISION", () => {
    expect(formatAnswer(options, "SQLite")).toBe("DECISION: SQLite");
    expect(formatAnswer(options, "SQLite", "keep it small")).toBe(
      "DECISION: SQLite\nNOTE: keep it small",
    );
  });

  test("a typed reply is flagged as the user's own words", () => {
    expect(formatAnswer(options, "Neither, use the existing DuckDB file")).toBe(
      "DECISION (typed by the user): Neither, use the existing DuckDB file",
    );
  });
});
